-- Adds default keys for pharmacy and dashboard logo uploads under configurations.display_options JSONB.
-- Safe to run multiple times.

UPDATE public.configurations
SET display_options = COALESCE(display_options, '{}'::jsonb)
    || jsonb_build_object(
        'pharmacy_logo_url', COALESCE(display_options->>'pharmacy_logo_url', ''),
        'dashboard_logo_url', COALESCE(display_options->>'dashboard_logo_url', '')
    )
WHERE TRUE;

COMMENT ON COLUMN public.configurations.display_options IS
'Flags for stock enforcement, printing preferences, and uploaded logo URLs (pharmacy_logo_url, dashboard_logo_url).';
