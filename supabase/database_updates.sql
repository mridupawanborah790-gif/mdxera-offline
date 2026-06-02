
-- ========================================================
-- MEDIMART ERP: RECOVERY TYPE ALIGNMENT SCRIPT
-- Safely drops dependent policies, alters types, and triggers
-- schema refresh.
-- ========================================================

DO $$
BEGIN
    -- 1. DROP ALL DEPENDENT POLICIES
    -- We drop these so we can alter the column types of 'organization_id'
    DROP POLICY IF EXISTS "Profiles are self-managed" ON public.profiles;
    DROP POLICY IF EXISTS "Org isolation for config" ON public.configurations;
    DROP POLICY IF EXISTS "Org isolation for distributors" ON public.distributors;
    DROP POLICY IF EXISTS "Org isolation for customers" ON public.customers;
    DROP POLICY IF EXISTS "Org isolation for inventory" ON public.inventory;
    DROP POLICY IF EXISTS "Org isolation for meds" ON public.medicine_master;
    DROP POLICY IF EXISTS "Org isolation for sales" ON public.transactions;
    DROP POLICY IF EXISTS "Org isolation for purchases" ON public.purchases;
    DROP POLICY IF EXISTS "Org isolation for mappings" ON public.distributor_product_map;

    -- 2. ALTER COLUMNS TO TEXT
    -- Profiles
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='organization_id') THEN
        ALTER TABLE public.profiles ALTER COLUMN organization_id TYPE text;
    END IF;

    -- Inventory
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory' AND column_name='organization_id') THEN
        ALTER TABLE public.inventory ALTER COLUMN organization_id TYPE text;
    END IF;

    -- Transactions
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='organization_id') THEN
        ALTER TABLE public.transactions ALTER COLUMN organization_id TYPE text;
    END IF;

    -- Purchases
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchases' AND column_name='organization_id') THEN
        ALTER TABLE public.purchases ALTER COLUMN organization_id TYPE text;
    END IF;

    -- Distributors
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='distributors' AND column_name='organization_id') THEN
        ALTER TABLE public.distributors ALTER COLUMN organization_id TYPE text;
    END IF;

    -- Customers
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customers' AND column_name='organization_id') THEN
        ALTER TABLE public.customers ALTER COLUMN organization_id TYPE text;
    END IF;

    -- Configurations
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='configurations' AND column_name='organization_id') THEN
        ALTER TABLE public.configurations ALTER COLUMN organization_id TYPE text;
    END IF;
    
    -- Medicine Master
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='medicine_master' AND column_name='organization_id') THEN
        ALTER TABLE public.medicine_master ALTER COLUMN organization_id TYPE text;
    END IF;

    -- Distributor Product Map
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='distributor_product_map' AND column_name='organization_id') THEN
        ALTER TABLE public.distributor_product_map ALTER COLUMN organization_id TYPE text;
    END IF;

    -- 3. NOTE: Run schema.sql after this to re-create the policies correctly.
END $$;

NOTIFY pgrst, 'reload schema';
