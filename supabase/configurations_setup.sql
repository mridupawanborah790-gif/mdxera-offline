
-- ========================================================
-- MEDIMART RETAIL ERP: GLOBAL CONFIGURATIONS MODULE
-- Handles Voucher Numbering, Display Logic, and Security
-- ========================================================

-- 1. SECURITY HELPER (Consistent across all modules)
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS text AS $$
DECLARE
  found_org_id text;
BEGIN
  -- Lookup organization identity linked to the current authenticated user
  SELECT organization_id::text INTO found_org_id FROM public.profiles WHERE user_id = auth.uid();
  RETURN COALESCE(found_org_id, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 2. CONFIGURATIONS TABLE
-- CASCADE ensures dependent policies and triggers are also refreshed.
DROP TABLE IF EXISTS public.configurations CASCADE;

CREATE TABLE public.configurations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL UNIQUE, -- Root Identity Lock
    
    -- VOUCHER NUMBERING (JSONB for dynamic sequence control)
    -- Structure: { prefix, startingNumber, paddingLength, useFiscalYear, currentNumber, activeMode }
    invoice_config jsonb DEFAULT '{
        "prefix": "INV",
        "startingNumber": 1,
        "paddingLength": 7,
        "useFiscalYear": true,
        "currentNumber": 1,
        "activeMode": "external"
    }'::jsonb,
    
    non_gst_invoice_config jsonb DEFAULT '{
        "prefix": "NG",
        "startingNumber": 1,
        "paddingLength": 7,
        "useFiscalYear": true,
        "currentNumber": 1,
        "activeMode": "external"
    }'::jsonb,
    
    purchase_config jsonb DEFAULT '{
        "prefix": "PB-",
        "startingNumber": 1,
        "paddingLength": 7,
        "useFiscalYear": true,
        "currentNumber": 1,
        "activeMode": "external"
    }'::jsonb,
    
    purchase_order_config jsonb DEFAULT '{
        "prefix": "PUR-",
        "startingNumber": 1,
        "paddingLength": 8,
        "useFiscalYear": false,
        "currentNumber": 1,
        "activeMode": "external"
    }'::jsonb,
    
    -- UI PREFERENCES
    master_shortcuts text[] DEFAULT '{"pos", "automatedPurchaseEntry", "inventory", "salesHistory", "distributors", "customers", "reports", "configuration"}',
    
    -- BUSINESS LOGIC & DISPLAY OPTIONS
    display_options jsonb DEFAULT '{
        "showMultipleRates": false,
        "strictStock": true,
        "showPurchaseRateInPOS": false,
        "expiryThreshold": 90,
        "defaultRateTier": "mrp",
        "calculationMode": "standard",
        "askCalculationOnBilling": true,
        "showBillDiscountOnPrint": true,
        "showItemWiseDiscountOnPrint": true,
        "enableNegativeStock": false,
        "printCopies": 1
    }'::jsonb,
    
    -- MODULE VISIBILITY & COLUMN SETTINGS
    -- Structure: { moduleId: { visible: boolean, fields: { fieldId: boolean } } }
    modules jsonb DEFAULT '{
        "pos": { "visible": true, "fields": { "colDate": true, "colCustomer": true, "colName": true, "colMrp": true, "colQty": true, "colAmount": true } }
    }'::jsonb,

    -- STATUTORY & COMPLIANCE
    gst_settings jsonb DEFAULT '{
        "periodicity": "monthly",
        "returnType": "Quarterly (Normal)"
    }'::jsonb,
    
    -- SYSTEM TIMESTAMPS
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 3. PERFORMANCE INDEXING
CREATE INDEX IF NOT EXISTS idx_configurations_org ON public.configurations (organization_id);

-- 4. MULTI-TENANT ROW LEVEL SECURITY (RLS)
ALTER TABLE public.configurations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org isolation for configurations" ON public.configurations;

CREATE POLICY "Org isolation for configurations"
ON public.configurations FOR ALL
TO authenticated
USING (organization_id::text = public.get_my_org_id())
WITH CHECK (organization_id::text = public.get_my_org_id());

-- 5. AUTOMATED TIMESTAMP TRIGGER
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = now();
   RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS tr_update_configurations_modtime ON public.configurations;
CREATE TRIGGER tr_update_configurations_modtime 
BEFORE UPDATE ON public.configurations 
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 6. METADATA COMMENTS
COMMENT ON TABLE public.configurations IS 'Global ERP settings per organization. Stores voucher series, business rules, and UI customizations.';
COMMENT ON COLUMN public.configurations.invoice_config IS 'JSONB configuration for sales invoice numbering logic.';
COMMENT ON COLUMN public.configurations.display_options IS 'Flags for stock enforcement, calculation modes, and printing preferences.';

-- 7. REFRESH SCHEMA CACHE
NOTIFY pgrst, 'reload schema';
