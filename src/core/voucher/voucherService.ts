/**
 * Offline-first voucher number generator (cursor-allocation model).
 *
 * Each device keeps a single running cursor per (organization_id, document_type,
 * fiscal_year) in the local `voucher_series_state` table. Numbers are handed
 * out one at a time, monotonically, identically online and offline. There is no
 * pre-reserved chunk — the series is continuous with no gaps left by ranges
 * that a device fetched but didn't fully use.
 *
 * On reconnect, locally-issued bills are pushed via the Postgres RPC
 * `commit_voucher_batch`. The RPC compares the proposed numbers against the
 * server's running counter (`configurations.<cfg>.internalCurrentNumber`)
 * under a `SELECT … FOR UPDATE` lock:
 *   - If proposed range > server counter: bills land with their proposed
 *     numbers, server counter advances to the new max.
 *   - If overlap exists: server keeps its already-committed numbers and
 *     RENUMBERS the incoming offline batch to the tail (Option B —
 *     "first-commit-wins"). The mapping is returned so the client can rewrite
 *     the bill row and a small set of soft-copy reference columns
 *     (sales_returns.original_invoice_number, etc.) and surface a UI notice
 *     so printed copies are reconciled out-of-band.
 *
 * Why this model (vs. chunk-reservation in legacy 006):
 *   - CONTINUOUS NUMBERING: no gaps from unused tails of pre-fetched chunks.
 *   - SINGLE-DEVICE OPTIMAL: the common case (one device billing at a time) is
 *     a single local INTEGER increment with no network round-trip.
 *   - SAFE UNDER CONCURRENT DEVICES: server-side `FOR UPDATE` + renumber-on-
 *     overlap means duplicates never land in production data.
 *
 * Required server function:
 *   supabase/functions/_shared/commit_voucher_batch.sql
 */
import { db } from '@core/db/client';
import { supabase } from '@core/db/supabaseClient';
import { isOnline } from '@core/sync/networkMonitor';
import type { RegisteredPharmacy } from '@core/types';

export type VoucherDocumentType =
  | 'sales-gst'
  | 'sales-non-gst'
  | 'purchase-entry'
  | 'purchase-order'
  | 'sales-challan'
  | 'delivery-challan'
  | 'physical-inventory';

export interface VoucherReservationResult {
  documentNumber: string;
  usedNumber: number;
  nextNumber: number;
  /**
   * Retained for API compatibility with the legacy chunk-allocation model.
   * Always `null` under the cursor model — the series is open-ended; only the
   * configured `endNumber` cap (if any) bounds it, and that is enforced
   * server-side on commit, not in local accounting.
   */
  remainingCount: number | null;
}

interface VoucherSeriesState {
  id: string;
  organization_id: string;
  document_type: string;
  fy: string;
  last_known_server_number: number;
  local_next_number: number;
  last_synced_at: number;
}

const DOC_TYPES: VoucherDocumentType[] = [
  'sales-gst', 'sales-non-gst', 'purchase-entry', 'purchase-order',
  'sales-challan', 'delivery-challan', 'physical-inventory',
];

// Hard safety cap so a runaway loop can't burn through INT4 space on the server.
const MAX_VOUCHER_NUMBER = 1_000_000_000;

// ── Formatting helpers (unchanged from chunk-allocation era) ──────────────

function defaultPrefix(docType: VoucherDocumentType): string {
  switch (docType) {
    case 'sales-gst':         return 'INV';
    case 'sales-non-gst':     return 'NGI';
    case 'purchase-entry':    return 'PUR';
    case 'purchase-order':    return 'PO';
    case 'sales-challan':     return 'SC';
    case 'delivery-challan':  return 'DC';
    case 'physical-inventory':return 'PI';
    default:                  return 'INV';
  }
}

function configColumn(docType: VoucherDocumentType): string {
  switch (docType) {
    case 'sales-gst':         return 'invoice_config';
    case 'sales-non-gst':     return 'non_gst_invoice_config';
    case 'purchase-entry':    return 'purchase_config';
    case 'purchase-order':    return 'purchase_order_config';
    case 'sales-challan':     return 'sales_challan_config';
    case 'delivery-challan':  return 'delivery_challan_config';
    case 'physical-inventory':return 'physical_inventory_config';
  }
}

/**
 * Single-year fiscal-year key that matches the rest of the codebase
 * (see src/core/utils/fiscalYear.ts → getDefaultFiscalYearWindow().label).
 * Indian FY April–March, identified by its START year only ("2026" for
 * 2026-04-01 → 2027-03-31).
 *
 * Originally returned "${start}-${end}" e.g. "2026-27", which silently
 * disagreed with the legacy `configurations.fiscalYearConfig.currentFiscalYear`
 * stored as just "2026". The mismatch caused commit_voucher_batch to see
 * cfg.fy != p_fy and reset the counter on every offline push — the bug
 * surfaced as voucher series getting renumbered from 1 each sync.
 */
