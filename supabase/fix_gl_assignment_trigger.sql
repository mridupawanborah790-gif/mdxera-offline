
-- Fix GL Assignment validation trigger and schema constraints.
-- 1. Drops NOT NULL constraints on material columns to support PARTY_GROUP scope.
-- 2. Updates validation trigger to skip checks for PARTY_GROUP.

-- Step 1: Alter table to make material columns nullable
ALTER TABLE public.gl_assignments 
  ALTER COLUMN material_master_type DROP NOT NULL,
  ALTER COLUMN purchase_gl DROP NOT NULL,
  ALTER COLUMN cogs_gl DROP NOT NULL,
  ALTER COLUMN discount_gl DROP NOT NULL,
  ALTER COLUMN tax_gl DROP NOT NULL;

-- Step 2: Update the validation trigger function
CREATE OR REPLACE FUNCTION public.validate_gl_assignment_types()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  inv_type text;
  pur_type text;
  cogs_type text;
  sales_type text;
  dis_type text;
  tax_type text;
  v_scope text;
BEGIN
  -- 1. Identify scope. Handle cases where assignment_scope column might not exist (legacy).
  BEGIN
    v_scope := NEW.assignment_scope;
  EXCEPTION WHEN undefined_column THEN
    v_scope := 'MATERIAL';
  END;

  -- 2. Skip material validation for PARTY_GROUP assignments.
  IF v_scope = 'PARTY_GROUP' THEN
    RETURN NEW;
  END IF;

  -- 3. MATERIAL validation (only if scope is MATERIAL or legacy)
  -- For MATERIAL assignments, material_master_type is mandatory.
  IF NEW.material_master_type IS NULL THEN
    RAISE EXCEPTION 'material_master_type is required for MATERIAL assignment';
  END IF;

  -- 4. Check for required columns in MATERIAL assignment.
  -- These columns must not be NULL for MATERIAL rows.
  IF NEW.purchase_gl IS NULL OR NEW.cogs_gl IS NULL OR NEW.discount_gl IS NULL OR NEW.tax_gl IS NULL THEN
    RAISE EXCEPTION 'purchase_gl, cogs_gl, discount_gl and tax_gl are required for MATERIAL assignment';
  END IF;

  -- 5. Validate GL types against GL Master.
  -- Inventory GL (Optional)
  IF NEW.inventory_gl IS NOT NULL THEN
    SELECT gl_type INTO inv_type FROM public.gl_master WHERE id = NEW.inventory_gl;
    IF inv_type IS DISTINCT FROM 'Asset' THEN
      RAISE EXCEPTION 'Inventory GL must be Asset';
    END IF;
  END IF;

  -- Purchase GL (Required)
  SELECT gl_type INTO pur_type FROM public.gl_master WHERE id = NEW.purchase_gl;
  IF pur_type IS DISTINCT FROM 'Expense' THEN
    RAISE EXCEPTION 'Purchase GL must be Expense';
  END IF;

  -- COGS GL (Required)
  SELECT gl_type INTO cogs_type FROM public.gl_master WHERE id = NEW.cogs_gl;
  IF cogs_type IS DISTINCT FROM 'Expense' THEN
    RAISE EXCEPTION 'COGS GL must be Expense';
  END IF;

  -- Sales GL (Optional)
  IF NEW.sales_gl IS NOT NULL THEN
    SELECT gl_type INTO sales_type FROM public.gl_master WHERE id = NEW.sales_gl;
    IF sales_type IS DISTINCT FROM 'Income' THEN
      RAISE EXCEPTION 'Sales GL must be Income';
    END IF;
  END IF;

  -- Discount GL (Required)
  SELECT gl_type INTO dis_type FROM public.gl_master WHERE id = NEW.discount_gl;
  IF dis_type IS DISTINCT FROM 'Expense' THEN
    RAISE EXCEPTION 'Discount GL must be Expense';
  END IF;

  -- Tax GL (Required)
  SELECT gl_type INTO tax_type FROM public.gl_master WHERE id = NEW.tax_gl;
  IF tax_type IS DISTINCT FROM 'Liability' THEN
    RAISE EXCEPTION 'Tax GL must be Liability';
  END IF;

  RETURN NEW;
END;
$$;

-- Ensure trigger is correctly attached (idempotent)
DROP TRIGGER IF EXISTS trg_validate_gl_assignment_types ON public.gl_assignments;
CREATE TRIGGER trg_validate_gl_assignment_types
BEFORE INSERT OR UPDATE ON public.gl_assignments
FOR EACH ROW
EXECUTE FUNCTION public.validate_gl_assignment_types();
