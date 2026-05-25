import { supabase } from '@core/db/supabaseClient';
import { SyncQueue, QueuedRecord } from './SyncQueue';
import { db } from '@core/db/client';
import { TABLE } from '@core/db/schema';
import {
  getMissingColumns,
  recordMissingColumns,
  parseMissingColumnError,
} from './schemaDriftCache';

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
    // ✗ Cancellation audit fields — may not exist in all Supabase versions
    'cancelledAt',             'cancelled_at',
    'cancelledBy',             'cancelled_by',
    'cancellationReason',      'cancellation_reason',
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
};

function camelToSnake(s: string): string {
  // Leave already-snake_case keys alone. For PascalCase like SyncStatus →
  // sync_status. For camelCase like minStockLimit → min_stock_limit.
  return s.replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`));
}

function normalizeForSupabase(row: Record<string, unknown>, tableName: string): Record<string, unknown> {
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
}

/** Push a batch of records for one table to Supabase. */
async function pushBatch(tableName: string, records: QueuedRecord[]): Promise<void> {
  const upserts: QueuedRecord[] = records.filter((r) => r.operation !== 'DELETE');
  const deletes: QueuedRecord[] = records.filter((r) => r.operation === 'DELETE');

  const idCol = tableName === 'profiles' ? 'user_id' : 'id';

  if (upserts.length > 0) {
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

      await db.execute(
        `INSERT OR REPLACE INTO ${TABLE.SYNC_META} (table_name, last_pushed_at) VALUES (?, ?)`,
        [tableName, Date.now()]
      );
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
