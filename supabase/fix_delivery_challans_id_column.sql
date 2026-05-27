-- ============================================================================
-- FIX: Recreate delivery_challans with the correct schema
-- ----------------------------------------------------------------------------
-- Symptom: Offline-created Purchase Challans fail to sync with error:
--   "column 'id' does not exist [42703]"
--
-- Cause:   The delivery_challans table on this Supabase instance was created
--          with the wrong schema. Its primary key is on `user_id` (which is
--          the profiles-table layout) and it has no `id` column at all.
--          SyncWorker.pushBatch upserts with ON CONFLICT (id) and fails.
--
-- Verified safe: COUNT(*) on the existing table returned 0 — no data to lose.
-- ============================================================================

-- 1. Drop the misconfigured table (CASCADE removes any dependent objects
--    such as the old RLS policy and FK from created_by_id).
DROP TABLE IF EXISTS public.delivery_challans CASCADE;

-- 2. Recreate it with the canonical schema (mirrors delivery_challans_schema.sql).
CREATE TABLE public.delivery_challans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text        NOT NULL,
    user_id         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by_id   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,

    challan_serial_id text      NOT NULL,
    supplier          text      NOT NULL,
    challan_number    text,
    date              timestamptz NOT NULL DEFAULT now(),

    total_amount numeric(15,2) DEFAULT 0,
    subtotal     numeric(15,2) DEFAULT 0,
    total_gst    numeric(15,2) DEFAULT 0,

    items  jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text  NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','cancelled')),
    remarks text,
    pricing_mode text DEFAULT 'rate',

    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 3. Indexes.
CREATE INDEX idx_delivery_challans_org      ON public.delivery_challans (organization_id);
CREATE INDEX idx_delivery_challans_supplier ON public.delivery_challans (lower(supplier));
CREATE INDEX idx_delivery_challans_serial   ON public.delivery_challans (challan_serial_id);
CREATE INDEX idx_delivery_challans_date     ON public.delivery_challans (date);
CREATE INDEX idx_delivery_challans_status   ON public.delivery_challans (status);
CREATE INDEX idx_delivery_challans_created_by ON public.delivery_challans (created_by_id);

-- 4. Row-Level Security.
ALTER TABLE public.delivery_challans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org isolation for delivery_challans" ON public.delivery_challans;
CREATE POLICY "Org isolation for delivery_challans"
ON public.delivery_challans FOR ALL
TO authenticated
USING      (organization_id::text = public.get_my_org_id())
WITH CHECK (organization_id::text = public.get_my_org_id());

-- 5. Updated-at trigger (uses the existing helper installed by other schemas).
DROP TRIGGER IF EXISTS tr_update_delivery_challans_modtime ON public.delivery_challans;
CREATE TRIGGER tr_update_delivery_challans_modtime
BEFORE UPDATE ON public.delivery_challans
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 6. Refresh PostgREST schema cache.
NOTIFY pgrst, 'reload schema';
