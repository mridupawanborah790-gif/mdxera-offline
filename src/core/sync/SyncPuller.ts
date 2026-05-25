import { supabase } from '@core/db/supabaseClient';
import { db } from '@core/db/client';
import { SYNCABLE_TABLES, TABLE } from '@core/db/schema';
import { resolveConflict } from './conflictResolver';
import { adaptRowForSqlite } from './columnFilter';

interface SyncMeta {
  table_name: string;
  last_pulled_at: number | null;
}

/**
 * Per-table overrides for sync mechanics. Default: PK = 'id', delta column = 'updated_at'.
 * `deltaCol: null` disables delta filtering (always full pull) — used when neither
 * `updated_at` nor `created_at` is reliable on the Supabase side.
 */
const TABLE_META: Record<string, { pk?: string; deltaCol?: string | null }> = {
  profiles:            { pk: 'user_id' },
  delivery_challans:   { deltaCol: 'created_at' },
  sales_challans:      { deltaCol: 'created_at' },
  physical_inventory:  { deltaCol: 'created_at' },
  mrp_change_log:      { deltaCol: 'created_at' },
  journal_entry_lines: { deltaCol: 'created_at' },
  // mbc_card_history on production has neither updated_at nor created_at —
  // always full-pull (small table).
  mbc_card_history:    { deltaCol: null },
  sales_returns:       { deltaCol: 'created_at' },
  purchase_returns:    { deltaCol: 'created_at' },
};

const pkColumn = (table: string) => TABLE_META[table]?.pk ?? 'id';
const deltaColumn = (table: string): string | null => {
  const v = TABLE_META[table]?.deltaCol;
  return v === undefined ? 'updated_at' : v;
};

/** Postgrest error messages mean "this table/column simply isn't there on the server". */
function isSchemaMissingError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('could not find the table') ||
    m.includes('could not find the column') ||
    m.includes('does not exist') ||
    m.includes('schema cache')
  );
}

/**
 * Tables we've confirmed don't exist on the server (or whose schema differs
 * incompatibly). Skipped for the rest of the session to stop repeated 404/400s
 * on every 30-second sync cycle.
 */
const _permanentlyMissingTables = new Set<string>();

/** Pull changes from Supabase for all syncable tables and apply them to SQLite. */
export async function pullDeltaFromSupabase(organizationId: string): Promise<void> {
  // Load all pull timestamps in one query
  const metaRows = await db.select<SyncMeta>(
    `SELECT table_name, last_pulled_at FROM ${TABLE.SYNC_META}`
  );
  const metaMap = new Map(metaRows.map((r) => [r.table_name, r.last_pulled_at]));

  for (const tableName of SYNCABLE_TABLES) {
    await pullTable(tableName, organizationId, metaMap.get(tableName) ?? null);
  }
}

async function pullTable(
  tableName: string,
  organizationId: string,
  lastPulledAt: number | null
): Promise<void> {
  // Skip tables we already know aren't on the server.
  if (_permanentlyMissingTables.has(tableName)) return;

  const pk = pkColumn(tableName);
  const delta = deltaColumn(tableName);
  try {
    let query = supabase
      .from(tableName)
      .select('*')
      .eq('organization_id', organizationId);

    if (lastPulledAt !== null && delta) {
      const since = new Date(lastPulledAt).toISOString();
      query = query.gt(delta, since);
    }

    const { data: remoteRows, error } = await query;
    if (error) {
      // Table or column not present on the server (older Supabase schema) —
      // remember and stop trying for the rest of the session.
      if (isSchemaMissingError(error.message)) {
        console.warn(`[SyncPuller] ${tableName}: schema mismatch on server, will skip for this session (${error.message})`);
        _permanentlyMissingTables.add(tableName);
        await updatePullTimestamp(tableName);
        return;
      }
      throw new Error(error.message);
    }
    if (!remoteRows || remoteRows.length === 0) {
      await updatePullTimestamp(tableName);
      return;
    }

    // For each remote row, compare with local and apply if remote wins.
    for (const remote of remoteRows) {
      const remoteKey = remote[pk];
      if (remoteKey === undefined || remoteKey === null) {
        // Server row missing its primary-key column — can't reconcile, just insert.
        await upsertLocalRow(tableName, remote);
        continue;
      }

      let localRows: Array<{ updated_at?: string; _sync_status?: string }> = [];
      try {
        // Only request updated_at if the local table actually has it.
        const cols = delta === 'updated_at' ? 'updated_at, _sync_status' : '_sync_status';
        localRows = await db.select(
          `SELECT ${cols} FROM ${tableName} WHERE ${pk} = ?`,
          [remoteKey]
        );
      } catch (err) {
        // Local table may not exist yet (migration not run) — fall through to insert.
        console.debug(`[SyncPuller] ${tableName}: local lookup skipped (${(err as Error)?.message})`);
      }

      if (localRows.length === 0) {
        await upsertLocalRow(tableName, remote);
        continue;
      }

      const local = localRows[0];
      if (local._sync_status === 'pending') continue;

      if (delta === 'updated_at' && local.updated_at) {
        const winner = resolveConflict(local.updated_at, remote.updated_at as string);
        if (winner === 'remote') {
          await upsertLocalRow(tableName, remote);
        }
      } else {
        // No reliable timestamp on the local row — server always wins.
        await upsertLocalRow(tableName, remote);
      }
    }

    await updatePullTimestamp(tableName);
  } catch (err) {
    // Log but don't crash — partial sync is acceptable
    console.warn(`[SyncPuller] Failed to pull table ${tableName}:`, err);
  }
}

