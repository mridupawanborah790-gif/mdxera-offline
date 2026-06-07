import { supabase } from './supabaseClient';

export const DEFAULT_CONFIG_MISSING_MESSAGE = 'Default Company / Default Set of Books not configured. Please update Company Configuration.';

type CompanyCodeRow = {
  id: string;
  code: string;
  status?: string | null;
  organization_id?: string;
  is_default?: boolean | null;
  default_set_of_books_id?: string | null;
};

type SetOfBooksRow = {
  id: string;
  company_code_id: string;
  organization_id?: string;
  active_status?: string | null;
};

export interface DefaultPostingContext {
  companyCodeId: string;
  companyCode: string;
  setOfBooksId: string;
}

const isUuid = (value: string): boolean => (
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
);


const isMissingDefaultColumnsError = (error: any): boolean => {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('is_default') || message.includes('default_set_of_books_id');
};

const loadLegacyFallbackPostingContext = async (organizationId: string): Promise<DefaultPostingContext> => {
  throw new Error(DEFAULT_CONFIG_MISSING_MESSAGE);
};

export const loadDefaultPostingContext = async (organizationId: string): Promise<DefaultPostingContext> => {
  try {
    const raw = localStorage.getItem(`mdxera_company_configuration_v2_${organizationId}`);
    if (!raw) throw new Error(DEFAULT_CONFIG_MISSING_MESSAGE);
    const store = JSON.parse(raw);
    
    const defaultCompany = store.companies?.find((c: any) => c.isDefault && c.status === 'Active');
    if (!defaultCompany || !defaultCompany.defaultSetOfBooksId) {
      throw new Error(DEFAULT_CONFIG_MISSING_MESSAGE);
    }
    
    const defaultBook = store.setOfBooks?.find((b: any) => 
      b.setOfBooksId === defaultCompany.defaultSetOfBooksId && 
      (b.companyCodeId === defaultCompany.id || b.companyCodeId === defaultCompany.code) && 
      b.activeStatus === 'Active'
    );
    
    if (!defaultBook) {
      throw new Error(DEFAULT_CONFIG_MISSING_MESSAGE);
    }
    
    return {
      companyCodeId: defaultCompany.id,
      companyCode: defaultCompany.code,
      setOfBooksId: defaultBook.id,
    };
  } catch (err: any) {
    if (err.message === DEFAULT_CONFIG_MISSING_MESSAGE) throw err;
    throw new Error(DEFAULT_CONFIG_MISSING_MESSAGE);
  }
};
