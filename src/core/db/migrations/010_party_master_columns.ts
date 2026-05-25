// Same root-cause as migration 009 (config tables) — the initial migration
// only captured a thin slice of the live Supabase schema for `customers` and
// `suppliers`. The production tables have address breakdowns
// (address_line1/2, area, pincode, district, state), credit-control fields,
// CRM/assignment fields, group + control-GL fields, and audit columns that
// the local SQLite mirror never had columns for.
//
// columnFilter.adaptRowForSqlite() silently drops every unknown column on
// pull, so a customer created either online or offline ends up locally as
// just { id, name, phone, email, address, gst_number, ledger, … } — even
// though the Supabase row (and the production web app reading from it)
// shows the full record with area, district, state, customer_group, etc.
// That's why the same Hanumankind customer renders complete on mdxera.in but
// shows mostly "N/A" inside the desktop app.
//
// This migration:
//   1. ALTERs `customers` and `suppliers` to add every column the app's
//      CUSTOMERS_ALLOWED_FIELDS / SUPPLIERS_ALLOWED_FIELDS reference (see
//      services/storageService.ts). Column types follow Supabase: text for
//      identifiers/strings, REAL for numerics, INTEGER for booleans.
//   2. Clears _sync_meta.last_pulled_at for both tables, so the next
//      SyncPuller cycle does a full re-pull instead of a delta. With the new
//      columns in place, the existing local rows get rewritten with the
//      complete record from Supabase, and the app shows the same data as the
//      web build.
//
// Re-pulling is harmless for rows the local user just created: the
// _sync_status='synced' guard in SyncPuller skips rows still marked
// 'pending', and synced rows simply get refreshed with Supabase's confirmed
// state (which by definition matches what was just pushed).
export const SQL_010_PARTY_MASTER_COLUMNS = `
-- ─── customers ──────────────────────────────────────────────────────────────
-- Auth / ownership tracking
ALTER TABLE customers ADD COLUMN user_id TEXT;
ALTER TABLE customers ADD COLUMN created_by_id TEXT;

-- Contact channels beyond the basic phone/email
ALTER TABLE customers ADD COLUMN mobile TEXT;

-- Address breakdown (the master_schema only had a single address field)
ALTER TABLE customers ADD COLUMN address_line1 TEXT;
ALTER TABLE customers ADD COLUMN address_line2 TEXT;
ALTER TABLE customers ADD COLUMN area TEXT;
ALTER TABLE customers ADD COLUMN city TEXT;
ALTER TABLE customers ADD COLUMN pincode TEXT;
ALTER TABLE customers ADD COLUMN district TEXT;
ALTER TABLE customers ADD COLUMN state TEXT;
ALTER TABLE customers ADD COLUMN country TEXT;

-- Statutory / compliance
ALTER TABLE customers ADD COLUMN pan_number TEXT;
ALTER TABLE customers ADD COLUMN drug_license TEXT;

-- Sales / commercial logic
ALTER TABLE customers ADD COLUMN default_rate_tier TEXT DEFAULT 'none';
ALTER TABLE customers ADD COLUMN credit_days INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN credit_status TEXT DEFAULT 'active';
ALTER TABLE customers ADD COLUMN credit_control_mode TEXT DEFAULT 'hard_block';
ALTER TABLE customers ADD COLUMN allow_override INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN override_approval_required INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN enable_credit_limit INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN payment_terms TEXT DEFAULT 'Due on Receipt';

-- CRM & assignment
ALTER TABLE customers ADD COLUMN assigned_staff_id TEXT;
ALTER TABLE customers ADD COLUMN assigned_staff_name TEXT;
ALTER TABLE customers ADD COLUMN referred_by TEXT;

-- Group + control-GL (server-managed via auto_map_party_control_gl trigger)
ALTER TABLE customers ADD COLUMN customer_group TEXT DEFAULT 'Sundry Debtors';
ALTER TABLE customers ADD COLUMN control_gl_id TEXT;

-- Runtime-computed display field (kept in sync by the app)
ALTER TABLE customers ADD COLUMN current_balance REAL DEFAULT 0;

-- System controls
ALTER TABLE customers ADD COLUMN is_blocked INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN remarks TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_area ON customers(area);

-- ─── suppliers ──────────────────────────────────────────────────────────────
-- Auth / ownership tracking
ALTER TABLE suppliers ADD COLUMN user_id TEXT;
ALTER TABLE suppliers ADD COLUMN created_by_id TEXT;

-- Contact channels & business identity
ALTER TABLE suppliers ADD COLUMN mobile TEXT;
ALTER TABLE suppliers ADD COLUMN contact_person TEXT;
ALTER TABLE suppliers ADD COLUMN website TEXT;
ALTER TABLE suppliers ADD COLUMN brand_agencies TEXT;

-- Address breakdown (see supplier_address_fields_update.sql for the
-- canonical column list on Supabase).
ALTER TABLE suppliers ADD COLUMN address_line1 TEXT;
ALTER TABLE suppliers ADD COLUMN address_line2 TEXT;
ALTER TABLE suppliers ADD COLUMN area TEXT;
ALTER TABLE suppliers ADD COLUMN city TEXT;
ALTER TABLE suppliers ADD COLUMN pincode TEXT;
ALTER TABLE suppliers ADD COLUMN country TEXT;

-- Statutory / compliance
ALTER TABLE suppliers ADD COLUMN pan_number TEXT;
ALTER TABLE suppliers ADD COLUMN drug_license TEXT;
ALTER TABLE suppliers ADD COLUMN food_license TEXT;
ALTER TABLE suppliers ADD COLUMN tan_number TEXT;

-- Runtime-computed display field (kept in sync by the app)
ALTER TABLE suppliers ADD COLUMN current_balance REAL DEFAULT 0;

-- System controls
ALTER TABLE suppliers ADD COLUMN is_blocked INTEGER DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN remarks TEXT;

CREATE INDEX IF NOT EXISTS idx_suppliers_org ON suppliers(organization_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

-- ─── force a full re-pull so existing rows pick up the new columns ─────────
-- Without this, SyncPuller would only fetch rows updated since the last
-- delta — leaving Hanumankind and any other historical row stuck with the
-- truncated payload. Clearing the timestamp triggers an unfiltered SELECT
-- on the next cycle.
DELETE FROM _sync_meta WHERE table_name IN ('customers','suppliers');

-- Also reset the InitialSync state for these tables in case the user is
-- mid-onboarding — guarantees the masters are pulled cleanly.
DELETE FROM _initial_sync_state WHERE table_name IN ('customers','suppliers');
`;
