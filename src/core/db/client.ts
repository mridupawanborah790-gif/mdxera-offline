import Database from '@tauri-apps/plugin-sql';
import { MIGRATIONS } from './migrations';

let _db: Database | null = null;
let _initPromise: Promise<Database> | null = null;

/**
 * Tauri's plugin-sql wraps a sqlx SqlitePool with N connections. Each
 * `database.execute()` call grabs an arbitrary connection — so BEGIN can land
 * on connection A and COMMIT can land on connection B, blowing up with
 * "cannot commit - no transaction is active". The plugin's JS API doesn't let
 * us pin to a single connection, so we serialize ALL operations through one
 * queue at the JS level and use only individual auto-commit statements
 * (no explicit BEGIN/COMMIT). With WAL + busy_timeout the SQLite layer
 * handles concurrent reads safely; the queue eliminates the pool-race
 * entirely for writes.
 */
let _opQueue: Promise<void> = Promise.resolve();

async function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const prior = _opQueue;
  let release: () => void = () => {};
  _opQueue = new Promise<void>((res) => { release = res; });
  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Retry a SQLite operation up to `attempts` times on SQLITE_BUSY (code 5/517).
 * Even with busy_timeout set, a contention burst can still surface. Short
 * exponential backoff usually clears it.
 */
async function withBusyRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as { message?: string })?.message ?? err);
      if (!/database is locked|SQLITE_BUSY|\bcode: (5|517)\b/i.test(msg)) throw err;
      // 50ms, 100ms, 200ms, 400ms
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

/**
 * Split a multi-statement SQL string on `;`, but ONLY on semicolons that
 * appear in actual statement positions — not inside `-- line comments`,
 * `/* block comments *\/`, or single-quoted string literals.
 *
 * The previous implementation did a naive `sql.split(';')` which broke
 * migration 011: a `;` inside an English `-- comment` ("Supabase doesn't
 * have those; they're effectively...") cut the chunk in half. The second
 * chunk started with `they're` and SQLite threw `near "they": syntax error`,
 * which then cascaded — every subsequent migration attempted to run that
 * malformed chunk and every later DB call hit the same error.
 *
 * Behaviour:
 *   - `--` extends to end of line.
 *   - `/* … *\/` extends until the matching close.
 *   - `'…'` honours `''` as an escaped quote (SQLite convention).
 *   - Outside any of those, a `;` ends the current statement.
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;

  while (i < n) {
    const c = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (inLineComment) {
      buf += c;
      if (c === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      buf += c;
      if (c === '*' && next === '/') { buf += next; i += 2; inBlockComment = false; continue; }
      i += 1;
      continue;
    }
    if (inSingleQuote) {
      buf += c;
      if (c === '\'' && next === '\'') { buf += next; i += 2; continue; } // SQL escaped quote
      if (c === '\'') inSingleQuote = false;
      i += 1;
      continue;
    }

    if (c === '-' && next === '-') { inLineComment = true; buf += c; i += 1; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; buf += c; i += 1; continue; }
    if (c === '\'') { inSingleQuote = true; buf += c; i += 1; continue; }

    if (c === ';') {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      i += 1;
      continue;
    }

    buf += c;
    i += 1;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

async function applyMigrations(database: Database): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  // tauri-plugin-sql select returns unknown[] at runtime; cast explicitly
  const rows = (await database.select(
    'SELECT version FROM _migrations ORDER BY version ASC'
  )) as Array<{ version: number }>;
  const appliedVersions = new Set(rows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    const statements = splitSqlStatements(migration.sql);

    for (const stmt of statements) {
      await database.execute(stmt);
    }

    await database.execute(
      'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [migration.version, migration.name, Date.now()]
    );
  }
}

async function createDb(): Promise<Database> {
  const database = await Database.load('sqlite:mdxera.db');

  // WAL mode lets multiple readers run concurrently with one writer instead
  // of forcing "database is locked" every time two operations overlap.
  // busy_timeout makes any remaining contention wait up to 10s instead of
  // immediately erroring. foreign_keys keeps relational integrity on.
  // NB: these PRAGMAs run once per connection in the pool, so call once for
  // each connection by issuing them several times. (sqlx applies the first
  // few to whatever connections the pool happens to spin up.)
  try {
    for (let i = 0; i < 4; i++) {
      await database.execute('PRAGMA journal_mode = WAL;');
      await database.execute('PRAGMA busy_timeout = 10000;');
      await database.execute('PRAGMA foreign_keys = ON;');
      await database.execute('PRAGMA synchronous = NORMAL;');
    }
  } catch (err) {
    console.warn('[db] PRAGMA setup failed (non-fatal):', err);
  }

  await applyMigrations(database);
  return database;
}

function getDb(): Promise<Database> {
  if (_db) return Promise.resolve(_db);
  if (!_initPromise) {
    _initPromise = createDb().then((database) => {
      _db = database;
      return database;
    });
  }
  return _initPromise;
}

export interface DbClient {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction(fn: (tx: Pick<DbClient, 'execute' | 'select'>) => Promise<void>): Promise<void>;
  upsert(table: string, row: Record<string, unknown>): Promise<void>;
  bulkUpsert(table: string, rows: Record<string, unknown>[]): Promise<void>;
}

export const db: DbClient = {
  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const database = await getDb();
    await runSerialized(() => withBusyRetry(() => database.execute(sql, params)));
  },

  async select<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const database = await getDb();
    // Serialize reads too — Tauri's pool can have a writer holding a lock
    // while a SELECT on another pooled connection trips SQLITE_BUSY.
    return runSerialized(() => withBusyRetry(() => database.select(sql, params))) as Promise<T[]>;
  },

  /**
   * "Transaction" in name only — Tauri's plugin-sql pool cannot keep
   * BEGIN/COMMIT on the same connection, so explicit transactions are
   * impossible. Instead we run each statement inside a single serialized
   * block, so no other DB caller can interleave between them. Statements
   * auto-commit individually; if one fails mid-batch the previous ones
   * are already persisted (no rollback). For our use case (sync upserts
   * with INSERT OR REPLACE, retry-on-failure), that's acceptable.
   */
  async transaction(
    fn: (tx: Pick<DbClient, 'execute' | 'select'>) => Promise<void>
  ): Promise<void> {
    const database = await getDb();
    await runSerialized(async () => {
      const tx: Pick<DbClient, 'execute' | 'select'> = {
        execute: (sql, params = []) =>
          withBusyRetry(() => database.execute(sql, params)).then(() => undefined),
        select: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
          withBusyRetry(() => database.select(sql, params)) as Promise<T[]>,
      };
      await fn(tx);
    });
  },

  async upsert(table: string, row: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    await db.execute(
      `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
      Object.values(row)
    );
  },

  async bulkUpsert(
    table: string,
    rows: Record<string, unknown>[]
  ): Promise<void> {
    if (rows.length === 0) return;
    await db.transaction(async (tx) => {
      for (const row of rows) {
        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(', ');
        await tx.execute(
          `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
          Object.values(row)
        );
      }
    });
  },
};

export async function initDatabase(): Promise<void> {
  await getDb();
}