/**
 * Tables that track ownership via Supabase's `created_by_id` column.
 * Mirrors OWNER_TRACKING_TABLES in SyncWorker.ts (and in
 * storageService.ts:OWNER_TRACKING_TABLES). Kept duplicated here so this
 * file stays free of cyclic imports.
 *
 * For rows from these tables we ensure that whichever of `created_by_id`
 * and `user_id` is populated server-side gets mirrored into BOTH local
 * columns. Why both:
 *   - The legacy app (services/storageService.ts, App.tsx) reads `user_id`.
 *   - The new push path (SyncWorker.normalizeForSupabase) reads `user_id`
 *     too — it's the input we map onto `created_by_id` before pushing.
 *   - Newly-created rows post-fix have user_id=NULL on Supabase (we
 *     stripped it during push). Without this mirror, those rows arrive
 *     locally with user_id=NULL and the legacy "who created this" reads
 *     come back empty.
 *
 * physical_inventory is intentionally excluded — it uses user_id as a
 * real FK and never had created_by_id.
 */
const OWNER_TRACKING_TABLES = new Set([
  'inventory', 'purchases', 'suppliers', 'customers', 'sales_bill',
  'material_master', 'purchase_orders', 'sales_challans', 'delivery_challans',
  'doctor_master', 'distributors',
]);

function mirrorOwnerIdColumns(tableName: string, row: Record<string, unknown>): Record<string, unknown> {
  if (!OWNER_TRACKING_TABLES.has(tableName)) return row;
  const out = { ...row };
  const userId = out.user_id;
  const createdBy = out.created_by_id;
  // Whichever is set, populate the other if it's currently empty. This keeps
  // both legacy reads (user_id) and new reads (created_by_id) working off
  // the same value, regardless of which column the server populated.
  if (typeof userId === 'string' && userId.length > 0) {
    if (typeof createdBy !== 'string' || createdBy.length === 0) {
      out.created_by_id = userId;
    }
  } else if (typeof createdBy === 'string' && createdBy.length > 0) {
    out.user_id = createdBy;
  }
  return out;
}

async function upsertLocalRow(
  tableName: string,
  remote: Record<string, unknown>
): Promise<void> {
  // Reconcile the user_id / created_by_id pair before adapting. See
  // mirrorOwnerIdColumns above for why this matters.
  const reconciled = mirrorOwnerIdColumns(tableName, remote);
  // Use the schema-aware adapter: drops unknown columns, handles JSONB/booleans,
  // and sets _sync_status/_local_only automatically.
  const adapted = await adaptRowForSqlite(tableName, reconciled, { syncStatus: 'synced' });
  if (!adapted) return; // table doesn't exist locally — skip
  await db.upsert(tableName, adapted);
}

async function updatePullTimestamp(tableName: string): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO ${TABLE.SYNC_META} (table_name, last_pulled_at) VALUES (?, ?)`,
    [tableName, Date.now()]
  );
}
