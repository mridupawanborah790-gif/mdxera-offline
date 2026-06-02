
-- ========================================================
-- MEDIMART ERP: TRANSACTION ID TYPE FIX
-- Converts primary key 'id' from UUID to TEXT
-- ========================================================

DO $$ 
BEGIN
    -- 1. Drop existing policies that might depend on the table
    DROP POLICY IF EXISTS "Org isolation policy" ON public.transactions;
    DROP POLICY IF EXISTS "Org isolation for sales" ON public.transactions;

    -- 2. Drop the primary key constraint safely
    ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_pkey CASCADE;

    -- 3. Alter the ID column type
    ALTER TABLE public.transactions ALTER COLUMN id TYPE text;

    -- 4. Re-apply the Primary Key constraint
    ALTER TABLE public.transactions ADD PRIMARY KEY (id);

    -- 5. Ensure organization_id is also text (alignment with other tables)
    ALTER TABLE public.transactions ALTER COLUMN organization_id TYPE text;

    -- 6. Re-create the isolation policy using our get_my_org_id helper
    CREATE POLICY "Org isolation policy" 
    ON public.transactions FOR ALL 
    TO authenticated 
    USING (organization_id = public.get_my_org_id()) 
    WITH CHECK (organization_id = public.get_my_org_id());

END $$;

NOTIFY pgrst, 'reload schema';
