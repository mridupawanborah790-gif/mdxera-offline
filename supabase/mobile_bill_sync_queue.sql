-- Mobile bill sync queue for Magic Mobile Link
CREATE TABLE IF NOT EXISTS public.mobile_bill_sync_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id text NOT NULL,
    organization_id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    status text NOT NULL DEFAULT 'synced' CHECK (status IN ('synced', 'imported', 'failed')),
    payload jsonb NOT NULL,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    imported_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_mobile_bill_sync_queue_lookup
    ON public.mobile_bill_sync_queue (organization_id, user_id, device_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mobile_bill_sync_queue_session
    ON public.mobile_bill_sync_queue (session_id, created_at DESC);
