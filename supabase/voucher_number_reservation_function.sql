-- Atomic voucher number reservation with row-level lock and audit trail

-- CLEANUP: Drop all previous overloaded versions to prevent PostgREST resolution errors (PGRST203)
DROP FUNCTION IF EXISTS public.reserve_voucher_number(text, text, boolean);
DROP FUNCTION IF EXISTS public.reserve_voucher_number(text, text, boolean, text);
DROP FUNCTION IF EXISTS public.log_voucher_number_event(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.log_voucher_number_event(text, text, text, text, text, text);

CREATE TABLE IF NOT EXISTS public.voucher_number_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    document_type text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('generated', 'used', 'cancelled')),
    document_number text NOT NULL,
    used_number integer,
    next_number integer,
    fy text,
    reference_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voucher_number_audit_org_doc
    ON public.voucher_number_audit (organization_id, document_type, created_at DESC);

-- Index to support fast MAX(used_number) lookups per FY (used by the reset/resume logic)
CREATE INDEX IF NOT EXISTS idx_voucher_number_audit_fy_lookup
    ON public.voucher_number_audit (organization_id, document_type, fy, event_type, used_number DESC);

CREATE OR REPLACE FUNCTION public.log_voucher_number_event(
    p_organization_id text,
    p_document_type text,
    p_event_type text,
    p_document_number text,
    p_reference_id text DEFAULT NULL,
    p_fy text DEFAULT NULL,
    p_used_number integer DEFAULT NULL,
    p_next_number integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.voucher_number_audit (
        organization_id,
        document_type,
        event_type,
        document_number,
        reference_id,
        fy,
        used_number,
        next_number
    )
    VALUES (
        p_organization_id,
        p_document_type,
        p_event_type,
        p_document_number,
        p_reference_id,
        p_fy,
        p_used_number,
        p_next_number
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_voucher_number(
    p_organization_id text,
    p_document_type text,
    p_is_preview boolean DEFAULT false,
    p_fy text DEFAULT NULL
)
RETURNS TABLE (
    success boolean,
    message text,
    document_number text,
    used_number integer,
    next_number integer,
    remaining_count integer,
    fy text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cfg_row public.configurations%ROWTYPE;
    cfg jsonb;
    cfg_key text;
    v_fy text;
    v_fy_short text;
    v_numbering_mode text;
    v_prefix text;
    v_start integer;
    v_end integer;
    v_padding integer;
    v_use_fy boolean;
    v_current integer;
    v_audit_max integer;
    v_doc text;
    v_stored_fy text;
    v_debug text;
BEGIN
    CASE p_document_type
        WHEN 'sales-gst' THEN cfg_key := 'invoice_config';
        WHEN 'sales-non-gst' THEN cfg_key := 'non_gst_invoice_config';
        WHEN 'purchase-entry' THEN cfg_key := 'purchase_config';
        WHEN 'purchase-order' THEN cfg_key := 'purchase_order_config';
        WHEN 'sales-challan' THEN cfg_key := 'sales_challan_config';
        WHEN 'delivery-challan' THEN cfg_key := 'delivery_challan_config';
        WHEN 'physical-inventory' THEN cfg_key := 'physical_inventory_config';
        ELSE
            RETURN QUERY SELECT false, 'Invalid document type', NULL::text, NULL::integer, NULL::integer, NULL::integer, NULL::text;
            RETURN;
    END CASE;

    IF p_is_preview THEN
        SELECT * INTO cfg_row
        FROM public.configurations
        WHERE organization_id = p_organization_id;
    ELSE
        SELECT * INTO cfg_row
        FROM public.configurations
        WHERE organization_id = p_organization_id
        FOR UPDATE;
    END IF;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'Configuration not found for organization', NULL::text, NULL::integer, NULL::integer, NULL::integer, NULL::text;
        RETURN;
    END IF;

    cfg := COALESCE(to_jsonb(cfg_row)->cfg_key, '{}'::jsonb);
    
    -- Priority: 1. p_fy (passed from UI), 2. config, 3. auto-calculated
    v_fy := p_fy;
    IF v_fy IS NULL THEN
        v_fy := NULLIF(TRIM(COALESCE(
            cfg_row.fiscal_year_config->>'currentFiscalYear',
            cfg_row.fiscal_year_config->>'current_fiscal_year',
            ''
        )), '');
    END IF;

    IF v_fy IS NULL THEN
        v_fy := CONCAT(
            CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE)::int >= 4
                THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1
            END,
            '-',
            LPAD((
                CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE)::int >= 4
                    THEN (EXTRACT(YEAR FROM CURRENT_DATE)::int + 1) % 100
                    ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int % 100
                END
            )::text, 2, '0')
        );
    END IF;

    v_fy_short := SPLIT_PART(v_fy, '-', 1); -- e.g., '2026' from '2026-27'

    v_prefix := COALESCE(cfg->>'prefix', 'INV');
    v_start := GREATEST(1, COALESCE((cfg->>'startingNumber')::integer, (cfg->>'starting_number')::integer, 1));
    v_end := COALESCE(NULLIF(cfg->>'endNumber', ''), NULLIF(cfg->>'end_number', ''))::integer;
    v_padding := GREATEST(1, COALESCE((cfg->>'paddingLength')::integer, (cfg->>'padding_length')::integer, 6));
    v_use_fy := COALESCE((cfg->>'useFiscalYear')::boolean, (cfg->>'use_fiscal_year')::boolean, true);

    v_numbering_mode := COALESCE(
        cfg_row.fiscal_year_config->>'voucherNumberingMode',
        cfg_row.fiscal_year_config->>'voucher_numbering_mode',
        'reset'
    );

    v_stored_fy := COALESCE(cfg->>'fy', '');

    IF v_use_fy AND v_numbering_mode = 'reset' THEN
        -- Robust detection: Search for MAX sequence. 
        -- Fallback: If used_number column is NULL (legacy records), we extract the number from the document_number string.
        SELECT MAX(COALESCE(
            audit.used_number, 
            (regexp_replace(audit.document_number, '^[^0-9]*0*([0-9]+).*$', '\1'))::integer
        )) INTO v_audit_max
        FROM public.voucher_number_audit audit
        WHERE audit.organization_id = p_organization_id
          AND audit.document_type = p_document_type
          AND audit.event_type IN ('generated', 'used')
          AND (
            audit.fy = v_fy 
            OR audit.fy LIKE v_fy_short || '%' 
            OR (audit.fy IS NULL AND audit.document_number ~ ('-' || v_fy_short || '($|-)'))
          );

        IF v_audit_max IS NOT NULL THEN
            v_current := v_audit_max + 1;
            v_debug := 'Audit found: ' || v_audit_max::text || ' (FY: ' || v_fy || ')';
        ELSIF (v_fy = v_stored_fy OR v_fy LIKE v_stored_fy || '%' OR v_stored_fy LIKE v_fy_short || '%') AND v_stored_fy <> '' THEN
            v_current := GREATEST(v_start, COALESCE((cfg->>'currentNumber')::integer, v_start));
            v_debug := 'Audit empty, using config counter (' || v_current::text || ')';
        ELSE
            v_current := v_start;
            v_debug := 'Fresh reset for FY ' || v_fy;
        END IF;
    ELSE
        v_current := GREATEST(v_start, COALESCE((cfg->>'currentNumber')::integer, v_start));
        v_debug := 'Continue mode: using config counter (' || v_current::text || ')';
    END IF;

    IF v_end IS NOT NULL AND v_current > v_end THEN
        RETURN QUERY SELECT false, 'Voucher range exhausted', NULL::text, v_current, (v_current + 1), 0, v_fy;
        RETURN;
    END IF;

    v_doc := v_prefix || LPAD(v_current::text, v_padding, '0') || CASE WHEN v_use_fy THEN '-' || v_fy ELSE '' END;

    IF p_is_preview THEN
        RETURN QUERY SELECT true, 'Preview mode (' || v_debug || ')', v_doc, v_current, (v_current + 1), CASE WHEN v_end IS NULL THEN NULL ELSE (v_end - v_current) END, v_fy;
        RETURN;
    END IF;

    -- Update config
    cfg := jsonb_set(cfg, '{fy}', to_jsonb(v_fy), true);
    cfg := jsonb_set(cfg, '{currentNumber}', to_jsonb(v_current + 1), true);

    UPDATE public.configurations
    SET
        invoice_config = CASE WHEN cfg_key = 'invoice_config' THEN cfg ELSE invoice_config END,
        non_gst_invoice_config = CASE WHEN cfg_key = 'non_gst_invoice_config' THEN cfg ELSE non_gst_invoice_config END,
        purchase_config = CASE WHEN cfg_key = 'purchase_config' THEN cfg ELSE purchase_config END,
        purchase_order_config = CASE WHEN cfg_key = 'purchase_order_config' THEN cfg ELSE purchase_order_config END,
        sales_challan_config = CASE WHEN cfg_key = 'sales_challan_config' THEN cfg ELSE sales_challan_config END,
        delivery_challan_config = CASE WHEN cfg_key = 'delivery_challan_config' THEN cfg ELSE delivery_challan_config END,
        physical_inventory_config = CASE WHEN cfg_key = 'physical_inventory_config' THEN cfg ELSE physical_inventory_config END,
        updated_at = now()
    WHERE id = cfg_row.id;

    INSERT INTO public.voucher_number_audit (
        organization_id, document_type, event_type, document_number, used_number, next_number, fy
    )
    VALUES (
        p_organization_id, p_document_type, 'generated', v_doc, v_current, v_current + 1, v_fy
    );

    RETURN QUERY SELECT true, 'Reserved', v_doc, v_current, (v_current + 1), CASE WHEN v_end IS NULL THEN NULL ELSE (v_end - v_current) END, v_fy;
END;
$$;
