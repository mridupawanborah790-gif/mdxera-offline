-- Add Linked Bank GL mapping in Bank Master
ALTER TABLE public.bank_master
  ADD COLUMN IF NOT EXISTS linked_bank_gl_id uuid REFERENCES public.gl_master(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.bank_master.linked_bank_gl_id IS 'Mapped Bank GL account from GL Master used for auto-posting bank-side accounting entries.';
