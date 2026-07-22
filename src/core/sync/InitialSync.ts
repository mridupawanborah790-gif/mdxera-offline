/**
 * Initial bulk download from Supabase → SQLite for first-time device setup
 * against an existing production database.
 *
 * Two-phase model:
 *   PHASE A (foreground): masters that the app cannot operate without
 *     - blocks the UI with a progress modal
 *     - typically ~30 seconds to 2 minutes for a normal pharmacy
 *
 *   PHASE B (background): transactional history
 *     - app is usable while this runs
 *     - shows a small badge in the StatusBar
 *     - typically 5–30 minutes depending on volume
 *
 * Key guarantees:
 *   - Paginated (1000 rows/batch via Supabase .range())
 *   - Resumable from any crash/disconnect (uses _initial_sync_state)
 *   - Auto-retry with exponential backoff (30s → 2min → 10min)
 *   - Forward-compatible with schema mismatches (columnFilter)
 *   - Per-table progress events for UI subscription
 */
import { supabase } from '@core/db/supabaseClient';
import { db } from '@core/db/client';
import { TABLE } from '@core/db/schema';
import { bulkInsertAdapted, adaptRowsForSqlite } from './columnFilter';
import { isOnline, checkConnectivity } from './networkMonitor';
import type { RegisteredPharmacy } from '@core/types';

// ── Configuration ──────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;
const BACKOFF_DELAYS_MS = [30_000, 120_000, 600_000]; // 30s, 2min, 10min
const MAX_RETRIES = 3;

/** Tables that block the UI (masters) — must be present before the app is usable. */
const FOREGROUND_TABLES: string[] = [
  TABLE.PROFILES,
  TABLE.CONFIGURATIONS,
  TABLE.BUSINESS_ROLES,
  TABLE.TEAM_MEMBERS,
  TABLE.COMPANY_CODES,
  TABLE.SET_OF_BOOKS,
  TABLE.GL_MASTER,
  TABLE.GL_ASSIGNMENTS,
  TABLE.CATEGORIES,
  TABLE.SUB_CATEGORIES,
  TABLE.MATERIAL_MASTER,
  TABLE.INVENTORY,
  TABLE.CUSTOMERS,
  TABLE.SUPPLIERS,
  TABLE.DISTRIBUTORS,
  TABLE.DOCTOR_MASTER,
  TABLE.SUPPLIER_PRODUCT_MAP,
  TABLE.CUSTOMER_PRICE_LIST,
  TABLE.MATERIAL_PRICE_LIST,
  TABLE.MBC_CARD_TYPES,
  TABLE.MBC_CARD_TEMPLATES,
  // Moved from background to block UI until all history is present:
  TABLE.PURCHASES,
  TABLE.PURCHASE_ORDERS,
  TABLE.SALES_BILL,
  TABLE.SALES_CHALLANS,
  TABLE.DELIVERY_CHALLANS,
  TABLE.SALES_RETURNS,
  TABLE.PURCHASE_RETURNS,
  TABLE.JOURNAL_ENTRY_HEADER,
  TABLE.JOURNAL_ENTRY_LINES,
  TABLE.PROMOTIONS,
  TABLE.EWAYBILLS,
  TABLE.MBC_CARDS,
  TABLE.MBC_CARD_HISTORY,
  TABLE.MBC_CARD_VALUE_HISTORY,
  TABLE.PHYSICAL_INVENTORY,
  TABLE.MRP_CHANGE_LOG,
];

/** Tables that download in the background (transactions). Currently empty as everything is moved to foreground. */
const BACKGROUND_TABLES: string[] = [];

// ── Types ──────────────────────────────────────────────────────────────────

export type SyncPhase = 'foreground' | 'background';

export interface TableProgress {
  table_name: string;
  phase: SyncPhase;
  total_rows: number | null;
  synced_rows: number;
  is_complete: boolean;
  last_error: string | null;
  retry_count: number;
}

export interface InitialSyncProgress {
  phase: SyncPhase | 'idle' | 'done';
  /** Per-table progress */
  tables: TableProgress[];
  /** 0..1 across the active phase */
  overallProgress: number;
  /** Currently-syncing table name, if any */
  currentTable: string | null;
  /** Error message if the whole sync is stuck */
  fatalError: string | null;
}

type ProgressListener = (progress: InitialSyncProgress) => void;

// ── State ──────────────────────────────────────────────────────────────────

