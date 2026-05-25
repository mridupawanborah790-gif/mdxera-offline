-- ============================================================================
-- SCHEMA AUDIT RPC
-- ============================================================================
-- Deploy once via Supabase Studio → SQL Editor → New Query → paste → Run.
--
-- Companion to src/core/sync/schemaAudit.ts on the client. Lets the desktop
-- app read the LIVE column list for any table from this specific Supabase
-- deployment, so we can diff it against the local SQLite schema and report
-- column-level drift definitively (not by guessing from the repo's *.sql
-- files, which may be out of sync with what was actually applied).
--
-- Read-only, SECURITY DEFINER (so authenticated users can introspect even
-- without explicit grants on information_schema). Restricts to public schema
-- and to the table name the caller supplies — no arbitrary catalog access.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mdxera_inspect_table_columns(p_table_name text)
RETURNS TABLE (
  column_name  text,
  data_type    text,
  is_nullable  text,
  column_default text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    column_name::text,
    data_type::text,
    is_nullable::text,
    column_default::text
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = p_table_name
  ORDER BY ordinal_position;
$$;

GRANT EXECUTE ON FUNCTION public.mdxera_inspect_table_columns(text) TO authenticated;

COMMENT ON FUNCTION public.mdxera_inspect_table_columns(text) IS
  'Returns the column list for a public.* table. Used by the offline-first MDXera ERP client to diff its local SQLite schema against the live Supabase schema and report column drift. Read-only, scoped to the public schema.';

NOTIFY pgrst, 'reload schema';
