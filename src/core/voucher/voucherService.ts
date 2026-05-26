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

function computeFiscalYear(now = new Date()): string {
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const start = month >= 4 ? year : year - 1;
  const end = (start + 1) % 100;
  return `${start}-${end.toString().padStart(2, '0')}`;
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

// ── Server cursor probe ───────────────────────────────────────────────────

/**
 * Read the server's running counter for a series. We deliberately query the
 * `configurations` row directly rather than calling a dedicated RPC: the
 * legacy app already writes both `internalCurrentNumber` and `currentNumber`
 * into the same JSONB blob, and the rest of the codebase pulls the same row.
 *
 * `internalCurrentNumber` is the source of truth (advanced atomically by
 * commit_voucher_batch and the legacy reserve_voucher_range function);
 * `currentNumber` is its display-formatted twin. We take MAX of the two so
 * we never hand out a number already known to exist anywhere.
 */
async function fetchServerCurrentNumber(
  orgId: string,
  docType: VoucherDocumentType
): Promise<number> {
  const col = configColumn(docType);
  const { data, error } = await supabase
    .from('configurations')
    .select(col)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const cfg = (data as Record<string, unknown> | null)?.[col] as
    | { internalCurrentNumber?: number | string; currentNumber?: number | string }
    | null
    | undefined;
  if (!cfg) return 0;
  const a = Number(cfg.internalCurrentNumber ?? 0) || 0;
  const b = Number(cfg.currentNumber ?? 0) || 0;
  return Math.max(a, b);
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

  const serverCurrent = await fetchServerCurrentNumber(orgId, docType);
  const startFrom = Math.max(serverCurrent, fmt.startingNumber - 1);

  const fresh: VoucherSeriesState = {
    id: seriesId(orgId, docType, fy),
    organization_id: orgId,
    document_type: docType,
    fy,
    last_known_server_number: serverCurrent,
    local_next_number: startFrom + 1,
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
 * from AuthProvider on online login so a device that has been idle picks up
 * any numbers issued elsewhere before handing out its first bill.
 *
 * Behaviour: if `local_next_number <= server_current`, bump it to
 * `server_current + 1`. If `local_next_number > server_current`, leave it —
 * that means we have pending offline bills whose numbers we want to keep
 * proposing on the next sync.
 *
 * Retains the legacy name `warmupVoucherRanges` for caller compatibility.
 */
export async function warmupVoucherRanges(user: RegisteredPharmacy): Promise<void> {
  if (!isOnline()) return;
  const fy = computeFiscalYear();

  for (const docType of DOC_TYPES) {
    try {
      const fmt = await readConfigFormatting(docType, user.organization_id);
      const serverCurrent = await fetchServerCurrentNumber(user.organization_id, docType);
      const existing = await loadState(user.organization_id, docType, fy);

      if (!existing) {
        // First time we've seen this series on this device — seed it.
        const startFrom = Math.max(serverCurrent, fmt.startingNumber - 1);
        await upsertState({
          id: seriesId(user.organization_id, docType, fy),
          organization_id: user.organization_id,
          document_type: docType,
          fy,
          last_known_server_number: serverCurrent,
          local_next_number: startFrom + 1,
          last_synced_at: Date.now(),
        });
        continue;
      }

      const bumpedNext = Math.max(existing.local_next_number, serverCurrent + 1);
      await upsertState({
        ...existing,
        last_known_server_number: serverCurrent,
        local_next_number: bumpedNext,
        last_synced_at: Date.now(),
      });
    } catch (err) {
      console.warn(`[voucher] warmup failed for ${docType}:`, err);
    }
  }
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
