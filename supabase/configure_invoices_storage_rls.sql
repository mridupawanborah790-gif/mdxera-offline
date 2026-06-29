-- ========================================================
-- MEDIMART RETAIL ERP: STORAGE RLS POLICIES FOR INVOICES
-- Sets up the 'invoices' bucket and defines secure multi-tenant RLS policies.
-- ========================================================

-- 1. Ensure the 'invoices' bucket exists in storage.buckets
INSERT INTO storage.buckets (id, name, public)
VALUES ('invoices', 'invoices', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Drop existing policies to avoid duplicates
DROP POLICY IF EXISTS "Allow authenticated selects on invoices" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated inserts on invoices" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated updates on invoices" ON storage.objects;

-- Option A: Secure Organization-Isolated RLS Policies (Recommended)
-- Restricts upload, select, and update actions to folders matching the user's organization_id.

-- Allow authenticated users to view invoices in their own organization's folder
CREATE POLICY "Allow authenticated selects on invoices" ON storage.objects
FOR SELECT TO authenticated
USING (
    bucket_id = 'invoices' AND
    (storage.foldername(name))[1] = public.get_my_org_id()
);

-- Allow authenticated users to insert new invoices in their own organization's folder
CREATE POLICY "Allow authenticated inserts on invoices" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'invoices' AND
    (storage.foldername(name))[1] = public.get_my_org_id()
);

-- Allow authenticated users to update/overwrite invoices in their own organization's folder
-- Required for upsert behavior (e.g. printing or sending the same invoice again)
CREATE POLICY "Allow authenticated updates on invoices" ON storage.objects
FOR UPDATE TO authenticated
USING (
    bucket_id = 'invoices' AND
    (storage.foldername(name))[1] = public.get_my_org_id()
);

/*
-- Option B: Permissive Authenticated RLS Policies (Fallback)
-- Use this if you do not want to enforce folder-level organization-based isolation.

CREATE POLICY "Allow authenticated selects on invoices" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'invoices');

CREATE POLICY "Allow authenticated inserts on invoices" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'invoices');

CREATE POLICY "Allow authenticated updates on invoices" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'invoices');
*/
