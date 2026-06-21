
-- ========================================================
-- MEDIMART RETAIL ERP: USER MANAGEMENT & ACCESS CONTROL SCHEMA
-- This script sets up the three key components requested:
-- 1. Business Roles (Access Templates)
-- 2. Business Users (Team Members / Organization Staff)
-- 3. Configuration Management
-- ========================================================

-- 1. EXTENSIONS & CORE TYPES
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$ BEGIN
    CREATE TYPE public.user_role AS ENUM ('owner', 'admin', 'manager', 'purchase', 'clerk', 'viewer');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 2. SECURITY HELPER FUNCTION
-- Used by RLS policies to find the current user's organization identity.
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS text AS $$
DECLARE
  found_org_id text;
BEGIN
  SELECT organization_id::text INTO found_org_id FROM public.profiles WHERE user_id = auth.uid();
  RETURN COALESCE(found_org_id, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 3. PROFILES TABLE (THE ANCHOR)
-- Links auth.users to an organization_id.
CREATE TABLE IF NOT EXISTS public.profiles (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    email text NOT NULL,
    full_name text,
    pharmacy_name text,
    role public.user_role DEFAULT 'clerk',
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 4. BUSINESS ROLES TABLE
-- Defines reusable permission sets (Work Centers and Views).
CREATE TABLE IF NOT EXISTS public.business_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    name text NOT NULL,
    description text,
    -- work_centers stores the JSON structure of accessible views
    work_centers jsonb NOT NULL DEFAULT '[]'::jsonb,
    permissions_matrix jsonb DEFAULT '{}'::jsonb,
    is_system_role boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 5. BUSINESS USERS (TEAM MEMBERS) TABLE
-- Extends profile information for organizational staff with security controls.
CREATE TABLE IF NOT EXISTS public.team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    technical_id uuid REFERENCES auth.users(id) ON DELETE SET NULL, -- Link to Supabase Auth
    email text NOT NULL,
    name text NOT NULL,
    role public.user_role DEFAULT 'clerk',
    status text DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
    
    -- HR & Administration
    employee_id text,
    department text DEFAULT 'GENERAL',
    company text,
    manager text,
    
    -- Security Controls
    valid_from date DEFAULT CURRENT_DATE,
    valid_to date,
    is_locked boolean DEFAULT false,
    password_locked boolean DEFAULT false,
    security_policy text DEFAULT 'Standard',
    
    -- Configuration & UX
    regional_settings jsonb DEFAULT '{
        "dateFormat": "DD-MM-YYYY",
        "timeFormat": "12H",
        "timezone": "Asia/Kolkata",
        "language": "en",
        "decimalNotation": "1,2,34.56"
    }'::jsonb,
    
    -- Role/Access Assignments
    assigned_roles uuid[], -- Array of business_roles.id
    work_centers jsonb DEFAULT '[]'::jsonb, -- Custom view overrides
    
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 6. CONFIGURATIONS TABLE
-- Global organization-level settings, voucher series, and UI preferences.
CREATE TABLE IF NOT EXISTS public.configurations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL UNIQUE,
    
    -- Voucher Numbering
    invoice_config jsonb,
    non_gst_invoice_config jsonb,
    purchase_config jsonb,
    purchase_order_config jsonb,
    medicine_master_config jsonb,
    physical_inventory_config jsonb,
    delivery_challan_config jsonb,
    sales_challan_config jsonb,
    
    -- UI & Behavior Preferences
    master_shortcuts text[],
    display_options jsonb,
    modules jsonb,
    sidebar jsonb,
    
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 7. PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_br_org ON public.business_roles (organization_id);
CREATE INDEX IF NOT EXISTS idx_tm_org ON public.team_members (organization_id);
CREATE INDEX IF NOT EXISTS idx_tm_email ON public.team_members (email);
CREATE INDEX IF NOT EXISTS idx_cfg_org ON public.configurations (organization_id);

-- 8. ROW LEVEL SECURITY (RLS) ISOLATION
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['business_roles', 'team_members', 'configurations']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS "Organization isolation" ON public.%I', tbl);
        EXECUTE format(
            'CREATE POLICY "Organization isolation" ON public.%I ' ||
            'FOR ALL TO authenticated ' ||
            'USING (organization_id = public.get_my_org_id()) ' ||
            'WITH CHECK (organization_id = public.get_my_org_id())',
            tbl
        );
    END LOOP;
END $$;

-- 9. AUTOMATED UPDATED_AT TRIGGERS
CREATE OR REPLACE FUNCTION public.fn_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = now();
   RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['profiles', 'business_roles', 'team_members', 'configurations']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS tr_update_timestamp ON public.%I', tbl);
        EXECUTE format('CREATE TRIGGER tr_update_timestamp BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp()', tbl);
    END LOOP;
END $$;

-- 10. AUTH TRIGGER (Auto-create profile and config on signup)
CREATE OR REPLACE FUNCTION public.handle_new_user_setup()
RETURNS trigger AS $$
DECLARE
  target_org_id text;
BEGIN
  -- 1. Extract or generate Org ID
  target_org_id := COALESCE(new.raw_user_meta_data->>'organization_id', gen_random_uuid()::text);

  -- 2. Create Profile
  INSERT INTO public.profiles (user_id, organization_id, email, full_name, role)
  VALUES (
    new.id,
    target_org_id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', 'System User'),
    COALESCE(new.raw_user_meta_data->>'role', 'owner')::public.user_role
  );

  -- 3. Create Default Org Configuration
  INSERT INTO public.configurations (organization_id)
  VALUES (target_org_id)
  ON CONFLICT (organization_id) DO NOTHING;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created_setup ON auth.users;
CREATE TRIGGER on_auth_user_created_setup
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_setup();

NOTIFY pgrst, 'reload schema';
