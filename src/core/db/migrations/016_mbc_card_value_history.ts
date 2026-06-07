// Migration 016 — mbc_card_value_history
//
// Creates a local mirror of the mbc_card_value_history table that exists on
// production Supabase. This table tracks every individual "Add Card Value"
// or "Deduct Card Value" transaction against a specific MBC card, independent
// of the high-level mbc_card_history audit log (which covers renewals,
// upgrades, etc.).
//
// Differences from mbc_card_history:
//   - Rows in mbc_card_value_history record monetary deltas (previous_value,
//     added_value, new_value) per card, per transaction.
//   - mbc_card_history records lifecycle events (renew, upgrade, create …).
//   - The component shows mbc_card_value_history in a dedicated full-screen
//     detail overlay; mbc_card_history appears in the Renewal/Upgrade panel.
//
// Sync notes (see SyncPuller.ts TABLE_META):
//   - deltaCol: 'created_at'  — server rows carry created_at; delta pull works.
//   - No organization_id FK check needed here; the sync engine filters by org.
//
// The table is lightweight — no full-text search indexes needed.
// created_at DESC index supports the per-card detail overlay query:
//   SELECT * FROM mbc_card_value_history WHERE card_id = ? ORDER BY created_at DESC
export const SQL_016_MBC_CARD_VALUE_HISTORY = `
CREATE TABLE IF NOT EXISTS mbc_card_value_history (
  id             TEXT PRIMARY KEY,
  organization_id TEXT,
  card_id        TEXT NOT NULL,
  card_number    TEXT NOT NULL,
  customer_name  TEXT,
  previous_value REAL DEFAULT 0,
  added_value    REAL NOT NULL DEFAULT 0,
  new_value      REAL NOT NULL DEFAULT 0,
  added_by       TEXT,
  remarks        TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  _sync_status   TEXT DEFAULT 'synced',
  _local_only    INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mbc_card_value_history_card_id_created_at
  ON mbc_card_value_history (card_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mbc_card_value_history_org
  ON mbc_card_value_history (organization_id, created_at DESC);
`;
