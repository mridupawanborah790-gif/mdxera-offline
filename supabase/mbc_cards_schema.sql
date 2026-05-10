-- MBC Card Management module schema (FIXED for Medimart ERP)

-- 1. MBC CARD TYPES
CREATE TABLE IF NOT EXISTS public.mbc_card_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL, -- Standardized as text for multi-tenant isolation
    type_name text NOT NULL,
    type_code text NOT NULL,
    description text,
    default_validity_value integer NOT NULL DEFAULT 1,
    default_validity_unit text NOT NULL DEFAULT 'years' CHECK (default_validity_unit IN ('days','months','years')),
    default_card_value numeric(12,2) NOT NULL DEFAULT 0,
    template_id uuid,
    color_theme text,
    prefix text NOT NULL DEFAULT 'MBC',
    auto_numbering boolean NOT NULL DEFAULT true,
    allow_manual_value_edit boolean NOT NULL DEFAULT false,
    allow_renewal boolean NOT NULL DEFAULT true,
    allow_upgrade boolean NOT NULL DEFAULT true,
    benefits text,
    terms_conditions text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, type_name),
    UNIQUE (organization_id, type_code)
);

-- 2. MBC CARD TEMPLATES
CREATE TABLE IF NOT EXISTS public.mbc_card_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    template_name text NOT NULL,
    template_code text NOT NULL,
    card_type_id uuid REFERENCES public.mbc_card_types(id) ON DELETE SET NULL,
    width numeric(8,2) NOT NULL DEFAULT 86,
    height numeric(8,2) NOT NULL DEFAULT 54,
    orientation text NOT NULL DEFAULT 'landscape',
    background_image text,
    logo_image text,
    template_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, template_name),
    UNIQUE (organization_id, template_code)
);

-- Circular reference link
ALTER TABLE public.mbc_card_types
    ADD CONSTRAINT mbc_card_types_template_fk
    FOREIGN KEY (template_id) REFERENCES public.mbc_card_templates(id) ON DELETE SET NULL;

-- 3. MBC CARDS
CREATE TABLE IF NOT EXISTS public.mbc_cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    card_number text NOT NULL,
    customer_name text NOT NULL,
    guardian_name text,
    date_of_birth date,
    gender text,
    address_line_1 text,
    address_line_2 text,
    city text,
    district text,
    state text,
    pin_code text,
    phone_number text NOT NULL,
    alternate_phone text,
    email text,
    card_type_id uuid NOT NULL REFERENCES public.mbc_card_types(id) ON DELETE RESTRICT,
    template_id uuid REFERENCES public.mbc_card_templates(id) ON DELETE SET NULL,
    issue_date date NOT NULL,
    validity_from date NOT NULL,
    validity_to date NOT NULL,
    validity_period_text text,
    card_value numeric(12,2) NOT NULL DEFAULT 0,
    qr_value text,
    barcode_value text,
    remarks text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','expired','upcoming')),
    created_by text,
    photo_url text,
    whatsapp_number text,
    website_link text,
    office_location_text text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, card_number)
);

-- 4. MBC CARD HISTORY
CREATE TABLE IF NOT EXISTS public.mbc_card_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    mbc_card_id uuid NOT NULL REFERENCES public.mbc_cards(id) ON DELETE CASCADE,
    action_type text NOT NULL CHECK (action_type IN ('create','update','renew','upgrade','deactivate')),
    old_card_type_id uuid REFERENCES public.mbc_card_types(id) ON DELETE SET NULL,
    new_card_type_id uuid REFERENCES public.mbc_card_types(id) ON DELETE SET NULL,
    old_validity_to date,
    new_validity_to date,
    old_card_value numeric(12,2),
    new_card_value numeric(12,2),
    remarks text,
    action_by text,
    action_date timestamptz NOT NULL DEFAULT now()
);

-- 5. INDEXES
CREATE INDEX IF NOT EXISTS idx_mbc_cards_org_status ON public.mbc_cards (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_mbc_cards_org_validity ON public.mbc_cards (organization_id, validity_to);
CREATE INDEX IF NOT EXISTS idx_mbc_history_org_card ON public.mbc_card_history (organization_id, mbc_card_id, action_date DESC);

-- 6. ROW LEVEL SECURITY
ALTER TABLE public.mbc_card_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mbc_card_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mbc_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mbc_card_history ENABLE ROW LEVEL SECURITY;

-- Using project standard public.get_my_org_id()
CREATE POLICY "mbc_card_types_org_policy" ON public.mbc_card_types
    FOR ALL USING (organization_id = public.get_my_org_id())
    WITH CHECK (organization_id = public.get_my_org_id());

CREATE POLICY "mbc_card_templates_org_policy" ON public.mbc_card_templates
    FOR ALL USING (organization_id = public.get_my_org_id())
    WITH CHECK (organization_id = public.get_my_org_id());

CREATE POLICY "mbc_cards_org_policy" ON public.mbc_cards
    FOR ALL USING (organization_id = public.get_my_org_id())
    WITH CHECK (organization_id = public.get_my_org_id());

CREATE POLICY "mbc_card_history_org_policy" ON public.mbc_card_history
    FOR ALL USING (organization_id = public.get_my_org_id())
    WITH CHECK (organization_id = public.get_my_org_id());

-- 7. TRIGGERS
-- Using project standard update_updated_at_column()
DROP TRIGGER IF EXISTS trg_mbc_card_types_updated_at ON public.mbc_card_types;
CREATE TRIGGER trg_mbc_card_types_updated_at BEFORE UPDATE ON public.mbc_card_types
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_mbc_card_templates_updated_at ON public.mbc_card_templates;
CREATE TRIGGER trg_mbc_card_templates_updated_at BEFORE UPDATE ON public.mbc_card_templates
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_mbc_cards_updated_at ON public.mbc_cards;
CREATE TRIGGER trg_mbc_cards_updated_at BEFORE UPDATE ON public.mbc_cards
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