const listeners = new Set<ProgressListener>();
let _currentState: InitialSyncProgress = {
  phase: 'idle',
  tables: [],
  overallProgress: 0,
  currentTable: null,
  fatalError: null,
};
let _running = false;
let _cancelled = false;

// Currently-active organization for state reads/writes. Set by the public
// entry points (runForegroundSync, startBackgroundSync, isForegroundComplete,
// isFullyInitialized, getBackgroundProgress) so internal helpers can scope
// SQL to this org without having to thread it through every call.
let _activeOrgId: string | null = null;
function requireActiveOrg(): string {
  if (!_activeOrgId) {
    throw new Error(
      '[InitialSync] _activeOrgId not set — call isForegroundComplete(orgId), ' +
      'runForegroundSync(user), or startBackgroundSync(user) first.'
    );
  }
  return _activeOrgId;
}

function emit() {
  listeners.forEach((fn) => fn(_currentState));
}

// ── State persistence helpers ──────────────────────────────────────────────

interface StateRowRaw {
  table_name: string;
  phase: SyncPhase;
  total_rows: number | null;
  synced_rows: number;
  is_complete: number;
  last_error: string | null;
  retry_count: number;
}

async function ensureStateRow(tableName: string, phase: SyncPhase): Promise<TableProgress> {
  const orgId = requireActiveOrg();
  const rows = await db.select<StateRowRaw>(
    `SELECT table_name, phase, total_rows, synced_rows, is_complete, last_error, retry_count
     FROM ${TABLE.INITIAL_SYNC_STATE}
     WHERE organization_id = ? AND table_name = ? LIMIT 1`,
    [orgId, tableName]
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      table_name: r.table_name,
      phase: r.phase,
      total_rows: r.total_rows,
      synced_rows: r.synced_rows,
      last_error: r.last_error,
      retry_count: r.retry_count,
      is_complete: r.is_complete === 1,
    };
  }
  
  try {
    await db.execute(
      `INSERT INTO _initial_sync_state (organization_id, table_name, phase, started_at)
       VALUES (?, ?, ?, ?)`,
      [orgId, tableName, phase, Date.now()]
    );
  } catch (err: any) {
    // If a concurrent sync attempt inserted it just now, that's fine. Ignore the unique constraint error.
    if (String(err).includes('UNIQUE constraint failed')) {
      console.warn(`[InitialSync] Concurrent insert for ${tableName}, ignoring unique constraint error.`);
    } else {
      throw err;
    }
  }
  
  return {
    table_name: tableName, phase, total_rows: null, synced_rows: 0,
    is_complete: false, last_error: null, retry_count: 0,
  };
}

async function updateState(tableName: string, patch: Partial<{
  total_rows: number;
  synced_rows: number;
  is_complete: boolean;
  completed_at: number;
  last_error: string | null;
  retry_count: number;
  next_retry_at: number | null;
}>): Promise<void> {
  const orgId = requireActiveOrg();
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    if (k === 'is_complete') vals.push(v ? 1 : 0);
    else vals.push(v ?? null);
  }
  if (sets.length === 0) return;
  vals.push(orgId, tableName);
  await db.execute(
    `UPDATE _initial_sync_state SET ${sets.join(', ')}
      WHERE organization_id = ? AND table_name = ?`,
    vals
  );
}

async function loadAllStates(): Promise<TableProgress[]> {
  const orgId = requireActiveOrg();
  const rows = await db.select<{ table_name: string; phase: string; total_rows: number | null;
    synced_rows: number; is_complete: number; last_error: string | null; retry_count: number }>(
    `SELECT table_name, phase, total_rows, synced_rows, is_complete, last_error, retry_count
     FROM _initial_sync_state
      WHERE organization_id = ?
      ORDER BY table_name ASC`,
    [orgId]
  );
  return rows.map((r) => ({
    table_name: r.table_name,
    phase: r.phase as SyncPhase,
    total_rows: r.total_rows,
    synced_rows: r.synced_rows,
    is_complete: r.is_complete === 1,
    last_error: r.last_error,
    retry_count: r.retry_count,
  }));
}

async function refreshSnapshot(activePhase: SyncPhase | 'idle' | 'done', currentTable: string | null): Promise<void> {
  const tables = await loadAllStates();
  const relevant = tables.filter((t) =>
    activePhase === 'idle' || activePhase === 'done' ? true : t.phase === activePhase
  );
  const totalProgress = relevant.reduce((sum, t) => {
    if (t.is_complete) return sum + 1;
    if (t.total_rows && t.total_rows > 0) {
      return sum + Math.min(1, t.synced_rows / t.total_rows);
    }
    return sum;
  }, 0);
  const overall = relevant.length > 0 ? totalProgress / relevant.length : 0;

  _currentState = {
    phase: activePhase,
    tables,
    overallProgress: overall,
    currentTable,
    fatalError: _currentState.fatalError,
  };
  emit();
}

