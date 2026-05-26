-- ============================================================================
-- VOUCHER BATCH COMMIT (cursor-allocation model)
-- ============================================================================
-- Atomically assigns voucher numbers to a batch of offline-generated bills.
-- Companion to src/core/voucher/voucherService.ts (cursor model) and replaces
-- the chunk-allocation semantics of reserve_voucher_range.
--
-- HOW IT WORKS
-- ------------
-- The client uploads { local_uuid, proposed_number } pairs for each pending
-- bill. The RPC locks the configurations row, compares the lowest proposed
-- number against the server's running counter, and decides per-batch:
--   * proposed_min > server_counter → no overlap → keep proposed numbers
--     as-is. (Common path. Single-device-at-a-time billing.)
--   * proposed_min ≤ server_counter → overlap → renumber the WHOLE batch to
--     server_counter+1 … server_counter+N in the client's preferred order.
--     (Rare path. Two devices billed concurrently.)
--
-- Either way, every bill gets an immutable assignment recorded in
-- voucher_number_assignment, keyed by local_uuid. A retry of the same batch
-- (e.g. after a network drop mid-push) returns the EXACT same numbers — no
-- double-allocation, no flapping.
--
-- The RPC does NOT insert the bill rows themselves. The renumber cascade
-- (sales_returns.original_invoice_number, journal_entry_*.document_reference,
-- etc.) happens client-side BEFORE the bills are pushed via the regular
-- SyncWorker upsert path. This keeps the RPC's surface area small and avoids
-- re-implementing schema-drift handling in plpgsql.
--
-- IDEMPOTENCY
-- -----------
-- voucher_number_assignment is keyed by local_uuid (the bill's PK on the
-- client). Any second call with the same UUID returns the original
-- assignment unchanged. Safe to call from a retry loop.
--
-- Run this once against your Supabase project (SQL Editor → New Query →
-- paste → Run).
-- ============================================================================

