import { supabase } from '@core/db/supabaseClient';
import { SyncQueue, QueuedRecord } from './SyncQueue';
import { db } from '@core/db/client';
import { TABLE } from '@core/db/schema';
import {
  getMissingColumns,
  recordMissingColumns,
  parseMissingColumnError,
  pushWithDriftLearning,
} from './schemaDriftCache';
import { getDeviceId } from '@core/utils/deviceId';
import {
  applyRenumberMappingLocally,
  type RenumberMappingRow,
  type VoucherDocumentType,
} from '@core/voucher/voucherService';

const BATCH_SIZE = 50;

/**
 * Push-order priority. Lower number = pushed first.
 * This ensures parent rows (customers, suppliers, materials...) sync before
 * child rows that reference them (sales bills, purchases, journal entries).
 *
 * Tables NOT in this list get a default priority of 999 (pushed last).
 */
const TABLE_PRIORITY: Record<string, number> = {
  // Core identity / config
  profiles:               1,
  configurations:         2,
  business_roles:         3,
  team_members:           4,

  // Accounting hierarchy (must exist before any transaction references them)
  company_codes:         10,
  set_of_books:          11,
  gl_master:             12,
  gl_assignments:        13,

  // Loyalty hierarchy
  mbc_card_types:        20,
  mbc_card_templates:    21,

  // Masters (referenced by transactions)
  material_master:       30,
  categories:            31,
  sub_categories:        32,
  doctor_master:         33,
  suppliers:             34,
  customers:             35,
  distributors:          36,
  promotions:            37,

  // Stock / mappings (depend on masters)
  inventory:             40,
  supplier_product_map:  41,
  customer_price_list:   42,
  material_price_list:   43,

  // Transactions (depend on masters + inventory)
  purchases:             50,
  purchase_orders:       51,
  delivery_challans:     52,
  sales_bill:            53,
  sales_challans:        54,
  sales_returns:         55,
  purchase_returns:      56,

  // Cards (depend on card_types)
  mbc_cards:             60,
  mbc_card_history:      61,
  mbc_card_value_history: 62,

  // Adjuncts (depend on transactions)
  mrp_change_log:        70,
  physical_inventory:    71,
  ewaybills:             72,

  // Accounting postings (depend on everything above)
  journal_entry_header:  80,
  journal_entry_lines:   81,
};

function tablePriority(name: string): number {
  return TABLE_PRIORITY[name] ?? 999;
}

/**
 * Detects whether an error is a foreign-key violation (i.e., a referenced
 * row doesn't exist yet on the server). When this happens, we should NOT
 * mark the record as 'failed' permanently — instead, defer it so the
 * dependency can be pushed in a later cycle.
 */
function isForeignKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: string; code?: string };
  const msg = (e.message ?? '').toLowerCase();
  return (
    e.code === '23503' || // Postgres FK violation
    msg.includes('foreign key') ||
    msg.includes('violates foreign key constraint') ||
    msg.includes('is not present in table')
  );
}

/**
 * Format any error (including Supabase's PostgrestError plain objects) into a
 * human-readable string. Default `String(err)` returns "[object Object]" for
 * non-Error objects, which is what we were storing into _sync_queue.last_error.
 */
function formatError(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const e = err as { message?: string; code?: string; details?: string; hint?: string };
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    if (e.code) parts.push(`[${e.code}]`);
    if (e.details) parts.push(`details: ${e.details}`);
    if (e.hint) parts.push(`hint: ${e.hint}`);
    if (parts.length > 0) return parts.join(' ');
    try { return JSON.stringify(err); } catch { /* fall through */ }
  }
  return String(err);
}

function groupByTable(records: QueuedRecord[]): Map<string, QueuedRecord[]> {
  const map = new Map<string, QueuedRecord[]>();
  for (const r of records) {
    const bucket = map.get(r.table_name) ?? [];
    bucket.push(r);
    map.set(r.table_name, bucket);
  }
  return map;
}

/**
 * Convert camelCase keys to snake_case, drop SQLite-only bookkeeping cols
 * and any other key the Supabase schema doesn't recognize. Without this,
 * pushes 400 with "Could not find the 'minStockLimit' column" etc.
 */
const BOOKKEEPING_KEYS = new Set([
  '_sync_status', '_local_only', 'sync_status', 'syncStatus', 'SyncStatus',
  '_syncStatus', 'local_only', 'localOnly', 'LocalOnly', '_localOnly',
  // legacy
  'record_uuid',
]);

/**
 * Per-table fields that exist only locally (SQLite / UI display) and must
 * NOT be forwarded to Supabase. Listed in both camelCase and snake_case so
 * they are caught before AND after camelToSnake conversion.
 *
 * RULE: Any field on a TypeScript model that has NO matching column in the
 * Supabase table must be listed here. Audit against 001_initial.ts schema.
 */
