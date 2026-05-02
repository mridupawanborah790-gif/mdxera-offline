-- ========================================================
-- MEDIMART RETAIL ERP: POS SALES (SALES BILL) SCHEMA
-- Renames 'transactions' to 'sales_bill' and defines full schema
-- ========================================================

-- 1. RENAME EXISTING TABLE
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transactions') THEN
        ALTER TABLE public.transactions RENAME TO sales_bill;
    END IF;
END $$;

-- 2. DEFINE SALES_BILL TABLE
CREATE TABLE IF NOT EXISTS public.sales_bill (
    id text PRIMARY KEY, -- Supports custom invoice numbers (e.g., INV0001-2024)
    organization_id text NOT NULL, -- Root tenant identifier
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL, -- Clerk who performed the sale
    date timestamptz NOT NULL DEFAULT now(),
    
    -- Customer Identity
    customer_name text NOT NULL,
    customer_id uuid, -- Links to public.customers.id
    customer_phone text,
    customer_address text,
    referred_by text, -- Doctor/RMP Name
    
    -- Item Data
    items jsonb NOT NULL DEFAULT '[]'::jsonb, -- Array of BillItem objects (name, batch, qty, price, disc, gst)
    item_count integer DEFAULT 0,
    
    -- Financial Breakdown
    subtotal numeric(15,2) DEFAULT 0, -- Taxable value (total before taxes and after item discounts)
    total_item_discount numeric(15,2) DEFAULT 0, -- Sum of all line item discounts
    total_gst numeric(15,2) DEFAULT 0, -- Total tax collected
    scheme_discount numeric(15,2) DEFAULT 0, -- Lumpsum or bill-level discount
    round_off numeric(10,2) DEFAULT 0,
    total numeric(15,2) DEFAULT 0, -- Final Net Payable (Grand Total)
    amount_received numeric(15,2) DEFAULT 0, -- Cash/Card received from customer
    
    -- Document Status & Attributes
    status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled', 'draft')),
    payment_mode text DEFAULT 'Cash', -- Cash, Credit, UPI, Card, etc.
    pricing_mode text DEFAULT 'mrp', -- mrp or rate
    bill_type text DEFAULT 'regular', -- regular (GST) or non-gst (Estimate)
    prescription_url text, -- Link to primary prescription image
    prescription_images text[], -- Array of additional prescription images (base64 or storage URLs)
    linked_challans text[], -- Reference to Sales Challan IDs if converted
    
    -- Audit Timestamps
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 3. INDEXES FOR PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_sales_bill_org ON public.sales_bill (organization_id);
CREATE INDEX IF NOT EXISTS idx_sales_bill_customer ON public.sales_bill (customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_bill_date ON public.sales_bill (date);
CREATE INDEX IF NOT EXISTS idx_sales_bill_status ON public.sales_bill (status);
CREATE INDEX IF NOT EXISTS idx_sales_bill_cust_name ON public.sales_bill (lower(customer_name));

-- 4. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.sales_bill ENABLE ROW LEVEL SECURITY;

-- Helper function to find org id (Defined in profiles)
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS text AS $$
DECLARE
  found_org_id text;
BEGIN
  SELECT organization_id::text INTO found_org_id FROM public.profiles WHERE user_id = auth.uid();
  RETURN COALESCE(found_org_id, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Strict Isolation Policy: Users can only manage sales belonging to their organization
DROP POLICY IF EXISTS "Org isolation for sales_bill" ON public.sales_bill;
CREATE POLICY "Org isolation for sales_bill"
ON public.sales_bill FOR ALL
TO authenticated
USING (organization_id::text = public.get_my_org_id())
WITH CHECK (organization_id::text = public.get_my_org_id());

-- 5. UPDATED_AT TRIGGER
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = now();
   RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS tr_update_sales_bill_modtime ON public.sales_bill;
CREATE TRIGGER tr_update_sales_bill_modtime 
BEFORE UPDATE ON public.sales_bill 
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Documentation Comments
COMMENT ON TABLE public.sales_bill IS 'Transactional records for POS sales. Renamed from transactions for clarity.';
COMMENT ON COLUMN public.sales_bill.id IS 'Primary key. Stored as text to allow for human-readable invoice numbers (e.g., INV-001/24-25).';
COMMENT ON COLUMN public.sales_bill.items IS 'JSONB array of BillItem objects. Critical for reconstructing the bill without looking up historical product states.';

NOTIFY pgrst, 'reload schema';
COMMENT ON COLUMN public.sales_bill.customer_address IS 'Billing address captured at POS for this sale.';