// ── Core sync routine ──────────────────────────────────────────────────────

/**
 * Per-table overrides. Mirror SyncPuller's TABLE_META — InitialSync needs the
 * same knowledge so .order() doesn't reference a non-existent column.
 *   orderCol: column to order paginated fetches by (null = no ordering)
 */
const TABLE_FETCH_META: Record<string, { orderCol?: string | null }> = {
  // Server has neither updated_at nor created_at — pull unordered (small table).
  mbc_card_history:    { orderCol: null },
  // mbc_card_value_history has created_at — order paginated pulls by it.
  mbc_card_value_history: { orderCol: 'created_at' },
  // These have created_at but no updated_at (on most projects).
  delivery_challans:   { orderCol: 'created_at' },
  sales_challans:      { orderCol: 'created_at' },
  physical_inventory:  { orderCol: 'created_at' },
  mrp_change_log:      { orderCol: 'created_at' },
  journal_entry_lines: { orderCol: 'created_at' },
  sales_returns:       { orderCol: 'created_at' },
  purchase_returns:    { orderCol: 'created_at' },
};
const orderColumn = (table: string): string | null => {
  const v = TABLE_FETCH_META[table]?.orderCol;
  return v === undefined ? 'created_at' : v;
};

/** Tables we confirmed don't exist on the server — skip without retries. */
const _missingOnServer = new Set<string>();

/**
 * Tables that exist on Supabase but have NO `organization_id` column.
 * Their rows are scoped by FK (e.g. card_id → mbc_cards.organization_id).
 * We skip the `.eq('organization_id', orgId)` filter for these tables when
 * fetching from Supabase — the full table is small enough to pull entirely.
 * NOTE: mbc_card_value_history was here temporarily; organization_id was added
 * to that table's Supabase schema and this workaround is no longer needed.
 */
const NO_ORG_FILTER_TABLES = new Set<string>([
  // empty — all current syncable tables have organization_id on the server
]);

function isSchemaMissingError(message: string): boolean {
  const m = (message || '').toLowerCase();
  return (
    m.includes('could not find the table') ||
    m.includes('could not find the column') ||
    m.includes('does not exist') ||
    m.includes('schema cache')
  );
}

async function fetchTotalCount(tableName: string, orgId: string): Promise<number> {
  // Some Supabase projects 400 on `select('id', { count: 'exact', head: true })`
  // for tables that have schema quirks (delivery_challans etc.). Try a series
  // of fallbacks instead of hard-failing the whole sync for the table.
  const noOrg = NO_ORG_FILTER_TABLES.has(tableName);
  const attempts: Array<() => ReturnType<typeof supabase.from>['select']> = noOrg
    ? [
        () => supabase.from(tableName).select('*', { count: 'exact',     head: true }) as any,
        () => supabase.from(tableName).select('*', { count: 'estimated', head: true }) as any,
      ]
    : [
        () => supabase.from(tableName).select('*',               { count: 'exact',     head: true }).eq('organization_id', orgId) as any,
        () => supabase.from(tableName).select('organization_id', { count: 'exact',     head: true }).eq('organization_id', orgId) as any,
        () => supabase.from(tableName).select('*',               { count: 'estimated', head: true }).eq('organization_id', orgId) as any,
      ];

  let lastError = '';
  for (const make of attempts) {
    try {
      const { count, error } = await make() as unknown as { count: number | null; error: { message?: string } | null };
      if (!error) return count ?? 0;
      lastError = error.message ?? '';
    } catch (err) {
      lastError = (err as Error)?.message ?? String(err);
    }
  }

  // All count attempts failed. Return Infinity so the page-pull loop runs
  // until it sees a short page (the standard pagination terminator). The
  // table will still sync; we just won't show an accurate ETA.
  console.warn(`[InitialSync] count(${tableName}) failed (${lastError}) — pulling without progress estimate`);
  return Number.MAX_SAFE_INTEGER;
}

