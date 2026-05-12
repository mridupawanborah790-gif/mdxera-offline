-- Add valuation fields in Material Master
-- Safe to run multiple times.

ALTER TABLE public.material_master
    ADD COLUMN IF NOT EXISTS valuation_method text NOT NULL DEFAULT 'standard';

ALTER TABLE public.material_master
    ADD COLUMN IF NOT EXISTS standard_price_rate numeric(18, 4) NOT NULL DEFAULT 0;

ALTER TABLE public.material_master
    ADD COLUMN IF NOT EXISTS moving_average_rate numeric(18, 4) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'material_master_valuation_method_check'
    ) THEN
        ALTER TABLE public.material_master
            ADD CONSTRAINT material_master_valuation_method_check
            CHECK (valuation_method IN ('standard', 'moving_average'));
    END IF;
END $$;

ALTER TABLE public.material_master
    DROP CONSTRAINT IF EXISTS material_master_standard_price_rate_non_negative;
ALTER TABLE public.material_master
    ADD CONSTRAINT material_master_standard_price_rate_non_negative
    CHECK (standard_price_rate >= 0);

ALTER TABLE public.material_master
    DROP CONSTRAINT IF EXISTS material_master_moving_average_rate_non_negative;
ALTER TABLE public.material_master
    ADD CONSTRAINT material_master_moving_average_rate_non_negative
    CHECK (moving_average_rate >= 0);
