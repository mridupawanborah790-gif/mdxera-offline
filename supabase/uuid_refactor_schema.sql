
-- ========================================================
-- MEDIMART RETAIL ERP: UUID REFACTORING (id -> user_id)
-- ========================================================

-- 1. DROP DEPENDENT VIEWS
DROP VIEW IF EXISTS public.transactions CASCADE;
DROP VIEW IF EXISTS public.medicine_master CASCADE;
DROP VIEW IF EXISTS public.distributors CASCADE;

-- 2. REFACTOR TABLES SAFELY

-- INVENTORY
DO $$ 
BEGIN 
    -- Only rename user_id if it's currently used for the author FK and created_by_id doesn't exist
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory' AND column_name = 'user_id') 
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory' AND column_name = 'created_by_id') THEN
        ALTER TABLE public.inventory RENAME COLUMN user_id TO created_by_id;
    END IF;
    
    -- Rename PK id to user_id
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory' AND column_name = 'id') THEN
        ALTER TABLE public.inventory RENAME COLUMN id TO user_id;
    END IF;
END $$;

-- SALES_BILL
DO $$ 
BEGIN 
    -- Rename existing user_id (FK to auth) to created_by_id if it exists and hasn't been renamed
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_bill' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_bill' AND column_name = 'created_by_id') 
       -- Check if user_id is the primary key. If not, it's the old FK.
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc 
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'sales_bill' AND kcu.column_name = 'user_id' AND tc.constraint_type = 'PRIMARY KEY'
       ) THEN
        ALTER TABLE public.sales_bill RENAME COLUMN user_id TO created_by_id;
    END IF;

    -- Handle the old 'id' column (text invoice number)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_bill' AND column_name = 'id') THEN
        ALTER TABLE public.sales_bill DROP CONSTRAINT IF EXISTS sales_bill_pkey;
        ALTER TABLE public.sales_bill DROP CONSTRAINT IF EXISTS transactions_pkey;
        ALTER TABLE public.sales_bill RENAME COLUMN id TO voucher_no;
        -- Add new UUID primary key
        ALTER TABLE public.sales_bill ADD COLUMN user_id uuid PRIMARY KEY DEFAULT gen_random_uuid();
    END IF;
END $$;

-- PURCHASES
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'user_id') 
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'created_by_id')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc 
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'purchases' AND kcu.column_name = 'user_id' AND tc.constraint_type = 'PRIMARY KEY'
       ) THEN
        ALTER TABLE public.purchases RENAME COLUMN user_id TO created_by_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'id') THEN
        ALTER TABLE public.purchases RENAME COLUMN id TO user_id;
        ALTER TABLE public.purchases ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- SUPPLIERS
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'suppliers' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'suppliers' AND column_name = 'created_by_id')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc 
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'suppliers' AND kcu.column_name = 'user_id' AND tc.constraint_type = 'PRIMARY KEY'
       ) THEN
        ALTER TABLE public.suppliers RENAME COLUMN user_id TO created_by_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'suppliers' AND column_name = 'id') THEN
        ALTER TABLE public.suppliers RENAME COLUMN id TO user_id;
        ALTER TABLE public.suppliers ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- CUSTOMERS
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'created_by_id')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc 
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'customers' AND kcu.column_name = 'user_id' AND tc.constraint_type = 'PRIMARY KEY'
       ) THEN
        ALTER TABLE public.customers RENAME COLUMN user_id TO created_by_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'id') THEN
        ALTER TABLE public.customers RENAME COLUMN id TO user_id;
        ALTER TABLE public.customers ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- MATERIAL_MASTER
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'material_master' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'material_master' AND column_name = 'created_by_id')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc 
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'material_master' AND kcu.column_name = 'user_id' AND tc.constraint_type = 'PRIMARY KEY'
       ) THEN
        ALTER TABLE public.material_master RENAME COLUMN user_id TO created_by_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'material_master' AND column_name = 'id') THEN
        ALTER TABLE public.material_master RENAME COLUMN id TO user_id;
        ALTER TABLE public.material_master ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- CONFIGURATIONS
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'configurations' AND column_name = 'id') THEN
        ALTER TABLE public.configurations RENAME COLUMN id TO user_id;
        ALTER TABLE public.configurations ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- LOGISTICS
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_challans' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_challans' AND column_name = 'created_by_id')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc 
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'sales_challans' AND kcu.column_name = 'user_id' AND tc.constraint_type = 'PRIMARY KEY'
       ) THEN
        ALTER TABLE public.sales_challans RENAME COLUMN user_id TO created_by_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_challans' AND column_name = 'id') THEN
        ALTER TABLE public.sales_challans RENAME COLUMN id TO user_id;
        ALTER TABLE public.sales_challans ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'delivery_challans' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'delivery_challans' AND column_name = 'created_by_id')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc 
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'delivery_challans' AND kcu.column_name = 'user_id' AND tc.constraint_type = 'PRIMARY KEY'
       ) THEN
        ALTER TABLE public.delivery_challans RENAME COLUMN user_id TO created_by_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'delivery_challans' AND column_name = 'id') THEN
        ALTER TABLE public.delivery_challans RENAME COLUMN id TO user_id;
        ALTER TABLE public.delivery_challans ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- AUDIT
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'physical_inventory' AND column_name = 'user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'physical_inventory' AND column_name = 'created_by_id')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc 
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'physical_inventory' AND kcu.column_name = 'user_id' AND tc.constraint_type = 'PRIMARY KEY'
       ) THEN
        ALTER TABLE public.physical_inventory RENAME COLUMN user_id TO created_by_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'physical_inventory' AND column_name = 'id') THEN
        ALTER TABLE public.physical_inventory DROP CONSTRAINT IF EXISTS physical_inventory_pkey;
        ALTER TABLE public.physical_inventory RENAME COLUMN id TO voucher_no;
        ALTER TABLE public.physical_inventory ADD COLUMN user_id uuid PRIMARY KEY DEFAULT gen_random_uuid();
    END IF;
END $$;

-- CATALOG
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'categories' AND column_name = 'id') THEN
        ALTER TABLE public.categories RENAME COLUMN id TO user_id;
        ALTER TABLE public.categories ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sub_categories' AND column_name = 'id') THEN
        ALTER TABLE public.sub_categories RENAME COLUMN id TO user_id;
        ALTER TABLE public.sub_categories ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sub_categories' AND column_name = 'category_id') THEN
        ALTER TABLE public.sub_categories RENAME COLUMN category_id TO parent_category_user_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'promotions' AND column_name = 'id') THEN
        ALTER TABLE public.promotions RENAME COLUMN id TO user_id;
        ALTER TABLE public.promotions ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- 3. RECREATE RLS POLICIES (Simplified Open Schema Logic)
DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    LOOP
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', tbl);
    END LOOP;
END $$;

-- 4. RECREATE VIEWS FOR COMPATIBILITY
-- Alias user_id back to id for legacy queries if needed, but UI should shift to user_id
CREATE OR REPLACE VIEW public.transactions AS SELECT voucher_no AS id, * FROM public.sales_bill;
CREATE OR REPLACE VIEW public.medicine_master AS SELECT * FROM public.material_master;
CREATE OR REPLACE VIEW public.distributors AS SELECT * FROM public.suppliers;

NOTIFY pgrst, 'reload schema';