-- 1. The assignment ledger. One row per bill, immutable.
CREATE TABLE IF NOT EXISTS public.voucher_number_assignment (
  bill_uuid          uuid PRIMARY KEY,
  organization_id    uuid NOT NULL,
  document_type      text NOT NULL,
  fy                 text NOT NULL,
  assigned_number    integer NOT NULL,
  final_document_number text NOT NULL,
  was_renumbered     boolean NOT NULL DEFAULT false,
  proposed_number    integer,
  device_id          text,
  assigned_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vna_org_type_fy_number
  ON public.voucher_number_assignment(organization_id, document_type, fy, assigned_number);

CREATE INDEX IF NOT EXISTS idx_vna_org_type_fy
  ON public.voucher_number_assignment(organization_id, document_type, fy);


DROP FUNCTION IF EXISTS public.commit_voucher_batch(text, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.commit_voucher_batch(
  p_org_id         text,
  p_document_type  text,
  p_fy             text,
  p_device_id      text,
  p_bills          jsonb   -- [{ "local_uuid": "...", "proposed_number": 101 }, ...]
)
RETURNS TABLE (
  local_uuid             text,
  assigned_number        integer,
  was_renumbered         boolean,
  final_document_number  text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg_row           public.configurations%ROWTYPE;
  cfg               jsonb;
  cfg_key           text;
  v_prefix          text;
  v_padding         integer;
  v_use_fy          boolean;
  v_starting        integer;
  v_end_cap         integer;
  v_current         integer;
  v_renumber        boolean := false;
  v_proposed_min    integer;
  v_proposed_max    integer;
  v_distinct_count  integer;
  v_input_count     integer;
  v_assigned_max    integer;
  v_org_uuid        uuid;
  v_bill            jsonb;
  v_existing        public.voucher_number_assignment%ROWTYPE;
  v_pending         jsonb := '[]'::jsonb;
  v_pending_arr     jsonb[];
  v_next_assign     integer;
  v_idx             integer;
  v_assigned_num    integer;
  v_doc_number      text;
BEGIN
  -- ─── Input validation ─────────────────────────────────────────────────
  IF p_bills IS NULL OR jsonb_typeof(p_bills) <> 'array' OR jsonb_array_length(p_bills) = 0 THEN
    RAISE EXCEPTION 'p_bills must be a non-empty JSON array';
  END IF;

  BEGIN
    v_org_uuid := p_org_id::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'p_org_id is not a valid UUID: %', p_org_id;
  END;

  -- ─── Map document type → configurations JSONB column ─────────────────
  CASE p_document_type
    WHEN 'sales-gst'          THEN cfg_key := 'invoice_config';
    WHEN 'sales-non-gst'      THEN cfg_key := 'non_gst_invoice_config';
    WHEN 'purchase-entry'     THEN cfg_key := 'purchase_config';
    WHEN 'purchase-order'     THEN cfg_key := 'purchase_order_config';
    WHEN 'sales-challan'      THEN cfg_key := 'sales_challan_config';
    WHEN 'delivery-challan'   THEN cfg_key := 'delivery_challan_config';
    WHEN 'physical-inventory' THEN cfg_key := 'physical_inventory_config';
    ELSE
      RAISE EXCEPTION 'Invalid document type: %', p_document_type;
  END CASE;

  -- ─── Lock configurations row ─────────────────────────────────────────
  -- All concurrent batches for this org serialize here. Holds for the entire
  -- transaction; releases on COMMIT/ROLLBACK.
  SELECT * INTO cfg_row FROM public.configurations
   WHERE organization_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Configuration not found for organization %', p_org_id;
  END IF;

  cfg := COALESCE(to_jsonb(cfg_row) -> cfg_key, '{}'::jsonb);

  -- ─── Read formatting + counter state ─────────────────────────────────
  v_prefix   := COALESCE(cfg ->> 'prefix', 'INV');
  v_padding  := GREATEST(1, COALESCE((cfg ->> 'paddingLength')::integer, 6));
  v_use_fy   := COALESCE((cfg ->> 'useFiscalYear')::boolean, true);
  v_starting := GREATEST(1, COALESCE((cfg ->> 'startingNumber')::integer, 1));
  v_end_cap  := NULLIF(cfg ->> 'endNumber', '')::integer;

  -- FY rollover: if the configured FY differs from the incoming batch's FY
  -- AND the reset rule is annual, the counter restarts at startingNumber-1.
  IF (cfg ->> 'resetRule') = 'financial-year'
     AND (cfg ->> 'fy') IS NOT NULL
     AND (cfg ->> 'fy') <> p_fy THEN
    v_current := v_starting - 1;
  ELSE
    v_current := GREATEST(
      v_starting - 1,
      COALESCE(NULLIF(cfg ->> 'internalCurrentNumber', '')::integer, v_starting - 1),
      COALESCE(NULLIF(cfg ->> 'currentNumber', '')::integer, v_starting - 1)
    );
  END IF;

  -- ─── Separate already-assigned bills from pending ────────────────────
  -- A bill with an existing voucher_number_assignment row keeps its number
  -- forever (idempotent on retry). Only bills without an assignment go
  -- through the renumber decision.
  FOR v_bill IN SELECT jsonb_array_elements(p_bills)
  LOOP
    SELECT * INTO v_existing FROM public.voucher_number_assignment
     WHERE bill_uuid = (v_bill ->> 'local_uuid')::uuid;

    IF FOUND THEN
      -- Idempotent return path.
      local_uuid := v_existing.bill_uuid::text;
      assigned_number := v_existing.assigned_number;
      was_renumbered := v_existing.was_renumbered;
      final_document_number := v_existing.final_document_number;
      RETURN NEXT;
    ELSE
      v_pending := v_pending || jsonb_build_array(v_bill);
    END IF;
  END LOOP;

  v_input_count := jsonb_array_length(v_pending);
  IF v_input_count = 0 THEN
    RETURN;  -- everything was already assigned
  END IF;

  -- ─── Decide: keep proposed numbers, or renumber the whole batch? ─────
  SELECT
    MIN((b ->> 'proposed_number')::integer),
    MAX((b ->> 'proposed_number')::integer),
    COUNT(DISTINCT (b ->> 'proposed_number')::integer)
    INTO v_proposed_min, v_proposed_max, v_distinct_count
  FROM jsonb_array_elements(v_pending) AS b;

  -- Renumber if:
  --   (a) any proposed number ≤ current server counter (overlap), OR
  --   (b) duplicates within the proposed set (client cursor went wrong), OR
  --   (c) any proposed number ≤ 0 (malformed)
  IF v_proposed_min IS NULL
     OR v_proposed_min <= v_current
     OR v_distinct_count < v_input_count
     OR v_proposed_min < 1 THEN
    v_renumber := true;
  END IF;

  -- ─── Enforce endNumber cap ───────────────────────────────────────────
  IF v_renumber THEN
    v_assigned_max := v_current + v_input_count;
  ELSE
    v_assigned_max := v_proposed_max;
  END IF;

  IF v_end_cap IS NOT NULL AND v_assigned_max > v_end_cap THEN
    RAISE EXCEPTION
      'Voucher series % would exceed endNumber cap (% > %). Extend the cap before syncing.',
      p_document_type, v_assigned_max, v_end_cap;
  END IF;

  -- ─── Assign numbers and persist ──────────────────────────────────────
  -- Sort pending bills by proposed_number so the renumber path preserves the
  -- client's intended ordering.
  v_pending_arr := ARRAY(
    SELECT b FROM jsonb_array_elements(v_pending) AS b
     ORDER BY (b ->> 'proposed_number')::integer
  );

  v_next_assign := v_current;

  FOR v_idx IN 1 .. array_length(v_pending_arr, 1)
  LOOP
    v_bill := v_pending_arr[v_idx];

    IF v_renumber THEN
      v_next_assign := v_next_assign + 1;
      v_assigned_num := v_next_assign;
    ELSE
      v_assigned_num := (v_bill ->> 'proposed_number')::integer;
    END IF;

    v_doc_number := v_prefix || lpad(v_assigned_num::text, v_padding, '0')
                    || CASE WHEN v_use_fy THEN '-' || p_fy ELSE '' END;

    BEGIN
      INSERT INTO public.voucher_number_assignment
        (bill_uuid, organization_id, document_type, fy,
         assigned_number, final_document_number, was_renumbered,
         proposed_number, device_id)
      VALUES
        ((v_bill ->> 'local_uuid')::uuid, v_org_uuid, p_document_type, p_fy,
         v_assigned_num, v_doc_number, v_renumber,
         NULLIF(v_bill ->> 'proposed_number','')::integer, p_device_id);
    EXCEPTION
      WHEN unique_violation THEN
        -- Either another transaction won the race on (org, type, fy, number)
        -- — should be impossible under FOR UPDATE — or the bill UUID just
        -- got committed by a concurrent retry. Re-read and return its value
        -- rather than failing the whole batch.
        SELECT * INTO v_existing FROM public.voucher_number_assignment
         WHERE bill_uuid = (v_bill ->> 'local_uuid')::uuid;
        IF FOUND THEN
          v_assigned_num := v_existing.assigned_number;
          v_doc_number := v_existing.final_document_number;
          v_renumber := v_existing.was_renumbered;  -- reflect the recorded truth
        ELSE
          RAISE;
        END IF;
    END;

    local_uuid := (v_bill ->> 'local_uuid');
    assigned_number := v_assigned_num;
    was_renumbered := v_renumber;
    final_document_number := v_doc_number;
    RETURN NEXT;
  END LOOP;

  -- ─── Advance the configurations counter ──────────────────────────────
  -- Both internalCurrentNumber and currentNumber are written so the legacy
  -- app's display + the new cursor model stay in lockstep.
  IF v_renumber THEN
    v_assigned_max := v_next_assign;
  END IF;

  cfg := jsonb_set(cfg, '{currentNumber}',         to_jsonb(v_assigned_max), true);
  cfg := jsonb_set(cfg, '{internalCurrentNumber}', to_jsonb(v_assigned_max), true);
  cfg := jsonb_set(cfg, '{fy}',                    to_jsonb(p_fy),           true);
  cfg := jsonb_set(cfg, '{resetRule}',             COALESCE(cfg -> 'resetRule', '"financial-year"'::jsonb), true);

  UPDATE public.configurations SET
    invoice_config            = CASE WHEN cfg_key = 'invoice_config'            THEN cfg ELSE invoice_config            END,
    non_gst_invoice_config    = CASE WHEN cfg_key = 'non_gst_invoice_config'    THEN cfg ELSE non_gst_invoice_config    END,
    purchase_config           = CASE WHEN cfg_key = 'purchase_config'           THEN cfg ELSE purchase_config           END,
    purchase_order_config     = CASE WHEN cfg_key = 'purchase_order_config'     THEN cfg ELSE purchase_order_config     END,
    sales_challan_config      = CASE WHEN cfg_key = 'sales_challan_config'      THEN cfg ELSE sales_challan_config      END,
    delivery_challan_config   = CASE WHEN cfg_key = 'delivery_challan_config'   THEN cfg ELSE delivery_challan_config   END,
    physical_inventory_config = CASE WHEN cfg_key = 'physical_inventory_config' THEN cfg ELSE physical_inventory_config END,
    updated_at = now()
  WHERE id = cfg_row.id;

  -- ─── Audit log (best-effort) ─────────────────────────────────────────
  BEGIN
    INSERT INTO public.voucher_number_audit (
      organization_id, document_type, event_type,
      document_number, used_number, next_number, fy, reference_id
    )
    SELECT
      p_org_id, p_document_type,
      CASE WHEN v_renumber THEN 'renumbered' ELSE 'generated' END,
      'BATCH-' || (v_assigned_max - v_input_count + 1) || '-' || v_assigned_max,
      v_assigned_max - v_input_count + 1,
      v_assigned_max + 1,
      p_fy,
      'device:' || p_device_id;
  EXCEPTION
    WHEN undefined_table THEN NULL;
    WHEN check_violation THEN
      -- Some deployments have a CHECK constraint on event_type that doesn't
      -- include 'renumbered'. Fall back to 'generated' so the audit still lands.
      BEGIN
        INSERT INTO public.voucher_number_audit (
          organization_id, document_type, event_type,
          document_number, used_number, next_number, fy, reference_id
        ) VALUES (
          p_org_id, p_document_type, 'generated',
          'BATCH-' || (v_assigned_max - v_input_count + 1) || '-' || v_assigned_max,
          v_assigned_max - v_input_count + 1,
          v_assigned_max + 1,
          p_fy,
          'device:' || p_device_id || CASE WHEN v_renumber THEN ' (renumbered)' ELSE '' END
        );
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    WHEN OTHERS THEN
      RAISE NOTICE '[commit_voucher_batch] audit log skipped: %', SQLERRM;
  END;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.commit_voucher_batch(text, text, text, text, jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.commit_voucher_batch(text, text, text, text, jsonb)
  IS 'Atomically assigns voucher numbers to a batch of offline-generated bills. Idempotent on bill_uuid; renumbers the entire incoming batch to the tail if any proposed number overlaps the server counter. See src/core/voucher/voucherService.ts (cursor-allocation model).';

-- ============================================================================
-- ALLOW RPC TO BE CALLED VIA POSTGREST
-- ============================================================================
NOTIFY pgrst, 'reload schema';
