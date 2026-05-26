// Re-scope per-table sync tracking to the active organization.
//
// Bug fix: when a user logs into Account B after previously syncing Account A,
// the local app left only `configurations` populated. Cause: both _sync_meta
// (delta-pull timestamps) and _initial_sync_state (bulk-pull progress flags)
// were keyed by `table_name` alone — so the new account's puller asked
// Supabase for rows changed after Account A's last pull, found nothing newer
// for Account B's smaller dataset, and gave up.
//
// Fix: drop and recreate both tables with composite PK
// (organization_id, table_name). Loss of the existing rows is acceptable —
// they only track sync progress; the next pull rebuilds them correctly for
// the active org. Existing user data in the real domain tables is untouched.
//
// Side effect: every existing install will perform a "first-time" InitialSync
// on the next launch for whichever org is currently signed in. That's
// expected — and it's exactly the recovery that solves the bug for users
// already affected.
export const SQL_015_SYNC_META_PER_ORG = `
-- Drop the legacy single-key tables. Their contents only track sync
-- progress; nothing user-facing is lost.
DROP TABLE IF EXISTS _sync_meta;
DROP TABLE IF EXISTS _initial_sync_state;

-- Per-org delta-pull progress.
CREATE TABLE _sync_meta (
  organization_id TEXT NOT NULL,
  table_name      TEXT NOT NULL,
  last_pulled_at  INTEGER,
  last_pushed_at  INTEGER,
  PRIMARY KEY (organization_id, table_name)
);
CREATE INDEX IF NOT EXISTS idx_sync_meta_org ON _sync_meta(organization_id);

-- Per-org bulk-pull progress (one row per (org, table) — resumable).
CREATE TABLE _initial_sync_state (
  organization_id TEXT NOT NULL,
  table_name      TEXT NOT NULL,
  phase           TEXT NOT NULL DEFAULT 'foreground',
  total_rows      INTEGER,
  synced_rows     INTEGER NOT NULL DEFAULT 0,
  is_complete     INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  completed_at    INTEGER,
  last_error      TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  next_retry_at   INTEGER,
  PRIMARY KEY (organization_id, table_name)
);
CREATE INDEX IF NOT EXISTS idx_iss_org_incomplete
  ON _initial_sync_state(organization_id, is_complete, phase);
`;
