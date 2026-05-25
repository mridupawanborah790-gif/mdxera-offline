/**
 * Dynamic Supabase schema-drift cache, with periodic re-validation.
 *
 * Different installations of MDXera run different ages/subsets of the
 * Supabase schema. The "canonical" *.sql files in the repo describe what
 * SHOULD be on Supabase, but a given customer's deployment may be older or
 * may have skipped some of the extension migrations
 * (e.g. supplier_address_fields_update.sql, customer_credit_control_update.sql).
 *
 * When we push a payload that contains a column the server doesn't recognise,
 * PostgREST rejects the whole upsert with:
 *
 *   {
 *     code:    'PGRST204',
 *     message: "Could not find the 'brand_agencies' column of 'suppliers' in the schema cache"
 *   }
 *
 * Static "local-only" lists in SyncWorker can't handle this — what's missing
 * on one customer's Supabase is present on another's. So we learn at runtime
 * AND we never commit to that learning forever: each entry has a timestamp,
 * and after REVALIDATION_TTL_MS the column is re-attempted on the next push.
 *
 * Lifecycle of a learned-missing column:
 *
 *   1. Push fails with PGRST204 → recordMissingColumns()
 *      stores  { column: { learnedAt: now } }, persists to localStorage.
 *   2. SyncWorker / supplierService / storageService strip the column from
 *      every subsequent push for REVALIDATION_TTL_MS (default: 24 h).
 *   3. After the TTL expires, getMissingColumns() omits the entry — the
 *      next push includes the column again.
 *      - If the server has since gained the column → upsert succeeds →
 *        clearMissingColumn() removes the entry → all future pushes include it.
 *      - If the server still doesn't have it → PGRST204 fires →
 *        recordMissingColumns() refreshes learnedAt → strip continues for
 *        another TTL window.
 *   4. window.__mdxera.resetSchemaDriftCache() — manual clear (also fired
 *      automatically by the "Sync All" button so a full resync also resets
 *      what the client thinks the server is missing).
 *
 * The cache key is the snake_case Supabase column name (the form the server
 * actually rejects). Callers can register either camelCase or snake_case and
 * we normalise on the way in so both lookups succeed.
 */

const STORAGE_KEY = 'mdxera.schemaDrift.v2'; // bumped from v1 — entries now carry timestamps
const LEGACY_STORAGE_KEY = 'mdxera.schemaDrift.v1';

/**
 * How long a learned-missing column stays in the strip-list before being
 * re-attempted on the next push.
 *
 * 24 hours is a deliberate balance:
 *   - Long enough that we don't burn a server round-trip every cycle on a
 *     deployment that's genuinely missing the column (steady state: 1
 *     wasted push per day per missing column).
 *   - Short enough that when a user runs a Supabase migration to add the
 *     column, they don't have to wait more than a day before the client
 *     re-discovers it on its own.
 *
 * Manual triggers — Sync All button, resetSchemaDriftCache() in DevTools —
 * bypass the TTL entirely.
 */
export const REVALIDATION_TTL_MS = 24 * 60 * 60 * 1000;

interface DriftEntry {
  /** Epoch ms when this column was last confirmed missing on the server. */
  learnedAt: number;
}

type DriftMap = Map<string, Map<string, DriftEntry>>; // table → column → entry

let _cache: DriftMap | null = null;

