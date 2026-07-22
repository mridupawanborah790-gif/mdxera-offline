// Extends database with material_price_list table for Material-Wise Price Master

export const SQL_018_MATERIAL_PRICE_MASTER = `
-- ─── material_price_list ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_price_list (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  price REAL NOT NULL,
  status TEXT DEFAULT 'active',
  item_name TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  modified_by TEXT,
  modified_at TEXT,
  _sync_status TEXT DEFAULT 'synced',
  _local_only INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mpl_org_material_status
  ON material_price_list (organization_id, material_id, status);

CREATE INDEX IF NOT EXISTS idx_mpl_org_status
  ON material_price_list (organization_id, status);

DELETE FROM _sync_meta WHERE table_name = 'material_price_list';
`;
