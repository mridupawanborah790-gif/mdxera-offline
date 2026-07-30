-- ========================================================
-- MEDIMART ERP: ADD WATERMARK FIELDS TO PROFILES
-- Enables custom watermarks on printed bills (logo/name & opacity)
-- ========================================================

DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
        -- Watermark Type Field
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='watermark_type') THEN
            ALTER TABLE public.profiles ADD COLUMN watermark_type TEXT DEFAULT 'none';
        END IF;

        -- Watermark Opacity Field
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='watermark_opacity') THEN
            ALTER TABLE public.profiles ADD COLUMN watermark_opacity NUMERIC DEFAULT 0.15;
        END IF;
    END IF;
END $$;

COMMENT ON COLUMN public.profiles.watermark_type IS 'Watermark type for printed bills: none, logo, or name';
COMMENT ON COLUMN public.profiles.watermark_opacity IS 'Watermark opacity for printed bills (0 to 1)';

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';