async function fetchPage(
  tableName: string,
  orgId: string,
  from: number,
  to: number
): Promise<Record<string, unknown>[]> {
  let query = supabase
    .from(tableName)
    .select('*');

  // Tables without an organization_id column are pulled in full (they are
  // small and scoped by FK to a card that already belongs to this org).
  if (!NO_ORG_FILTER_TABLES.has(tableName)) {
    query = query.eq('organization_id', orgId) as typeof query;
  }

  const orderCol = orderColumn(tableName);
  if (orderCol) {
    query = query.order(orderCol, { ascending: true, nullsFirst: true });
    // Add deterministic tie-breaker to prevent pagination data loss
    const pk = tableName === 'profiles' ? 'user_id' : 'id';
    query = query.order(pk, { ascending: true });
  }

  const { data, error } = await query.range(from, to);
  if (error) throw new Error(`fetch(${tableName} ${from}-${to}): ${error.message}`);
  return data ?? [];
}

async function syncOneTable(
  tableName: string,
  phase: SyncPhase,
  orgId: string
): Promise<void> {
  if (_cancelled) return;

  const state = await ensureStateRow(tableName, phase);
  if (state.is_complete) return; // already done

  _currentState = { ..._currentState, currentTable: tableName };
  emit();

  // Determine total
  let total = state.total_rows;
  if (total === null) {
    total = await fetchTotalCount(tableName, orgId);
    await updateState(tableName, { total_rows: total });
  }

  // Resume from where we left off
  let offset = state.synced_rows;

  while (offset < total) {
    if (_cancelled) return;

    // Re-check connectivity before each batch
    if (!isOnline()) {
      await updateState(tableName, { last_error: 'Network offline', next_retry_at: Date.now() + BACKOFF_DELAYS_MS[0] });
      throw new Error(`Network offline mid-sync on ${tableName}`);
    }

    const to = Math.min(offset + PAGE_SIZE - 1, total - 1);
    const page = await fetchPage(tableName, orgId, offset, to);

    if (page.length === 0) {
      // Server claims more rows exist but returned none — treat as done
      break;
    }

    // Adapt + bulk insert
    const adapted = await adaptRowsForSqlite(tableName, page);
    if (adapted.length > 0) {
      await bulkInsertAdapted(tableName, adapted);
    }

    offset += page.length;
    await updateState(tableName, { synced_rows: offset, last_error: null });

    // Update the sync_meta so future delta-pulls work
    await db.execute(
      `INSERT OR REPLACE INTO ${TABLE.SYNC_META}
         (organization_id, table_name, last_pulled_at) VALUES (?, ?, ?)`,
      [orgId, tableName, Date.now()]
    );

    await refreshSnapshot(phase, tableName);

    // If we got fewer than expected, we're done
    if (page.length < PAGE_SIZE) break;
  }

  await updateState(tableName, { is_complete: true, completed_at: Date.now(), last_error: null });
}

