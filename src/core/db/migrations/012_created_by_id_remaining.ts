// Final ownership-column patch.
//
// Background (the long version):
//   The Supabase `fix_created_by_id.sql` migration added an audit column
//   `created_by_id uuid REFERENCES auth.users(id)` to every owner-tracked
//   table — sales_bill, purchases, customers, suppliers, material_master,
//   purchase_orders, sales_challans, delivery_challans, inventory,
//   doctor_master, distributors. This column is now the canonical
//   "who created this row" marker.
//
//   storageService.getSupabasePayload() and (as of last session)
//   SyncWorker.normalizeForSupabase() both map the app-side user_id into
//   created_by_id and drop user_id before pushing. Going forward, every
//   row in those tables on Supabase has the audit recorded in
//   created_by_id (with user_id NULL for newly-created rows).
//
//   BUT: when SyncPuller fetches one of those rows back from Supabase,
//   adaptRowForSqlite drops `created_by_id` because the local SQLite
//   table doesn't have that column. The local mirror keeps user_id only
//   — and after the SyncWorker change, user_id is NULL on new rows. So
//   the legacy app reading bill.user_id loses ownership info entirely.
//
//   Migration 010 fixed this for customers + suppliers, migration 011
//   for distributors + doctor_master. This migration covers the rest
//   of the OWNER_TRACKING_TABLES set so created_by_id survives the pull.
//
// What this migration does:
//   1. ALTERs the remaining tables to add `created_by_id TEXT` (matches
//      the UUID we get from Supabase; SQLite stores it as text).
//   2. Backfills created_by_id from user_id for any rows that currently
//      have user_id but not created_by_id (i.e. rows that landed locally
//      before today). Idempotent — only touches rows where both columns
//      exist and created_by_id is currently NULL.
//   3. Clears _sync_meta so the next SyncPuller cycle does a full pull
//      and populates created_by_id from the server for any row that
//      already had it server-side (mirrors what the backfill SQL we just
//      ran on Supabase did over there).
//
// SyncPuller will also be updated (next file edit) to copy created_by_id
// into user_id at pull-time, so the legacy app's reads on `user_id`
// continue to work whether the row was created pre- or post-fix.
export const SQL_012_CREATED_BY_ID_REMAINING = `
ALTER TABLE sales_bill ADD COLUMN created_by_id TEXT;
ALTER TABLE purchases ADD COLUMN created_by_id TEXT;
ALTER TABLE material_master ADD COLUMN created_by_id TEXT;
ALTER TABLE purchase_orders ADD COLUMN created_by_id TEXT;
ALTER TABLE sales_challans ADD COLUMN created_by_id TEXT;
ALTER TABLE delivery_challans ADD COLUMN created_by_id TEXT;
ALTER TABLE inventory ADD COLUMN created_by_id TEXT;

-- Backfill from user_id where available. Idempotent — does nothing on
-- rows that already have created_by_id populated.
UPDATE sales_bill         SET created_by_id = user_id WHERE created_by_id IS NULL AND user_id IS NOT NULL;
UPDATE purchases          SET created_by_id = user_id WHERE created_by_id IS NULL AND user_id IS NOT NULL;
UPDATE material_master    SET created_by_id = user_id WHERE created_by_id IS NULL AND user_id IS NOT NULL;
UPDATE purchase_orders    SET created_by_id = user_id WHERE created_by_id IS NULL AND user_id IS NOT NULL;
UPDATE sales_challans     SET created_by_id = user_id WHERE created_by_id IS NULL AND user_id IS NOT NULL;
UPDATE delivery_challans  SET created_by_id = user_id WHERE created_by_id IS NULL AND user_id IS NOT NULL;
UPDATE inventory          SET created_by_id = user_id WHERE created_by_id IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_bill_created_by         ON sales_bill(created_by_id);
CREATE INDEX IF NOT EXISTS idx_purchases_created_by          ON purchases(created_by_id);
CREATE INDEX IF NOT EXISTS idx_material_master_created_by    ON material_master(created_by_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_by    ON purchase_orders(created_by_id);
CREATE INDEX IF NOT EXISTS idx_sales_challans_created_by     ON sales_challans(created_by_id);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_created_by  ON delivery_challans(created_by_id);
CREATE INDEX IF NOT EXISTS idx_inventory_created_by          ON inventory(created_by_id);

-- Force a fresh pull so server-resolved created_by_id values land locally.
DELETE FROM _sync_meta WHERE table_name IN (
  'sales_bill','purchases','material_master','purchase_orders',
  'sales_challans','delivery_challans','inventory'
);
`;
