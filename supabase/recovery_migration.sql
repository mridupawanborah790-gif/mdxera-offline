
-- 1. Ensure Table Structure is correct
CREATE TABLE IF NOT EXISTS public.supplier_product_map (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    supplier_id uuid NOT NULL,
    supplier_product_name text NOT NULL,
    master_medicine_id uuid NOT NULL,
    auto_apply boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 2. Fix potential naming issues from previous migrations
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_product_map' AND column_name='distributorId') THEN
        ALTER TABLE public.supplier_product_map RENAME COLUMN "distributorId" TO supplier_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_product_map' AND column_name='distributor_id') THEN
        ALTER TABLE public.supplier_product_map RENAME COLUMN distributor_id TO supplier_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_product_map' AND column_name='distributorProductName') THEN
        ALTER TABLE public.supplier_product_map RENAME COLUMN "distributorProductName" TO supplier_product_name;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_product_map' AND column_name='masterMedicineId') THEN
        ALTER TABLE public.supplier_product_map RENAME COLUMN "masterMedicineId" TO master_medicine_id;
    END IF;
END $$;

-- 3. Fix Uniqueness using Index instead of Constraint to avoid syntax error with lower()
ALTER TABLE public.supplier_product_map DROP CONSTRAINT IF EXISTS supplier_product_map_unique;
DROP INDEX IF EXISTS idx_spm_unique_mapping;
CREATE UNIQUE INDEX idx_spm_unique_mapping ON public.supplier_product_map (organization_id, supplier_id, lower(supplier_product_name));

-- 4. Refresh policies
ALTER TABLE public.supplier_product_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Org isolation for mappings" ON public.supplier_product_map;

-- Re-create policy using robust lookup
CREATE POLICY "Org isolation for mappings" ON public.supplier_product_map FOR ALL TO authenticated 
USING (organization_id = (SELECT organization_id FROM public.profiles WHERE user_id = auth.uid())) 
WITH CHECK (organization_id = (SELECT organization_id FROM public.profiles WHERE user_id = auth.uid()));

NOTIFY pgrst, 'reload schema';