async function syncTableWithRetry(
  tableName: string,
  phase: SyncPhase,
  orgId: string
): Promise<void> {
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      await syncOneTable(tableName, phase, orgId);
      return;
    } catch (err) {
      attempt += 1;
      const msg = err instanceof Error ? err.message : String(err);
      await updateState(tableName, { last_error: msg, retry_count: attempt });
      console.warn(`[InitialSync] ${tableName} attempt ${attempt}/${MAX_RETRIES} failed:`, msg);

      if (attempt > MAX_RETRIES) throw err;

      const delay = BACKOFF_DELAYS_MS[Math.min(attempt - 1, BACKOFF_DELAYS_MS.length - 1)];
      await updateState(tableName, { next_retry_at: Date.now() + delay });
      await refreshSnapshot(phase, tableName);
      await sleep(delay);
      await updateState(tableName, { next_retry_at: null });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Phase runners ──────────────────────────────────────────────────────────

async function runPhase(tables: string[], phase: SyncPhase, orgId: string): Promise<void> {
  for (const tableName of tables) {
    if (_cancelled) break;
    await syncTableWithRetry(tableName, phase, orgId);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Subscribe to progress updates. */
export function onInitialSyncProgress(fn: ProgressListener): () => void {
  listeners.add(fn);
  fn(_currentState); // immediate snapshot
  return () => listeners.delete(fn);
}

/** Current snapshot (sync use). */
export function getInitialSyncSnapshot(): InitialSyncProgress {
  return _currentState;
}

/** Has the foreground phase been completed at least once on this device for this org? */
export async function isForegroundComplete(orgId: string): Promise<boolean> {
  _activeOrgId = orgId;
  try {
    const rows = await db.select<{ n: number }>(
      `SELECT COUNT(*) as n FROM _initial_sync_state
       WHERE organization_id = ? AND phase = 'foreground' AND is_complete = 1`,
      [orgId]
    );
    return (rows[0]?.n ?? 0) >= FOREGROUND_TABLES.length;
  } catch {
    return false;
  }
}

/** Has the full initial sync (both phases) been completed for this org? */
export async function isFullyInitialized(orgId: string): Promise<boolean> {
  _activeOrgId = orgId;
  try {
    const rows = await db.select<{ n: number }>(
      `SELECT COUNT(*) as n FROM _initial_sync_state
        WHERE organization_id = ? AND is_complete = 1`,
      [orgId]
    );
    return (rows[0]?.n ?? 0) >= (FOREGROUND_TABLES.length + BACKGROUND_TABLES.length);
  } catch {
    return false;
  }
}

/**
 * Run the foreground phase (masters). Throws on fatal failure.
 * Safe to call repeatedly — already-complete tables are skipped.
 */
export async function runForegroundSync(user: RegisteredPharmacy): Promise<void> {
  // If a previous sync was cancelled but hasn't fully shut down yet, wait for it.
  while (_running) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  _running = true;
  _cancelled = false;
  _activeOrgId = user.organization_id;
  _currentState = { ..._currentState, fatalError: null, phase: 'foreground' };

  try {
    // Verify connectivity first
    const SUPABASE_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL
      ?? 'https://sblmbkgoiefqzykjksgm.supabase.co';
    const reachable = await checkConnectivity(SUPABASE_URL);
    if (!reachable) throw new Error('Cannot reach the server. Please check your internet connection.');

    await refreshSnapshot('foreground', null);
    await runPhase(FOREGROUND_TABLES, 'foreground', user.organization_id);
    await refreshSnapshot('foreground', null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown sync error';
    _currentState = { ..._currentState, fatalError: msg };
    emit();
    throw err;
  } finally {
    _running = false;
  }
}

/**
 * Start the background phase (transactions). Returns immediately;
 * progress is delivered via listeners. Safe to call repeatedly.
 */
export function startBackgroundSync(user: RegisteredPharmacy): void {
  // Background sync is fire-and-forget, but if the engine is already running,
  // we shouldn't start another one.
  if (_running) return;
  _running = true;
  _cancelled = false;
  _activeOrgId = user.organization_id;
  _currentState = { ..._currentState, phase: 'background', fatalError: null };

  // Fire and forget
  (async () => {
    try {
      await refreshSnapshot('background', null);
      await runPhase(BACKGROUND_TABLES, 'background', user.organization_id);
      await refreshSnapshot('done', null);
      _currentState = { ..._currentState, phase: 'done', currentTable: null };
      emit();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Background sync error';
      _currentState = { ..._currentState, fatalError: msg };
      emit();
      console.warn('[InitialSync] background phase failed (will retry on next session):', err);
    } finally {
      _running = false;
    }
  })();
}

/** Cancel current sync (e.g., user is forcing offline mode or logging out). */
export function cancelInitialSync(): void {
  _cancelled = true;
  _running = false;
}

/** Forcibly reset running state (useful on fresh login). */
export function resetRunningState(): void {
  _running = false;
  _cancelled = false;
}

/** For the StatusBar background badge — count of background-phase rows pending. */
export async function getBackgroundProgress(orgId: string): Promise<{
  totalPending: number;
  currentTable: string | null;
  overallPercent: number;
}> {
  _activeOrgId = orgId;
  try {
    const rows = await db.select<{
      table_name: string; total_rows: number | null; synced_rows: number; is_complete: number
    }>(
      `SELECT table_name, total_rows, synced_rows, is_complete
       FROM _initial_sync_state
        WHERE organization_id = ? AND phase = 'background'`,
      [orgId]
    );
    let pending = 0;
    let totalAll = 0;
    let doneAll = 0;
    for (const r of rows) {
      if (r.is_complete === 1) {
        totalAll += r.total_rows ?? 0;
        doneAll += r.total_rows ?? 0;
      } else if (r.total_rows && r.total_rows > 0) {
        pending += r.total_rows - r.synced_rows;
        totalAll += r.total_rows;
        doneAll += r.synced_rows;
      }
    }
    return {
      totalPending: pending,
      currentTable: _currentState.currentTable,
      overallPercent: totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : 0,
    };
  } catch {
    return { totalPending: 0, currentTable: null, overallPercent: 0 };
  }
}
