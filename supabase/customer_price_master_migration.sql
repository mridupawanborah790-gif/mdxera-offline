-- ========================================================
-- CUSTOMER PRICE MASTER: Supabase Migration
-- Adds FK Price, status, and audit columns to the existing
-- customer_price_list table. Also adds performance indexes
-- and a unique partial index to prevent duplicate active
-- records per customer+material combination.
-- ========================================================

-- 1. CREATE TABLE IF NOT EXISTS
CREATE TABLE IF NOT EXISTS public.customer_price_list (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  customer_id text NOT NULL,
  material_id text,
  discount_percent numeric DEFAULT 0,
  special_price numeric,
  fk_price numeric DEFAULT NULL,
  status text DEFAULT 'active',
  created_by text,
  modified_by text,
  modified_at timestamptz,
  item_name text,
  customer_name text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. ADD NEW COLUMNS (for safety if table existed prior)
ALTER TABLE public.customer_price_list ALTER COLUMN organization_id SET DEFAULT public.get_my_org_id();
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS fk_price numeric DEFAULT NULL;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS modified_by text;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS modified_at timestamptz;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS item_name text;
ALTER TABLE public.customer_price_list ADD COLUMN IF NOT EXISTS customer_name text;

-- 2. BACKFILL: set status = 'active' for all existing rows
UPDATE public.customer_price_list SET status = 'active' WHERE status IS NULL;

-- 3. DEACTIVATE OLD DUPLICATE ACTIVE ROWS IN SUPABASE
WITH duplicates AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY organization_id, customer_id, material_id
           ORDER BY updated_at DESC, created_at DESC
         ) as rn
  FROM public.customer_price_list
  WHERE status = 'active'
)
UPDATE public.customer_price_list
SET status = 'inactive'
WHERE id IN (
  SELECT id FROM duplicates WHERE rn > 1
);

-- 4. UNIQUE PARTIAL INDEX & TRIGGER FOR AUTO-DEACTIVATION
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpl_unique_active_customer_material
  ON public.customer_price_list (organization_id, customer_id, material_id)
  WHERE status = 'active';

-- Automatic Trigger: Deactivates previous active rows when a new active row is inserted/upserted
CREATE OR REPLACE FUNCTION public.deactivate_previous_customer_price_entry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' THEN
    UPDATE public.customer_price_list
    SET status = 'inactive',
        modified_at = now()
    WHERE organization_id = NEW.organization_id
      AND customer_id = NEW.customer_id
      AND material_id = NEW.material_id
      AND status = 'active'
      AND id != NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_deactivate_previous_customer_price ON public.customer_price_list;

CREATE TRIGGER trg_deactivate_previous_customer_price
BEFORE INSERT OR UPDATE ON public.customer_price_list
FOR EACH ROW
EXECUTE FUNCTION public.deactivate_previous_customer_price_entry();

-- 4. PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_cpl_customer_material_status
  ON public.customer_price_list (customer_id, material_id, status);

CREATE INDEX IF NOT EXISTS idx_cpl_org_status
  ON public.customer_price_list (organization_id, status);

-- 6. SECURITY HELPER FUNCTION (JWT + Profile lookup)
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS text AS $$
DECLARE
  found_org_id text;
BEGIN
  found_org_id := (auth.jwt() ->> 'organization_id');
  IF found_org_id IS NOT NULL AND found_org_id != '' THEN
    RETURN found_org_id;
  END IF;

  SELECT organization_id::text INTO found_org_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1;
  RETURN COALESCE(found_org_id, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 7. ROW LEVEL SECURITY (Supports Authenticated Sync Pushes)
ALTER TABLE public.customer_price_list ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org isolation for customer_price_list" ON public.customer_price_list;
DROP POLICY IF EXISTS "Org isolation policy" ON public.customer_price_list;

CREATE POLICY "Org isolation policy"
ON public.customer_price_list FOR ALL
TO authenticated, anon
USING (
  COALESCE((auth.jwt() ->> 'role') = 'service_role', false) OR
  organization_id IS NULL OR
  organization_id::text = public.get_my_org_id() OR
  public.get_my_org_id() = ''
)
WITH CHECK (
  COALESCE((auth.jwt() ->> 'role') = 'service_role', false) OR
  organization_id IS NULL OR
  organization_id::text = public.get_my_org_id() OR
  public.get_my_org_id() = ''
);

-- 8. ADD PRICING_PRIORITY TO CONFIGURATIONS TABLE IF MISSING
ALTER TABLE public.configurations ADD COLUMN IF NOT EXISTS pricing_priority jsonb DEFAULT NULL;

-- 9. RELOAD API CACHE
NOTIFY pgrst, 'reload schema';
