import { supabase } from '@core/db/supabaseClient';
import { db } from '@core/db/client';
import { SYNCABLE_TABLES, TABLE } from '@core/db/schema';
import { resolveConflict } from './conflictResolver';
import { adaptRowForSqlite } from './columnFilter';

const syncChannel = new BroadcastChannel('mdxera-sync-channel');

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
  // mbc_card_value_history only has created_at, so use it for delta filtering.
  mbc_card_value_history: { deltaCol: 'created_at' },
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

/**
 * Tables that exist on Supabase but have NO `organization_id` column.
 * The `.eq('organization_id', ...)` filter is skipped for these tables;
 * the full table is pulled instead (they are small by design).
 * NOTE: mbc_card_value_history was here temporarily; organization_id was added
 * to that table's Supabase schema and this workaround is no longer needed.
 */
const NO_ORG_FILTER_TABLES = new Set<string>([
  // empty — all current syncable tables have organization_id on the server
]);

/** Pull changes from Supabase for all syncable tables and apply them to SQLite. */
export async function pullDeltaFromSupabase(organizationId: string): Promise<void> {
  // Load all pull timestamps scoped to the current org. Cross-org isolation
  // matters because the local DB now stores progress for every org the user
  // has signed in as (migration 015) — and Account A's `last_pulled_at` must
  // never be used to filter Account B's pull.
  const metaRows = await db.select<SyncMeta>(
    `SELECT table_name, last_pulled_at FROM ${TABLE.SYNC_META}
      WHERE organization_id = ?`,
    [organizationId]
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
  const skipOrgFilter = NO_ORG_FILTER_TABLES.has(tableName);
  try {
    let query = supabase
      .from(tableName)
      .select('*');

    // Only filter by organization_id when the server table has that column.
    if (!skipOrgFilter) {
      query = query.eq('organization_id', organizationId) as typeof query;
    }

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
        await updatePullTimestamp(tableName, organizationId);
        return;
      }
      throw new Error(error.message);
    }
    if (!remoteRows || remoteRows.length === 0) {
      await updatePullTimestamp(tableName, organizationId);
      return;
    }

    // For each remote row, compare with local and apply if remote wins.
    let didUpdate = false;
    for (const remote of remoteRows) {
      const remoteKey = remote[pk];
      if (remoteKey === undefined || remoteKey === null) {
        // Server row missing its primary-key column — can't reconcile, just insert.
        await upsertLocalRow(tableName, remote);
        didUpdate = true;
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
        didUpdate = true;
        continue;
      }

      const local = localRows[0];
      if (local._sync_status === 'pending') continue;

      if (delta === 'updated_at' && local.updated_at) {
        const winner = resolveConflict(local.updated_at, remote.updated_at as string);
        if (winner === 'remote') {
          await upsertLocalRow(tableName, remote);
          didUpdate = true;
        }
      } else {
        // No reliable timestamp on the local row — server always wins.
        await upsertLocalRow(tableName, remote);
        didUpdate = true;
      }
    }

    await updatePullTimestamp(tableName, organizationId);
    
    if (didUpdate) {
      syncChannel.postMessage({ action: 'invalidate', table: tableName });
    }
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

// Columns that live in local SQLite but have no Supabase counterpart. Because
// `db.upsert` is INSERT OR REPLACE, a remote pull would otherwise wipe these
// back to NULL on every sync. We preload the existing local row and reinject
// these values into the adapted payload so the link survives.
const LOCAL_ONLY_PRESERVE: Record<string, string[]> = {
  inventory: ['code', 'material_id'],
};

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

  const preserveCols = LOCAL_ONLY_PRESERVE[tableName];
  if (preserveCols && adapted.id) {
    const existing = await db.select<Record<string, unknown>>(
      `SELECT ${preserveCols.join(', ')} FROM ${tableName} WHERE id = ? LIMIT 1`,
      [adapted.id as string],
    );
    if (existing.length > 0) {
      for (const col of preserveCols) {
        const incoming = adapted[col];
        const local = existing[0][col];
        if ((incoming === undefined || incoming === null) && local != null) {
          adapted[col] = local;
        }
      }
    }
  }

  await db.upsert(tableName, adapted);
}

async function updatePullTimestamp(tableName: string, organizationId: string): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO ${TABLE.SYNC_META}
       (organization_id, table_name, last_pulled_at) VALUES (?, ?, ?)`,
    [organizationId, tableName, Date.now()]
  );
}
