-- ========================================================
-- CUSTOMER PRICE MASTER: Supabase Migration
-- Adds FK Price, status, and audit columns to the existing
-- customer_price_list table. Also adds performance indexes
-- and a unique partial index to prevent duplicate active
-- records per customer+material combination.
-- ========================================================

-- 1. ADD NEW COLUMNS
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS fk_price numeric DEFAULT NULL;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS modified_by text;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS modified_at timestamptz;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS item_name text;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS customer_name text;

-- 2. BACKFILL: set status = 'active' for all existing rows
UPDATE public.customer_price_list SET status = 'active' WHERE status IS NULL;

-- 3. UNIQUE PARTIAL INDEX
-- Prevents more than one active price master record per org+customer+material
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpl_unique_active_customer_material
  ON public.customer_price_list (organization_id, customer_id, material_id)
  WHERE status = 'active';

-- 4. PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_cpl_customer_material_status
  ON public.customer_price_list (customer_id, material_id, status);

CREATE INDEX IF NOT EXISTS idx_cpl_org_status
  ON public.customer_price_list (organization_id, status);

-- 5. ROW LEVEL SECURITY
ALTER TABLE public.customer_price_list ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org isolation for customer_price_list" ON public.customer_price_list;
CREATE POLICY "Org isolation for customer_price_list"
ON public.customer_price_list FOR ALL
TO authenticated
USING (organization_id::text = public.get_my_org_id())
WITH CHECK (organization_id::text = public.get_my_org_id());

-- 6. RELOAD API CACHE
NOTIFY pgrst, 'reload schema';
