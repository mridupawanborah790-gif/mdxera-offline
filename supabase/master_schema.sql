
-- ========================================================
-- MEDIMART RETAIL ERP: MASTER DATABASE SCHEMA
-- Enterprise-grade, Multi-tenant, Pharmaceutical Optimized
-- ========================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 2. CORE ENUMS & TYPES
DO $$ BEGIN
    CREATE TYPE public.user_role AS ENUM ('owner', 'admin', 'manager', 'purchase', 'clerk', 'viewer');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 3. UTILITY FUNCTIONS
-- Automatically updates the 'updated_at' column on any modification
CREATE OR REPLACE FUNCTION public.fn_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = now();
   RETURN NEW;
END;
$$ language 'plpgsql';

-- 4. SECURITY & ISOLATION HELPER
-- SECURITY DEFINER allows RLS policies to perform internal lookups during evaluation
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS text AS $$
DECLARE
  found_org_id text;
BEGIN
  SELECT organization_id::text INTO found_org_id FROM public.profiles WHERE user_id = auth.uid();
  RETURN COALESCE(found_org_id, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 5. IDENTITY & ACCESS CONTROL

-- PROFILES: Link Supabase Auth users to an Organizational Identity
CREATE TABLE IF NOT EXISTS public.profiles (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    email text NOT NULL,
    full_name text,
    pharmacy_name text,
    manager_name text,
    role public.user_role DEFAULT 'clerk',
    is_active boolean DEFAULT true,
    
    -- Business Information
    address text,
    address_line2 text,
    pincode text,
    district text,
    state text,
    mobile text,
    gstin text,
    retailer_gstin text,
    drug_license text,
    dl_valid_to date,
    food_license text,
    pan_number text,
    
    -- Settlement Details
    bank_account_name text,
    bank_account_number text,
    bank_ifsc_code text,
    bank_upi_id text,
    authorized_signatory text,
    pharmacy_logo_url text,
    
    -- Document Policies
    terms_and_conditions text,
    purchase_order_terms text,
    
    -- Subscription
    subscription_plan text DEFAULT 'starter',
    subscription_status text DEFAULT 'active',
    subscription_id text,
    
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- CONFIGURATIONS: Organization-level settings and numbering series
CREATE TABLE IF NOT EXISTS public.configurations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL UNIQUE,
    invoice_config jsonb,
    non_gst_invoice_config jsonb,
    purchase_config jsonb,
    purchase_order_config jsonb,
    medicine_master_config jsonb,
    physical_inventory_config jsonb,
    delivery_challan_config jsonb,
    sales_challan_config jsonb,
    master_shortcuts text[],
    display_options jsonb,
    modules jsonb,
    sidebar jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- BUSINESS ROLES: Reusable permission templates
CREATE TABLE IF NOT EXISTS public.business_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    name text NOT NULL,
    description text,
    work_centers jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_system_role boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- TEAM MEMBERS: Organizational staff identities
CREATE TABLE IF NOT EXISTS public.team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    technical_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    email text NOT NULL,
    name text NOT NULL,
    role public.user_role DEFAULT 'clerk',
    status text DEFAULT 'active',
    employee_id text,
    department text,
    is_locked boolean DEFAULT false,
    assigned_roles uuid[],
    work_centers jsonb DEFAULT '[]'::jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 6. MATERIAL & INVENTORY DATA

-- MATERIAL MASTER: The authoritative Global SKU Catalog
CREATE TABLE IF NOT EXISTS public.material_master (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    name text NOT NULL,
    material_code text NOT NULL,
    barcode text,
    brand text,
    manufacturer text,
    marketer text,
    composition text,
    pack text,
    description text,
    directions text,
    gst_rate numeric DEFAULT 12,
    hsn_code text,
    mrp numeric DEFAULT 0,
    rate_a numeric DEFAULT 0,
    rate_b numeric DEFAULT 0,
    rate_c numeric DEFAULT 0,
    valuation_method text NOT NULL DEFAULT 'standard' CHECK (valuation_method IN ('standard', 'moving_average')),
    standard_price_rate numeric(18, 4) NOT NULL DEFAULT 0 CHECK (standard_price_rate >= 0),
    moving_average_rate numeric(18, 4) NOT NULL DEFAULT 0 CHECK (moving_average_rate >= 0),
    is_prescription_required boolean DEFAULT true,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE(organization_id, material_code)
);

-- INVENTORY: Real-time batch-wise stock and aging
CREATE TABLE IF NOT EXISTS public.inventory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    name text NOT NULL,
    brand text,
    category text DEFAULT 'General',
    batch text NOT NULL,
    expiry date,
    stock numeric NOT NULL DEFAULT 0,
    min_stock_limit numeric DEFAULT 10,
    units_per_pack integer DEFAULT 1,
    pack_type text,
    purchase_price numeric DEFAULT 0,
    ptr numeric DEFAULT 0,
    mrp numeric NOT NULL DEFAULT 0,
    rate_a numeric DEFAULT 0,
    rate_b numeric DEFAULT 0,
    rate_c numeric DEFAULT 0,
    gst_percent numeric DEFAULT 12,
    hsn_code text,
    barcode text,
    composition text,
    supplier_name text,
    rack_number text,
    cost numeric DEFAULT 0,
    value numeric DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- SUPPLIER PRODUCT MAP: Vendor nomenclature synchronization
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
CREATE UNIQUE INDEX idx_spm_unique_mapping ON public.supplier_product_map (organization_id, supplier_id, lower(supplier_product_name));

-- 7. TRANSACTION REGISTERS

-- SUPPLIERS (Accounts Payable)
CREATE TABLE IF NOT EXISTS public.suppliers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    name text NOT NULL,
    category text DEFAULT 'Wholesaler',
    supplier_group text DEFAULT 'Sundry Creditors',
    control_gl_id uuid REFERENCES public.gl_master(id) ON DELETE RESTRICT,
    gst_number text,
    phone text,
    email text,
    address text,
    state text,
    district text,
    payment_details jsonb DEFAULT '{}'::jsonb,
    ledger jsonb DEFAULT '[]'::jsonb,
    opening_balance numeric DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- CUSTOMERS (Accounts Receivable)
CREATE TABLE IF NOT EXISTS public.customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    name text NOT NULL,
    phone text,
    email text,
    address text,
    gst_number text,
    ledger jsonb DEFAULT '[]'::jsonb,
    opening_balance numeric DEFAULT 0,
    default_discount numeric DEFAULT 0,
    customer_type text DEFAULT 'regular',
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- SALES BILL (Outward Invoices)
CREATE TABLE IF NOT EXISTS public.sales_bill (
    id text PRIMARY KEY,
    organization_id text NOT NULL,
    user_id uuid REFERENCES auth.users(id),
    date timestamptz NOT NULL DEFAULT now(),
    customer_name text NOT NULL,
    customer_id uuid,
    customer_phone text,
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    subtotal numeric(15,2) DEFAULT 0,
    total_item_discount numeric(15,2) DEFAULT 0,
    total_gst numeric(15,2) DEFAULT 0,
    scheme_discount numeric(15,2) DEFAULT 0,
    round_off numeric(10,2) DEFAULT 0,
    total numeric(15,2) DEFAULT 0,
    status text DEFAULT 'completed',
    payment_mode text DEFAULT 'Cash',
    pricing_mode text DEFAULT 'mrp',
    bill_type text DEFAULT 'regular',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- PURCHASES (Inward Bills)
CREATE TABLE IF NOT EXISTS public.purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_serial_id text NOT NULL,
    organization_id text NOT NULL,
    supplier text NOT NULL,
    invoice_number text NOT NULL,
    date date NOT NULL DEFAULT CURRENT_DATE,
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    total_amount numeric(15,2) DEFAULT 0,
    subtotal numeric(15,2) DEFAULT 0,
    total_gst numeric(15,2) DEFAULT 0,
    status text DEFAULT 'completed',
    pricing_mode text DEFAULT 'rate',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 8. LOGISTICS & AUDIT

-- DELIVERY CHALLANS (Inward)
CREATE TABLE IF NOT EXISTS public.delivery_challans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    challan_serial_id text NOT NULL,
    supplier text NOT NULL,
    date timestamptz NOT NULL DEFAULT now(),
    items jsonb DEFAULT '[]'::jsonb,
    total_amount numeric(15,2) DEFAULT 0,
    status text DEFAULT 'open',
    pricing_mode text DEFAULT 'rate',
    created_at timestamptz DEFAULT now()
);

-- SALES CHALLANS (Outward)
CREATE TABLE IF NOT EXISTS public.sales_challans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    challan_serial_id text NOT NULL,
    customer_name text NOT NULL,
    date timestamptz NOT NULL DEFAULT now(),
    items jsonb DEFAULT '[]'::jsonb,
    total_amount numeric(15,2) DEFAULT 0,
    status text DEFAULT 'open',
    pricing_mode text DEFAULT 'mrp',
    created_at timestamptz DEFAULT now()
);

-- PHYSICAL INVENTORY (Stock Audit)
CREATE TABLE IF NOT EXISTS public.physical_inventory (
    id text PRIMARY KEY,
    organization_id text NOT NULL,
    status text DEFAULT 'in_progress',
    start_date timestamptz NOT NULL DEFAULT now(),
    end_date timestamptz,
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    total_variance_value numeric DEFAULT 0,
    performed_by_name text,
    created_at timestamptz DEFAULT now()
);

-- 9. ROW LEVEL SECURITY (RLS) POLICIES
DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN 
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('profiles')
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS "Org isolation policy" ON public.%I', tbl);
        EXECUTE format('CREATE POLICY "Org isolation policy" ON public.%I FOR ALL TO authenticated USING (organization_id::text = public.get_my_org_id()) WITH CHECK (organization_id::text = public.get_my_org_id())', tbl);
    END LOOP;
END $$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles are self-managed" ON public.profiles FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 10. AUTOMATED TIMESTAMP TRIGGERS
DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN 
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tr_update_%I_modtime ON public.%I', tbl, tbl);
        EXECUTE format('CREATE TRIGGER tr_update_%I_modtime BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp()', tbl, tbl);
    END LOOP;
END $$;

-- 11. AUTH SIGNUP TRIGGER
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  target_org_id text;
BEGIN
  target_org_id := COALESCE(new.raw_user_meta_data->>'organization_id', gen_random_uuid()::text);
  
  INSERT INTO public.profiles (user_id, organization_id, email, full_name, pharmacy_name, role)
  VALUES (
    new.id,
    target_org_id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', 'System User'),
    COALESCE(new.raw_user_meta_data->>'pharmacy_name', 'Medimart Retail'),
    'owner'
  ) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.configurations (organization_id)
  VALUES (target_org_id)
  ON CONFLICT (organization_id) DO NOTHING;
  
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 12. COMPATIBILITY VIEWS
CREATE OR REPLACE VIEW public.transactions AS SELECT * FROM public.sales_bill;
CREATE OR REPLACE VIEW public.medicine_master AS SELECT * FROM public.material_master;
CREATE OR REPLACE VIEW public.distributors AS SELECT * FROM public.suppliers;

NOTIFY pgrst, 'reload schema';


--no need to import now in supabase, will do it later, once other setup are completed
