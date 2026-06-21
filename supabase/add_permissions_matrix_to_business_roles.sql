-- migration: add_permissions_matrix_to_business_roles.sql

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'business_roles' AND column_name = 'permissions_matrix') THEN
        ALTER TABLE public.business_roles ADD COLUMN permissions_matrix jsonb DEFAULT '{}'::jsonb;
        COMMENT ON COLUMN public.business_roles.permissions_matrix IS 'JSONB matrix defining detailed module action permissions (view, entry, edit, etc).';
    END IF;
END $$;