const LOCAL_ONLY_COLUMNS: Record<string, Set<string>> = {

  // ─── sales_bill ────────────────────────────────────────────────────────────
  // SQLite cols: id, organization_id, user_id, date, customer_name, customer_id,
  //   customer_phone, items, subtotal, total_item_discount, total_gst,
  //   scheme_discount, round_off, total, status, payment_mode, pricing_mode,
  //   bill_type, created_at, updated_at
  // Strip ONLY fields that have NO column in Supabase sales_bill.
  // Fields like narration, adjustment, amountReceived, roundOff, linkedChallans
  // ARE valid Supabase columns and must NOT be stripped here.
  sales_bill: new Set([
    // ✗ Local ledger display — not a Supabase column
    'balanceAfterBill',          'balance_after_bill',
    'previousBalanceBeforeBill', 'previous_balance_before_bill',
    // ✗ Accounting posting context — no matching Supabase column on sales_bill
    'companyCodeId',             'company_code_id',
    'setOfBooksId',              'set_of_books_id',
    // ✗ UI display-only fields
    'hideRetailerOnBill',        'hide_retailer_on_bill',
    'billedById',                'billed_by_id',
    'billedByName',              'billed_by_name',
    'taxCalculationType',        'tax_calculation_type',
    // ✗ not in SQLite sales_bill schema (eWayBill handled elsewhere)
    'eWayBillNo',                'e_way_bill_no',
    'eWayBillDate',              'e_way_bill_date',
    // ✗ created_by_id is already mapped from user_id in getSupabasePayload;
    //   sending it separately through the queue path causes confusion
    'createdById',               // snake version stays as created_by_id which may be valid
    // ✗ doctorId not in sales_bill Supabase schema (it's only local)
    'doctorId',                  'doctor_id',
  ]),

  // ─── inventory ─────────────────────────────────────────────────────────────
  // SQLite cols: id, organization_id, name, brand, category, batch, expiry,
  //   stock, min_stock_limit, units_per_pack, pack_type, purchase_price, ptr,
  //   mrp, rate_a, rate_b, rate_c, gst_percent, hsn_code, barcode, composition,
  //   supplier_name, rack_number, cost, value, is_active, material_id,
  //   created_at, updated_at
  // TypeScript InventoryItem has extra frontend fields:
  inventory: new Set([
    'materialId',         'material_id',      // SQLite-only FK for local joins
    'deal',                                    // UI-only promo field
    'free',                                    // UI-only promo field
    'purchaseDeal',       'purchase_deal',
    'purchaseFree',       'purchase_free',
    'taxBasis',           'tax_basis',
    'description',                             // not in inventory SQLite schema (it's in material_master)
    'manufacturer',                            // not in inventory SQLite schema
    'code',                                    // UI alias
    'unitOfMeasurement',  'unit_of_measurement',
    'packUnit',           'pack_unit',
    'baseUnit',           'base_unit',
    'outerPack',          'outer_pack',
    'unitsPerOuterPack',  'units_per_outer_pack',
  ]),

  // ─── purchases ─────────────────────────────────────────────────────────────
  // SQLite cols: id, purchase_serial_id, organization_id, supplier, invoice_number,
  //   date, items, total_amount, subtotal, total_gst, status, pricing_mode,
  //   supplier_id, created_at, updated_at
  // Strip ONLY fields with no Supabase column. Standard financial fields
  // (totalItemDiscount, schemeDiscount, roundOff etc.) ARE in Supabase.
  purchases: new Set([
    // ✗ Accounting context — no column in purchases Supabase table
    'companyCodeId',           'company_code_id',
    'setOfBooksId',            'set_of_books_id',
    // ✗ Receive-flow UI state — local only
    'sourceReceiveMode',       'source_receive_mode',
    // NOTE: cancellation audit columns (cancelled_at, cancelled_by,
    // cancellation_reason) WERE stripped here as "may not exist in all
    // Supabase versions". The live audit confirmed they DO exist on this
    // deployment (and presumably most others, since fix_legacy_mismatches.sql
    // ships them). Strip removed so cancellation reasons flow through to
    // Supabase. Any deployment that genuinely lacks them gets handled by
    // schemaDriftCache the first time PGRST204 fires.
  ]),

  // ─── sales_returns ─────────────────────────────────────────────────────────
  // Supabase schema for returns is legacy/incomplete — strip extra fields
  // that getSupabasePayload also strips:
  sales_returns: new Set([
    'customerId',        'customer_id',
    'status',
    'updatedAt',         'updated_at',
    'userId',            'user_id',
    'createdById',       'created_by_id',
    'performedById',     'performed_by_id',
    'companyCodeId',     'company_code_id',
    'setOfBooksId',      'set_of_books_id',
  ]),

  // ─── purchase_returns ──────────────────────────────────────────────────────
  purchase_returns: new Set([
    'supplierId',        'supplier_id',
    'status',
    'updatedAt',         'updated_at',
    'userId',            'user_id',
    'createdById',       'created_by_id',
    'performedById',     'performed_by_id',
    'companyCodeId',     'company_code_id',
    'setOfBooksId',      'set_of_books_id',
  ]),

  // ─── mrp_change_log ────────────────────────────────────────────────────────
  // SQLite cols: id, organization_id, inventory_id, old_mrp, new_mrp,
  //   changed_by, reason, created_at
  // TypeScript MrpChangeLogEntry has camelCase fields + extras not in Supabase:
  mrp_change_log: new Set([
    // ✗ These camelCase fields don't have matching Supabase columns
    // (Supabase uses: inventory_id, old_mrp, new_mrp, changed_by, reason)
    'materialCode',    'material_code',
    'productName',     'product_name',
    'changedAt',       'changed_at',      // maps to created_at in Supabase
    'changedById',     'changed_by_id',
    'changedByName',   'changed_by_name',
    'sourceScreen',    'source_screen',
    'inventoryId',     // only if Supabase uses inventory_id (it does via toSnake)
  ]),

  // ─── material_master ───────────────────────────────────────────────────────
  // Extra TypeScript fields not in SQLite/Supabase material_master:
  material_master: new Set([
    'isInventorised',           'is_inventorised',
    'isSalesEnabled',           'is_sales_enabled',
    'isPurchaseEnabled',        'is_purchase_enabled',
    'isProductionEnabled',      'is_production_enabled',
    'isInternalIssueEnabled',   'is_internal_issue_enabled',
    'defaultDiscountPercent',   'default_discount_percent',
    'schemePercent',            'scheme_percent',
    'schemeType',               'scheme_type',
    'schemeCalculationBasis',   'scheme_calculation_basis',
    'schemeFormat',             'scheme_format',
    'schemeRate',               'scheme_rate',
    'productDiscount',          'product_discount',
    'masterPriceMaintains',     'master_price_maintains',
    'isPrescriptionRequired',   'is_prescription_required',  // in SQLite but may miss Supabase
    'countryOfOrigin',          'country_of_origin',
    'imei',
    'marketer',
    'pack',
    'materialMasterType',       'material_master_type',      // in SQLite as material_master_type
  ]),

  // ─── customers ─────────────────────────────────────────────────────────────
  // The SyncWorker handles customers via LOCAL_ONLY_COLUMNS but the
  // storageService already uses CUSTOMERS_ALLOWED_FIELDS for the direct path.
  // Only strip fields with NO Supabase column. Many extended fields (creditLimit,
  // assignedStaffId, etc.) DO exist in Supabase and must pass through.
  customers: new Set([
    // ✗ Runtime-computed display field
    'currentBalance',           'current_balance',
    // ✗ Server-managed: the auto_map_party_control_gl trigger on
    // public.customers fills control_gl_id from the party-group mapping
    // and raises P0001 ("Control GL is auto-mapped from group and cannot
    // be manually edited") if the client sends a value that doesn't match
    // its own resolution. Offline we can't always replicate that lookup
    // exactly (no local mirror of gl_assignments PARTY_GROUP rows on older
    // installs), so we drop the field entirely and let the trigger set it.
    // SyncPuller will populate the local copy with the server's value on
    // the next delta-pull.
    'controlGlId',              'control_gl_id',
  ]),

  // ─── suppliers ─────────────────────────────────────────────────────────────
  suppliers: new Set([
    // ✗ Runtime-computed display field
    'currentBalance',           'current_balance',
    // ✗ Same trigger as customers — auto_map_party_control_gl is attached
    // to suppliers too. Let the server fill it.
    'controlGlId',              'control_gl_id',
  ]),

  // ─── configurations ────────────────────────────────────────────────────────
  // Production Supabase's `configurations` table is a subset of our local
  // SQLite schema — strip JSONB columns that don't exist there or PostgREST
  // rejects the whole upsert with PGRST204 "Could not find column".
  // If the production schema later gains one of these, remove it here.
  configurations: new Set([
    'medicineMasterConfig',     'medicine_master_config',
    'fiscalYearConfig',         'fiscal_year_config',
  ]),
  // NOTE: mbc_card_value_history was previously listed here because the
  // Supabase table lacked an organization_id column. That column has now been
  // added to the server schema, so organization_id must be included in pushes.
};


