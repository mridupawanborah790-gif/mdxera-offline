/**
 * Definitive schema-drift audit between LIVE Supabase and LIVE local SQLite.
 *
 * Unlike schemaDriftCache (which only learns drift the hard way — via PGRST204
 * errors during push), this module proactively introspects both sides and
 * reports every column mismatch in one shot. Useful for:
 *
 *   1. Answering "do all our tables match?" with certainty for THIS specific
 *      deployment (the repo's supabase/*.sql files describe what SHOULD be
 *      there, not what is).
 *   2. Discovering server columns we'd otherwise silently drop on pull
 *      (because adaptRowForSqlite filters by local schema).
 *   3. Generating the input for a future codegen pipeline that auto-writes
 *      migrations to close the gaps.
 *
 * Server side: requires the RPC defined in
 *   supabase/functions/_shared/inspect_columns.sql (deploy once via Studio).
 * Client side: exposed on window.__mdxera.auditSchemas — open DevTools and
 *   run `console.table(Object.entries(await window.__mdxera.auditSchemas()).map(...))`
 *   to get a row-per-table summary, or look at the full object for column
 *   lists per side.
 *
 * What "drift" means here:
 *   - server-only column: exists on Supabase, not in local SQLite. PULL drops
 *     it silently (data is lost in the local mirror). Fix: add to a migration.
 *   - local-only column: exists locally, not on Supabase. PUSH would fail
 *     PGRST204 (caught + cached by schemaDriftCache). Fix: either deploy a
 *     Supabase migration that adds the column, or accept the strip.
 *
 * Underscore-prefixed columns (_sync_status, _local_only) are local
 * bookkeeping and never expected on the server — excluded from the diff.
 * Likewise, columns that exist on both sides under different types are NOT
 * flagged (e.g. `is_active` is INTEGER locally but boolean on Supabase —
 * that's intentional, SQLite has no bool type).
 */
import { db } from '@core/db/client';
import { supabase } from '@core/db/supabaseClient';
import { SYNCABLE_TABLES } from '@core/db/schema';

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

export interface TableAuditResult {
  /** Columns present on Supabase but missing in local SQLite. */
  serverOnly: string[];
  /** Columns present in local SQLite but missing on Supabase. */
  localOnly: string[];
  /** Columns present in both (just names — types may still differ). */
  aligned: string[];
  /** Whether the table even exists on each side. */
  existsLocally: boolean;
  existsOnServer: boolean;
  /** True iff serverOnly.length === 0 && localOnly.length === 0. */
  ok: boolean;
}

export type SchemaAuditReport = Record<string, TableAuditResult>;

const LOCAL_BOOKKEEPING = new Set(['_sync_status', '_local_only']);

async function getLocalColumns(table: string): Promise<Set<string> | null> {
  try {
    const rows = await db.select<{ name: string }>(`PRAGMA table_info(${table})`);
    if (rows.length === 0) return null;
    return new Set(rows.map((r) => r.name).filter((n) => !LOCAL_BOOKKEEPING.has(n)));
  } catch (err) {
    console.warn(`[schemaAudit] local PRAGMA for ${table} failed:`, err);
    return null;
  }
}

async function getServerColumns(table: string): Promise<Set<string> | null> {
  try {
    const { data, error } = await supabase.rpc('mdxera_inspect_table_columns', {
      p_table_name: table,
    });
    if (error) {
      // RPC not deployed → message contains "Could not find the function"
      // Table doesn't exist server-side → empty result (data === []) — return empty set
      // Other errors → log and skip
      if (/Could not find the function/i.test(error.message ?? '')) {
        throw new Error(
          'RPC mdxera_inspect_table_columns is not deployed. ' +
          'Deploy supabase/functions/_shared/inspect_columns.sql via Supabase Studio first.',
        );
      }
      console.warn(`[schemaAudit] RPC failed for ${table}:`, error.message);
      return null;
    }
    const cols = (data as ColumnInfo[] | null) ?? [];
    if (cols.length === 0) return null; // table doesn't exist server-side
    return new Set(cols.map((c) => c.column_name));
  } catch (err) {
    // Rethrow the "not deployed" message so the caller can show a clear
    // setup error. Suppress everything else (we still want partial results).
    if (err instanceof Error && /not deployed/.test(err.message)) throw err;
    console.warn(`[schemaAudit] unexpected error for ${table}:`, err);
    return null;
  }
}

/**
 * Diff every table in SYNCABLE_TABLES. Returns one record per table. Tables
 * missing on either side are flagged via existsLocally / existsOnServer.
 *
 * Safe to call repeatedly. Network cost: one RPC round-trip per syncable
 * table (currently ~35, completes in a couple of seconds).
 */
export async function auditSchemas(): Promise<SchemaAuditReport> {
  const report: SchemaAuditReport = {};

  for (const table of SYNCABLE_TABLES) {
    const [localCols, serverCols] = await Promise.all([
      getLocalColumns(table),
      getServerColumns(table),
    ]);

    const existsLocally = localCols !== null;
    const existsOnServer = serverCols !== null;
    const local = localCols ?? new Set<string>();
    const server = serverCols ?? new Set<string>();

    const serverOnly = [...server].filter((c) => !local.has(c)).sort();
    const localOnly = [...local].filter((c) => !server.has(c)).sort();
    const aligned = [...local].filter((c) => server.has(c)).sort();

    report[table] = {
      serverOnly,
      localOnly,
      aligned,
      existsLocally,
      existsOnServer,
      ok: existsLocally && existsOnServer && serverOnly.length === 0 && localOnly.length === 0,
    };
  }

  return report;
}

/**
 * Compact summary helper for `console.table` — one row per table, just the
 * counts and OK status. Run this first; only dig into the full report for
 * tables where ok=false.
 *
 *   await window.__mdxera.snapshotSchemaAudit()
 */
export async function snapshotSchemaAudit(): Promise<
  Array<{ table: string; ok: boolean; serverOnly: number; localOnly: number; existsLocally: boolean; existsOnServer: boolean }>
> {
  const report = await auditSchemas();
  return Object.entries(report).map(([table, r]) => ({
    table,
    ok: r.ok,
    serverOnly: r.serverOnly.length,
    localOnly: r.localOnly.length,
    existsLocally: r.existsLocally,
    existsOnServer: r.existsOnServer,
  }));
}
