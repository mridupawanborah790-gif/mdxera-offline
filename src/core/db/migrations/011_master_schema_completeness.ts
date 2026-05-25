// Completes the schema-drift fixes started in migrations 009 (config tables)
// and 010 (customers / suppliers). After auditing every syncable table against
// its canonical Supabase definition (see the supabase/ folder, especially
// distributors_schema.sql, doctor_master_schema.sql, inventory_table_schema.sql,
// material_master_schema.sql, purchases_schema.sql, purchase_orders_schema.sql,
// sales_challans_schema.sql, delivery_challans_schema.sql, sales_returns_schema.sql,
// and sales_bill_schema.sql), several tables were still missing columns the app
// either writes (via storageService.saveData / supplierService / etc.) or reads
// (via screens that compare against the production view). When an app payload
// included one of those columns, the offline-write path failed silently — the
// row was successfully queued for push, but the local upsert threw "no such
// column", got swallowed by the surrounding try/catch in
// services/storageService.ts:persistLocalRowToSqlite or
// services/supplierService.ts:createSupplierQuick, and the row never appeared
// in the local UI until SyncPuller eventually pulled it back (often still
// truncated due to the missing columns).
//
// This migration also clears _sync_meta for every patched table so the next
// SyncPuller cycle does a full pull and rewrites historical rows with the
// columns that were previously dropped on the way in.
//
// SQLite ALTER TABLE ADD COLUMN is one-shot (no IF NOT EXISTS), so this only
// runs once via _migrations bookkeeping. If a column already exists locally
// from a future bespoke ALTER, the migration will fail and roll itself back
// — but in the current codebase nothing else adds these columns.
export const SQL_011_MASTER_SCHEMA_COMPLETENESS = `
-- ─── doctor_master ─────────────────────────────────────────────────────────
-- Local from 001 had: id, organization_id, name, doctor_code, specialization,
-- qualification, phone, address. Supabase (doctor_master_schema.sql) has many
-- more — most importantly mobile/email/clinic_name/area for searches and
-- registration_no for compliance. Leaves the legacy phone and address
-- columns in place (Supabase doesn't have those, so they remain as local
-- aliases that the app stops populating once it sees mobile/area/etc.)
ALTER TABLE doctor_master ADD COLUMN registration_no TEXT;
ALTER TABLE doctor_master ADD COLUMN mobile TEXT;
ALTER TABLE doctor_master ADD COLUMN alternate_contact TEXT;
ALTER TABLE doctor_master ADD COLUMN email TEXT;
ALTER TABLE doctor_master ADD COLUMN clinic_name TEXT;
ALTER TABLE doctor_master ADD COLUMN area TEXT;
ALTER TABLE doctor_master ADD COLUMN city TEXT;
ALTER TABLE doctor_master ADD COLUMN state TEXT;
ALTER TABLE doctor_master ADD COLUMN pincode TEXT;
ALTER TABLE doctor_master ADD COLUMN commission_percent REAL;
ALTER TABLE doctor_master ADD COLUMN notes TEXT;
ALTER TABLE doctor_master ADD COLUMN created_by_id TEXT;
CREATE INDEX IF NOT EXISTS idx_doctor_master_mobile ON doctor_master(mobile);

-- ─── distributors ──────────────────────────────────────────────────────────
-- Local had only: id, organization_id, name, phone, email, address, is_active.
-- Supabase (distributors_schema.sql) has 17 columns. Missing locally: every
-- compliance + financial column the Accounts-Payable screen reads.
ALTER TABLE distributors ADD COLUMN user_id TEXT;
ALTER TABLE distributors ADD COLUMN gst_number TEXT;
ALTER TABLE distributors ADD COLUMN pan_number TEXT;
ALTER TABLE distributors ADD COLUMN state TEXT;
ALTER TABLE distributors ADD COLUMN district TEXT;
ALTER TABLE distributors ADD COLUMN drug_license TEXT;
ALTER TABLE distributors ADD COLUMN payment_details TEXT DEFAULT '{}';
ALTER TABLE distributors ADD COLUMN ledger TEXT DEFAULT '[]';
ALTER TABLE distributors ADD COLUMN opening_balance REAL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_distributors_name ON distributors(name);

-- ─── inventory ─────────────────────────────────────────────────────────────
-- Local was missing several unit-conversion + scheme + ownership columns that
-- the POS, PurchaseEntry, and Inventory screens write into. Without these the
-- row was being truncated on every offline save and every pulled refresh.
ALTER TABLE inventory ADD COLUMN user_id TEXT;
ALTER TABLE inventory ADD COLUMN manufacturer TEXT;
ALTER TABLE inventory ADD COLUMN code TEXT;
ALTER TABLE inventory ADD COLUMN pack_unit TEXT;
ALTER TABLE inventory ADD COLUMN base_unit TEXT;
ALTER TABLE inventory ADD COLUMN outer_pack TEXT;
ALTER TABLE inventory ADD COLUMN units_per_outer_pack INTEGER DEFAULT 0;
ALTER TABLE inventory ADD COLUMN unit_of_measurement TEXT;
ALTER TABLE inventory ADD COLUMN tax_basis TEXT DEFAULT '1-Tax Exclusive';
ALTER TABLE inventory ADD COLUMN deal INTEGER DEFAULT 0;
ALTER TABLE inventory ADD COLUMN free INTEGER DEFAULT 0;
ALTER TABLE inventory ADD COLUMN purchase_deal INTEGER DEFAULT 0;
ALTER TABLE inventory ADD COLUMN purchase_free INTEGER DEFAULT 0;
ALTER TABLE inventory ADD COLUMN description TEXT;
ALTER TABLE inventory ADD COLUMN country_of_origin TEXT DEFAULT 'India';
CREATE INDEX IF NOT EXISTS idx_inventory_code ON inventory(code);
CREATE INDEX IF NOT EXISTS idx_inventory_expiry ON inventory(expiry);

-- ─── material_master ───────────────────────────────────────────────────────
-- Production catalog carries marketing copy + ownership tracking that the
-- Material Master form writes into when a user fills the detail panel.
ALTER TABLE material_master ADD COLUMN user_id TEXT;
ALTER TABLE material_master ADD COLUMN storage TEXT;
ALTER TABLE material_master ADD COLUMN uses TEXT;
ALTER TABLE material_master ADD COLUMN side_effects TEXT;
ALTER TABLE material_master ADD COLUMN benefits TEXT;
ALTER TABLE material_master ADD COLUMN country_of_origin TEXT DEFAULT 'India';
ALTER TABLE material_master ADD COLUMN imei_required INTEGER DEFAULT 0;
ALTER TABLE material_master ADD COLUMN product_discount REAL DEFAULT 0;

-- ─── purchases ─────────────────────────────────────────────────────────────
-- Production purchases carries scheme/discount breakdown and e-way bill data.
-- Without these locally, every offline purchase save lost everything except
-- the basic totals, so reports built off the local mirror under-reported.
ALTER TABLE purchases ADD COLUMN user_id TEXT;
ALTER TABLE purchases ADD COLUMN total_item_discount REAL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN total_item_scheme_discount REAL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN scheme_discount REAL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN round_off REAL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN e_way_bill_no TEXT;
ALTER TABLE purchases ADD COLUMN e_way_bill_date TEXT;
ALTER TABLE purchases ADD COLUMN reference_doc_number TEXT;
ALTER TABLE purchases ADD COLUMN idempotency_key TEXT;
ALTER TABLE purchases ADD COLUMN linked_challans TEXT;

-- ─── purchase_orders ───────────────────────────────────────────────────────
-- Local schema invented a column called po_serial_id, whereas Supabase uses
-- serial_id. The pull adapter dropped the real Supabase column because
-- po_serial_id isn't on the server. Add the canonical name as a sibling so
-- both code paths populate it. po_serial_id stays as a dead alias.
ALTER TABLE purchase_orders ADD COLUMN serial_id TEXT;
ALTER TABLE purchase_orders ADD COLUMN distributor_id TEXT;
ALTER TABLE purchase_orders ADD COLUMN distributor_name TEXT;
ALTER TABLE purchase_orders ADD COLUMN sender_email TEXT;
ALTER TABLE purchase_orders ADD COLUMN sync_status TEXT DEFAULT 'pending';
ALTER TABLE purchase_orders ADD COLUMN total_items INTEGER DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN remarks TEXT;
ALTER TABLE purchase_orders ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_po_serial ON purchase_orders(serial_id);

-- ─── sales_challans / delivery_challans ────────────────────────────────────
-- Both were missing the financial breakdown columns (subtotal, total_gst)
-- and the customer/supplier link columns the conversion-to-bill flow relies
-- on. Local rows looked complete in JSON but lost half their fields on pull.
ALTER TABLE sales_challans ADD COLUMN customer_id TEXT;
ALTER TABLE sales_challans ADD COLUMN customer_phone TEXT;
ALTER TABLE sales_challans ADD COLUMN subtotal REAL DEFAULT 0;
ALTER TABLE sales_challans ADD COLUMN total_gst REAL DEFAULT 0;
ALTER TABLE sales_challans ADD COLUMN remarks TEXT;
ALTER TABLE sales_challans ADD COLUMN narration TEXT;
ALTER TABLE sales_challans ADD COLUMN user_id TEXT;
ALTER TABLE sales_challans ADD COLUMN updated_at TEXT;

ALTER TABLE delivery_challans ADD COLUMN challan_number TEXT;
ALTER TABLE delivery_challans ADD COLUMN subtotal REAL DEFAULT 0;
ALTER TABLE delivery_challans ADD COLUMN total_gst REAL DEFAULT 0;
ALTER TABLE delivery_challans ADD COLUMN remarks TEXT;
ALTER TABLE delivery_challans ADD COLUMN user_id TEXT;
ALTER TABLE delivery_challans ADD COLUMN updated_at TEXT;

-- ─── sales_returns / purchase_returns ──────────────────────────────────────
-- Local schema invented original_bill_id / original_purchase_id, whereas
-- Supabase uses original_invoice_id on both. Same fix as purchase_orders: add the
-- canonical name. Also adds customer_id/supplier_id and total_refund (the
-- canonical financial column — local had total_amount which Supabase doesn't).
ALTER TABLE sales_returns ADD COLUMN original_invoice_id TEXT;
ALTER TABLE sales_returns ADD COLUMN customer_id TEXT;
ALTER TABLE sales_returns ADD COLUMN total_refund REAL DEFAULT 0;
ALTER TABLE sales_returns ADD COLUMN user_id TEXT;

ALTER TABLE purchase_returns ADD COLUMN original_invoice_id TEXT;
ALTER TABLE purchase_returns ADD COLUMN supplier_id TEXT;
ALTER TABLE purchase_returns ADD COLUMN total_refund REAL DEFAULT 0;
ALTER TABLE purchase_returns ADD COLUMN user_id TEXT;

-- ─── sales_bill ────────────────────────────────────────────────────────────
-- Migration 008 added most extension columns, but missed three that the
-- POS save path writes (item_count is computed by the schema cache, and
-- adjustment + narration are user-entered). Without these locally,
-- "subtotal + adjustment = total" computations after a refresh broke.
ALTER TABLE sales_bill ADD COLUMN item_count INTEGER DEFAULT 0;
ALTER TABLE sales_bill ADD COLUMN adjustment REAL DEFAULT 0;
ALTER TABLE sales_bill ADD COLUMN narration TEXT;

-- ─── categories / sub_categories ───────────────────────────────────────────
ALTER TABLE categories ADD COLUMN description TEXT;
ALTER TABLE categories ADD COLUMN image_url TEXT;
ALTER TABLE sub_categories ADD COLUMN description TEXT;

-- ─── profiles ──────────────────────────────────────────────────────────────
-- The profile-settings screen writes manager_mobile + organization_type +
-- area (see services/storageService.ts:saveProfile path). Local schema didn't
-- have them so they were silently lost on every save.
ALTER TABLE profiles ADD COLUMN manager_mobile TEXT;
ALTER TABLE profiles ADD COLUMN organization_type TEXT;
ALTER TABLE profiles ADD COLUMN area TEXT;
ALTER TABLE profiles ADD COLUMN city TEXT;

-- ─── physical_inventory ────────────────────────────────────────────────────
-- Production carries a 'reason' column the local schema lacks, and the
-- updated_at audit column is missing locally (only created_at was defined).
ALTER TABLE physical_inventory ADD COLUMN reason TEXT;
ALTER TABLE physical_inventory ADD COLUMN updated_at TEXT;
ALTER TABLE physical_inventory ADD COLUMN user_id TEXT;

-- ─── promotions ────────────────────────────────────────────────────────────
-- The local schema modelled promotions as { type, rules } but the production
-- table uses { slug, description, start_date, end_date, status, priority,
-- applies_to, assignment, discount_type, discount_value, max_discount_amount,
-- is_gst_inclusive, channels }. Add the canonical columns and keep the
-- local "type" and "rules" columns as legacy aliases (no app code reads them).
ALTER TABLE promotions ADD COLUMN slug TEXT;
ALTER TABLE promotions ADD COLUMN description TEXT;
ALTER TABLE promotions ADD COLUMN start_date TEXT;
ALTER TABLE promotions ADD COLUMN end_date TEXT;
ALTER TABLE promotions ADD COLUMN status TEXT DEFAULT 'draft';
ALTER TABLE promotions ADD COLUMN priority INTEGER DEFAULT 0;
ALTER TABLE promotions ADD COLUMN applies_to TEXT;
ALTER TABLE promotions ADD COLUMN assignment TEXT DEFAULT '{}';
ALTER TABLE promotions ADD COLUMN discount_type TEXT;
ALTER TABLE promotions ADD COLUMN discount_value REAL DEFAULT 0;
ALTER TABLE promotions ADD COLUMN max_discount_amount REAL;
ALTER TABLE promotions ADD COLUMN is_gst_inclusive INTEGER DEFAULT 0;
ALTER TABLE promotions ADD COLUMN channels TEXT;

-- ─── mrp_change_log ────────────────────────────────────────────────────────
-- Production uses (material_code, product_name, changed_at, changed_by_id,
-- changed_by_name, source_screen). Local stored (inventory_id, changed_by).
-- The local model was for an old aggregate-by-inventory log, whereas the current
-- production model is by material_code. Add the canonical columns so pulls
-- populate them.
ALTER TABLE mrp_change_log ADD COLUMN material_code TEXT;
ALTER TABLE mrp_change_log ADD COLUMN product_name TEXT;
ALTER TABLE mrp_change_log ADD COLUMN changed_at TEXT;
ALTER TABLE mrp_change_log ADD COLUMN changed_by_id TEXT;
ALTER TABLE mrp_change_log ADD COLUMN changed_by_name TEXT;
ALTER TABLE mrp_change_log ADD COLUMN source_screen TEXT;

-- ─── team_members ──────────────────────────────────────────────────────────
-- The schema mostly matches, but the password-tracking and lock-state fields
-- the legacy IDB representation used aren't on Supabase — and the production
-- table uses 'technical_id' which DOES exist locally. We just need updated_at
-- to be writable (it already exists) and to mirror the 'is_locked' boolean.
-- No columns needed here today.

-- ─── force re-pull for every patched table ─────────────────────────────────
-- Same logic as migrations 009 and 010: clearing the timestamp causes the
-- next SyncPuller cycle to do a full pull (no delta filter), so existing
-- rows get rewritten with the columns that were previously dropped.
DELETE FROM _sync_meta WHERE table_name IN (
  'doctor_master','distributors','inventory','material_master','purchases',
  'purchase_orders','sales_challans','delivery_challans','sales_returns',
  'purchase_returns','sales_bill','categories','sub_categories','profiles',
  'physical_inventory','promotions','mrp_change_log'
);
`;
