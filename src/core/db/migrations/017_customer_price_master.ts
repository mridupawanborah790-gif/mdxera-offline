// Extends customer_price_list with columns required by the Customer Price
// Master UI and the FK-price workflow.
//
// New columns:
//   fk_price       – FK Price shadow price (print-only; not used in billing calc)
//   status         – Active / Inactive lifecycle flag (default 'active')
//   created_by     – Audit: who created the row
//   modified_by    – Audit: who last modified the row
//   modified_at    – Audit: when the row was last modified (ISO-8601 TEXT)
//   item_name      – Denormalised inventory item name for display (avoids JOIN)
//   customer_name  – Denormalised customer name for display (avoids JOIN)
//
// Two composite indexes are created so the customer-price lookup screen and
// the org-wide active-price list queries both hit indexes instead of full scans.
//
// _sync_meta is cleared for customer_price_list so the next SyncPuller cycle
// does a full re-pull and populates the new columns from the server.
export const SQL_017_CUSTOMER_PRICE_MASTER = `
-- ─── customer_price_list – new columns ──────────────────────────────────────
ALTER TABLE customer_price_list ADD COLUMN fk_price REAL DEFAULT NULL;
ALTER TABLE customer_price_list ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE customer_price_list ADD COLUMN created_by TEXT;
ALTER TABLE customer_price_list ADD COLUMN modified_by TEXT;
ALTER TABLE customer_price_list ADD COLUMN modified_at TEXT;
ALTER TABLE customer_price_list ADD COLUMN item_name TEXT;
ALTER TABLE customer_price_list ADD COLUMN customer_name TEXT;

-- ─── indexes for lookup-heavy query paths ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_customer_price_list_customer_item
  ON customer_price_list (customer_id, material_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_price_list_org_status
  ON customer_price_list (organization_id, status);

-- ─── force re-pull so new columns are populated from the server ───────────────
DELETE FROM _sync_meta WHERE table_name = 'customer_price_list';
`;
