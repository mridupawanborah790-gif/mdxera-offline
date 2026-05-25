// Closes every real schema gap identified by a LIVE audit
// (window.__mdxera.auditSchemas()) against the user's actual Supabase
// deployment — NOT against the repo's *.sql files, which had drifted from
// what was actually applied to the server.
//
// Every column added below is one that the server's information_schema
// returns but local SQLite was silently dropping on pull. After this
// migration applies and _sync_meta is cleared for the affected tables,
// the next SyncPuller cycle re-fetches the rows in full and the local
// mirror finally matches what's on Supabase.
//
// Skipped from the audit's serverOnly list (intentionally):
//   - configurations._isDirty / _is_dirty  → client-state junk that got
//     pushed accidentally; the `_`-prefix strip in normalizeForSupabase
//     already keeps us from sending them and we don't want to mirror them.
//
// Skipped from the audit's localOnly list (handled elsewhere):
//   - Most localOnly entries are legacy alias columns the schemaDriftCache
//     learns to strip dynamically (and re-validates every 24h, in case the
//     server gains the column later). Adding them to a static strip list
//     would be wrong because the same column may be present on a different
//     org's Supabase. Self-healing wins here.
//
// Two non-additive bugs are handled in SyncWorker (see normalizeForSupabase
// edits in this same commit), not here:
//   - purchase_orders.supplier / supplier_id  →  distributor_name / distributor_id
//   - journal_entry_lines.debit / credit       →  debit_amount  / credit_amount
//
// Re-run window.__mdxera.snapshotSchemaAudit() after this migration applies
// to confirm everything is `ok: true` (modulo the localOnly entries which
// are now drift-cache territory).
export const SQL_013_CLOSE_AUDIT_GAPS = `
-- ─── profiles ──────────────────────────────────────────────────────────────
-- Supabase has both user_id (PK) and id (extra text column added by
-- profiles_settings_update.sql — "Meta ID cleanup"). Mirror it.
ALTER TABLE profiles ADD COLUMN id TEXT;

-- ─── material_master ───────────────────────────────────────────────────────
-- Module-visibility flags + the master-price strategy field. The local
-- migration 001 only captured the basic product fields.
ALTER TABLE material_master ADD COLUMN allow_packaging_sale INTEGER DEFAULT 1;
ALTER TABLE material_master ADD COLUMN imei TEXT;
ALTER TABLE material_master ADD COLUMN is_internal_issue_enabled INTEGER DEFAULT 0;
ALTER TABLE material_master ADD COLUMN is_inventorised INTEGER DEFAULT 1;
ALTER TABLE material_master ADD COLUMN is_production_enabled INTEGER DEFAULT 0;
ALTER TABLE material_master ADD COLUMN is_purchase_enabled INTEGER DEFAULT 1;
ALTER TABLE material_master ADD COLUMN is_sales_enabled INTEGER DEFAULT 1;
ALTER TABLE material_master ADD COLUMN master_price_maintains TEXT;
ALTER TABLE material_master ADD COLUMN material_master_type TEXT DEFAULT 'trading_goods';

-- ─── suppliers ─────────────────────────────────────────────────────────────
-- The user's Supabase has the camelCase quoted form addressLine1 (not the
-- snake address_line_1). Mirror with quoted identifier so PRAGMA + columnFilter
-- match on the wire format. SQLite identifiers are case-insensitive for
-- comparison but preserve case from definition, so both reads and pulls work.
ALTER TABLE suppliers ADD COLUMN "addressLine1" TEXT;

-- ─── sales_bill ────────────────────────────────────────────────────────────
-- Legacy duplicate of id used by older code paths.
ALTER TABLE sales_bill ADD COLUMN voucher_no TEXT;

-- ─── purchases ─────────────────────────────────────────────────────────────
-- Cancellation audit fields. Previously stripped on push as
-- "may not exist in all Supabase versions" — turns out this deployment has them.
-- Two changes needed: add locally so pulls populate; AND remove from
-- LOCAL_ONLY_COLUMNS.purchases in SyncWorker (done in same commit).
ALTER TABLE purchases ADD COLUMN cancellation_reason TEXT;
ALTER TABLE purchases ADD COLUMN cancelled_at TEXT;
ALTER TABLE purchases ADD COLUMN cancelled_by TEXT;

-- ─── purchase_orders ───────────────────────────────────────────────────────
-- JSON-array columns tracking the receive flow + linked purchase bills.
-- columnFilter JSON-encodes the values on the way in; the legacy app's
-- toCamel path already auto-detects JSON-looking strings on read.
ALTER TABLE purchase_orders ADD COLUMN receive_links TEXT;
ALTER TABLE purchase_orders ADD COLUMN source_purchase_bill_ids TEXT;

-- ─── purchase_returns ──────────────────────────────────────────────────────
-- Server uses original_purchase_invoice_id / total_value; local schema
-- invented original_purchase_id / total_amount in 001 (which Supabase
-- doesn't have). Add the canonical names — both columns will exist locally,
-- with the canonical ones populated by pulls.
ALTER TABLE purchase_returns ADD COLUMN original_purchase_invoice_id TEXT;
ALTER TABLE purchase_returns ADD COLUMN total_value REAL DEFAULT 0;

-- ─── physical_inventory ────────────────────────────────────────────────────
-- The user's deployment carries the standard audit columns plus a voucher_no
-- mirror. Local schema only had id and items.
ALTER TABLE physical_inventory ADD COLUMN created_by_id TEXT;
ALTER TABLE physical_inventory ADD COLUMN performed_by_id TEXT;
ALTER TABLE physical_inventory ADD COLUMN voucher_no TEXT;

-- ─── ewaybills ─────────────────────────────────────────────────────────────
-- The Supabase schema (fix_missing_tables_v2.sql) uses camelCase quoted
-- column names. Local migration 001 modelled ewaybills as a flat JSON blob
-- in a single 'data' column, so pulls were losing 31 individual fields.
-- Mirror them all so the legacy app can read either the blob OR the flat
-- columns going forward.
ALTER TABLE ewaybills ADD COLUMN "cessValue" REAL DEFAULT 0;
ALTER TABLE ewaybills ADD COLUMN "cgstValue" REAL DEFAULT 0;
ALTER TABLE ewaybills ADD COLUMN "documentDate" TEXT;
ALTER TABLE ewaybills ADD COLUMN "documentNo" TEXT;
ALTER TABLE ewaybills ADD COLUMN "documentType" TEXT;
ALTER TABLE ewaybills ADD COLUMN "eWayBillDate" TEXT;
ALTER TABLE ewaybills ADD COLUMN "eWayBillNo" TEXT;
ALTER TABLE ewaybills ADD COLUMN "fromAddr1" TEXT;
ALTER TABLE ewaybills ADD COLUMN "fromAddr2" TEXT;
ALTER TABLE ewaybills ADD COLUMN "fromGstin" TEXT;
ALTER TABLE ewaybills ADD COLUMN "fromPincode" INTEGER;
ALTER TABLE ewaybills ADD COLUMN "fromPlace" TEXT;
ALTER TABLE ewaybills ADD COLUMN "fromStateCode" INTEGER;
ALTER TABLE ewaybills ADD COLUMN "fromTrdName" TEXT;
ALTER TABLE ewaybills ADD COLUMN "igstValue" REAL DEFAULT 0;
ALTER TABLE ewaybills ADD COLUMN "sgstValue" REAL DEFAULT 0;
ALTER TABLE ewaybills ADD COLUMN "subSupplyType" TEXT;
ALTER TABLE ewaybills ADD COLUMN "supplyType" TEXT;
ALTER TABLE ewaybills ADD COLUMN "toAddr1" TEXT;
ALTER TABLE ewaybills ADD COLUMN "toAddr2" TEXT;
ALTER TABLE ewaybills ADD COLUMN "toGstin" TEXT;
ALTER TABLE ewaybills ADD COLUMN "toPincode" INTEGER;
ALTER TABLE ewaybills ADD COLUMN "toPlace" TEXT;
ALTER TABLE ewaybills ADD COLUMN "toStateCode" INTEGER;
ALTER TABLE ewaybills ADD COLUMN "toTrdName" TEXT;
ALTER TABLE ewaybills ADD COLUMN "totalValue" REAL DEFAULT 0;
ALTER TABLE ewaybills ADD COLUMN "transactionType" TEXT;
ALTER TABLE ewaybills ADD COLUMN "transportMode" TEXT;
ALTER TABLE ewaybills ADD COLUMN "validUntil" TEXT;
ALTER TABLE ewaybills ADD COLUMN "vehicleNo" TEXT;
ALTER TABLE ewaybills ADD COLUMN "vehicleType" TEXT;

-- ─── mbc_cards ─────────────────────────────────────────────────────────────
-- Production carries the full loyalty-card detail; local migration 004
-- captured only the slim summary fields. Add the missing 29 columns so
-- pulled card records arrive intact.
ALTER TABLE mbc_cards ADD COLUMN address_line_1 TEXT;
ALTER TABLE mbc_cards ADD COLUMN address_line_2 TEXT;
ALTER TABLE mbc_cards ADD COLUMN alternate_phone TEXT;
ALTER TABLE mbc_cards ADD COLUMN barcode_value TEXT;
ALTER TABLE mbc_cards ADD COLUMN card_type_id TEXT;
ALTER TABLE mbc_cards ADD COLUMN card_value REAL DEFAULT 0;
ALTER TABLE mbc_cards ADD COLUMN city TEXT;
ALTER TABLE mbc_cards ADD COLUMN created_by TEXT;
ALTER TABLE mbc_cards ADD COLUMN customer_name TEXT;
ALTER TABLE mbc_cards ADD COLUMN date_of_birth TEXT;
ALTER TABLE mbc_cards ADD COLUMN district TEXT;
ALTER TABLE mbc_cards ADD COLUMN email TEXT;
ALTER TABLE mbc_cards ADD COLUMN gender TEXT;
ALTER TABLE mbc_cards ADD COLUMN guardian_name TEXT;
ALTER TABLE mbc_cards ADD COLUMN issue_date TEXT;
ALTER TABLE mbc_cards ADD COLUMN office_location_text TEXT;
ALTER TABLE mbc_cards ADD COLUMN phone_number TEXT;
ALTER TABLE mbc_cards ADD COLUMN photo_url TEXT;
ALTER TABLE mbc_cards ADD COLUMN pin_code TEXT;
ALTER TABLE mbc_cards ADD COLUMN qr_value TEXT;
ALTER TABLE mbc_cards ADD COLUMN remarks TEXT;
ALTER TABLE mbc_cards ADD COLUMN state TEXT;
ALTER TABLE mbc_cards ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE mbc_cards ADD COLUMN template_id TEXT;
ALTER TABLE mbc_cards ADD COLUMN validity_from TEXT;
ALTER TABLE mbc_cards ADD COLUMN validity_period_text TEXT;
ALTER TABLE mbc_cards ADD COLUMN validity_to TEXT;
ALTER TABLE mbc_cards ADD COLUMN website_link TEXT;
ALTER TABLE mbc_cards ADD COLUMN whatsapp_number TEXT;

-- ─── gl_master ─────────────────────────────────────────────────────────────
ALTER TABLE gl_master ADD COLUMN account_group TEXT;
ALTER TABLE gl_master ADD COLUMN alias TEXT;
ALTER TABLE gl_master ADD COLUMN mapping_structure TEXT;
ALTER TABLE gl_master ADD COLUMN subgroup TEXT;

-- ─── set_of_books ──────────────────────────────────────────────────────────
ALTER TABLE set_of_books ADD COLUMN default_bank_gl_id TEXT;
ALTER TABLE set_of_books ADD COLUMN default_demo_bank_gl_id TEXT;

-- ─── sub_categories ────────────────────────────────────────────────────────
ALTER TABLE sub_categories ADD COLUMN image_url TEXT;

-- ─── distributors ──────────────────────────────────────────────────────────
-- Migration 011 added 9 fields based on the canonical distributors_schema.sql
-- in this repo. The user's actual Supabase has 10 more (added via various
-- extension migrations that ran historically). Adding them now.
ALTER TABLE distributors ADD COLUMN address_line2 TEXT;
ALTER TABLE distributors ADD COLUMN area TEXT;
ALTER TABLE distributors ADD COLUMN category TEXT DEFAULT 'Wholesaler';
ALTER TABLE distributors ADD COLUMN contact_person TEXT;
ALTER TABLE distributors ADD COLUMN food_license TEXT;
ALTER TABLE distributors ADD COLUMN is_blocked INTEGER DEFAULT 0;
ALTER TABLE distributors ADD COLUMN mobile TEXT;
ALTER TABLE distributors ADD COLUMN pincode TEXT;
ALTER TABLE distributors ADD COLUMN remarks TEXT;
ALTER TABLE distributors ADD COLUMN website TEXT;

-- ─── journal_entry_lines ───────────────────────────────────────────────────
-- The user's Supabase uses *_amount suffixed columns. Local migration 003
-- used the bare debit/credit names. Add the suffixed mirrors so pulls
-- populate them. SyncWorker.normalizeForSupabase (separate edit in this
-- commit) maps debit → debit_amount and credit → credit_amount on push.
ALTER TABLE journal_entry_lines ADD COLUMN credit_amount REAL DEFAULT 0;
ALTER TABLE journal_entry_lines ADD COLUMN debit_amount REAL DEFAULT 0;

-- ─── indexes for lookup-heavy columns ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_material_master_type    ON material_master(material_master_type);
CREATE INDEX IF NOT EXISTS idx_distributors_mobile     ON distributors(mobile);
CREATE INDEX IF NOT EXISTS idx_distributors_pincode    ON distributors(pincode);
CREATE INDEX IF NOT EXISTS idx_mbc_cards_card_type     ON mbc_cards(card_type_id);
CREATE INDEX IF NOT EXISTS idx_mbc_cards_phone         ON mbc_cards(phone_number);
CREATE INDEX IF NOT EXISTS idx_mbc_cards_validity_to   ON mbc_cards(validity_to);

-- ─── force re-pull for every patched table ─────────────────────────────────
-- Same pattern as migrations 009–012: clear last_pulled_at so the next
-- SyncPuller cycle does a full (unfiltered) pull. Existing rows that were
-- previously truncated now arrive intact.
DELETE FROM _sync_meta WHERE table_name IN (
  'profiles','material_master','suppliers','sales_bill','purchases',
  'purchase_orders','purchase_returns','physical_inventory','ewaybills',
  'mbc_cards','gl_master','set_of_books','sub_categories','distributors',
  'journal_entry_lines'
);
`;