function camelToSnakeKey(s: string): string {
  return s.replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`));
}

function loadFromStorage(): DriftMap {
  const map: DriftMap = new Map();
  if (typeof localStorage === 'undefined') return map;

  // Preferred: v2 format with timestamps.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, Record<string, { learnedAt: number }>>;
      for (const [table, cols] of Object.entries(obj)) {
        const inner = new Map<string, DriftEntry>();
        for (const [col, entry] of Object.entries(cols)) {
          if (entry && typeof entry.learnedAt === 'number') {
            inner.set(col, { learnedAt: entry.learnedAt });
          }
        }
        if (inner.size > 0) map.set(table, inner);
      }
      return map;
    }
  } catch (err) {
    console.warn('[schemaDrift] failed to load v2 cache, falling back to v1:', err);
  }

  // Legacy: v1 format (string[] without timestamps). Migrate forward by
  // treating each entry as "just learned" so the TTL clock starts fresh.
  // This avoids permanently stripping columns on installs that upgraded
  // through the v1 cache before the TTL feature shipped.
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, string[]>;
      const now = Date.now();
      for (const [table, cols] of Object.entries(obj)) {
        if (!Array.isArray(cols)) continue;
        const inner = new Map<string, DriftEntry>();
        for (const col of cols) inner.set(col, { learnedAt: now });
        if (inner.size > 0) map.set(table, inner);
      }
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      // Persist in v2 format immediately so we don't read v1 again next boot.
      _cache = map;
      persist();
    }
  } catch (err) {
    console.warn('[schemaDrift] failed to migrate v1 cache:', err);
  }
  return map;
}

function persist(): void {
  if (!_cache) return;
  if (typeof localStorage === 'undefined') return;
  try {
    const obj: Record<string, Record<string, { learnedAt: number }>> = {};
    for (const [table, cols] of _cache.entries()) {
      const tableObj: Record<string, { learnedAt: number }> = {};
      for (const [col, entry] of cols.entries()) {
        tableObj[col] = { learnedAt: entry.learnedAt };
      }
      obj[table] = tableObj;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (err) {
    console.warn('[schemaDrift] failed to persist cache:', err);
  }
}

function ensureLoaded(): DriftMap {
  if (_cache === null) _cache = loadFromStorage();
  return _cache;
}

/**
 * Returns the set of column names known to be missing on the server for the
 * given table, AS OF RIGHT NOW. Entries older than REVALIDATION_TTL_MS are
 * omitted — letting the next push attempt include the column again. If the
 * server still rejects it, recordMissingColumns() will refresh the timestamp.
 *
 * The returned set contains BOTH the snake_case Supabase column name and the
 * camelCase variant, so callers comparing pre-snake keys also strip the field.
 */
export function getMissingColumns(tableName: string): Set<string> {
  const cache = ensureLoaded();
  const stored = cache.get(tableName);
  if (!stored || stored.size === 0) return new Set();

  const now = Date.now();
  const expanded = new Set<string>();
  for (const [snake, entry] of stored.entries()) {
    if (now - entry.learnedAt > REVALIDATION_TTL_MS) continue; // stale — re-try this column
    expanded.add(snake);
    const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (camel !== snake) expanded.add(camel);
  }
  return expanded;
}

/**
 * Record one or more columns as confirmed-missing on the server for a table.
 * Refreshes the `learnedAt` timestamp on each call so a column that keeps
 * being rejected stays stripped indefinitely (the TTL only matures from the
 * LAST confirmed miss). Persists to localStorage immediately.
 */
export function recordMissingColumns(tableName: string, columns: Iterable<string>): void {
  const cache = ensureLoaded();
  const existing = cache.get(tableName) ?? new Map<string, DriftEntry>();
  const now = Date.now();
  let changed = false;
  for (const col of columns) {
    const snake = camelToSnakeKey(col);
    const prev = existing.get(snake);
    if (!prev || prev.learnedAt !== now) {
      existing.set(snake, { learnedAt: now });
      changed = true;
    }
  }
  if (changed) {
    cache.set(tableName, existing);
    persist();
  }
}

/**
 * Forget a single learned-missing column — call this after a push that
 * SUCCEEDED while sending it. Implies the server now has the column.
 * (Currently only called via observation in pushWithDriftLearning's success
 * path; see that function for details.)
 */
export function clearMissingColumn(tableName: string, column: string): void {
  const cache = ensureLoaded();
  const existing = cache.get(tableName);
  if (!existing) return;
  const snake = camelToSnakeKey(column);
  if (!existing.has(snake)) return;
  existing.delete(snake);
  if (existing.size === 0) cache.delete(tableName);
  persist();
}

/**
 * Extract `(table, column)` from a PostgREST PGRST204 error. PostgREST always
 * formats these as: "Could not find the 'X' column of 'Y' in the schema cache".
 * Returns null if the error isn't a PGRST204 column-missing error.
 */
export function parseMissingColumnError(err: unknown):
  | { table: string; column: string }
  | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: string; message?: string };
  if (e.code !== 'PGRST204') return null;
  const m = /Could not find the '([^']+)' column of '([^']+)'/.exec(e.message ?? '');
  if (!m) return null;
  return { column: m[1], table: m[2] };
}

/**
 * Clear all learned drift. Useful when a customer upgrades their Supabase
 * schema and wants the client to start sending the new columns again. Wired
 * into the "Sync All" button so a full resync also resets the drift cache —
 * the user's mental model is "everything fresh," which should include
 * re-discovering what the server now accepts.
 */
export function resetSchemaDriftCache(): void {
  _cache = new Map();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch { /* noop */ }
}

/** For diagnostics / the SyncIndicator panel. */
export function snapshotSchemaDrift(): Record<string, Array<{ column: string; learnedAt: string; expiresIn: string }>> {
  const cache = ensureLoaded();
  const now = Date.now();
  const out: Record<string, Array<{ column: string; learnedAt: string; expiresIn: string }>> = {};
  for (const [table, cols] of cache.entries()) {
    out[table] = Array.from(cols.entries())
      .map(([column, entry]) => {
        const expiresMs = Math.max(0, REVALIDATION_TTL_MS - (now - entry.learnedAt));
        const hours = Math.floor(expiresMs / 3_600_000);
        const minutes = Math.floor((expiresMs % 3_600_000) / 60_000);
        return {
          column,
          learnedAt: new Date(entry.learnedAt).toISOString(),
          expiresIn: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
        };
      })
      .sort((a, b) => a.column.localeCompare(b.column));
  }
  return out;
}

/**
 * Remove columns known to be missing on the server from a snake_case payload.
 * Both snake_case and camelCase forms are stripped (so callers can call this
 * either before or after their own snake-case conversion). Idempotent. Honours
 * the TTL automatically via getMissingColumns().
 */
export function stripDriftedColumns(
  tableName: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const missing = getMissingColumns(tableName);
  if (missing.size === 0) return payload;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (missing.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Wrap a Supabase write so PGRST204 schema-drift errors auto-learn the
 * missing column, persist it, and the write is retried without the column.
 * Also: if the write succeeded while sending columns previously thought
 * missing, those entries are removed from the cache — the server has caught
 * up and we want all future pushes to include them again.
 *
 * Generic so it works for upserts, inserts, and update().select() — pass a
 * callback that performs the actual Supabase call against a possibly-filtered
 * payload, and we'll keep filtering and retrying until the server either
 * accepts the write or raises an error that isn't a column-missing one.
 *
 * Caller responsibilities:
 *   - The payload must already be in snake_case (drift cache uses snake_case
 *     as the canonical form).
 *   - The push callback must return a typical Supabase `{ data, error }` shape.
 *   - On non-PGRST204 errors the original error is thrown unchanged.
 */
export async function pushWithDriftLearning<T>(
  tableName: string,
  payload: Record<string, unknown> | Record<string, unknown>[],
  push: (filtered: Record<string, unknown> | Record<string, unknown>[]) => Promise<{
    data: T | null;
    error: { code?: string; message?: string } | null;
  }>,
): Promise<{ data: T | null; error: { code?: string; message?: string } | null }> {
  const MAX_RETRIES = 20;

  // Snapshot what we BELIEVE was missing BEFORE this push. Any column the
  // client sends that's NOT in this snapshot but IS in the cache afterward
  // means a TTL expiry re-included it. If the push succeeds, those entries
  // can be cleared — the server now accepts them.
  const beforeMissing = new Set(getMissingColumns(tableName));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const filtered = Array.isArray(payload)
      ? payload.map((p) => stripDriftedColumns(tableName, p))
      : stripDriftedColumns(tableName, payload);

    const result = await push(filtered);
    if (!result.error) {
      // Detect TTL-driven re-validations: any cache entry that was stale at
      // the start of this push (and therefore NOT stripped) but whose column
      // we ended up sending must have been accepted. Clear them so future
      // pushes include the column with no extra round-trip.
      const cacheNow = ensureLoaded().get(tableName);
      if (cacheNow && cacheNow.size > 0) {
        const sentColumns = collectSentColumnNames(filtered);
        for (const [snake] of cacheNow.entries()) {
          if (sentColumns.has(snake) && !beforeMissing.has(snake)) {
            clearMissingColumn(tableName, snake);
            console.info(
              `[schemaDrift] ${tableName}.${snake} accepted by server on re-validation — ` +
              `removed from drift cache`,
            );
          }
        }
      }
      return result;
    }

    const drift = parseMissingColumnError(result.error);
    if (!drift || !drift.column) return result; // genuine error — let caller handle

    recordMissingColumns(tableName, [drift.column]);
    console.info(
      `[schemaDrift] ${tableName}: server has no column '${drift.column}' — ` +
      `stripped and retrying (learned: ${attempt + 1})`,
    );
  }
  // Exceeded retries — return the last error
  return push(
    Array.isArray(payload)
      ? payload.map((p) => stripDriftedColumns(tableName, p))
      : stripDriftedColumns(tableName, payload),
  );
}

function collectSentColumnNames(
  filtered: Record<string, unknown> | Record<string, unknown>[],
): Set<string> {
  const out = new Set<string>();
  const rows = Array.isArray(filtered) ? filtered : [filtered];
  for (const row of rows) {
    for (const k of Object.keys(row)) out.add(k);
  }
  return out;
}
