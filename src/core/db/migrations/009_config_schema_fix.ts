// Fixes a long-standing schema drift between local SQLite and Supabase for the
// company-configuration master tables. The initial migration (001) only
// captured a handful of columns for gl_assignments / set_of_books / gl_master /
// company_codes / configurations — but the live Supabase schema (see
// company_configuration_schema.sql) has many more, including the columns the
// app actually queries to resolve a control GL for a customer / supplier
// (assignment_scope, party_type, party_group, control_gl_id, active_status,
// default_customer_gl_id, default_supplier_gl_id, …).
//
// Because columnFilter.adaptRowForSqlite() silently drops unknown columns on
// pull, the local mirror was populated with rows that had every meaningful
// column stripped. That made resolvePartyControlGlByGroup throw "no such
// column: assignment_scope", land in its catch, and fall through to the
// "Internet connection required" path — which is why creating a customer
// offline appeared to require internet even though the bill itself could be
// queued locally.
//
// This migration:
//   1. ALTERs the five tables to add every column the app reads.
//      (SQLite is dynamically typed, so the pre-existing INTEGER-affinity
//       `active_status` columns happily store 'Active' / 'Inactive' text.)
//   2. Clears _sync_meta.last_pulled_at for those tables so the next
//      SyncPuller cycle does a full re-pull from Supabase (the delta filter
//      `gt(updated_at, since)` is bypassed when last_pulled_at is null).
//   3. Marks the corresponding _initial_sync_state rows incomplete so
//      isForegroundComplete() returns false → InitialSync re-pulls them with
//      the modal. Necessary because the locally cached rows have empty values
//      for every newly-added column; only a re-pull populates them.
//
// SQLite does NOT support `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so this
// must run exactly once. The _migrations row records that.
export const SQL_009_CONFIG_SCHEMA_FIX = `
-- ─── gl_assignments ────────────────────────────────────────────────────────
ALTER TABLE gl_assignments ADD COLUMN assignment_scope TEXT DEFAULT 'MATERIAL';
ALTER TABLE gl_assignments ADD COLUMN material_master_type TEXT;
ALTER TABLE gl_assignments ADD COLUMN party_type TEXT;
ALTER TABLE gl_assignments ADD COLUMN party_group TEXT;
ALTER TABLE gl_assignments ADD COLUMN control_gl_id TEXT;
ALTER TABLE gl_assignments ADD COLUMN inventory_gl TEXT;
ALTER TABLE gl_assignments ADD COLUMN purchase_gl TEXT;
ALTER TABLE gl_assignments ADD COLUMN cogs_gl TEXT;
ALTER TABLE gl_assignments ADD COLUMN sales_gl TEXT;
ALTER TABLE gl_assignments ADD COLUMN discount_gl TEXT;
ALTER TABLE gl_assignments ADD COLUMN tax_gl TEXT;
ALTER TABLE gl_assignments ADD COLUMN active_status TEXT DEFAULT 'Active';
ALTER TABLE gl_assignments ADD COLUMN seeded_by_system INTEGER DEFAULT 0;
ALTER TABLE gl_assignments ADD COLUMN template_version TEXT DEFAULT 'v1.0';
ALTER TABLE gl_assignments ADD COLUMN created_by TEXT DEFAULT 'system';
ALTER TABLE gl_assignments ADD COLUMN updated_by TEXT DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_gl_assignments_lookup
  ON gl_assignments(organization_id, set_of_books_id, assignment_scope, party_type, party_group);

-- ─── set_of_books ──────────────────────────────────────────────────────────
ALTER TABLE set_of_books ADD COLUMN default_customer_gl_id TEXT;
ALTER TABLE set_of_books ADD COLUMN default_supplier_gl_id TEXT;
ALTER TABLE set_of_books ADD COLUMN default_currency TEXT DEFAULT 'INR';
ALTER TABLE set_of_books ADD COLUMN posting_count INTEGER DEFAULT 0;
ALTER TABLE set_of_books ADD COLUMN created_by TEXT DEFAULT 'system';
ALTER TABLE set_of_books ADD COLUMN updated_by TEXT DEFAULT 'system';

-- ─── gl_master ─────────────────────────────────────────────────────────────
ALTER TABLE gl_master ADD COLUMN posting_allowed INTEGER DEFAULT 1;
ALTER TABLE gl_master ADD COLUMN control_account INTEGER DEFAULT 0;
ALTER TABLE gl_master ADD COLUMN seeded_by_system INTEGER DEFAULT 0;
ALTER TABLE gl_master ADD COLUMN template_version TEXT DEFAULT 'v1.0';
ALTER TABLE gl_master ADD COLUMN posting_count INTEGER DEFAULT 0;
ALTER TABLE gl_master ADD COLUMN created_by TEXT DEFAULT 'system';
ALTER TABLE gl_master ADD COLUMN updated_by TEXT DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_gl_master_lookup
  ON gl_master(organization_id, set_of_books_id, gl_code);

-- ─── company_codes ─────────────────────────────────────────────────────────
ALTER TABLE company_codes ADD COLUMN is_default INTEGER DEFAULT 0;
ALTER TABLE company_codes ADD COLUMN default_set_of_books_id TEXT;
ALTER TABLE company_codes ADD COLUMN created_by TEXT DEFAULT 'system';
ALTER TABLE company_codes ADD COLUMN updated_by TEXT DEFAULT 'system';

-- ─── configurations ───────────────────────────────────────────────────────
ALTER TABLE configurations ADD COLUMN gst_settings TEXT;
ALTER TABLE configurations ADD COLUMN fiscal_year_config TEXT;
ALTER TABLE configurations ADD COLUMN master_shortcut_order TEXT;

-- ─── force a re-pull from Supabase ─────────────────────────────────────────
-- Clearing _sync_meta makes the next SyncPuller cycle do a full pull (no
-- delta filter applied). Clearing _initial_sync_state for these tables makes
-- isForegroundComplete() return false, triggering the InitialSync modal on
-- next boot when the user is online. Offline boots are unaffected — the
-- existing skip-when-offline behaviour in SyncBootstrap handles that.
DELETE FROM _sync_meta WHERE table_name IN ('gl_assignments','set_of_books','gl_master','company_codes','configurations');
DELETE FROM _initial_sync_state WHERE table_name IN ('gl_assignments','set_of_books','gl_master','company_codes','configurations');
`;