function computeFiscalYear(now = new Date()): string {
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const start = month >= 4 ? year : year - 1;
  return `${start}`;
}

interface ConfigFormatting {
  prefix: string;
  paddingLength: number;
  useFiscalYear: boolean;
  startingNumber: number;
}

async function readConfigFormatting(
  docType: VoucherDocumentType,
  orgId: string
): Promise<ConfigFormatting> {
  const col = configColumn(docType);
  const rows = await db.select<Record<string, unknown>>(
    `SELECT ${col} as cfg FROM configurations WHERE organization_id = ? LIMIT 1`,
    [orgId]
  );
  let cfg: {
    prefix?: string;
    paddingLength?: number;
    useFiscalYear?: boolean;
    startingNumber?: number;
  } = {};
  if (rows.length > 0 && rows[0].cfg) {
    const raw = rows[0].cfg;
    if (typeof raw === 'string') {
      try { cfg = JSON.parse(raw); } catch { /* defaults */ }
    } else if (typeof raw === 'object') {
      cfg = raw as typeof cfg;
    }
  }
  return {
    prefix: cfg.prefix ?? defaultPrefix(docType),
    paddingLength: Math.max(1, cfg.paddingLength ?? 6),
    useFiscalYear: cfg.useFiscalYear ?? true,
    startingNumber: Math.max(1, cfg.startingNumber ?? 1),
  };
}

function format(fmt: ConfigFormatting, n: number, fy: string): string {
  return fmt.prefix + n.toString().padStart(fmt.paddingLength, '0') + (fmt.useFiscalYear ? `-${fy}` : '');
}

// ── Local bill-table probe ────────────────────────────────────────────────

/**
 * Map each voucher document type to the local SQLite table + column where
 * its assigned number ends up. Used by warmup to derive a safety floor for
 * the cursor: even if configurations.invoice_config.currentNumber is stale
 * (e.g. the production web app advances its cursor via a code path that
 * doesn't write back to that field), we still bump the cursor past every
 * bill number we've already seen.
 */
/**
 * Local column name diverges from the server in exactly one place:
 * `purchase_orders.po_serial_id` (local legacy alias) → `serial_id` (server
 * canonical). SyncWorker maps it on push. We keep both names side-by-side
 * here so local SQL and Supabase queries each get the right identifier.
 */
const BILL_TABLE_BY_DOCTYPE: Record<VoucherDocumentType, {
  table: string;
  localNumberCol: string;
  serverNumberCol: string;
} | null> = {
  'sales-gst':         { table: 'sales_bill',         localNumberCol: 'invoice_number',     serverNumberCol: 'invoice_number' },
  'sales-non-gst':     { table: 'sales_bill',         localNumberCol: 'invoice_number',     serverNumberCol: 'invoice_number' },
  'purchase-entry':    { table: 'purchases',          localNumberCol: 'purchase_serial_id', serverNumberCol: 'purchase_serial_id' },
  'purchase-order':    { table: 'purchase_orders',    localNumberCol: 'po_serial_id',       serverNumberCol: 'serial_id' },
  'sales-challan':     { table: 'sales_challans',     localNumberCol: 'challan_serial_id',  serverNumberCol: 'challan_serial_id' },
  'delivery-challan':  { table: 'delivery_challans',  localNumberCol: 'challan_serial_id',  serverNumberCol: 'challan_serial_id' },
  'physical-inventory':{ table: 'physical_inventory', localNumberCol: 'voucher_no',         serverNumberCol: 'voucher_no' },
};

/**
 * Parse the integer suffix out of a formatted document number like
 * "INV0004102-2026" → 4102. Returns 0 if no digit run can be located.
 *
 * Strategy: strip the prefix if it matches, strip any trailing fiscal-year
 * suffix (handles "2026", "25-26", "2026-27"), then read the last digit run.
 * Robust against the dual FY format that coexists in this codebase.
 */
