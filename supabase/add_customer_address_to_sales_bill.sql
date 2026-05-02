-- migration: add_customer_address_to_sales_bill.sql
-- Adds customer_address column in sales_bill to persist POS address field

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'sales_bill'
          AND column_name = 'customer_address'
    ) THEN
        ALTER TABLE public.sales_bill ADD COLUMN customer_address text;
    END IF;
END $$;

COMMENT ON COLUMN public.sales_bill.customer_address IS 'Billing address captured at POS for this sale.';
