
-- ========================================================
-- MEDIMART ERP: VIEW FOR CUSTOMER OUTSTANDING BALANCES
-- Dynamically calculates outstanding balance from the JSONB ledger.
-- ========================================================

-- Ensure the helper function to get organization ID exists (as per schema.sql)
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS text AS $$
  SELECT organization_id::text FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Drop the view if it already exists to allow updates
DROP VIEW IF EXISTS public.customer_outstanding_balances CASCADE;

-- Create the view
CREATE OR REPLACE VIEW public.customer_outstanding_balances AS
SELECT
    c.id,
    c.organization_id,
    c.user_id,
    c.name,
    c.phone,
    c.email,
    c.address,
    c.area,
    c.pincode,
    c.district,
    c.state,
    c.gst_number,
    c.drug_license,
    c.pan_card,
    -- The actual ledger JSONB is included here if needed in the view
    -- c.ledger,
    c.default_discount,
    c.customer_type,
    c.is_active,
    c.default_rate_tier,
    c.assigned_staff_id,
    c.assigned_staff_name,
    c.created_at,
    c.updated_at,
    -- Extract the balance from the last entry in the 'ledger' JSONB array
    CASE
        WHEN jsonb_array_length(c.ledger) > 0 THEN
            ((c.ledger->>((jsonb_array_length(c.ledger) - 1)::text))->>'balance')::numeric
        ELSE
            0.00 -- Default to 0 if the ledger is empty or null
    END AS outstanding_balance
FROM
    public.customers c;

COMMENT ON VIEW public.customer_outstanding_balances IS 'A view showing all customer details, with an automatically calculated outstanding balance from their ledger.';
COMMENT ON COLUMN public.customer_outstanding_balances.outstanding_balance IS 'The computed outstanding balance based on the last entry in the customer''s transaction ledger.';

-- Enable Row Level Security (RLS) on the new view to match the base table's security
ALTER VIEW public.customer_outstanding_balances ENABLE ROW LEVEL SECURITY;

-- Drop existing RLS policy for this view if it might conflict during schema updates/re-runs
DROP POLICY IF EXISTS "Users can only view customer outstanding balances in their org" ON public.customer_outstanding_balances;

-- Create an RLS policy for the view, mirroring the base 'customers' table's policy
CREATE POLICY "Users can only view customer outstanding balances in their org"
ON public.customer_outstanding_balances FOR SELECT
TO authenticated
USING (organization_id::text = public.get_my_org_id()::text);

-- Notify PostgREST to reload the schema for immediate changes to the API endpoints
NOTIFY pgrst, 'reload schema';