function extractNumberFromDocument(doc: string, prefix: string): number {
  if (!doc) return 0;
  let s = doc;
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  // Strip trailing fiscal-year markers: -2026, -25-26, -2026-27.
  s = s.replace(/-\d{2,4}(-\d{2})?$/, '');
  const match = s.match(/(\d+)/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Highest voucher number already present in the local bill table for this
 * series. Filters by prefix so sales-gst and sales-non-gst — which share
 * the sales_bill table — don't pollute each other's max.
 */
async function fetchLocalMaxBillNumber(
  orgId: string,
  docType: VoucherDocumentType,
  prefix: string
): Promise<number> {
  const meta = BILL_TABLE_BY_DOCTYPE[docType];
  if (!meta) return 0;
  const col = meta.localNumberCol;
  try {
    // LIKE 'INV%' narrows the scan when sales-gst and sales-non-gst share a
    // table. For tables that aren't shared the LIKE is harmless overhead.
    const rows = await db.select<{ n: string | null }>(
      `SELECT ${col} AS n FROM ${meta.table}
        WHERE organization_id = ?
          AND ${col} IS NOT NULL
          AND ${col} LIKE ?`,
      [orgId, `${prefix}%`]
    );
    let max = 0;
    for (const r of rows) {
      if (!r.n) continue;
      const parsed = extractNumberFromDocument(r.n, prefix);
      if (parsed > max) max = parsed;
    }
    return max;
  } catch (err) {
    // Table missing locally (e.g. a fresh install before InitialSync ran),
    // or column doesn't exist — degrade gracefully to 0 so warmup still
    // proceeds based on the configurations fetch alone.
    console.debug(`[voucher] fetchLocalMaxBillNumber(${docType}) skipped:`, (err as Error)?.message);
    return 0;
  }
}

// ── Server cursor probes ──────────────────────────────────────────────────
//
// Three sources contribute to the "highest number ever issued on the server"
// for a series. We take MAX of all of them so the cursor is monotonic even
// when one source is incomplete:
//
//   1. configurations.invoice_config.currentNumber  — legacy counter,
//      advanced by reserve_voucher_range chunk reservations AND by my
//      commit_voucher_batch RPC. May be ahead of actual bill data on
//      accounts that ran the chunk allocator (gaps were "reserved" but
//      never billed). We HONOR these gaps so a future bill never re-uses a
//      number a chunk once claimed — standard ERP monotonicity guarantee.
//
//   2. MAX(invoice_number) from the bill table on Supabase, filtered by
//      prefix. Catches real bills that may not be reflected in (1) if the
//      legacy counter wasn't kept in sync.
//
//   3. MAX(assigned_number) from voucher_number_assignment for this
//      org/docType/fy. The per-bill commit ledger written by my RPC; this
//      catches numbers committed but whose sales_bill row hasn't propagated
//      yet, and is the authoritative source going forward.

/**
 * Read `configurations.<cfg>.currentNumber` for this series — the
 * server-side "next number to issue" that production's UI displays directly.
 *
 * We deliberately ignore `internalCurrentNumber`. Empirically (confirmed by
 * direct SQL on production data), the two fields diverge: `currentNumber`
 * is what bill creation maintains and what production's UI reads;
 * `internalCurrentNumber` is the legacy chunk-reservation pointer that gets
 * inflated to chunk_end+1 and then never comes back down even when bills
 * weren't created within the chunk. Taking MAX of the two — as my earlier
 * code did — would silently pick up the inflated value and push the
 * offline cursor 94 numbers past production for purchase-entry, etc.
 *
 * Fallback to `internalCurrentNumber` only if `currentNumber` is genuinely
 * missing (very old configurations rows from before the field was added).
 */
async function fetchServerConfigurationsCurrentNumber(
  orgId: string,
  docType: VoucherDocumentType
): Promise<number> {
  const col = configColumn(docType);
  try {
    const { data, error } = await supabase
      .from('configurations')
      .select(col)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (error) {
      if (/could not find/i.test(error.message)) return 0;
      throw new Error(error.message);
    }
    const cfg = (data as Record<string, unknown> | null)?.[col] as
      | { internalCurrentNumber?: number | string; currentNumber?: number | string }
      | null
      | undefined;
    if (!cfg) return 0;
    const current = Number(cfg.currentNumber ?? 0) || 0;
    if (current > 0) return current;
    // Only fall back to internalCurrentNumber when currentNumber is absent.
    return Number(cfg.internalCurrentNumber ?? 0) || 0;
  } catch (err) {
    console.warn(`[voucher] fetchServerConfigurationsCurrentNumber(${docType}) failed:`, err);
    return 0;
  }
}

/**
 * Highest voucher number actually present on the server's bill table for
 * this series. Filtered by prefix so sales-gst (INV) and sales-non-gst (NG)
 * — which share `sales_bill` — don't pollute each other.
 *
 * Uses lexicographic DESC ordering, which equals numeric DESC for the
 * zero-padded fixed-width numbers this app produces ("INV000123-2026").
 */
async function fetchServerMaxBillNumber(
  orgId: string,
  docType: VoucherDocumentType,
  prefix: string
): Promise<number> {
  const meta = BILL_TABLE_BY_DOCTYPE[docType];
  if (!meta || !prefix) return 0;
  const col = meta.serverNumberCol;
  try {
    const { data, error } = await supabase
      .from(meta.table)
      .select(col)
      .eq('organization_id', orgId)
      .ilike(col, `${prefix}%`)
      .order(col, { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      // Table or column missing on server: skip — local + assignment ledger
      // are still usable signal.
      if (/could not find|does not exist/i.test(error.message)) return 0;
      throw new Error(error.message);
    }
    if (!data) return 0;
    const raw = (data as unknown as Record<string, unknown>)[col];
    return extractNumberFromDocument(typeof raw === 'string' ? raw : '', prefix);
  } catch (err) {
    console.warn(`[voucher] fetchServerMaxBillNumber(${docType}) failed:`, err);
    return 0;
  }
}

/**
 * Highest number committed via commit_voucher_batch for this series/fy.
 * voucher_number_assignment is the per-bill ledger written by the RPC; it
 * captures assignments that have been finalised even if the corresponding
 * sales_bill row hasn't propagated to readable storage yet. Returns 0 if the
 * table doesn't exist (commit_voucher_batch.sql not yet deployed).
 */
async function fetchServerMaxAssignedNumber(
  orgId: string,
  docType: VoucherDocumentType,
  fy: string
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('voucher_number_assignment')
      .select('assigned_number')
      .eq('organization_id', orgId)
      .eq('document_type', docType)
      .eq('fy', fy)
      .order('assigned_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      // Table missing — RPC SQL not deployed. Fine; we still have bill-table max.
      if (/could not find|relation .* does not exist/i.test(error.message)) return 0;
      throw new Error(error.message);
    }
    return Number((data as { assigned_number?: number } | null)?.assigned_number ?? 0) || 0;
  } catch (err) {
    console.warn(`[voucher] fetchServerMaxAssignedNumber(${docType}) failed:`, err);
    return 0;
  }
}

/**
 * Combined server-side "next number to issue" for a series, taking the
 * highest of every source so the cursor is monotonic and never collides:
 *
 *   - configurations.<cfg>.currentNumber  — already represents "next" (no +1)
 *   - MAX(invoice_number) on the bill table — last issued, so + 1
 *   - MAX(assigned_number) on voucher_number_assignment — last assigned, + 1
 *
 * Different semantics between the three: the legacy `currentNumber` field
 * already points at the NEXT number (production's UI reads it directly),
 * whereas the table MAXes point at the LAST taken number. Mixing them up
 * with a uniform `+1` was the off-by-one that pushed the offline cursor
 * past production by 1 (for the active series) or by 100 (for series the
 * chunk allocator inflated).
 */
async function fetchServerNextNumber(
  orgId: string,
  docType: VoucherDocumentType,
  fy: string,
  prefix: string
): Promise<number> {
  const [bill, assigned, cfgCurrent] = await Promise.all([
    fetchServerMaxBillNumber(orgId, docType, prefix),
    fetchServerMaxAssignedNumber(orgId, docType, fy),
    fetchServerConfigurationsCurrentNumber(orgId, docType),
  ]);
  return Math.max(cfgCurrent, bill + 1, assigned + 1);
}

// ── State row management ──────────────────────────────────────────────────

function seriesId(orgId: string, docType: string, fy: string): string {
  return `${orgId}-${docType}-${fy}`;
}

async function loadState(
  orgId: string,
  docType: VoucherDocumentType,
  fy: string
): Promise<VoucherSeriesState | null> {
  const rows = await db.select<VoucherSeriesState>(
    `SELECT * FROM voucher_series_state
      WHERE organization_id = ? AND document_type = ? AND fy = ?
      LIMIT 1`,
    [orgId, docType, fy]
  );
  return rows[0] ?? null;
}

async function upsertState(s: VoucherSeriesState): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO voucher_series_state
       (id, organization_id, document_type, fy,
        last_known_server_number, local_next_number, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [s.id, s.organization_id, s.document_type, s.fy,
     s.last_known_server_number, s.local_next_number, s.last_synced_at]
  );
}

/**
 * Ensure a state row exists for (org, docType, fy). On first call for a series
 * this requires internet so we can seed `local_next_number` from the server's
 * actual counter — otherwise two fresh-install devices would each start at 1
 * and immediately collide on first sync.
 */
async function ensureState(
  orgId: string,
  docType: VoucherDocumentType,
  fy: string,
  fmt: ConfigFormatting
): Promise<VoucherSeriesState> {
  const existing = await loadState(orgId, docType, fy);
  if (existing) return existing;

  if (!isOnline()) {
    throw new Error(
      `No local voucher cursor for "${docType}" yet. ` +
      `Please connect to the internet once so the first number can be seeded from the server.`
    );
  }

  const serverNext = await fetchServerNextNumber(orgId, docType, fy, fmt.prefix);
  const nextNumber = Math.max(fmt.startingNumber, serverNext);

  const fresh: VoucherSeriesState = {
    id: seriesId(orgId, docType, fy),
    organization_id: orgId,
    document_type: docType,
    fy,
    last_known_server_number: serverNext > 0 ? serverNext - 1 : 0,
    local_next_number: nextNumber,
    last_synced_at: Date.now(),
  };
  await upsertState(fresh);
  return fresh;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function reserveVoucherNumber(
  docType: VoucherDocumentType,
  user: RegisteredPharmacy,
  isPreview: boolean = false
): Promise<VoucherReservationResult> {
  const fy = computeFiscalYear();
  const fmt = await readConfigFormatting(docType, user.organization_id);

  const state = await ensureState(user.organization_id, docType, fy, fmt);
  const usedNumber = state.local_next_number;

  if (usedNumber > MAX_VOUCHER_NUMBER) {
    throw new Error('Voucher number out of safe range — please contact support.');
  }

  const documentNumber = format(fmt, usedNumber, fy);

  if (isPreview) {
    return {
      documentNumber,
      usedNumber,
      nextNumber: usedNumber + 1,
      remainingCount: null,
    };
  }

  await upsertState({
    ...state,
    local_next_number: usedNumber + 1,
    last_synced_at: Date.now(),
  });

  return {
    documentNumber,
    usedNumber,
    nextNumber: usedNumber + 1,
    remainingCount: null,
  };
}

/**
 * Cancel a voucher number. If the cancelled number is the most recent one we
 * handed out, rewind the cursor so the next bill reuses it. Otherwise the
 * cancellation just leaves a gap in the sequence — same semantics as before.
 *
 * The server-side audit log is best-effort when online.
 */
export async function markVoucherCancelled(
  docType: VoucherDocumentType,
  user: RegisteredPharmacy,
  documentNumber: string,
  referenceId?: string
): Promise<void> {
  const fy = computeFiscalYear();
  const fmt = await readConfigFormatting(docType, user.organization_id);
  const state = await loadState(user.organization_id, docType, fy);

  if (state && state.local_next_number > 1) {
    const lastIssued = state.local_next_number - 1;
    const lastIssuedFormatted = format(fmt, lastIssued, fy);
    if (lastIssuedFormatted === documentNumber) {
      await upsertState({
        ...state,
        local_next_number: lastIssued,
        last_synced_at: Date.now(),
      });
    }
  }

  if (isOnline()) {
    try {
      await supabase.rpc('log_voucher_number_event', {
        p_organization_id: user.organization_id,
        p_document_type: docType,
        p_event_type: 'cancelled',
        p_document_number: documentNumber,
        p_reference_id: referenceId ?? null,
      });
    } catch (err) {
      console.warn('[voucher] cancel audit log failed (non-fatal):', err);
    }
  }
}

/**
 * Drop every voucher_series_state row for this org. The next call to
 * `reserveVoucherNumber` or `warmupVoucherSeries` will re-seed each cursor
 * from scratch using the bill-table and assignment-ledger MAXes — the
 * correct floor under the cursor model.
 *
 * Use when the cursor has been left in an inflated state by a past bug
 * (e.g. legacy chunk-reservation ghosts pushed it above the real bill max,
 * and warmup's "only-bump-up" rule won't shrink it). Safe to call any time
 * the active user is online; offline use risks re-seeding from local data
 * only and missing recent server activity.
 *
 * Exposed via window.__mdxera.resetVoucherCursors() for DevTools use.
 */
export async function resetVoucherCursors(orgId: string): Promise<void> {
  await db.execute(
    `DELETE FROM voucher_series_state WHERE organization_id = ?`,
    [orgId]
  );
  console.info('[voucher] resetVoucherCursors: dropped all cursors for org', orgId);
}

/**
 * Wipe the local cursor cache for this device. Next reservation will re-seed
 * from the server (requires internet).
 */
export async function clearVoucherReservations(): Promise<void> {
  await db.execute(`DELETE FROM voucher_series_state`);
  // Legacy reservation table — clear too so stale ranges can't shadow a future
  // re-introduction. Harmless if the table is already empty.
  try {
    await db.execute(`DELETE FROM voucher_reservations`);
  } catch {
    // Table may not exist on very old installs; ignore.
  }
  console.info('[voucher] cleared voucher_series_state (and legacy voucher_reservations)');
}

/**
 * Snap every local cursor forward to the server's current counter. Call this
 * after each sync cycle and whenever the network comes back online — the
 * cursor needs to stay glued to the server even if the boot-time warmup ran
 * while the device was offline.
 *
 * Behaviour: if `local_next_number <= server_current`, bump it to
 * `server_current + 1`. If `local_next_number > server_current`, leave it —
 * that means we have pending offline bills whose numbers we want to keep
 * proposing on the next sync.
 *
 * The internal `_perform` does the work; `warmupVoucherSeries(orgId)` is the
 * new external entry point that doesn't require a full user object — used by
 * SyncEngine which only knows the orgId. `warmupVoucherRanges(user)` is kept
 * as a thin wrapper so the existing AuthProvider/SyncBootstrap callers
 * continue to compile.
 */
async function _performWarmup(orgId: string): Promise<void> {
  const online = isOnline();
  const fy = computeFiscalYear();

  for (const docType of DOC_TYPES) {
    try {
      const fmt = await readConfigFormatting(docType, orgId);
      // Cursor floor = the highest "next number" any source thinks should be
      // issued. configurations.<cfg>.currentNumber is already a "next" value
      // (production's UI displays it as-is); bill-table and assignment-ledger
      // MAXes are "last taken" so they need +1.
      const serverNext = online ? await fetchServerNextNumber(orgId, docType, fy, fmt.prefix) : 0;
      const localMaxFromBills = await fetchLocalMaxBillNumber(orgId, docType, fmt.prefix);
      const existing = await loadState(orgId, docType, fy);

      const flooredNext = Math.max(
        fmt.startingNumber,
        serverNext,
        localMaxFromBills + 1,
      );

      if (!existing) {
        await upsertState({
          id: seriesId(orgId, docType, fy),
          organization_id: orgId,
          document_type: docType,
          fy,
          last_known_server_number: serverNext > 0 ? serverNext - 1 : 0,
          local_next_number: flooredNext,
          last_synced_at: Date.now(),
        });
        console.info(
          `[voucher] warmup: seeded ${docType} cursor at ${flooredNext} ` +
          `(serverNext=${serverNext}, localMaxBill=${localMaxFromBills})`
        );
        continue;
      }

      const bumpedNext = Math.max(existing.local_next_number, flooredNext);
      if (bumpedNext !== existing.local_next_number) {
        console.info(
          `[voucher] warmup: ${docType} cursor bumped ` +
          `${existing.local_next_number} → ${bumpedNext} ` +
          `(serverNext=${serverNext}, localMaxBill=${localMaxFromBills})`
        );
      }
      await upsertState({
        ...existing,
        last_known_server_number: Math.max(
          existing.last_known_server_number,
          serverNext > 0 ? serverNext - 1 : 0
        ),
        local_next_number: bumpedNext,
        last_synced_at: Date.now(),
      });
    } catch (err) {
      console.warn(`[voucher] warmup failed for ${docType}:`, err);
    }
  }
}

/** Refresh every cursor against the server. Preferred entry point. */
export async function warmupVoucherSeries(orgId: string): Promise<void> {
  return _performWarmup(orgId);
}

/** Legacy entry point kept for AuthProvider/SyncBootstrap; delegates. */
export async function warmupVoucherRanges(user: RegisteredPharmacy): Promise<void> {
  return _performWarmup(user.organization_id);
}

/**
 * Diagnostic — returns, for every voucher series, what the local cursor
 * thinks vs. what the server has. Used from DevTools when the displayed
 * "Next Sequence No" drifts from the server.
 *
 *     await window.__mdxera.diagnoseVoucherSeries()
 *
 * The returned array is also console.table-friendly.
 */
export interface VoucherSeriesDiagnostic {
  documentType: VoucherDocumentType;
  fy: string;
  online: boolean;
  localNextNumber: number | null;
  lastKnownServerNumber: number | null;
  /** configurations.<cfg>.currentNumber / internalCurrentNumber (legacy counter). */
  serverConfigurationsCurrent: number | null;
  /** MAX of the server's actual bill-table number column (parsed). */
  serverMaxFromBills: number | null;
  /** MAX from voucher_number_assignment (per-bill commit ledger). */
  serverMaxFromAssignments: number | null;
  localMaxFromBills: number | null;
  localBillCount: number | null;
  localPendingPushCount: number | null;
  bumpedNextWouldBe: number | null;
  error: string | null;
}

/**
 * For a docType, count rows in the local bill table that match its prefix.
 * Used by diagnoseVoucherSeries to surface whether a cursor gap reflects
 * real local bills or a phantom counter value.
 */
async function countLocalBillsFor(
  orgId: string,
  docType: VoucherDocumentType,
  prefix: string
): Promise<{ total: number; pending: number }> {
  const meta = BILL_TABLE_BY_DOCTYPE[docType];
  if (!meta) return { total: 0, pending: 0 };
  const col = meta.localNumberCol;
  try {
    const totalRows = await db.select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${meta.table}
        WHERE organization_id = ? AND ${col} LIKE ?`,
      [orgId, `${prefix}%`]
    );
    const pendingRows = await db.select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM _sync_queue
        WHERE organization_id = ? AND table_name = ? AND status != 'done'`,
      [orgId, meta.table]
    );
    return {
      total: totalRows[0]?.n ?? 0,
      pending: pendingRows[0]?.n ?? 0,
    };
  } catch (err) {
    console.debug(`[voucher] countLocalBillsFor(${docType}) skipped:`, (err as Error)?.message);
    return { total: 0, pending: 0 };
  }
}

export async function diagnoseVoucherSeries(orgId: string): Promise<VoucherSeriesDiagnostic[]> {
  const fy = computeFiscalYear();
  const online = isOnline();
  const results: VoucherSeriesDiagnostic[] = [];

  for (const docType of DOC_TYPES) {
    const row: VoucherSeriesDiagnostic = {
      documentType: docType,
      fy,
      online,
      localNextNumber: null,
      lastKnownServerNumber: null,
      serverConfigurationsCurrent: null,
      serverMaxFromBills: null,
      serverMaxFromAssignments: null,
      localMaxFromBills: null,
      localBillCount: null,
      localPendingPushCount: null,
      bumpedNextWouldBe: null,
      error: null,
    };
    try {
      const fmt = await readConfigFormatting(docType, orgId);
      const existing = await loadState(orgId, docType, fy);
      row.localNextNumber = existing?.local_next_number ?? null;
      row.lastKnownServerNumber = existing?.last_known_server_number ?? null;
      row.localMaxFromBills = await fetchLocalMaxBillNumber(orgId, docType, fmt.prefix);
      const counts = await countLocalBillsFor(orgId, docType, fmt.prefix);
      row.localBillCount = counts.total;
      row.localPendingPushCount = counts.pending;

      if (online) {
        try {
          row.serverConfigurationsCurrent = await fetchServerConfigurationsCurrentNumber(orgId, docType);
        } catch (err) {
          row.error = `server-config-fetch failed: ${(err as Error)?.message ?? String(err)}`;
        }
        try {
          row.serverMaxFromBills = await fetchServerMaxBillNumber(orgId, docType, fmt.prefix);
        } catch (err) {
          row.error = (row.error ? row.error + '; ' : '') +
            `server-bill-fetch failed: ${(err as Error)?.message ?? String(err)}`;
        }
        try {
          row.serverMaxFromAssignments = await fetchServerMaxAssignedNumber(orgId, docType, fy);
        } catch (err) {
          row.error = (row.error ? row.error + '; ' : '') +
            `server-assign-fetch failed: ${(err as Error)?.message ?? String(err)}`;
        }
      }

      row.bumpedNextWouldBe = Math.max(
        fmt.startingNumber,
        // configurations.currentNumber is already a "next" value — no +1.
        row.serverConfigurationsCurrent ?? 0,
        (row.serverMaxFromBills ?? 0) + 1,
        (row.serverMaxFromAssignments ?? 0) + 1,
        (row.localMaxFromBills ?? 0) + 1,
      );
    } catch (err) {
      row.error = (err as Error)?.message ?? String(err);
    }
    results.push(row);
  }

  console.table(results);
  // Some browsers (Safari) collapse the console.table view and don't render
  // array fields when they're held inside a Promise's `.then(d => …)` chain.
  // Also dump the pretty-JSON so the diagnostic is visible no matter how
  // the function is invoked.
  console.log('[voucher] diagnoseVoucherSeries =\n' + JSON.stringify(results, null, 2));
  return results;
}

/**
 * Status snapshot for the StatusBar UI. Retains the legacy name
 * `getVoucherPoolStatus`. The `remaining` column is null under the cursor
 * model (open-ended); UI should fall back to showing nextNumber instead.
 */
export async function getVoucherPoolStatus(orgId: string): Promise<Array<{
  documentType: string;
  remaining: number | null;
  rangeEnd: number | null;
  fy: string;
  nextNumber: number;
  lastKnownServerNumber: number;
}>> {
  const fy = computeFiscalYear();
  const rows = await db.select<VoucherSeriesState>(
    `SELECT * FROM voucher_series_state
      WHERE organization_id = ? AND fy = ?`,
    [orgId, fy]
  );
  return rows.map((r) => ({
    documentType: r.document_type,
    remaining: null,
    rangeEnd: null,
    fy: r.fy,
    nextNumber: r.local_next_number,
    lastKnownServerNumber: r.last_known_server_number,
  }));
}

// ── Sync-side helpers (used by SyncWorker) ────────────────────────────────

/**
 * Apply a renumber mapping returned by commit_voucher_batch to the local
 * mirror. Called by SyncWorker after the RPC returns. Updates:
 *   - the bill row's number column (table-specific)
 *   - soft-copy reference columns on sales_returns / purchase_returns
 *   - narration column on journal_entry_header / journal_entry_lines
 *
 * If the renumber pushes our cursor past the prior `local_next_number`, we
 * also advance the cursor — because future bills must continue from past the
 * tail we just consumed.
 */
export interface RenumberMappingRow {
  local_uuid: string;
  assigned_number: number;
  was_renumbered: boolean;
  final_document_number: string;
}

const NUMBER_COLUMN_BY_TABLE: Record<string, string> = {
  sales_bill:        'invoice_number',
  purchases:         'purchase_serial_id',
  purchase_orders:   'po_serial_id',
  sales_challans:    'challan_serial_id',
  delivery_challans: 'challan_serial_id',
  physical_inventory:'voucher_no',
};

const DOC_TYPE_BY_TABLE: Record<string, VoucherDocumentType> = {
  sales_bill:        'sales-gst',
  purchases:         'purchase-entry',
  purchase_orders:   'purchase-order',
  sales_challans:    'sales-challan',
  delivery_challans: 'delivery-challan',
  physical_inventory:'physical-inventory',
};

/**
 * Return the voucher number column for a given bill table, or null if the
 * table is not voucher-numbered.
 */
export function numberColumnForTable(tableName: string): string | null {
  return NUMBER_COLUMN_BY_TABLE[tableName] ?? null;
}

/**
 * Return the document type for a given bill table, or null if not voucher-
 * numbered.
 */
export function docTypeForTable(tableName: string): VoucherDocumentType | null {
  return DOC_TYPE_BY_TABLE[tableName] ?? null;
}

/**
 * Rewrite local rows + soft-copy references following a server-driven
 * renumber. Idempotent: a row already at the assigned number is a no-op.
 */
export async function applyRenumberMappingLocally(
  tableName: string,
  orgId: string,
  mapping: RenumberMappingRow[]
): Promise<{ renumberedCount: number; renumbered: Array<{ uuid: string; newNumber: string }> }> {
  const numberCol = NUMBER_COLUMN_BY_TABLE[tableName];
  if (!numberCol) return { renumberedCount: 0, renumbered: [] };

  let renumberedCount = 0;
  const renumbered: Array<{ uuid: string; newNumber: string }> = [];

  for (const row of mapping) {
    if (!row.was_renumbered) continue;
    renumberedCount += 1;
    renumbered.push({ uuid: row.local_uuid, newNumber: row.final_document_number });

    // 1. The bill row itself.
    await db.execute(
      `UPDATE ${tableName} SET ${numberCol} = ? WHERE id = ?`,
      [row.final_document_number, row.local_uuid]
    );

    // 2. Soft-copy reference columns. These are string mirrors of the printed
    //    number used by returns flows for orphan lookup; FKs themselves point
    //    at the UUID and don't need touching.
    if (tableName === 'sales_bill') {
      await db.execute(
        `UPDATE sales_returns SET original_invoice_number = ?
          WHERE original_invoice_id = ? AND organization_id = ?`,
        [row.final_document_number, row.local_uuid, orgId]
      );
    } else if (tableName === 'purchases') {
      await db.execute(
        `UPDATE purchase_returns SET original_invoice_number = ?
          WHERE original_invoice_id = ? AND organization_id = ?`,
        [row.final_document_number, row.local_uuid, orgId]
      );
    }

    // 3. Journal entries — narration field only.
    const docType = DOC_TYPE_BY_TABLE[tableName];
    if (docType) {
      await db.execute(
        `UPDATE journal_entry_header SET document_reference = ?
          WHERE reference_document_id = ? AND document_type = ?`,
        [row.final_document_number, row.local_uuid, docType]
      );
      await db.execute(
        `UPDATE journal_entry_lines SET document_reference = ?
          WHERE reference_document_id = ? AND document_type = ?`,
        [row.final_document_number, row.local_uuid, docType]
      );
    }
  }

  // Advance the local cursor past the highest assigned number, so subsequent
  // local reservations don't propose numbers the server has already issued.
  if (mapping.length > 0) {
    const docType = DOC_TYPE_BY_TABLE[tableName];
    if (docType) {
      const fy = computeFiscalYear();
      const state = await loadState(orgId, docType, fy);
      const maxAssigned = mapping.reduce((m, r) => Math.max(m, r.assigned_number), 0);
      if (state && maxAssigned >= state.local_next_number) {
        await upsertState({
          ...state,
          last_known_server_number: Math.max(state.last_known_server_number, maxAssigned),
          local_next_number: maxAssigned + 1,
          last_synced_at: Date.now(),
        });
      }
    }
  }

  return { renumberedCount, renumbered };
}