function camelToSnake(s: string): string {
  // Leave already-snake_case keys alone. For PascalCase like SyncStatus →
  // sync_status. For camelCase like minStockLimit → min_stock_limit.
  return s.replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`));
}

/**
 * Tables that track ownership via `created_by_id` (a uuid FK to auth.users).
 * Mirrors OWNER_TRACKING_TABLES in services/storageService.ts — kept here as
 * a local set so this file doesn't have to import from storageService (which
 * pulls in a huge dependency graph and would create a cycle through
 * SyncQueue → SyncWorker → storageService → SyncQueue).
 *
 * If a table is in this set, the row that lands on Supabase must have its
 * user_id mapped to created_by_id and the user_id field dropped — that's
 * what getSupabasePayload() does for the direct online insert path. Without
 * the same mapping here, every row that flushes through the offline queue
 * arrives with created_by_id = NULL while the direct-online rows have it
 * populated, breaking ownership-based filters / reports / audit trails.
 *
 * Exceptions handled below:
 *   - physical_inventory uses user_id directly as a real FK column.
 *   - sales_returns / purchase_returns strip BOTH columns via
 *     LOCAL_ONLY_COLUMNS (older schema variant lacks them entirely), so the
 *     mapping below becomes a no-op.
 */
const OWNER_TRACKING_TABLES = new Set([
  'inventory', 'purchases', 'suppliers', 'customers', 'sales_bill',
  'material_master', 'purchase_orders', 'sales_challans', 'delivery_challans',
  'doctor_master',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Exported for unit tests in src/core/sync/__tests__/normalizeForSupabase.test.ts.
// Runtime callers should keep using this via the local closure — the export is
// purely so the test can pin the transformation rules.
export function normalizeForSupabase(row: Record<string, unknown>, tableName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const localOnly = LOCAL_ONLY_COLUMNS[tableName] ?? new Set<string>();
  // Runtime-learned drift: columns the server has previously rejected with
  // PGRST204. See schemaDriftCache.ts — the set covers both camelCase and
  // snake_case variants so it fires whether we drop the key before or after
  // the camelToSnake conversion below.
  const driftMissing = getMissingColumns(tableName);
  for (const [key, value] of Object.entries(row)) {
    if (BOOKKEEPING_KEYS.has(key)) continue;
    if (key.startsWith('_')) continue; // any other SQLite bookkeeping
    if (localOnly.has(key)) continue;  // table-specific local-only fields
    if (driftMissing.has(key)) continue; // server rejected this column before
    const snakeKey = camelToSnake(key);
    if (driftMissing.has(snakeKey)) continue;
    out[snakeKey] = value;
  }

  // Ownership audit: map user_id -> created_by_id. Mirrors the same logic in
  // storageService.getSupabasePayload(). Without this, every offline-queued
  // row for these tables loses created_by_id when SyncWorker pushes it.
  if (OWNER_TRACKING_TABLES.has(tableName)) {
    const uid = out.user_id;
    if (typeof uid === 'string' && UUID_RE.test(uid)) {
      // Don't clobber an explicitly-set created_by_id (e.g. someone reassigns
      // a bill to a different staff member). Only fill it in if missing.
      if (typeof out.created_by_id !== 'string' || !UUID_RE.test(out.created_by_id as string)) {
        out.created_by_id = uid;
      }
      // Drop user_id for these tables — the canonical column on Supabase is
      // created_by_id; user_id was the legacy name and is left NULL by the
      // online path too. (physical_inventory is intentionally NOT in
      // OWNER_TRACKING_TABLES above because it keeps user_id as a real FK.)
      delete out.user_id;
    }
  }

  // purchases.sourcePurchaseOrderId is the app's field name; the Supabase
  // column is reference_doc_number. The direct online path remaps it in
  // getSupabasePayload(); the offline-queue path was sending the camelToSnake
  // form (source_purchase_order_id) which doesn't exist on Supabase, so the
  // PO linkage was being dropped on every offline-pushed purchase.
  if (tableName === 'purchases') {
    const srcPo = out.source_purchase_order_id ?? out.sourcePurchaseOrderId;
    if (typeof srcPo === 'string' && srcPo.length > 0) {
      if (!out.reference_doc_number) out.reference_doc_number = srcPo;
      delete out.source_purchase_order_id;
      delete out.sourcePurchaseOrderId;
    }
  }

  // purchase_orders: the app's data model calls the counterparty
  // "supplier" / "supplier_id" (matching the local SQLite migration 001
  // schema). Supabase's purchase_orders schema (purchase_orders_schema.sql)
  // uses "distributor_name" / "distributor_id" — every offline-pushed PO
  // was landing with NULL distributor fields and the supplier columns
  // getting silently dropped server-side (which is why migration 011's
  // localOnly audit flagged supplier/supplier_id as drift).
  if (tableName === 'purchase_orders') {
    const supplierName = out.supplier;
    const supplierId = out.supplier_id;
    if (typeof supplierName === 'string' && supplierName.length > 0 && !out.distributor_name) {
      out.distributor_name = supplierName;
    }
    if (typeof supplierId === 'string' && supplierId.length > 0 && !out.distributor_id) {
      out.distributor_id = supplierId;
    }
    delete out.supplier;
    delete out.supplier_id;
    // po_serial_id is the local legacy alias for the canonical serial_id.
    // Migration 011 added serial_id locally so both should normally be
    // present; map if only the legacy form survived this far.
    if (!out.serial_id && typeof out.po_serial_id === 'string') {
      out.serial_id = out.po_serial_id;
    }
    delete out.po_serial_id;
  }

  // journal_entry_lines: server columns are debit_amount / credit_amount
  // (note the _amount suffix). Local schema 003 used the bare names.
  // Mirror in the push direction; the inverse (pull) is handled by
  // adaptRowForSqlite now that migration 013 added the suffixed columns
  // to the local table.
  if (tableName === 'journal_entry_lines') {
    // Supabase has a bigint primary key identity on this table; do not send client UUID text
    delete out.id;
    // Server has debit_amount/credit_amount as generated columns; do not send values for them
    delete out.debit_amount;
    delete out.credit_amount;
  }

  // Generic UUID guard: any *_id field that's neither a valid UUID nor a
  // recognised text-PK gets nulled out so Supabase doesn't reject the whole
  // row with "invalid input syntax for type uuid". Mirrors the loop in
  // getSupabasePayload(). The id column on sales_bill / physical_inventory
  // is intentionally text (e.g. invoice number), so skip it there.
  const idFields = Object.keys(out).filter((f) =>
    f === 'created_by_id' || f === 'performed_by_id' || f === 'assigned_staff_id' ||
    f === 'customer_id' || f === 'supplier_id' || f === 'doctor_id' ||
    f === 'master_medicine_id' || f === 'inventory_id' || f === 'material_id' ||
    f === 'distributor_id' || f === 'control_gl_id' || f === 'set_of_books_id' ||
    f === 'company_code_id' || f === 'card_type_id' || f === 'template_id' ||
    f === 'mbc_card_id' || f === 'journal_entry_id' || f === 'reference_id' ||
    f === 'reference_document_id'
  );
  for (const f of idFields) {
    const v = out[f];
    if (v !== null && v !== undefined && (typeof v !== 'string' || !UUID_RE.test(v))) {
      out[f] = null;
    }
  }

  return out;
}

/**
 * Mark a batch of locally-mirrored entity rows as 'synced' after the push has
 * been confirmed by Supabase. Without this, rows we wrote via
 * `persistLocalRowToSqlite(..., 'pending')` stay pending forever — and
 * SyncPuller's pending-guard would then refuse to overwrite them with newer
 * remote updates, drifting the local copy out of date.
 *
 * Some tables don't carry `_sync_status` (because the SQLite schema for that
 * table is older); a failed UPDATE there is harmless and ignored.
 */
async function markEntityRowsSynced(
  tableName: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const idCol = tableName === 'profiles' ? 'user_id' : 'id';
  try {
    const placeholders = ids.map(() => '?').join(',');
    await db.execute(
      `UPDATE ${tableName} SET _sync_status = 'synced' WHERE ${idCol} IN (${placeholders})`,
      ids
    );
  } catch (err) {
    // Likely: no _sync_status column on this table or table absent locally.
    // Either way it's non-fatal — the queue row is already marked done.
    console.debug(`[sync] markEntityRowsSynced(${tableName}) skipped:`, (err as Error)?.message);
  }

  // Notify the UI so it can drop the stale `sync_status: 'pending'` from the
  // matching in-memory rows without forcing a full data reload. Without this
  // the "Sync Pending" badge in Sales History sticks until the user reloads.
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('sync-rows-synced', { detail: { tableName, ids } }));
    }
  } catch {
    /* no-op */
  }
}

/**
 * Tables where every row carries a user-visible sequential code that has a
 * (organization_id, <code>) UNIQUE constraint server-side. If two devices
 * (or a device + the web app) generate the same code while offline, the
 * push hits 23505 forever — see material_master_code_org_unique and the
 * matching constraint on doctor_master.
 *
 * For these tables we leave the batch path entirely and push one row at a
 * time. On a code-collision 23505 we query Supabase for the live MAX(code),
 * assign the row max+1, update the LOCAL mirror so the user sees the same
 * value as what landed on the server, and retry. Mirrors the existing
 * online-direct logic in storageService.saveData (lines ~1013-1066) which
 * already had this behaviour for ONLINE creates — the offline-queued path
 * was just missing it.
 */
const TABLES_WITH_AUTO_CODE: Record<string, { codeCol: string; prefix: string; padLength: number; startNum: number }> = {
  material_master: { codeCol: 'material_code', prefix: '',     padLength: 8, startNum: 10000000 },
  doctor_master:   { codeCol: 'doctor_code',   prefix: 'DOC-', padLength: 6, startNum: 1 },
};

function isCodeUniqueViolation(error: { code?: string; message?: string }, tableName: string): boolean {
  if (error?.code !== '23505') return false;
  const meta = TABLES_WITH_AUTO_CODE[tableName];
  if (!meta) return false;
  const msg = (error.message ?? '').toLowerCase();
  // Match the constraint name (material_master_code_org_unique) OR the
  // column name appearing in the message — Postgres includes one or both
  // depending on how the constraint was defined.
  return msg.includes(meta.codeCol) || msg.includes('code_org_unique');
}

/**
 * Query Supabase for the highest numeric code in the given table for this
 * org, return max+1 padded to the configured length. Paginates because
 * Postgres can't sort numerically by a text column reliably when codes have
 * mixed lengths.
 */
async function claimNextCodeFromServer(tableName: string, organizationId: string): Promise<string> {
  const meta = TABLES_WITH_AUTO_CODE[tableName];
  if (!meta) throw new Error(`No auto-code config for ${tableName}`);

  const PAGE = 1000;
  let maxNum = meta.startNum - 1;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(tableName)
      .select(meta.codeCol)
      .eq('organization_id', organizationId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const raw = (row as unknown as Record<string, unknown>)[meta.codeCol];
      if (typeof raw !== 'string') continue;
      const stripped = meta.prefix ? raw.replace(new RegExp(`^${meta.prefix}`), '') : raw;
      const n = parseInt(stripped, 10);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  const next = maxNum + 1;
  return meta.prefix + String(next).padStart(meta.padLength, '0');
}

/**
 * Push records for material_master / doctor_master one at a time. On a
 * code-collision 23505, reclaim a new code from the server, update the
 * local mirror, and retry up to MAX_CODE_RETRIES times. Other 23505s (e.g.
 * primary-key duplicate) bubble up unchanged so the queue marks them
 * failed and the user can investigate.
 */
async function pushCodedRecordsIndividually(tableName: string, records: QueuedRecord[]): Promise<void> {
  const meta = TABLES_WITH_AUTO_CODE[tableName];
  const MAX_CODE_RETRIES = 5;

  for (const record of records) {
    const rawPayload = JSON.parse(record.payload) as Record<string, unknown>;
    const recordId = String(rawPayload.id ?? '');
    let attempt = 0;

    // Local retry loop on code collision. Drift-learning still applies and
    // is handled inside pushWithDriftLearning, separately from the code
    // reassignment loop below.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { error } = await pushWithDriftLearning(
        tableName,
        normalizeForSupabase(rawPayload, tableName),
        async (filtered) => {
          const r = await supabase
            .from(tableName)
            .upsert(filtered as Record<string, unknown>, { onConflict: 'id', ignoreDuplicates: false });
          return { data: null, error: r.error };
        },
      );
      if (!error) break;

      if (isCodeUniqueViolation(error as { code?: string; message?: string }, tableName) && attempt < MAX_CODE_RETRIES) {
        attempt += 1;
        const orgId = rawPayload.organization_id as string;
        const newCode = await claimNextCodeFromServer(tableName, orgId);
        const oldCode = rawPayload[meta.codeCol] ?? rawPayload[snakeToCamel(meta.codeCol)];
        console.info(
          `[sync] ${tableName} code collision: ${oldCode} already exists for org ${orgId}, ` +
          `retrying with ${newCode} (attempt ${attempt}/${MAX_CODE_RETRIES})`,
        );

        // Update the in-flight payload AND the local SQLite row so the
        // user sees the new code immediately. Both snake and camel keys
        // are set so whichever the legacy app reads from picks it up.
        rawPayload[meta.codeCol] = newCode;
        rawPayload[snakeToCamel(meta.codeCol)] = newCode;
        try {
          await db.execute(
            `UPDATE ${tableName} SET ${meta.codeCol} = ? WHERE id = ?`,
            [newCode, recordId],
          );
        } catch (localErr) {
          console.warn(`[sync] failed to update local ${tableName}.${meta.codeCol} after reclaim:`, localErr);
        }
        continue;
      }

      throw error; // not a code collision, or exhausted retries
    }

    if (recordId) await markEntityRowsSynced(tableName, [recordId]);
  }
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// ─── Voucher batch commit ───────────────────────────────────────────────────
// For the 6 voucher-numbered tables, before pushing the row payloads we call
// the server RPC `commit_voucher_batch`. The RPC atomically assigns final
// voucher numbers (renumbering the whole batch to the tail if proposed numbers
// overlap the server counter — see supabase/functions/_shared/commit_voucher_batch.sql).
// We then rewrite the queued payloads + local mirror rows + soft-copy
// reference columns so the regular upsert path pushes the FINAL numbers.

interface VoucherTableMeta {
  numberCol: string;
  dateCol: string;
  docType: VoucherDocumentType;
}

const VOUCHER_TABLE_META: Record<string, VoucherTableMeta> = {
  sales_bill:         { numberCol: 'invoice_number',     dateCol: 'date',       docType: 'sales-gst' },
  purchases:          { numberCol: 'purchase_serial_id', dateCol: 'date',       docType: 'purchase-entry' },
  purchase_orders:    { numberCol: 'po_serial_id',       dateCol: 'date',       docType: 'purchase-order' },
  sales_challans:     { numberCol: 'challan_serial_id',  dateCol: 'date',       docType: 'sales-challan' },
  delivery_challans:  { numberCol: 'challan_serial_id',  dateCol: 'date',       docType: 'delivery-challan' },
  physical_inventory: { numberCol: 'voucher_no',         dateCol: 'start_date', docType: 'physical-inventory' },
};

/**
 * Derive the fiscal-year key from a bill date. MUST match the format used by
 * voucherService.computeFiscalYear() and the legacy
 * `configurations.fiscalYearConfig.currentFiscalYear` (single start year,
 * e.g. "2026" for the Indian FY 2026-04-01 → 2027-03-31). See the long
 * comment in voucherService.ts for the bug this format alignment fixes.
 */
function fyFromDateString(dateStr: string | undefined): string {
  const fallback = (): string => {
    const now = new Date();
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    const start = m >= 4 ? y : y - 1;
    return `${start}`;
  };
  if (!dateStr) return fallback();
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return fallback();
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  const start = m >= 4 ? y : y - 1;
  return `${start}`;
}

/**
 * Extract the integer voucher number from a formatted document number string
 * (e.g. "INV000101-25-26" → 101). Returns 0 if no digit run is found, in
 * which case the bill is pushed via the normal path without going through
 * the assignment RPC (used for legacy rows whose number column was never
 * populated).
 */
function extractProposedNumber(formatted: string | undefined | null): number {
  if (!formatted) return 0;
  // Strip the trailing fiscal-year suffix (`-25-26`) before looking for the
  // sequence digits, so "INV000101-25-26" doesn't pick up 25 or 26.
  const stripped = formatted.replace(/-\d{2}-\d{2}$/, '');
  const match = stripped.match(/(\d+)\s*$/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Optional UI listener — fires whenever the server renumbered any bills in a
// just-completed sync cycle. UI can subscribe to show a toast / banner so the
// user knows their printed copies are stale.
export interface VoucherRenumberNotice {
  tableName: string;
  docType: VoucherDocumentType;
  renumbered: Array<{ uuid: string; newNumber: string }>;
}
type VoucherRenumberListener = (notice: VoucherRenumberNotice) => void;
let voucherRenumberListener: VoucherRenumberListener | null = null;
export function setVoucherRenumberListener(fn: VoucherRenumberListener | null): void {
  voucherRenumberListener = fn;
}

/**
 * Commit voucher numbers for a batch of records via the server RPC, then
 * rewrite local rows + queued payloads to use the final assigned numbers.
 * Called from pushBatch BEFORE the regular upsert path runs.
 */
async function commitVoucherBatchAndRewrite(
  tableName: string,
  records: QueuedRecord[]
): Promise<void> {
  const meta = VOUCHER_TABLE_META[tableName];
  if (!meta) return;

  interface Bill { local_uuid: string; proposed_number: number }
  interface Group { orgId: string; fy: string; bills: Bill[] }

  const groups = new Map<string, Group>();
  const recordsByUuid = new Map<string, QueuedRecord>();

  for (const rec of records) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rec.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const orgId = payload.organization_id as string | undefined;
    const billUuid = payload.id as string | undefined;
    if (!orgId || !billUuid) continue;

    const proposed = extractProposedNumber(payload[meta.numberCol] as string | undefined);
    if (proposed <= 0) {
      // No parseable number — let the regular upsert path try; if the server
      // has a NOT NULL constraint it'll fail loudly and we'll fix the source.
      continue;
    }

    const fy = fyFromDateString(payload[meta.dateCol] as string | undefined);
    const key = `${orgId}|${fy}`;
    let g = groups.get(key);
    if (!g) {
      g = { orgId, fy, bills: [] };
      groups.set(key, g);
    }
    g.bills.push({ local_uuid: billUuid, proposed_number: proposed });
    recordsByUuid.set(billUuid, rec);
  }

  if (groups.size === 0) return;

  const deviceId = await getDeviceId();
  const allRenumbered: Array<{ uuid: string; newNumber: string }> = [];

  for (const g of groups.values()) {
    const { data, error } = await supabase.rpc('commit_voucher_batch', {
      p_org_id: g.orgId,
      p_document_type: meta.docType,
      p_fy: g.fy,
      p_device_id: deviceId,
      p_bills: g.bills,
    });

    if (error) {
      // Surface to the queue handler so the batch retries; do NOT silently
      // push bills with proposed-but-unassigned numbers.
      throw new Error(
        `commit_voucher_batch failed for ${tableName} (${meta.docType}, fy=${g.fy}): ${error.message}`
      );
    }

    const mapping = (data ?? []) as RenumberMappingRow[];

    // 1. Apply mapping to local mirror + soft-copy references.
    const applied = await applyRenumberMappingLocally(tableName, g.orgId, mapping);
    allRenumbered.push(...applied.renumbered);

    // 2. Rewrite the queued payloads so the upsert that follows uses the
    //    FINAL document number — otherwise we'd push the stale local one.
    const finalByUuid = new Map(mapping.map((m) => [m.local_uuid, m.final_document_number]));
    for (const [uuid, finalNumber] of finalByUuid.entries()) {
      const rec = recordsByUuid.get(uuid);
      if (!rec) continue;
      try {
        const p = JSON.parse(rec.payload) as Record<string, unknown>;
        p[meta.numberCol] = finalNumber;
        rec.payload = JSON.stringify(p);
      } catch {
        // ignore; the bill will be pushed with whatever payload it carried
      }
    }
  }

  if (allRenumbered.length > 0 && voucherRenumberListener) {
    try {
      voucherRenumberListener({
        tableName,
        docType: meta.docType,
        renumbered: allRenumbered,
      });
    } catch (err) {
      console.warn('[sync] voucher renumber listener threw:', err);
    }
  }
}

/** Push a batch of records for one table to Supabase. */
async function pushBatch(tableName: string, records: QueuedRecord[]): Promise<void> {
  const upserts: QueuedRecord[] = records.filter((r) => r.operation !== 'DELETE');
  const deletes: QueuedRecord[] = records.filter((r) => r.operation === 'DELETE');

  const idCol = tableName === 'profiles' ? 'user_id' : 'id';

  // Voucher-numbered tables: atomically claim final numbers from the server
  // and rewrite both the local rows and the queued payloads BEFORE the
  // regular upsert path runs. Idempotent on bill UUID — safe to retry.
  if (VOUCHER_TABLE_META[tableName] && upserts.length > 0) {
    await commitVoucherBatchAndRewrite(tableName, upserts);
  }

  // Tables with auto-generated user-visible codes get the per-row loop so a
  // single colliding row doesn't poison the rest of the batch.
  if (TABLES_WITH_AUTO_CODE[tableName] && upserts.length > 0) {
    await pushCodedRecordsIndividually(tableName, upserts);

    // Still handle deletes via the bulk path below.
    if (deletes.length === 0) return;
  } else if (upserts.length > 0) {
    // Decode payloads once; we may renormalise them several times if the
    // server keeps reporting different unknown columns.
    const rawPayloads = upserts.map((r) => JSON.parse(r.payload) as Record<string, unknown>);

    // PGRST204 only ever names one missing column at a time, so a row that
    // carries N drifted columns needs up to N retries before it succeeds. We
    // cap at MAX_DRIFT_RETRIES to avoid an infinite loop if the parser ever
    // mis-extracts (defence in depth — the cache itself is monotonic, so a
    // genuine bug would just keep adding the same column).
    const MAX_DRIFT_RETRIES = 20;
    let realIds: string[] = [];

    for (let attempt = 0; attempt <= MAX_DRIFT_RETRIES; attempt++) {
      const payloads = rawPayloads.map((r) => normalizeForSupabase(r, tableName));

      // Deduplicate payloads by primary key. Keep only the latest update for each record.
      // PostgreSQL `ON CONFLICT DO UPDATE` fails if the same key appears multiple times in one batch.
      const uniquePayloadsMap = new Map<string, Record<string, unknown>>();
      realIds = [];
      for (const payload of payloads) {
        const idVal = payload[idCol] as string;
        if (idVal) {
          if (!uniquePayloadsMap.has(idVal)) realIds.push(idVal);
          uniquePayloadsMap.set(idVal, payload);
        } else {
          // Fallback for records missing ID — random key keeps the dedup map
          // unique but excludes the row from local _sync_status flipping.
          uniquePayloadsMap.set(`__missing_${Math.random()}`, payload);
        }
      }
      const uniquePayloads = Array.from(uniquePayloadsMap.values());

      const { error } = await supabase.from(tableName).upsert(uniquePayloads, {
        onConflict: idCol,
        ignoreDuplicates: false,
      });

      if (!error) break;

      // Schema drift: the server is missing a column this client thinks
      // exists. Learn it, persist for future sessions, and retry without it.
      const drift = parseMissingColumnError(error);
      if (drift && drift.column) {
        recordMissingColumns(tableName, [drift.column]);
        console.info(
          `[sync] ${tableName}: server has no column '${drift.column}' — stripped and retrying ` +
          `(learned: ${attempt + 1})`,
        );
        continue;
      }

      throw error; // genuine failure — let the outer handler defer/fail
    }

    // Local mirror is now confirmed — flip _sync_status so SyncPuller will
    // accept the next remote update for these rows.
    await markEntityRowsSynced(tableName, realIds);
  }

  // Deduplicate deletes
  const uniqueDeletes = new Set<string>();
  for (const del of deletes) {
    const payload = JSON.parse(del.payload) as Record<string, unknown>;
    const idVal = (payload[idCol] ?? payload.id) as string;
    if (idVal) uniqueDeletes.add(idVal);
  }

  for (const idVal of uniqueDeletes) {
    const { error } = await supabase.from(tableName).delete().eq(idCol, idVal);
    if (error) throw error;
  }
}

/**
 * Defer a record back to pending without incrementing the attempt counter.
 * Used for FK errors where the dependency will be pushed in a later cycle.
 */
async function deferRecord(id: number, reason: string): Promise<void> {
  await db.execute(
    `UPDATE _sync_queue SET status = 'pending', last_error = ? WHERE id = ?`,
    [`Deferred: ${reason}`, id]
  );
}

/**
 * Process the entire pending queue, returning counts.
 * Records are processed in table-priority order so masters sync before transactions.
 * FK violations cause records to be deferred (not failed) for the next cycle.
 */
export async function processSyncQueue(): Promise<{
  pushed: number;
  failed: number;
  deferred: number;
}> {
  const pending = await SyncQueue.getPending(BATCH_SIZE);
  if (pending.length === 0) return { pushed: 0, failed: 0, deferred: 0 };

  // Guard: discard any records that have no table_name or record_id.
  // These are orphaned/corrupt entries that would cause supabase.from('')
  // to throw and then retry forever.
  const corrupt = pending.filter((r) => !r.table_name || !r.record_id);
  if (corrupt.length > 0) {
    const ids = corrupt.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await db.execute(
      `DELETE FROM _sync_queue WHERE id IN (${placeholders})`,
      ids
    );
    console.warn(`[sync] Discarded ${corrupt.length} corrupt queue record(s) with missing table_name/record_id.`);
  }

  const valid = pending.filter((r) => r.table_name && r.record_id);
  if (valid.length === 0) return { pushed: 0, failed: 0, deferred: 0 };

  const ids = valid.map((r) => r.id);
  await SyncQueue.markSyncing(ids);

  // Group by table and sort the table list by priority
  const byTable = groupByTable(valid);
  const sortedTables = Array.from(byTable.keys()).sort(
    (a, b) => tablePriority(a) - tablePriority(b)
  );

  let pushed = 0;
  let failed = 0;
  let deferred = 0;

  for (const tableName of sortedTables) {
    const records = byTable.get(tableName)!;
    try {
      await pushBatch(tableName, records);
      await SyncQueue.markDone(records.map((r) => r.id));
      pushed += records.length;
      console.info(`[sync] Pushed ${records.length} ${tableName} record(s).`);

      // Update the per-org push timestamp. Migration 015 made
      // organization_id part of the PK on _sync_meta, so omitting it here
      // (as the legacy schema allowed) fails the NOT NULL constraint and
      // the whole cycle is reported as failed even though the actual
      // upserts to Supabase succeeded.
      //
      // The batch is grouped by table_name only, so it CAN contain records
      // from different orgs if the user is signed into multiple installs on
      // one device. Bump every org represented in the batch.
      const orgIds = Array.from(new Set(records.map((r) => r.organization_id))).filter(Boolean);
      for (const orgId of orgIds) {
        await db.execute(
          `INSERT OR REPLACE INTO ${TABLE.SYNC_META}
             (organization_id, table_name, last_pushed_at) VALUES (?, ?, ?)`,
          [orgId, tableName, Date.now()]
        );
      }
    } catch (err) {
      if (isForeignKeyError(err)) {
        // Dependency missing — defer for next cycle (don't burn an attempt)
        const msg = formatError(err);
        for (const record of records) {
          await deferRecord(record.id, msg);
        }
        deferred += records.length;
        console.warn(`[sync] Deferring ${records.length} ${tableName} record(s) — FK dependency: ${msg}`);
      } else {
        // Real error — count attempts and eventually fail
        const msg = formatError(err);
        for (const record of records) {
          await SyncQueue.markFailed(record.id, msg);
        }
        failed += records.length;
        console.warn(`[sync] Push failed for ${tableName}: ${msg}`);
      }
    }
  }

  return { pushed, failed, deferred };
}
