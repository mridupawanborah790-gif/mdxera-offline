-- ========================================================
-- MEDIMART RETAIL ERP: BUSINESS ROLES & ACCESS CONTROL
-- Defines reusable permission templates for organizational staff.
-- ========================================================

-- 1. PRE-REQUISITES
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. SECURITY HELPER (Ensures organizational data isolation)
-- This function identifies the organization of the currently logged-in user.
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS text AS $$
DECLARE
  found_org_id text;
BEGIN
  SELECT organization_id::text INTO found_org_id FROM public.profiles WHERE user_id = auth.uid();
  RETURN COALESCE(found_org_id, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 3. DROP AND RECREATE BUSINESS_ROLES TABLE
-- CASCADE ensures dependent policies and triggers are also refreshed.
DROP TABLE IF EXISTS public.business_roles CASCADE;

CREATE TABLE public.business_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL, -- Isolated by Root Organization Identity
    
    -- Role Identity
    name text NOT NULL,
    description text,
    
    -- Permissions Matrix
    -- Stored as JSONB to hold the array of WorkCenters and their assigned views.
    -- Example Structure: [{ "id": "sales", "name": "Sales", "views": [{ "id": "pos", "name": "POS", "assigned": true }] }]
    work_centers jsonb NOT NULL DEFAULT '[]'::jsonb,
    permissions_matrix jsonb DEFAULT '{}'::jsonb,
    
    -- System Controls
    is_system_role boolean DEFAULT false, -- Protects built-in roles from deletion
    is_active boolean DEFAULT true,
    
    -- System Audit
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 4. PERFORMANCE INDEXING
-- Optimized for search and organization-level lookups
CREATE INDEX IF NOT EXISTS idx_business_roles_org ON public.business_roles(organization_id);
CREATE INDEX IF NOT EXISTS idx_business_roles_name ON public.business_roles(organization_id, lower(name));

-- 5. MULTI-TENANT ROW LEVEL SECURITY (RLS)
ALTER TABLE public.business_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org isolation for business_roles" ON public.business_roles;

-- Policy ensures users can only interact with roles belonging to their specific organization
CREATE POLICY "Org isolation for business_roles"
ON public.business_roles FOR ALL
TO authenticated
USING (organization_id::text = public.get_my_org_id())
WITH CHECK (organization_id::text = public.get_my_org_id());

-- 6. AUTOMATED TIMESTAMP TRIGGER
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = now();
   RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS tr_update_business_roles_modtime ON public.business_roles;
CREATE TRIGGER tr_update_business_roles_modtime 
BEFORE UPDATE ON public.business_roles 
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 7. SEED DEFAULT TEMPLATES (Helper function to be called on Org Init)
-- These represent standard pharmaceutical industry roles.
CREATE OR REPLACE FUNCTION public.seed_default_org_roles(target_org_id text)
RETURNS void AS $$
BEGIN
    INSERT INTO public.business_roles (organization_id, name, description, is_system_role, work_centers)
    VALUES 
    (target_org_id, 'PHARMACIST', 'Full access to sales, returns, and material master.', true, '[
        {"id": "sales", "name": "Sales & Distribution", "views": [{"id": "pos", "name": "POS Billing", "assigned": true}, {"id": "returns", "name": "Sales Returns", "assigned": true}, {"id": "history", "name": "Sales History", "assigned": true}]},
        {"id": "inventory", "name": "Inventory Management", "views": [{"id": "inv_list", "name": "Current Inventory", "assigned": true}, {"id": "master", "name": "Material Master", "assigned": true}]}
    ]'::jsonb),
    (target_org_id, 'SALES CLERK', 'Restricted to billing and sales history only.', true, '[
        {"id": "sales", "name": "Sales & Distribution", "views": [{"id": "pos", "name": "POS Billing", "assigned": true}, {"id": "history", "name": "Sales History", "assigned": true}]}
    ]'::jsonb),
    (target_org_id, 'INVENTORY MANAGER', 'Full control over stock, audits, and purchases.', true, '[
        {"id": "purchasing", "name": "Purchasing", "views": [{"id": "pur_entry", "name": "Purchase Entry", "assigned": true}, {"id": "orders", "name": "Purchase Orders", "assigned": true}]},
        {"id": "inventory", "name": "Inventory Management", "views": [{"id": "inv_list", "name": "Current Inventory", "assigned": true}, {"id": "audit", "name": "Stock Audit", "assigned": true}]}
    ]'::jsonb);
END;
$$ LANGUAGE plpgsql;

-- 8. METADATA COMMENTS
COMMENT ON TABLE public.business_roles IS 'Defines reusable access permission sets (roles) for organization staff.';
COMMENT ON COLUMN public.business_roles.work_centers IS 'JSONB matrix defining accessible work centers and specific UI views.';

-- 9. RELOAD SCHEMA CACHE
NOTIFY pgrst, 'reload schema';