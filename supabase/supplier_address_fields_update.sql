-- Add address fields for supplier master maintenance in create/edit flows.
DO $$
BEGIN
    -- Primary table used by app
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'suppliers'
    ) THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='suppliers' AND column_name='address_line1') THEN
            ALTER TABLE public.suppliers ADD COLUMN address_line1 text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='suppliers' AND column_name='address_line2') THEN
            ALTER TABLE public.suppliers ADD COLUMN address_line2 text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='suppliers' AND column_name='area') THEN
            ALTER TABLE public.suppliers ADD COLUMN area text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='suppliers' AND column_name='pincode') THEN
            ALTER TABLE public.suppliers ADD COLUMN pincode text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='suppliers' AND column_name='district') THEN
            ALTER TABLE public.suppliers ADD COLUMN district text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='suppliers' AND column_name='state') THEN
            ALTER TABLE public.suppliers ADD COLUMN state text;
        END IF;
    END IF;

    -- Optional compatibility table if deployment uses supplier_master naming.
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'supplier_master'
    ) THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='supplier_master' AND column_name='address_line1') THEN
            ALTER TABLE public.supplier_master ADD COLUMN address_line1 text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='supplier_master' AND column_name='address_line2') THEN
            ALTER TABLE public.supplier_master ADD COLUMN address_line2 text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='supplier_master' AND column_name='area') THEN
            ALTER TABLE public.supplier_master ADD COLUMN area text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='supplier_master' AND column_name='pincode') THEN
            ALTER TABLE public.supplier_master ADD COLUMN pincode text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='supplier_master' AND column_name='district') THEN
            ALTER TABLE public.supplier_master ADD COLUMN district text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='supplier_master' AND column_name='state') THEN
            ALTER TABLE public.supplier_master ADD COLUMN state text;
        END IF;
    END IF;
END $$;
