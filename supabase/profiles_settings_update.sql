
-- ========================================================
-- MEDIMART ERP: ADD MISSING SETTINGS FIELDS TO PROFILES
-- Enables granular location and management tracking
-- ========================================================

DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
        -- Location Fields
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='state') THEN
            ALTER TABLE public.profiles ADD COLUMN state TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='district') THEN
            ALTER TABLE public.profiles ADD COLUMN district TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='pincode') THEN
            ALTER TABLE public.profiles ADD COLUMN pincode TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='address_line2') THEN
            ALTER TABLE public.profiles ADD COLUMN address_line2 TEXT;
        END IF;

        -- Management Fields
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='manager_mobile') THEN
            ALTER TABLE public.profiles ADD COLUMN manager_mobile TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='dl_valid_to') THEN
            ALTER TABLE public.profiles ADD COLUMN dl_valid_to DATE;
        END IF;
        
        -- Meta ID cleanup (ensure it matches frontend user_id mapping if needed)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='id') THEN
            ALTER TABLE public.profiles ADD COLUMN id TEXT;
        END IF;
    END IF;
END $$;

-- Update comments for the new columns
COMMENT ON COLUMN public.profiles.state IS 'State where the pharmacy is located.';
COMMENT ON COLUMN public.profiles.district IS 'District where the pharmacy is located.';
COMMENT ON COLUMN public.profiles.pincode IS 'Postal code of the pharmacy location.';
COMMENT ON COLUMN public.profiles.dl_valid_to IS 'Expiry date of the primary Drug License.';

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';
