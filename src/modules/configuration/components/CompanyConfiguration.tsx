import React, { useEffect, useMemo, useState } from 'react';
import Card from '@core/components/ui/Card';
import { supabase } from '@core/db/supabaseClient';
import { RegisteredPharmacy } from '@core/types';
import { isOnline } from '@core/sync/networkMonitor';

const STORAGE_KEY = 'mdxera_company_configuration_v2';

type Status = 'Active' | 'Inactive';
type GLType = 'Asset' | 'Expense' | 'Income' | 'Liability' | 'Equity' | 'Bank';
type AccountType = 'Savings' | 'Current' | 'OD' | 'Cash Credit' | 'Other';
type MaterialType = 'Trading Goods' | 'Finished Goods' | 'Consumables' | 'Service Material' | 'Packaging';

type AuditFields = {
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
};

type CompanyCode = AuditFields & {
  id: string;
  organizationId?: string;
  code: string;
  description: string;
  status: Status;
  isDefault: boolean;
  defaultSetOfBooksId?: string;
};

type SetOfBooks = AuditFields & {
  id: string;
  companyCodeId: string;
  setOfBooksId: string;
  description: string;
  defaultCurrency: string;
  defaultCustomerGLId?: string;
  defaultSupplierGLId?: string;
  defaultDemoBankGLId?: string;
  defaultBankGLId?: string;
  activeStatus: Status;
  postingCount: number;
};

type GLMaster = AuditFields & {
  id: string;
  setOfBooksId: string;
  glCode: string;
  glName: string;
  glType: GLType;
  accountGroup?: string;
  subgroup?: string;
  alias?: string;
  mappingStructure?: string;
  postingAllowed: boolean;
  controlAccount: boolean;
  activeStatus: Status;
  seeded_by_system: boolean;
  template_version: string;
  postingCount: number;
};

type BankMaster = AuditFields & {
  id: string;
  companyCodeId: string;
  linkedBankGlId?: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifscCode: string;
  branchName: string;
  accountType: AccountType;
  openingBalance: number;
  openingDate: string;
  defaultBank: boolean;
  activeStatus: Status;
};

type GLAssignment = AuditFields & {
  id: string;
  setOfBooksId: string;
  assignmentScope?: 'MATERIAL' | 'PARTY_GROUP';
  materialMasterType?: MaterialType;
  partyType?: 'Customer' | 'Supplier';
  partyGroup?: string;
  controlGL?: string;
  inventoryGL?: string;
  purchaseGL?: string;
  cogsGL?: string;
  salesGL?: string;
  discountGL?: string;
  taxGL?: string;
  seeded_by_system: boolean;
  template_version: string;
  activeStatus?: Status;
};

type AssignmentHistory = {
  id: string;
  assignmentId: string;
  setOfBooksId: string;
  materialMasterType: MaterialType;
  changed_at: string;
  changed_by: string;
  effective_from: string;
  previous: Partial<GLAssignment>;
  next: Partial<GLAssignment>;
};

type SetupLog = {
  id: string;
  setOfBooksId: string;
  action: 'DEFAULT_CREATED' | 'RESET_DEFAULT';
  message: string;
  created_at: string;
  created_by: string;
};

type Store = {
  companies: CompanyCode[];
  setOfBooks: SetOfBooks[];
  glMasters: GLMaster[];
  glAssignments: GLAssignment[];
  assignmentHistory: AssignmentHistory[];
  setupLogs: SetupLog[];
  bankMasters: BankMaster[];
};

type TabId = 'company' | 'books' | 'gl' | 'assignment' | 'customerGroupAssignment' | 'supplierGroupAssignment' | 'bank' | 'wizard';


type CompanyConfigurationProps = {
  currentUser: RegisteredPharmacy | null;
};

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'company', label: 'Company Code' },
  { id: 'books', label: 'Set of Books' },
  { id: 'gl', label: 'GL Master' },
  { id: 'bank', label: 'Bank Master' },
  { id: 'assignment', label: 'GL Assignment' },
  { id: 'customerGroupAssignment', label: 'Customer Group GL Assignment' },
  { id: 'supplierGroupAssignment', label: 'Supplier Group GL Assignment' },
  { id: 'wizard', label: 'Setup Wizard / Defaults Log' },
];

const materialTypes: MaterialType[] = ['Trading Goods', 'Finished Goods', 'Consumables', 'Service Material', 'Packaging'];
const glTypes: GLType[] = ['Asset', 'Expense', 'Income', 'Liability', 'Equity', 'Bank'];
const accountTypes: AccountType[] = ['Savings', 'Current', 'OD', 'Cash Credit', 'Other'];

const defaultStore: Store = {
  companies: [],
  setOfBooks: [],
  glMasters: [],
  glAssignments: [],
  assignmentHistory: [],
  setupLogs: [],
  bankMasters: [],
};

const DEFAULT_TEMPLATE_VERSION = 'v1.0';
const SYSTEM_USER = 'system';
const now = () => new Date().toISOString();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value: string | null | undefined): value is string => !!value && UUID_REGEX.test(value);
const getId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};


const normalizeScope = (value: unknown): 'MATERIAL' | 'PARTY_GROUP' => {
  return String(value || '').toUpperCase() === 'PARTY_GROUP' ? 'PARTY_GROUP' : 'MATERIAL';
};

const normalizePartyType = (value: unknown): 'Customer' | 'Supplier' | undefined => {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'customer') return 'Customer';
  if (v === 'supplier') return 'Supplier';
  return undefined;
};

const defaultGlTemplate: Array<{ key: string; glName: string; glType: GLType; code: number }> = [
  { key: 'customerControl', glName: 'Accounts Receivable (Trade Debtors)', glType: 'Asset', code: 120000 },
  { key: 'defaultDemoBank', glName: 'Default Bank A/c', glType: 'Bank', code: 100900 },
  { key: 'invTrading', glName: 'Inventory - Trading Goods', glType: 'Asset', code: 140000 },
  { key: 'invFinished', glName: 'Inventory - Finished Goods', glType: 'Asset', code: 140100 },
  { key: 'invConsumable', glName: 'Inventory - Consumables', glType: 'Asset', code: 140200 },
  { key: 'invPackaging', glName: 'Inventory - Packaging', glType: 'Asset', code: 140300 },
  { key: 'purchase', glName: 'Purchase Account', glType: 'Expense', code: 500100 },
  { key: 'cogs', glName: 'COGS Account', glType: 'Expense', code: 500200 },
  { key: 'discount', glName: 'Discount Account', glType: 'Expense', code: 500300 },
  { key: 'serviceCost', glName: 'Service Cost', glType: 'Expense', code: 500400 },
  { key: 'sales', glName: 'Sales Account', glType: 'Income', code: 400100 },
  { key: 'outputCgst', glName: 'Output CGST', glType: 'Liability', code: 210110 },
  { key: 'outputSgst', glName: 'Output SGST', glType: 'Liability', code: 210120 },
  { key: 'outputIgst', glName: 'Output IGST', glType: 'Liability', code: 210130 },
  { key: 'roundOff', glName: 'Round Off Account', glType: 'Expense', code: 510000 },
  { key: 'gstInput', glName: 'GST Input', glType: 'Liability', code: 210200 },
  { key: 'supplierControl', glName: 'Accounts Payable (Trade Creditors)', glType: 'Liability', code: 210000 },
  { key: 'payables', glName: 'Trade Payables', glType: 'Liability', code: 220000 },
];

const CONTROL_GL_CODES = {
  customer: '120000',
  supplier: '210000',
} as const;

const defaultCustomerGroupConfig: Array<{ group: string; glCode: number; glName: string }> = [
  { group: 'Sundry Debtors', glCode: 110001, glName: 'Sundry Debtors A/c' },
  { group: 'Cash Customers', glCode: 110005, glName: 'Cash Customer Receivable A/c' },
  { group: 'Corporate Customers', glCode: 110002, glName: 'Corporate Customer Receivable A/c' },
  { group: 'Retail Customers', glCode: 110003, glName: 'Retail Customer Receivable A/c' },
  { group: 'Government Customers', glCode: 110004, glName: 'Government Customer Receivable A/c' },
];

const defaultSupplierGroupConfig: Array<{ group: string; glCode: number; glName: string }> = [
  { group: 'Sundry Creditors', glCode: 210001, glName: 'Sundry Creditors A/c' },
  { group: 'Import Vendors', glCode: 210002, glName: 'Import Creditors A/c' },
  { group: 'Local Vendors', glCode: 210003, glName: 'Trade Creditors A/c' },
  { group: 'Service Vendors', glCode: 210004, glName: 'Service Creditors A/c' },
];

const requiredFieldRules: Record<MaterialType, { inventoryRequired: boolean; salesRequired: boolean }> = {
  'Trading Goods': { inventoryRequired: true, salesRequired: true },
  'Finished Goods': { inventoryRequired: true, salesRequired: true },
  Consumables: { inventoryRequired: false, salesRequired: false },
  'Service Material': { inventoryRequired: false, salesRequired: true },
  Packaging: { inventoryRequired: true, salesRequired: false },
};

const exportCsv = (filename: string, headers: string[], rows: Array<Array<string | number | boolean | undefined>>) => {
  const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
};

const CompanyConfiguration: React.FC<CompanyConfigurationProps> = ({ currentUser }) => {
  const [activeTab, setActiveTab] = useState<TabId>('company');
  const [store, setStore] = useState<Store>(defaultStore);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');

  // Scoped storage key based on organization to prevent data leakage
  const orgScopedKey = useMemo(() => {
    return currentUser?.organization_id ? `${STORAGE_KEY}_${currentUser.organization_id}` : STORAGE_KEY;
  }, [currentUser?.organization_id]);

  const [isFetchingFromServer, setIsFetchingFromServer] = useState(false);

  const [companyForm, setCompanyForm] = useState({ code: '', description: '', status: 'Active' as Status, isDefault: false, defaultSetOfBooksId: '' });
  const [booksForm, setBooksForm] = useState({ companyCodeId: '', setOfBooksId: '', description: '', defaultCurrency: 'INR', defaultCustomerGLId: '', defaultSupplierGLId: '', defaultDemoBankGLId: '', defaultBankGLId: '', activeStatus: 'Active' as Status, postingCount: 0 });
  const [glForm, setGlForm] = useState({ setOfBooksId: '', glCode: '', glName: '', alias: '', glType: 'Asset' as GLType, accountGroup: '', subgroup: '', mappingStructure: '', postingAllowed: true, controlAccount: false, activeStatus: 'Active' as Status, postingCount: 0 });
  const [assignmentForm, setAssignmentForm] = useState({ setOfBooksId: '', materialMasterType: 'Trading Goods' as MaterialType, inventoryGL: '', purchaseGL: '', cogsGL: '', salesGL: '', discountGL: '', taxGL: '' });
  const [customerGroupAssignmentForm, setCustomerGroupAssignmentForm] = useState({ setOfBooksId: '', customerGroup: 'Sundry Debtors', controlGL: '' });
  const [supplierGroupAssignmentForm, setSupplierGroupAssignmentForm] = useState({ setOfBooksId: '', supplierGroup: 'Sundry Creditors', controlGL: '', status: 'Active' as Status });

  const [bankForm, setBankForm] = useState({ companyCodeId: '', linkedBankGlId: '', bankName: '', accountName: '', accountNumber: '', ifscCode: '', branchName: '', accountType: 'Savings' as AccountType, openingBalance: 0, openingDate: '', defaultBank: false, activeStatus: 'Active' as Status });

  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null);
  const [editingBooksId, setEditingBooksId] = useState<string | null>(null);
  const [editingGlId, setEditingGlId] = useState<string | null>(null);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null);
  const [editingCustomerGroupAssignmentId, setEditingCustomerGroupAssignmentId] = useState<string | null>(null);
  const [editingSupplierGroupAssignmentId, setEditingSupplierGroupAssignmentId] = useState<string | null>(null);
  const [editingBankId, setEditingBankId] = useState<string | null>(null);

  const persist = (next: Store) => {
    setStore(next);
    localStorage.setItem(orgScopedKey, JSON.stringify(next));
  };


  useEffect(() => {
    const initializeStore = async () => {
      setStore(defaultStore);

      const raw = localStorage.getItem(orgScopedKey);
      let initialStore = raw ? { ...defaultStore, ...JSON.parse(raw) } : defaultStore;
      setStore(initialStore);

      if (!currentUser?.organization_id) return;

      // Setup wizard reads several tables that aren't yet mirrored in SQLite
      // (setup_wizard_defaults_log, gl_assignment_history, bank_master). When
      // offline we fall back to the localStorage cache loaded above and skip
      // the network refresh entirely.
      if (!isOnline()) return;

      try {
        const organizationId = currentUser.organization_id;
        const [companiesRes, booksRes, glRes, assignmentRes, logsRes, historyRes, bankRes] = await Promise.all([
          supabase.from('company_codes').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
          supabase.from('set_of_books').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
          supabase.from('gl_master').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
          supabase.from('gl_assignments').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
          supabase.from('setup_wizard_defaults_log').select('*').eq('organization_id', organizationId).order('created_at', { ascending: false }),
          supabase.from('gl_assignment_history').select('*').eq('organization_id', organizationId).order('changed_at', { ascending: false }),
          supabase.from('bank_master').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
        ]);

        const hasSchemaError = [companiesRes, booksRes, glRes, assignmentRes, logsRes, historyRes, bankRes].some(r => r.error);
        if (hasSchemaError) return;

        const booksForOrg: SetOfBooks[] = (booksRes.data || []).map((b: any) => ({
          id: b.id,
          companyCodeId: b.company_code_id,
          setOfBooksId: b.set_of_books_id,
          description: b.description || '',
          defaultCurrency: b.default_currency || 'INR',
          defaultCustomerGLId: b.default_customer_gl_id || undefined,
          defaultSupplierGLId: b.default_supplier_gl_id || undefined,
          defaultDemoBankGLId: b.default_demo_bank_gl_id || undefined,
          defaultBankGLId: b.default_bank_gl_id || undefined,
          activeStatus: b.active_status || 'Active',
          postingCount: b.posting_count || 0,
          created_by: b.created_by || SYSTEM_USER,
          created_at: b.created_at || now(),
          updated_by: b.updated_by || SYSTEM_USER,
          updated_at: b.updated_at || now(),
        }));

        const normalizedCompanies: CompanyCode[] = (companiesRes.data || []).map((c: any) => {
          const rawDefaultSob = String(c.default_set_of_books_id || '').trim();
          const mappedByCode = booksForOrg.find((b) => b.setOfBooksId === rawDefaultSob && b.companyCodeId === c.id && b.activeStatus === 'Active');

          return {
            id: c.id,
            organizationId: c.organization_id,
            code: c.code,
            description: c.description || '',
            status: c.status || 'Active',
            isDefault: !!c.is_default,
            defaultSetOfBooksId: mappedByCode?.setOfBooksId || '',
            created_by: c.created_by || SYSTEM_USER,
            created_at: c.created_at || now(),
            updated_by: c.updated_by || SYSTEM_USER,
            updated_at: c.updated_at || now(),
          };
        });

        const dbStore: Store = {
          companies: normalizedCompanies,
          setOfBooks: booksForOrg.map((b) => {
            const matchingCompanyById = normalizedCompanies.find(c => c.id === b.companyCodeId);
            const matchingCompanyByCode = normalizedCompanies.find(c => c.code === b.companyCodeId);
            return {
              ...b,
              companyCodeId: matchingCompanyById?.id || matchingCompanyByCode?.id || b.companyCodeId,
            };
          }),
          glMasters: (glRes.data || []).map((g: any) => ({
            id: g.id,
            setOfBooksId: g.set_of_books_id,
            glCode: g.gl_code,
            glName: g.gl_name,
            glType: g.gl_type,
            accountGroup: g.account_group || '',
            subgroup: g.subgroup || '',
            alias: g.alias || '',
            mappingStructure: g.mapping_structure || '',
            postingAllowed: !!g.posting_allowed,
            controlAccount: !!g.control_account,
            activeStatus: g.active_status || 'Active',
            seeded_by_system: !!g.seeded_by_system,
            template_version: g.template_version || DEFAULT_TEMPLATE_VERSION,
            postingCount: g.posting_count || 0,
            created_by: g.created_by || SYSTEM_USER,
            created_at: g.created_at || now(),
            updated_by: g.updated_by || SYSTEM_USER,
            updated_at: g.updated_at || now(),
          })),
          glAssignments: (assignmentRes.data || []).map((a: any) => ({
            id: a.id,
            setOfBooksId: a.set_of_books_id,
            assignmentScope: normalizeScope(a.assignment_scope),
            materialMasterType: normalizeScope(a.assignment_scope) === 'MATERIAL' ? a.material_master_type : undefined,
            partyType: normalizePartyType(a.party_type),
            partyGroup: a.party_group || '',
            controlGL: a.control_gl_id || '',
            activeStatus: a.active_status || 'Active',
            inventoryGL: a.inventory_gl || '',
            purchaseGL: a.purchase_gl || '',
            cogsGL: a.cogs_gl || '',
            salesGL: a.sales_gl || '',
            discountGL: a.discount_gl || '',
            taxGL: a.tax_gl || '',
            seeded_by_system: !!a.seeded_by_system,
            template_version: a.template_version || DEFAULT_TEMPLATE_VERSION,
            active_status: a.activeStatus || 'Active',
            created_by: a.created_by || SYSTEM_USER,
            created_at: a.created_at || now(),
            updated_by: a.updated_by || SYSTEM_USER,
            updated_at: a.updated_at || now(),
          })),
          setupLogs: (logsRes.data || []).map((l: any) => ({
            id: l.id,
            setOfBooksId: l.set_of_books_id,
            action: l.action,
            message: l.message,
            created_at: l.created_at || now(),
            created_by: l.created_by || SYSTEM_USER,
          })),
          assignmentHistory: (historyRes.data || []).map((h: any) => ({
            id: h.id,
            assignmentId: h.assignment_id,
            setOfBooksId: h.set_of_books_id,
            materialMasterType: h.material_master_type,
            changed_at: h.changed_at || now(),
            changed_by: h.changed_by || SYSTEM_USER,
            effective_from: h.effective_from || now(),
            previous: h.previous_payload || {},
            next: h.next_payload || {},
          })),
          bankMasters: (bankRes.data || []).map((b: any) => ({
            id: b.id,
            companyCodeId: b.company_code_id,
            linkedBankGlId: b.linked_bank_gl_id || undefined,
            bankName: b.bank_name || '',
            accountName: b.account_name || '',
            accountNumber: b.account_number || '',
            ifscCode: b.ifsc_code || '',
            branchName: b.branch_name || '',
            accountType: b.account_type || 'Savings',
            openingBalance: Number(b.opening_balance || 0),
            openingDate: b.opening_date || '',
            defaultBank: !!b.default_bank,
            activeStatus: b.active_status || 'Active',
            created_by: b.created_by || SYSTEM_USER,
            created_at: b.created_at || now(),
            updated_by: b.updated_by || SYSTEM_USER,
            updated_at: b.updated_at || now(),
          })),
        };

        if (dbStore.companies.length || dbStore.setOfBooks.length || dbStore.glMasters.length || dbStore.glAssignments.length || dbStore.bankMasters.length) {
          persist(dbStore);
        }
      } catch (err) {
        console.error('Failed to load configuration from database:', err);
      }
    };

    initializeStore();
  }, [currentUser?.organization_id, orgScopedKey]);

  const booksById = useMemo(() => new Map(store.setOfBooks.map(s => [s.id, s])), [store.setOfBooks]);
  const glById = useMemo(() => new Map(store.glMasters.map(g => [g.id, g])), [store.glMasters]);
  const glForSelectedBooks = useMemo(() => store.glMasters.filter(g => g.setOfBooksId === assignmentForm.setOfBooksId && g.activeStatus === 'Active'), [store.glMasters, assignmentForm.setOfBooksId]);
  const customerGroupGlOptions = useMemo(() => store.glMasters.filter(g => g.setOfBooksId === customerGroupAssignmentForm.setOfBooksId && g.activeStatus === 'Active' && g.glType === 'Asset'), [store.glMasters, customerGroupAssignmentForm.setOfBooksId]);
  const supplierGroupGlOptions = useMemo(() => store.glMasters.filter(g => g.setOfBooksId === supplierGroupAssignmentForm.setOfBooksId && g.activeStatus === 'Active' && g.glType === 'Liability'), [store.glMasters, supplierGroupAssignmentForm.setOfBooksId]);
  const booksForCompanyForm = useMemo(() => {
    if (!editingCompanyId) return [];
    return store.setOfBooks.filter(b => b.companyCodeId === editingCompanyId && b.activeStatus === 'Active');
  }, [store.setOfBooks, editingCompanyId]);
  const defaultBooksOptions = useMemo(() => {
    if (editingCompanyId) {
      return store.setOfBooks.filter(b => b.companyCodeId === editingCompanyId && b.activeStatus === 'Active');
    }
    const companyCode = companyForm.code.trim().toLowerCase();
    if (!companyCode) return [];
    const matchingCompanyIds = store.companies
      .filter(c => c.code.trim().toLowerCase() === companyCode)
      .map(c => c.id);
    return store.setOfBooks.filter(b => matchingCompanyIds.includes(b.companyCodeId) && b.activeStatus === 'Active');
  }, [store.setOfBooks, store.companies, editingCompanyId, companyForm.code]);
  const activeCompanies = useMemo(() => store.companies.filter(c => c.status === 'Active'), [store.companies]);
  const booksFormRecord = useMemo(() => store.setOfBooks.find(b => b.setOfBooksId === booksForm.setOfBooksId && b.companyCodeId === booksForm.companyCodeId), [store.setOfBooks, booksForm.setOfBooksId, booksForm.companyCodeId]);
  const bankGlOptionsForBooksForm = useMemo(() => {
    if (!booksFormRecord?.id) return [] as GLMaster[];
    return store.glMasters.filter(g => g.setOfBooksId === booksFormRecord.id && g.glType === 'Bank' && g.activeStatus === 'Active');
  }, [store.glMasters, booksFormRecord?.id]);


  const bankGlOptionsForBankForm = useMemo(() => {
    if (!bankForm.companyCodeId) return [] as GLMaster[];
    const activeBooksIds = new Set(
      store.setOfBooks
        .filter((b) => b.companyCodeId === bankForm.companyCodeId && b.activeStatus === 'Active')
        .map((b) => b.id)
    );
    return store.glMasters.filter((g) => activeBooksIds.has(g.setOfBooksId) && g.glType === 'Bank' && g.activeStatus === 'Active');
  }, [store.glMasters, store.setOfBooks, bankForm.companyCodeId]);

  const seedDefaultsForBooks = (setOfBooksId: string, mode: 'create' | 'append', currentStore?: Store) => {
    const activeStore = currentStore || store;
    const stamp = now();
    const glExisting = activeStore.glMasters.filter(g => g.setOfBooksId === setOfBooksId);
    const codeExists = new Set(glExisting.map(g => g.glCode));
    const keyToGlId = new Map<string, string>();
    const createdGL: GLMaster[] = [];

    defaultGlTemplate.forEach((tpl) => {
      const baseCode = String(tpl.code);
      const found = glExisting.find(g =>
        (g.glName.toLowerCase() === tpl.glName.toLowerCase() && g.glType === tpl.glType)
        || (g.glCode === baseCode && g.glType === tpl.glType)
      );
      if (found) {
        keyToGlId.set(tpl.key, found.id);
        codeExists.add(found.glCode);
        return;
      }

      let generatedCode = baseCode;
      let suffix = 1;
      while (codeExists.has(generatedCode)) {
        generatedCode = `${baseCode}-${String(suffix).padStart(2, '0')}`;
        suffix += 1;
      }
      codeExists.add(generatedCode);

      const glId = getId();
      const isControl = tpl.key === 'customerControl' || tpl.key === 'supplierControl';
      createdGL.push({
        id: glId,
        setOfBooksId,
        glCode: generatedCode,
        glName: tpl.glName,
        glType: tpl.glType,
        postingAllowed: !isControl,
        controlAccount: isControl,
        activeStatus: 'Active',
        seeded_by_system: true,
        template_version: DEFAULT_TEMPLATE_VERSION,
        postingCount: 0,
        created_at: stamp,
        updated_at: stamp,
        created_by: SYSTEM_USER,
        updated_by: SYSTEM_USER,
      });
      keyToGlId.set(tpl.key, glId);
    });

    defaultCustomerGroupConfig.forEach((cfg) => {
      const code = String(cfg.glCode);
      const found = glExisting.find(g =>
        (g.glCode === code && g.glType === 'Asset')
        || (g.glName.toLowerCase() === cfg.glName.toLowerCase() && g.glType === 'Asset')
      );
      if (found) {
        keyToGlId.set(`customerGroup:${cfg.group}`, found.id);
        codeExists.add(found.glCode);
        return;
      }

      let generatedCode = code;
      let suffix = 1;
      while (codeExists.has(generatedCode)) {
        generatedCode = `${code}-${String(suffix).padStart(2, '0')}`;
        suffix += 1;
      }
      codeExists.add(generatedCode);

      const glId = getId();
      createdGL.push({
        id: glId,
        setOfBooksId,
        glCode: generatedCode,
        glName: cfg.glName,
        glType: 'Asset',
        accountGroup: 'Current Assets',
        subgroup: 'Trade Receivables',
        postingAllowed: false,
        controlAccount: true,
        activeStatus: 'Active',
        seeded_by_system: true,
        template_version: DEFAULT_TEMPLATE_VERSION,
        postingCount: 0,
        created_at: stamp,
        updated_at: stamp,
        created_by: SYSTEM_USER,
        updated_by: SYSTEM_USER,
      });
      keyToGlId.set(`customerGroup:${cfg.group}`, glId);
    });


    defaultSupplierGroupConfig.forEach((cfg) => {
      const code = String(cfg.glCode);
      const found = glExisting.find(g =>
        (g.glCode === code && g.glType === 'Liability')
        || (g.glName.toLowerCase() === cfg.glName.toLowerCase() && g.glType === 'Liability')
      );
      if (found) {
        keyToGlId.set(`supplierGroup:${cfg.group}`, found.id);
        codeExists.add(found.glCode);
        return;
      }

      let generatedCode = code;
      let suffix = 1;
      while (codeExists.has(generatedCode)) {
        generatedCode = `${code}-${String(suffix).padStart(2, '0')}`;
        suffix += 1;
      }
      codeExists.add(generatedCode);

      const glId = getId();
      createdGL.push({
        id: glId,
        setOfBooksId,
        glCode: generatedCode,
        glName: cfg.glName,
        glType: 'Liability',
        accountGroup: 'Current Liabilities',
        subgroup: 'Trade Payables',
        postingAllowed: false,
        controlAccount: true,
        activeStatus: 'Active',
        seeded_by_system: true,
        template_version: DEFAULT_TEMPLATE_VERSION,
        postingCount: 0,
        created_at: stamp,
        updated_at: stamp,
        created_by: SYSTEM_USER,
        updated_by: SYSTEM_USER,
      });
      keyToGlId.set(`supplierGroup:${cfg.group}`, glId);
    });

    const assignmentSeed: Array<Omit<GLAssignment, keyof AuditFields | 'id'>> = [
      { assignmentScope: 'MATERIAL', setOfBooksId, materialMasterType: 'Trading Goods', inventoryGL: keyToGlId.get('invTrading') || '', purchaseGL: keyToGlId.get('purchase') || '', cogsGL: keyToGlId.get('cogs') || '', salesGL: keyToGlId.get('sales') || '', discountGL: keyToGlId.get('discount') || '', taxGL: keyToGlId.get('outputCgst') || keyToGlId.get('payables') || '', seeded_by_system: true, template_version: DEFAULT_TEMPLATE_VERSION },
      { assignmentScope: 'MATERIAL', setOfBooksId, materialMasterType: 'Finished Goods', inventoryGL: keyToGlId.get('invFinished') || '', purchaseGL: keyToGlId.get('purchase') || '', cogsGL: keyToGlId.get('cogs') || '', salesGL: keyToGlId.get('sales') || '', discountGL: keyToGlId.get('discount') || '', taxGL: keyToGlId.get('outputCgst') || keyToGlId.get('payables') || '', seeded_by_system: true, template_version: DEFAULT_TEMPLATE_VERSION },
      { assignmentScope: 'MATERIAL', setOfBooksId, materialMasterType: 'Consumables', inventoryGL: keyToGlId.get('invConsumable') || '', purchaseGL: keyToGlId.get('purchase') || '', cogsGL: keyToGlId.get('cogs') || '', salesGL: keyToGlId.get('sales') || '', discountGL: keyToGlId.get('discount') || '', taxGL: keyToGlId.get('outputCgst') || keyToGlId.get('payables') || '', seeded_by_system: true, template_version: DEFAULT_TEMPLATE_VERSION },
      { assignmentScope: 'MATERIAL', setOfBooksId, materialMasterType: 'Service Material', inventoryGL: '', purchaseGL: keyToGlId.get('serviceCost') || keyToGlId.get('purchase') || '', cogsGL: keyToGlId.get('serviceCost') || keyToGlId.get('cogs') || '', salesGL: keyToGlId.get('sales') || '', discountGL: keyToGlId.get('discount') || '', taxGL: keyToGlId.get('outputCgst') || keyToGlId.get('payables') || '', seeded_by_system: true, template_version: DEFAULT_TEMPLATE_VERSION },
      { assignmentScope: 'MATERIAL', setOfBooksId, materialMasterType: 'Packaging', inventoryGL: keyToGlId.get('invPackaging') || '', purchaseGL: keyToGlId.get('purchase') || '', cogsGL: keyToGlId.get('cogs') || '', salesGL: '', discountGL: keyToGlId.get('discount') || '', taxGL: keyToGlId.get('outputCgst') || keyToGlId.get('payables') || '', seeded_by_system: true, template_version: DEFAULT_TEMPLATE_VERSION },
      ...defaultCustomerGroupConfig.map((cfg) => ({
        assignmentScope: 'PARTY_GROUP' as const,
        setOfBooksId,
        partyType: 'Customer' as const,
        partyGroup: cfg.group,
        controlGL: keyToGlId.get(`customerGroup:${cfg.group}`) || '',
        seeded_by_system: true,
        template_version: DEFAULT_TEMPLATE_VERSION,
      })),
      ...defaultSupplierGroupConfig.map((cfg) => ({
        assignmentScope: 'PARTY_GROUP' as const,
        setOfBooksId,
        partyType: 'Supplier' as const,
        partyGroup: cfg.group,
        controlGL: keyToGlId.get(`supplierGroup:${cfg.group}`) || '',
        seeded_by_system: true,
        template_version: DEFAULT_TEMPLATE_VERSION,
      })),
    ];

    const existingAssignments = activeStore.glAssignments.filter(a => a.setOfBooksId === setOfBooksId);
    const createdAssignments = assignmentSeed
      .filter((a) => {
        if (a.assignmentScope === 'PARTY_GROUP') {
          return !existingAssignments.some(e => (e.assignmentScope || 'MATERIAL') === 'PARTY_GROUP' && e.setOfBooksId === a.setOfBooksId && e.partyType === a.partyType && e.partyGroup === a.partyGroup);
        }
        return !existingAssignments.some(e => (e.assignmentScope || 'MATERIAL') === 'MATERIAL' && e.materialMasterType === a.materialMasterType);
      })
      .map(a => ({ id: getId(), ...a, created_at: stamp, updated_at: stamp, created_by: SYSTEM_USER, updated_by: SYSTEM_USER }));

    const next: Store = {
      ...activeStore,
      setOfBooks: activeStore.setOfBooks.map((book) => {
        if (book.id !== setOfBooksId) return book;
        return {
          ...book,
          defaultCustomerGLId: keyToGlId.get('customerControl') || keyToGlId.get('customerGroup:Sundry Debtors') || book.defaultCustomerGLId,
          defaultSupplierGLId: keyToGlId.get('supplierControl') || book.defaultSupplierGLId,
          defaultDemoBankGLId: keyToGlId.get('defaultDemoBank') || book.defaultDemoBankGLId,
          defaultBankGLId: keyToGlId.get('defaultDemoBank') || book.defaultBankGLId,
          updated_at: stamp,
          updated_by: SYSTEM_USER,
        };
      }),
      glMasters: [...activeStore.glMasters, ...createdGL],
      glAssignments: [...activeStore.glAssignments, ...createdAssignments],
      setupLogs: [...activeStore.setupLogs, {
        id: getId(),
        setOfBooksId,
        action: mode === 'create' ? 'DEFAULT_CREATED' : 'RESET_DEFAULT',
        message: mode === 'create'
          ? 'Default GL, customer/supplier control GLs, customer-group GLs, and assignments seeded.'
          : 'Reset to default (append mode) with customer/supplier and customer-group control GL assignment.',
        created_at: stamp,
        created_by: SYSTEM_USER,
      }],
    };

    persist(next);
    setSuccess(`Default setup complete. Added ${createdGL.length} GL(s) and ${createdAssignments.length} assignment(s).`);
  };

  const validateAssignment = (payload: typeof assignmentForm): string | null => {
    const sobId = payload.setOfBooksId;
    const rule = requiredFieldRules[payload.materialMasterType];
    const validateType = (id: string | undefined, expected: GLType, label: string, required = true) => {
      if (!id) return required ? `${label} is required.` : null;
      const gl = glById.get(id);
      if (!gl || gl.setOfBooksId !== sobId) return `${label} is invalid for selected Set of Books.`;
      if (gl.glType !== expected) return `${label} must be ${expected}.`;
      return null;
    };

    const checks = [
      validateType(payload.inventoryGL, 'Asset', 'Inventory GL', rule.inventoryRequired),
      validateType(payload.purchaseGL, 'Expense', 'Purchase GL'),
      validateType(payload.cogsGL, 'Expense', 'COGS GL'),
      validateType(payload.salesGL, 'Income', 'Sales GL', rule.salesRequired),
      validateType(payload.discountGL, 'Expense', 'Discount GL'),
      validateType(payload.taxGL, 'Liability', 'Tax GL'),
    ];

    return checks.find(Boolean) || null;
  };

  const filteredCompanies = store.companies.filter(c => [c.code, c.description, c.status, c.isDefault ? 'default' : ''].join(' ').toLowerCase().includes(search.toLowerCase()));
  const filteredBooks = store.setOfBooks.filter(b => [b.setOfBooksId, b.description, b.defaultCurrency].join(' ').toLowerCase().includes(search.toLowerCase()));
  const filteredGL = store.glMasters.filter(g => [g.glCode, g.glName, g.glType].join(' ').toLowerCase().includes(search.toLowerCase()));
  const filteredAssignments = store.glAssignments.filter(a => (a.assignmentScope || 'MATERIAL') === 'MATERIAL' && [a.materialMasterType, booksById.get(a.setOfBooksId)?.setOfBooksId || ''].join(' ').toLowerCase().includes(search.toLowerCase()));
  const filteredCustomerGroupAssignments = store.glAssignments.filter(a => (a.assignmentScope || 'MATERIAL') === 'PARTY_GROUP' && a.partyType === 'Customer' && [a.partyGroup, booksById.get(a.setOfBooksId)?.setOfBooksId || ''].join(' ').toLowerCase().includes(search.toLowerCase()));
  const filteredSupplierGroupAssignments = store.glAssignments.filter(a => (a.assignmentScope || 'MATERIAL') === 'PARTY_GROUP' && a.partyType === 'Supplier' && [a.partyGroup, booksById.get(a.setOfBooksId)?.setOfBooksId || ''].join(' ').toLowerCase().includes(search.toLowerCase()));
  const filteredBanks = store.bankMasters.filter(b => [b.bankName, b.accountName, b.accountNumber, b.ifscCode, b.branchName].join(' ').toLowerCase().includes(search.toLowerCase()));

  const onSaveCompany = () => {
    setError('');
    setSuccess('');
    if (!companyForm.code.trim()) return setError('Company Code is mandatory before Set of Books setup.');
    const duplicate = store.companies.some(c => c.code.toLowerCase() === companyForm.code.trim().toLowerCase() && c.id !== editingCompanyId);
    if (duplicate) return setError('Company Code must be unique.');
    if (companyForm.isDefault && companyForm.status !== 'Active') return setError('Inactive company cannot be selected as default company.');
    if (companyForm.isDefault && !companyForm.defaultSetOfBooksId) return setError('Default Company must always have a Default Set of Books assigned.');

    if (companyForm.isDefault && editingCompanyId) {
      const mappedBooks = store.setOfBooks.find(b => b.setOfBooksId === companyForm.defaultSetOfBooksId && b.companyCodeId === editingCompanyId && b.activeStatus === 'Active');
      if (!mappedBooks) return setError('Default Set of Books must belong to the selected Company Code and must be Active.');
    }

    const stamp = now();
    const baseCompany = editingCompanyId
      ? store.companies.find(c => c.id === editingCompanyId)
      : null;
    const targetId = editingCompanyId || getId();

    const nextCompanies = store.companies
      .filter(c => c.id !== targetId)
      .map(c => companyForm.isDefault ? { ...c, isDefault: false, updated_at: stamp, updated_by: SYSTEM_USER } : c);

    nextCompanies.push({
      ...(baseCompany || { created_at: stamp, created_by: SYSTEM_USER }),
      id: targetId,
      organizationId: currentUser?.organization_id,
      code: companyForm.code.trim(),
      description: companyForm.description,
      status: companyForm.status,
      isDefault: companyForm.isDefault,
      defaultSetOfBooksId: companyForm.defaultSetOfBooksId || '',
      updated_at: stamp,
      updated_by: SYSTEM_USER,
    } as CompanyCode);

    persist({ ...store, companies: nextCompanies });
    setSuccess(editingCompanyId ? 'Company Code updated.' : 'Company Code created.');

    setCompanyForm({ code: '', description: '', status: 'Active', isDefault: false, defaultSetOfBooksId: '' });
    setEditingCompanyId(null);
  };

  const onSaveBooks = () => {
    setError('');
    setSuccess('');
    if (!booksForm.companyCodeId || !isUuid(booksForm.companyCodeId)) return setError('Company Code must be selected before assigning Set of Books.');
    const selectedCompany = store.companies.find(c => c.id === booksForm.companyCodeId);
    if (!selectedCompany) return setError('Company Code must be selected before assigning Set of Books.');
    if (!booksForm.setOfBooksId.trim()) return setError('Set of Books ID is required.');

    const duplicate = store.setOfBooks.some(b => b.companyCodeId === booksForm.companyCodeId && b.setOfBooksId.toLowerCase() === booksForm.setOfBooksId.trim().toLowerCase() && b.id !== editingBooksId);
    if (duplicate) return setError('Set of Books ID must be unique per Company Code.');

    const stamp = now();
    if (editingBooksId) {
      persist({ ...store, setOfBooks: store.setOfBooks.map(b => b.id === editingBooksId ? { ...b, ...booksForm, setOfBooksId: booksForm.setOfBooksId.trim(), updated_at: stamp, updated_by: SYSTEM_USER } : b) });
      setSuccess('Set of Books updated.');
    } else {
      const newBooksId = getId();
      const newBook: SetOfBooks = { id: newBooksId, ...booksForm, setOfBooksId: booksForm.setOfBooksId.trim(), created_at: stamp, updated_at: stamp, created_by: SYSTEM_USER, updated_by: SYSTEM_USER };
      const nextStore = {
        ...store,
        setOfBooks: [...store.setOfBooks, newBook],
      };
      
      seedDefaultsForBooks(newBooksId, 'create', nextStore);
    }

    setBooksForm({ companyCodeId: '', setOfBooksId: '', description: '', defaultCurrency: 'INR', defaultCustomerGLId: '', defaultSupplierGLId: '', defaultDemoBankGLId: '', defaultBankGLId: '', activeStatus: 'Active', postingCount: 0 });
    setEditingBooksId(null);
  };


  const onCopyGL = (source: GLMaster) => {
    setGlForm({
      setOfBooksId: source.setOfBooksId,
      glCode: '',
      glName: `${source.glName} Copy`,
      alias: source.alias || '',
      glType: source.glType,
      accountGroup: source.accountGroup || '',
      subgroup: source.subgroup || '',
      mappingStructure: source.mappingStructure || '',
      postingAllowed: source.postingAllowed,
      controlAccount: false,
      activeStatus: source.activeStatus,
      postingCount: 0,
    });
    setEditingGlId(null);
    setSuccess('GL copied. Update GL Code / GL Name and save.');
    setError('');
  };

  const onSaveBank = () => {
    setError('');
    setSuccess('');
    if (!bankForm.companyCodeId) return setError('Company Code is required for Bank Master.');
    if (!bankForm.bankName.trim()) return setError('Bank Name is required.');
    if (!bankForm.accountName.trim()) return setError('Account Name is required.');
    if (!bankForm.accountNumber.trim()) return setError('Account Number is required.');
    if (!bankForm.linkedBankGlId) return setError('Linked Bank GL is required.');

    const duplicate = store.bankMasters.some(b => b.companyCodeId === bankForm.companyCodeId && b.accountNumber.trim() === bankForm.accountNumber.trim() && b.id !== editingBankId);
    if (duplicate) return setError('Account Number must be unique per Company Code.');

    const stamp = now();
    let nextBanks = store.bankMasters;
    if (bankForm.defaultBank) {
      nextBanks = nextBanks.map(b => b.companyCodeId === bankForm.companyCodeId ? { ...b, defaultBank: false, updated_at: stamp, updated_by: SYSTEM_USER } : b);
    }

    if (editingBankId) {
      nextBanks = nextBanks.map(b => b.id === editingBankId ? {
        ...b,
        ...bankForm,
        linkedBankGlId: bankForm.linkedBankGlId || undefined,
        bankName: bankForm.bankName.trim(),
        accountName: bankForm.accountName.trim(),
        accountNumber: bankForm.accountNumber.trim(),
        ifscCode: bankForm.ifscCode.trim(),
        branchName: bankForm.branchName.trim(),
        updated_at: stamp,
        updated_by: SYSTEM_USER,
      } : b);
      setSuccess('Bank Master updated.');
    } else {
      nextBanks = [...nextBanks, {
        id: getId(),
        ...bankForm,
        linkedBankGlId: bankForm.linkedBankGlId || undefined,
        bankName: bankForm.bankName.trim(),
        accountName: bankForm.accountName.trim(),
        accountNumber: bankForm.accountNumber.trim(),
        ifscCode: bankForm.ifscCode.trim(),
        branchName: bankForm.branchName.trim(),
        created_at: stamp,
        updated_at: stamp,
        created_by: SYSTEM_USER,
        updated_by: SYSTEM_USER,
      }];
      setSuccess('Bank Master created.');
    }

    persist({ ...store, bankMasters: nextBanks });
    setBankForm({ companyCodeId: '', linkedBankGlId: '', bankName: '', accountName: '', accountNumber: '', ifscCode: '', branchName: '', accountType: 'Savings', openingBalance: 0, openingDate: '', defaultBank: false, activeStatus: 'Active' });
    setEditingBankId(null);
  };

  const onSaveGL = () => {
    setError('');
    setSuccess('');
    if (!glForm.setOfBooksId) return setError('Set of Books is required for GL Master.');
    if (!glForm.glCode.trim()) return setError('GL Code is required.');
    if (!glForm.glName.trim()) return setError('GL Name is required.');

    const duplicate = store.glMasters.some(g => g.setOfBooksId === glForm.setOfBooksId && g.glCode.toLowerCase() === glForm.glCode.trim().toLowerCase() && g.id !== editingGlId);
    if (duplicate) return setError('GL Code must be unique per Set of Books.');

    if (editingGlId) {
      const current = store.glMasters.find(g => g.id === editingGlId);
      if (current && current.postingCount > 0 && current.glCode !== glForm.glCode.trim()) {
        return setError('GL Code cannot be changed because postings already exist.');
      }
      if (current?.controlAccount && current.postingCount > 0) {
        const onlyNameChanged =
          current.glName !== glForm.glName.trim()
          && current.glCode === glForm.glCode.trim()
          && current.glType === glForm.glType
          && (current.accountGroup || '') === (glForm.accountGroup || '')
          && (current.subgroup || '') === (glForm.subgroup || '')
          && (current.alias || '') === (glForm.alias || '')
          && (current.mappingStructure || '') === (glForm.mappingStructure || '')
          && current.postingAllowed === glForm.postingAllowed
          && current.activeStatus === glForm.activeStatus;
        if (!onlyNameChanged) {
          return setError('For control GLs with postings, only GL Name can be edited.');
        }
      }
      if (current?.controlAccount) {
        if (current.glCode === CONTROL_GL_CODES.customer && glForm.glType !== 'Asset') {
          return setError('Customer Control GL must remain Asset type.');
        }
        if (current.glCode === CONTROL_GL_CODES.supplier && glForm.glType !== 'Liability') {
          return setError('Supplier Control GL must remain Liability type.');
        }
      }
    }

    const stamp = now();
    if (editingGlId) {
      persist({ ...store, glMasters: store.glMasters.map(g => g.id === editingGlId ? { ...g, ...glForm, glCode: glForm.glCode.trim(), glName: glForm.glName.trim(), updated_at: stamp, updated_by: SYSTEM_USER } : g) });
      setSuccess('GL Master updated.');
    } else {
      persist({ ...store, glMasters: [...store.glMasters, {
        id: getId(),
        ...glForm,
        glCode: glForm.glCode.trim(),
        glName: glForm.glName.trim(),
        controlAccount: false,
        seeded_by_system: false,
        template_version: DEFAULT_TEMPLATE_VERSION,
        created_at: stamp,
        updated_at: stamp,
        created_by: SYSTEM_USER,
        updated_by: SYSTEM_USER,
      }] });
      setSuccess('GL Master created.');
    }

    setGlForm({ setOfBooksId: '', glCode: '', glName: '', alias: '', glType: 'Asset', accountGroup: '', subgroup: '', mappingStructure: '', postingAllowed: true, controlAccount: false, activeStatus: 'Active', postingCount: 0 });
    setEditingGlId(null);
  };

  const onSaveAssignment = () => {
    setError('');
    setSuccess('');
    if (!assignmentForm.setOfBooksId) return setError('Set of Books is required.');

    const duplicate = store.glAssignments.some(a => (a.assignmentScope || 'MATERIAL') === 'MATERIAL' && a.setOfBooksId === assignmentForm.setOfBooksId && a.materialMasterType === assignmentForm.materialMasterType && a.id !== editingAssignmentId);
    if (duplicate) return setError('Unique mapping rule violated for Set of Books + Material Type.');

    const validationError = validateAssignment(assignmentForm);
    if (validationError) return setError(validationError);

    const stamp = now();
    if (editingAssignmentId) {
      const current = store.glAssignments.find(a => a.id === editingAssignmentId);
      if (current && booksById.get(current.setOfBooksId)?.postingCount) {
        store.assignmentHistory.push({
          id: getId(),
          assignmentId: editingAssignmentId,
          setOfBooksId: current.setOfBooksId,
          materialMasterType: current.materialMasterType || 'Trading Goods',
          changed_at: stamp,
          changed_by: SYSTEM_USER,
          effective_from: stamp,
          previous: current,
          next: assignmentForm,
        });
      }
      persist({ ...store, glAssignments: store.glAssignments.map(a => a.id === editingAssignmentId ? { ...a, assignmentScope: 'MATERIAL', ...assignmentForm, updated_at: stamp, updated_by: SYSTEM_USER } : a) });
      setSuccess('Assignment updated. If postings exist, this applies only to future postings.');
    } else {
      persist({ ...store, glAssignments: [...store.glAssignments, { id: getId(), assignmentScope: 'MATERIAL', ...assignmentForm, seeded_by_system: false, template_version: DEFAULT_TEMPLATE_VERSION, created_at: stamp, updated_at: stamp, created_by: SYSTEM_USER, updated_by: SYSTEM_USER }] });
      setSuccess('Assignment created.');
    }

    setAssignmentForm({ setOfBooksId: '', materialMasterType: 'Trading Goods', inventoryGL: '', purchaseGL: '', cogsGL: '', salesGL: '', discountGL: '', taxGL: '' });
    setEditingAssignmentId(null);
  };


  const onSaveCustomerGroupAssignment = () => {
    setError('');
    setSuccess('');
    if (!customerGroupAssignmentForm.setOfBooksId) return setError('Set of Books is required.');
    if (!customerGroupAssignmentForm.customerGroup.trim()) return setError('Customer Group is required.');
    if (!customerGroupAssignmentForm.controlGL) return setError('Default GL Code is required.');

    const selectedGl = glById.get(customerGroupAssignmentForm.controlGL);
    if (!selectedGl) return setError('Selected GL is invalid.');
    if (selectedGl.setOfBooksId !== customerGroupAssignmentForm.setOfBooksId) return setError('Selected GL must belong to selected Set of Books.');
    if (selectedGl.glType !== 'Asset') return setError('Customer Group GL must be Asset type.');

    const duplicate = store.glAssignments.some(a =>
      (a.assignmentScope || 'MATERIAL') === 'PARTY_GROUP'
      && a.partyType === 'Customer'
      && a.setOfBooksId === customerGroupAssignmentForm.setOfBooksId
      && (a.partyGroup || '').toLowerCase() === customerGroupAssignmentForm.customerGroup.trim().toLowerCase()
      && a.id !== editingCustomerGroupAssignmentId
    );
    if (duplicate) return setError('One Customer Group can be linked with only one GL.');

    const stamp = now();
    if (editingCustomerGroupAssignmentId) {
      persist({ ...store, glAssignments: store.glAssignments.map(a => a.id === editingCustomerGroupAssignmentId ? {
        ...a,
        assignmentScope: 'PARTY_GROUP',
        partyType: 'Customer',
        partyGroup: customerGroupAssignmentForm.customerGroup.trim(),
        controlGL: customerGroupAssignmentForm.controlGL,
        materialMasterType: undefined,
        inventoryGL: '',
        purchaseGL: '',
        cogsGL: '',
        salesGL: '',
        discountGL: '',
        taxGL: '',
        updated_at: stamp,
        updated_by: SYSTEM_USER,
      } : a) });
      setSuccess('Customer Group GL assignment updated.');
    } else {
      persist({ ...store, glAssignments: [...store.glAssignments, {
        id: getId(),
        setOfBooksId: customerGroupAssignmentForm.setOfBooksId,
        assignmentScope: 'PARTY_GROUP',
        partyType: 'Customer',
        partyGroup: customerGroupAssignmentForm.customerGroup.trim(),
        controlGL: customerGroupAssignmentForm.controlGL,
        inventoryGL: '',
        purchaseGL: '',
        cogsGL: '',
        salesGL: '',
        discountGL: '',
        taxGL: '',
        seeded_by_system: false,
        template_version: DEFAULT_TEMPLATE_VERSION,
        created_at: stamp,
        updated_at: stamp,
        created_by: SYSTEM_USER,
        updated_by: SYSTEM_USER,
      }] });
      setSuccess('Customer Group GL assignment created.');
    }

    setCustomerGroupAssignmentForm({ setOfBooksId: '', customerGroup: 'Sundry Debtors', controlGL: '' });
    setEditingCustomerGroupAssignmentId(null);
  };


  const onSaveSupplierGroupAssignment = () => {
    setError('');
    setSuccess('');
    if (!supplierGroupAssignmentForm.setOfBooksId) return setError('Set of Books is required.');
    if (!supplierGroupAssignmentForm.supplierGroup.trim()) return setError('Supplier Group is required.');
    if (!supplierGroupAssignmentForm.controlGL) return setError('Default GL Code is required.');

    const selectedGl = glById.get(supplierGroupAssignmentForm.controlGL);
    if (!selectedGl) return setError('Selected GL is invalid.');
    if (selectedGl.setOfBooksId !== supplierGroupAssignmentForm.setOfBooksId) return setError('Selected GL must belong to selected Set of Books.');
    if (selectedGl.glType !== 'Liability') return setError('Supplier Group GL must be Liability type.');

    const duplicate = store.glAssignments.some(a =>
      (a.assignmentScope || 'MATERIAL') === 'PARTY_GROUP'
      && a.partyType === 'Supplier'
      && a.setOfBooksId === supplierGroupAssignmentForm.setOfBooksId
      && (a.partyGroup || '').toLowerCase() === supplierGroupAssignmentForm.supplierGroup.trim().toLowerCase()
      && a.id !== editingSupplierGroupAssignmentId
    );
    if (duplicate) return setError('One Supplier Group can be linked with only one GL.');

    const stamp = now();
    if (editingSupplierGroupAssignmentId) {
      persist({ ...store, glAssignments: store.glAssignments.map(a => a.id === editingSupplierGroupAssignmentId ? {
        ...a,
        assignmentScope: 'PARTY_GROUP',
        partyType: 'Supplier',
        partyGroup: supplierGroupAssignmentForm.supplierGroup.trim(),
        controlGL: supplierGroupAssignmentForm.controlGL,
        materialMasterType: undefined,
        inventoryGL: '',
        purchaseGL: '',
        cogsGL: '',
        salesGL: '',
        discountGL: '',
        taxGL: '',
        activeStatus: supplierGroupAssignmentForm.status,
        updated_at: stamp,
        updated_by: SYSTEM_USER,
      } : a) });
      setSuccess('Supplier Group GL assignment updated.');
    } else {
      persist({ ...store, glAssignments: [...store.glAssignments, {
        id: getId(),
        setOfBooksId: supplierGroupAssignmentForm.setOfBooksId,
        assignmentScope: 'PARTY_GROUP',
        partyType: 'Supplier',
        partyGroup: supplierGroupAssignmentForm.supplierGroup.trim(),
        controlGL: supplierGroupAssignmentForm.controlGL,
        inventoryGL: '',
        purchaseGL: '',
        cogsGL: '',
        salesGL: '',
        discountGL: '',
        taxGL: '',
        activeStatus: supplierGroupAssignmentForm.status,
        seeded_by_system: false,
        template_version: DEFAULT_TEMPLATE_VERSION,
        created_at: stamp,
        updated_at: stamp,
        created_by: SYSTEM_USER,
        updated_by: SYSTEM_USER,
      }] });
      setSuccess('Supplier Group GL assignment created.');
    }

    setSupplierGroupAssignmentForm({ setOfBooksId: '', supplierGroup: 'Sundry Creditors', controlGL: '', status: 'Active' });
    setEditingSupplierGroupAssignmentId(null);
  };

  const runResetDefaults = (setOfBooksId: string) => {
    setError('');
    const books = booksById.get(setOfBooksId);
    if (!books) return;
    if (books.postingCount > 0) {
      const confirmed = window.confirm('Postings already exist. Create additional defaults without deleting existing?');
      if (!confirmed) return;
    }
    seedDefaultsForBooks(setOfBooksId, 'append');
  };

  const activeRule = requiredFieldRules[assignmentForm.materialMasterType];

  const onFetchFromServer = async () => {
    if (!currentUser?.organization_id) {
      setError('No organisation found. Please log in again.');
      return;
    }
    if (!isOnline()) {
      setError('Internet connection required to fetch from server.');
      return;
    }
    setIsFetchingFromServer(true);
    setError('');
    setSuccess('');
    try {
      const organizationId = currentUser.organization_id;
      const [companiesRes, booksRes, glRes, assignmentRes, logsRes, historyRes, bankRes] = await Promise.all([
        supabase.from('company_codes').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
        supabase.from('set_of_books').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
        supabase.from('gl_master').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
        supabase.from('gl_assignments').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
        supabase.from('setup_wizard_defaults_log').select('*').eq('organization_id', organizationId).order('created_at', { ascending: false }),
        supabase.from('gl_assignment_history').select('*').eq('organization_id', organizationId).order('changed_at', { ascending: false }),
        supabase.from('bank_master').select('*').eq('organization_id', organizationId).order('created_at', { ascending: true }),
      ]);

      const firstError = [companiesRes, booksRes, glRes, assignmentRes, logsRes, historyRes, bankRes].find(r => r.error)?.error;
      if (firstError) throw new Error(firstError.message);

      const booksForOrg: SetOfBooks[] = (booksRes.data || []).map((b: any) => ({
        id: b.id,
        companyCodeId: b.company_code_id,
        setOfBooksId: b.set_of_books_id,
        description: b.description || '',
        defaultCurrency: b.default_currency || 'INR',
        defaultCustomerGLId: b.default_customer_gl_id || undefined,
        defaultSupplierGLId: b.default_supplier_gl_id || undefined,
        defaultDemoBankGLId: b.default_demo_bank_gl_id || undefined,
        defaultBankGLId: b.default_bank_gl_id || undefined,
        activeStatus: b.active_status || 'Active',
        postingCount: b.posting_count || 0,
        created_by: b.created_by || SYSTEM_USER,
        created_at: b.created_at || now(),
        updated_by: b.updated_by || SYSTEM_USER,
        updated_at: b.updated_at || now(),
      }));

      const normalizedCompanies: CompanyCode[] = (companiesRes.data || []).map((c: any) => {
        const rawDefaultSob = String(c.default_set_of_books_id || '').trim();
        const mappedByCode = booksForOrg.find((b) => b.setOfBooksId === rawDefaultSob && b.companyCodeId === c.id && b.activeStatus === 'Active');
        return {
          id: c.id,
          organizationId: c.organization_id,
          code: c.code,
          description: c.description || '',
          status: c.status || 'Active',
          isDefault: !!c.is_default,
          defaultSetOfBooksId: mappedByCode?.setOfBooksId || '',
          created_by: c.created_by || SYSTEM_USER,
          created_at: c.created_at || now(),
          updated_by: c.updated_by || SYSTEM_USER,
          updated_at: c.updated_at || now(),
        };
      });

      const fetched: Store = {
        companies: normalizedCompanies,
        setOfBooks: booksForOrg.map((b) => {
          const byId = normalizedCompanies.find(c => c.id === b.companyCodeId);
          const byCode = normalizedCompanies.find(c => c.code === b.companyCodeId);
          return { ...b, companyCodeId: byId?.id || byCode?.id || b.companyCodeId };
        }),
        glMasters: (glRes.data || []).map((g: any) => ({
          id: g.id, setOfBooksId: g.set_of_books_id, glCode: g.gl_code, glName: g.gl_name,
          glType: g.gl_type, accountGroup: g.account_group || '', subgroup: g.subgroup || '',
          alias: g.alias || '', mappingStructure: g.mapping_structure || '',
          postingAllowed: !!g.posting_allowed, controlAccount: !!g.control_account,
          activeStatus: g.active_status || 'Active', seeded_by_system: !!g.seeded_by_system,
          template_version: g.template_version || DEFAULT_TEMPLATE_VERSION, postingCount: g.posting_count || 0,
          created_by: g.created_by || SYSTEM_USER, created_at: g.created_at || now(),
          updated_by: g.updated_by || SYSTEM_USER, updated_at: g.updated_at || now(),
        })),
        glAssignments: (assignmentRes.data || []).map((a: any) => ({
          id: a.id, setOfBooksId: a.set_of_books_id,
          assignmentScope: normalizeScope(a.assignment_scope),
          materialMasterType: normalizeScope(a.assignment_scope) === 'MATERIAL' ? a.material_master_type : undefined,
          partyType: normalizePartyType(a.party_type), partyGroup: a.party_group || '',
          controlGL: a.control_gl_id || '', activeStatus: a.active_status || 'Active',
          inventoryGL: a.inventory_gl || '', purchaseGL: a.purchase_gl || '',
          cogsGL: a.cogs_gl || '', salesGL: a.sales_gl || '',
          discountGL: a.discount_gl || '', taxGL: a.tax_gl || '',
          seeded_by_system: !!a.seeded_by_system, template_version: a.template_version || DEFAULT_TEMPLATE_VERSION,
          created_by: a.created_by || SYSTEM_USER, created_at: a.created_at || now(),
          updated_by: a.updated_by || SYSTEM_USER, updated_at: a.updated_at || now(),
        })),
        setupLogs: (logsRes.data || []).map((l: any) => ({
          id: l.id, setOfBooksId: l.set_of_books_id, action: l.action, message: l.message,
          created_at: l.created_at || now(), created_by: l.created_by || SYSTEM_USER,
        })),
        assignmentHistory: (historyRes.data || []).map((h: any) => ({
          id: h.id, assignmentId: h.assignment_id, setOfBooksId: h.set_of_books_id,
          materialMasterType: h.material_master_type, changed_at: h.changed_at || now(),
          changed_by: h.changed_by || SYSTEM_USER, effective_from: h.effective_from || now(),
          previous: h.previous_payload || {}, next: h.next_payload || {},
        })),
        bankMasters: (bankRes.data || []).map((b: any) => ({
          id: b.id, companyCodeId: b.company_code_id, linkedBankGlId: b.linked_bank_gl_id || undefined,
          bankName: b.bank_name || '', accountName: b.account_name || '',
          accountNumber: b.account_number || '', ifscCode: b.ifsc_code || '',
          branchName: b.branch_name || '', accountType: b.account_type || 'Savings',
          openingBalance: Number(b.opening_balance || 0), openingDate: b.opening_date || '',
          defaultBank: !!b.default_bank, activeStatus: b.active_status || 'Active',
          created_by: b.created_by || SYSTEM_USER, created_at: b.created_at || now(),
          updated_by: b.updated_by || SYSTEM_USER, updated_at: b.updated_at || now(),
        })),
      };

      persist(fetched);
      setSuccess('Company configuration fetched from server and saved to local file.');
    } catch (e: any) {
      setError('Fetch failed: ' + (e?.message || 'Unknown error'));
    } finally {
      setIsFetchingFromServer(false);
    }
  };

  const onSaveConfiguration = async () => {
    setError('');
    setSuccess('');
    localStorage.setItem(orgScopedKey, JSON.stringify(store));

    if (!currentUser?.organization_id) {
      setSuccess('Configuration saved locally. Login with organization access to sync database tables.');
      return;
    }

    const organizationId = currentUser.organization_id;
    const userName = currentUser.full_name || SYSTEM_USER;
    const companyById = new Map(store.companies.map(c => [c.id, c]));
    let adjustedCustomerControlGl = false;
    const normalizedGlMasters = store.glMasters.map((g) => {
      if (g.glCode === CONTROL_GL_CODES.customer && g.glType !== 'Asset') {
        adjustedCustomerControlGl = true;
        return { ...g, glType: 'Asset' as GLType };
      }
      return g;
    });

    const missingCompanyCode = store.setOfBooks.some((book) => {
      if (!book.companyCodeId || !isUuid(book.companyCodeId)) return true;
      return !companyById.has(book.companyCodeId);
    });
    if (missingCompanyCode) {
      setError('Company Code must be selected before assigning Set of Books.');
      return;
    }

    const defaultCompanies = store.companies.filter(c => c.isDefault);
    if (defaultCompanies.length > 1) {
      setError('Only one default company is allowed per organization.');
      return;
    }
    if (defaultCompanies.length === 1) {
      const defaultCompany = defaultCompanies[0];
      if (!defaultCompany.defaultSetOfBooksId) {
        setError('Default Company must always have a Default Set of Books assigned.');
        return;
      }
      if (defaultCompany.status !== 'Active') {
        setError('Inactive company cannot be selected as default company.');
        return;
      }
      const mappedBooks = store.setOfBooks.find(b => b.setOfBooksId === defaultCompany.defaultSetOfBooksId && b.companyCodeId === defaultCompany.id && b.activeStatus === 'Active');
      if (!mappedBooks) {
        setError('Default Set of Books must belong to the selected Default Company and must be Active.');
        return;
      }
    }

    // Company configuration save touches 7 tables (3 of which aren't yet
    // mirrored in SQLite), so we require internet for this operation.
    if (!isOnline()) {
      setError('Internet connection required to save company configuration. Please reconnect and try again.');
      return;
    }

    try {
      // Step 1: Upsert Company Codes with temporary non-default flags.
      // This avoids the DB trigger rejecting rows where a default company is persisted
      // before its Set of Books row exists in the same sync run.
      if (store.companies.length > 0) {
        const { error: companyErr } = await supabase.from('company_codes').upsert(store.companies.map(c => ({
          id: c.id,
          organization_id: organizationId,
          code: c.code,
          description: c.description,
          status: c.status,
          is_default: false,
          default_set_of_books_id: null,
          created_by: c.created_by || userName,
          created_at: c.created_at,
          updated_by: userName,
          updated_at: now(),
        })), { onConflict: 'id' });
        if (companyErr) throw companyErr;
      }

      // Step 2: Upsert Set of Books
      if (store.setOfBooks.length > 0) {
        const { error: booksErr } = await supabase.from('set_of_books').upsert(store.setOfBooks.map(b => {
          const selectedCompany = companyById.get(b.companyCodeId);
          return {
            id: b.id,
            organization_id: selectedCompany?.organizationId || organizationId,
            company_code_id: selectedCompany?.id || b.companyCodeId,
            set_of_books_id: b.setOfBooksId,
            description: b.description,
            default_currency: b.defaultCurrency,
            // Save without defaults first so GL type corrections can be synced safely.
            default_customer_gl_id: null,
            default_supplier_gl_id: null,
            default_demo_bank_gl_id: null,
            default_bank_gl_id: null,
            active_status: b.activeStatus,
            posting_count: b.postingCount || 0,
            created_by: b.created_by || userName,
            created_at: b.created_at,
            updated_by: userName,
            updated_at: now(),
          };
        }), { onConflict: 'id' });
        if (booksErr) throw booksErr;
      }

      // Step 2b: Update default Set of Books mapping once Set of Books rows exist
      if (store.companies.length > 0) {
        const { error: companyDefaultErr } = await supabase.from('company_codes').upsert(store.companies.map(c => ({
          id: c.id,
          organization_id: organizationId,
          code: c.code,
          description: c.description,
          status: c.status,
          is_default: !!c.isDefault,
          default_set_of_books_id: c.defaultSetOfBooksId?.trim() || null,
          created_by: c.created_by || userName,
          created_at: c.created_at,
          updated_by: userName,
          updated_at: now(),
        })), { onConflict: 'id' });
        if (companyDefaultErr) throw companyDefaultErr;
      }

      // Step 3: Upsert GL Masters
      if (normalizedGlMasters.length > 0) {
        const { error: glErr } = await supabase.from('gl_master').upsert(normalizedGlMasters.map(g => ({
          id: g.id,
          organization_id: organizationId,
          set_of_books_id: g.setOfBooksId,
          gl_code: g.glCode,
          gl_name: g.glName,
          gl_type: g.glType,
          account_group: g.accountGroup || null,
          subgroup: g.subgroup || null,
          alias: g.alias || null,
          mapping_structure: g.mappingStructure || null,
          posting_allowed: g.postingAllowed,
          control_account: !!g.controlAccount,
          active_status: g.activeStatus,
          seeded_by_system: !!g.seeded_by_system,
          template_version: g.template_version || DEFAULT_TEMPLATE_VERSION,
          posting_count: g.postingCount || 0,
          created_by: g.created_by || userName,
          created_at: g.created_at,
          updated_by: userName,
          updated_at: now(),
        })), { onConflict: 'id' });
        if (glErr) throw glErr;
      }

      // Step 3b: Attach default control GL pointers after GL sync.
      if (store.setOfBooks.length > 0) {
        const { error: booksDefaultErr } = await supabase.from('set_of_books').upsert(store.setOfBooks.map(b => ({
          id: b.id,
          organization_id: organizationId,
          company_code_id: b.companyCodeId,
          set_of_books_id: b.setOfBooksId,
          description: b.description,
          default_currency: b.defaultCurrency,
          default_customer_gl_id: b.defaultCustomerGLId || null,
          default_supplier_gl_id: b.defaultSupplierGLId || null,
          default_demo_bank_gl_id: b.defaultDemoBankGLId || null,
          default_bank_gl_id: b.defaultBankGLId || null,
          active_status: b.activeStatus,
          posting_count: b.postingCount || 0,
          created_by: b.created_by || userName,
          created_at: b.created_at,
          updated_by: userName,
          updated_at: now(),
        })), { onConflict: 'id' });
        if (booksDefaultErr) throw booksDefaultErr;
      }

      if (adjustedCustomerControlGl) {
        persist({ ...store, glMasters: normalizedGlMasters });
      }

      let assignmentSyncWarning = '';
      if (store.glAssignments.length > 0) {
        const glMap = new Map(normalizedGlMasters.map((g) => [g.id, g]));
        const invalidMaterialRows: string[] = [];

        const materialRows = store.glAssignments.filter((a) => (a.assignmentScope || 'MATERIAL') === 'MATERIAL');
        const partyRows = store.glAssignments.filter((a) => (a.assignmentScope || 'MATERIAL') === 'PARTY_GROUP');

        const validMaterialRows = materialRows.filter((a) => {
          const purchaseType = a.purchaseGL ? glMap.get(a.purchaseGL)?.glType : undefined;
          const cogsType = a.cogsGL ? glMap.get(a.cogsGL)?.glType : undefined;
          const discountType = a.discountGL ? glMap.get(a.discountGL)?.glType : undefined;
          const taxType = a.taxGL ? glMap.get(a.taxGL)?.glType : undefined;
          const inventoryType = a.inventoryGL ? glMap.get(a.inventoryGL)?.glType : undefined;
          const salesType = a.salesGL ? glMap.get(a.salesGL)?.glType : undefined;

          const isValid = (
            purchaseType === 'Expense'
            && cogsType === 'Expense'
            && discountType === 'Expense'
            && taxType === 'Liability'
            && (!a.inventoryGL || inventoryType === 'Asset')
            && (!a.salesGL || salesType === 'Income')
          );

          if (!isValid) {
            invalidMaterialRows.push(`${a.materialMasterType || 'Unknown'}@${a.setOfBooksId}`);
          }
          return isValid;
        });

        if (invalidMaterialRows.length > 0) {
          assignmentSyncWarning += ` Skipped ${invalidMaterialRows.length} invalid MATERIAL assignment(s) (GL type mismatch).`;
        }

        const scopedPayload = [
          ...validMaterialRows.map(a => ({
            id: a.id,
            organization_id: organizationId,
            set_of_books_id: a.setOfBooksId,
            assignment_scope: 'MATERIAL',
            material_master_type: a.materialMasterType,
            party_type: null,
            party_group: null,
            control_gl_id: null,
            inventory_gl: a.inventoryGL || null,
            purchase_gl: a.purchaseGL || null,
            cogs_gl: a.cogsGL || null,
            sales_gl: a.salesGL || null,
            discount_gl: a.discountGL || null,
            tax_gl: a.taxGL || null,
            seeded_by_system: !!a.seeded_by_system,
            template_version: a.template_version || DEFAULT_TEMPLATE_VERSION,
            active_status: a.activeStatus || 'Active',
            created_by: a.created_by || userName,
            created_at: a.created_at,
            updated_by: userName,
            updated_at: now(),
          })),
          ...partyRows.map(a => ({
            id: a.id,
            organization_id: organizationId,
            set_of_books_id: a.setOfBooksId,
            assignment_scope: 'PARTY_GROUP',
            material_master_type: null,
            party_type: a.partyType || null,
            party_group: a.partyGroup || null,
            control_gl_id: a.controlGL || null,
            inventory_gl: null,
            purchase_gl: null,
            cogs_gl: null,
            sales_gl: null,
            discount_gl: null,
            tax_gl: null,
            seeded_by_system: !!a.seeded_by_system,
            template_version: a.template_version || DEFAULT_TEMPLATE_VERSION,
            active_status: a.activeStatus || 'Active',
            created_by: a.created_by || userName,
            created_at: a.created_at,
            updated_by: userName,
            updated_at: now(),
          })),
        ];

        if (scopedPayload.length > 0) {
          const { error: assignmentErr } = await supabase
            .from('gl_assignments')
            .upsert(scopedPayload, { onConflict: 'id' });

          if (assignmentErr) {
            const msg = String((assignmentErr as any)?.message || '').toLowerCase();
            const missingScopeColumn = msg.includes('assignment_scope') && (msg.includes('schema cache') || msg.includes('column'));
            if (!missingScopeColumn) throw assignmentErr;

            const legacyPayload = validMaterialRows.map(a => ({
              id: a.id,
              organization_id: organizationId,
              set_of_books_id: a.setOfBooksId,
              material_master_type: a.materialMasterType,
              inventory_gl: a.inventoryGL || null,
              purchase_gl: a.purchaseGL || null,
              cogs_gl: a.cogsGL || null,
              sales_gl: a.salesGL || null,
              discount_gl: a.discountGL || null,
              tax_gl: a.taxGL || null,
              seeded_by_system: !!a.seeded_by_system,
              template_version: a.template_version || DEFAULT_TEMPLATE_VERSION,
            active_status: a.activeStatus || 'Active',
              created_by: a.created_by || userName,
              created_at: a.created_at,
              updated_by: userName,
              updated_at: now(),
            }));

            if (legacyPayload.length > 0) {
              const { error: legacyErr } = await supabase
                .from('gl_assignments')
                .upsert(legacyPayload, { onConflict: 'id' });
              if (legacyErr) throw legacyErr;
            }

            assignmentSyncWarning += ' PARTYGROUP mappings are saved locally; apply latest DB migration and retry sync.';
          }
        }
      }

      if (store.setupLogs.length > 0) {
        await supabase.from('setup_wizard_defaults_log').upsert(store.setupLogs.map(l => ({
          id: l.id,
          organization_id: organizationId,
          set_of_books_id: l.setOfBooksId,
          action: l.action,
          message: l.message,
          created_by: l.created_by || userName,
          created_at: l.created_at,
        })), { onConflict: 'id' });
      }

      if (store.assignmentHistory.length > 0) {
        await supabase.from('gl_assignment_history').upsert(store.assignmentHistory.map(h => ({
          id: h.id,
          organization_id: organizationId,
          assignment_id: h.assignmentId,
          set_of_books_id: h.setOfBooksId,
          material_master_type: h.materialMasterType,
          changed_at: h.changed_at,
          changed_by: h.changed_by || userName,
          effective_from: h.effective_from,
          previous_payload: h.previous || {},
          next_payload: h.next || {},
        })), { onConflict: 'id' });
      }

      if (store.bankMasters.length > 0) {
        await supabase.from('bank_master').upsert(store.bankMasters.map(b => ({
          id: b.id,
          organization_id: organizationId,
          company_code_id: b.companyCodeId,
          bank_name: b.bankName,
          linked_bank_gl_id: b.linkedBankGlId || null,
          account_name: b.accountName,
          account_number: b.accountNumber,
          ifsc_code: b.ifscCode || null,
          branch_name: b.branchName || null,
          account_type: b.accountType,
          opening_balance: b.openingBalance || 0,
          opening_date: b.openingDate || null,
          default_bank: !!b.defaultBank,
          active_status: b.activeStatus,
          created_by: b.created_by || userName,
          created_at: b.created_at,
          updated_by: userName,
          updated_at: now(),
        })), { onConflict: 'id' });
      }

      setSuccess(`Company Configuration saved locally and synced to database tables.${assignmentSyncWarning}`);
    } catch (e: any) {
      setError(`Saved locally but database sync failed. ${e?.message || 'Please check your connection and retry.'}`);
    }
  };

  return (
    <div className="p-6 space-y-4 overflow-y-auto h-full">
      <Card>
        <div className="mb-4">
          <h2 className="text-lg font-black text-primary uppercase">Company Configuration</h2>
          <p className="text-xs text-gray-500 font-bold uppercase">Utilities & Setup → Company Configuration</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 mb-4">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => { setActiveTab(tab.id); setError(''); setSuccess(''); }} className={`px-2 py-2 border text-[11px] font-black uppercase ${activeTab === tab.id ? 'bg-primary text-white border-primary' : 'bg-white text-gray-700 border-gray-300'}`}>{tab.label}</button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <input className="tally-input" placeholder="Search / filter" value={search} onChange={e => setSearch(e.target.value)} />
          <div className="text-[11px] text-gray-500 font-bold uppercase p-2 border border-gray-200 bg-gray-50 md:col-span-1">Flow: Company Code → Set of Books → GL Master / Bank Master → GL Assignment</div>
          <button
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black uppercase px-3 py-2 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
            onClick={onFetchFromServer}
            disabled={isFetchingFromServer || !isOnline()}
            title="Re-fetch all company configuration tables from Supabase and save to local file."
          >
            {isFetchingFromServer
              ? <><span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Fetching…</>
              : <>↓ Fetch from Server</>}
          </button>
          <button className="bg-primary text-white text-xs font-black uppercase px-3 py-2" onClick={onSaveConfiguration}>Save Configuration</button>
        </div>

        {error && <div className="mb-3 text-xs font-black text-red-700 bg-red-50 border border-red-200 p-2">{error}</div>}
        {success && <div className="mb-3 text-xs font-black text-green-700 bg-green-50 border border-green-200 p-2">{success}</div>}

        {activeTab === 'company' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              <input className="tally-input" placeholder="Company Code*" value={companyForm.code} onChange={e => setCompanyForm({ ...companyForm, code: e.target.value })} />
              <input className="tally-input" placeholder="Description" value={companyForm.description} onChange={e => setCompanyForm({ ...companyForm, description: e.target.value })} />
              <select className="tally-input" value={companyForm.status} onChange={e => setCompanyForm({ ...companyForm, status: e.target.value as Status })}><option>Active</option><option>Inactive</option></select>
              <label className="flex items-center gap-2 text-xs font-black uppercase border border-gray-300 px-2">
                <input
                  type="checkbox"
                  checked={companyForm.isDefault}
                  onChange={(e) => setCompanyForm({
                    ...companyForm,
                    isDefault: e.target.checked,
                    defaultSetOfBooksId: e.target.checked ? companyForm.defaultSetOfBooksId : '',
                  })}
                />
                Set as Default Company
              </label>
              <button className="bg-primary text-white text-xs font-black uppercase px-3" onClick={onSaveCompany}>{editingCompanyId ? 'Update' : 'Add'}</button>
            </div>
            <select
              className="tally-input"
              value={companyForm.defaultSetOfBooksId}
              onChange={e => setCompanyForm({ ...companyForm, defaultSetOfBooksId: e.target.value })}
              disabled={!companyForm.isDefault || !companyForm.code.trim()}
            >
              <option value="">Default Set of Books*</option>
              {defaultBooksOptions.map(b => <option key={b.id} value={b.setOfBooksId}>{b.setOfBooksId} - {b.description || 'NA'}</option>)}
            </select>
            <button className="text-xs font-bold text-primary" onClick={() => exportCsv('company-codes.csv', ['Code', 'Description', 'Status', 'Created By', 'Created At'], filteredCompanies.map(c => [c.code, c.description, c.status, c.created_by, c.created_at]))}>Export CSV</button>
            <div className="overflow-auto border border-gray-200">
              <table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Code</th><th className="p-2 text-left">Description</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Default</th><th className="p-2 text-left">Default Set of Books</th><th className="p-2 text-left">Audit</th><th className="p-2 text-left">Actions</th></tr></thead><tbody>
                {filteredCompanies.map(c => <tr key={c.id} className="border-t"><td className="p-2">{c.code}</td><td className="p-2">{c.description}</td><td className="p-2">{c.status}</td><td className="p-2">{c.isDefault ? 'Yes' : 'No'}</td><td className="p-2">{c.defaultSetOfBooksId || '-'}</td><td className="p-2">{c.created_by}<br />{new Date(c.created_at).toLocaleString()}</td><td className="p-2"><button className="text-primary font-bold" onClick={() => { setCompanyForm({ code: c.code, description: c.description, status: c.status, isDefault: !!c.isDefault, defaultSetOfBooksId: c.defaultSetOfBooksId || '' }); setEditingCompanyId(c.id); }}>Edit</button></td></tr>)}
              </tbody></table>
            </div>
          </div>
        )}

        {activeTab === 'books' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <select className="tally-input" value={booksForm.companyCodeId} onChange={e => setBooksForm({ ...booksForm, companyCodeId: e.target.value })}><option value="">Company Code*</option>{activeCompanies.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}</select>
              <input className="tally-input" placeholder="Set of Books ID*" value={booksForm.setOfBooksId} onChange={e => setBooksForm({ ...booksForm, setOfBooksId: e.target.value })} />
              <input className="tally-input" placeholder="Description" value={booksForm.description} onChange={e => setBooksForm({ ...booksForm, description: e.target.value })} />
              <input className="tally-input" placeholder="Currency" value={booksForm.defaultCurrency} onChange={e => setBooksForm({ ...booksForm, defaultCurrency: e.target.value })} />
              <input className="tally-input" type="number" placeholder="Posting Count" value={booksForm.postingCount} onChange={e => setBooksForm({ ...booksForm, postingCount: Number(e.target.value) || 0 })} />
              <select className="tally-input" value={booksForm.activeStatus} onChange={e => setBooksForm({ ...booksForm, activeStatus: e.target.value as Status })}><option>Active</option><option>Inactive</option></select>
              <select className="tally-input" value={booksForm.defaultDemoBankGLId} onChange={e => setBooksForm({ ...booksForm, defaultDemoBankGLId: e.target.value })}><option value="">Default Demo Bank GL</option>{bankGlOptionsForBooksForm.map(g => <option key={g.id} value={g.id}>{g.glCode} - {g.glName}</option>)}</select>
              <select className="tally-input" value={booksForm.defaultBankGLId} onChange={e => setBooksForm({ ...booksForm, defaultBankGLId: e.target.value })}><option value="">Default Bank GL Selection</option>{bankGlOptionsForBooksForm.map(g => <option key={g.id} value={g.id}>{g.glCode} - {g.glName}</option>)}</select>
              <button className="bg-primary text-white text-xs font-black uppercase px-3 disabled:opacity-50 disabled:cursor-not-allowed" onClick={onSaveBooks} disabled={!booksForm.companyCodeId || !isUuid(booksForm.companyCodeId) || !store.companies.some(c => c.id === booksForm.companyCodeId)}>{editingBooksId ? 'Update' : 'Add'}</button>
            </div>
            <div className="text-[11px] text-gray-500 font-bold uppercase p-2 border border-blue-200 bg-blue-50">On create, system auto-creates default GLs and assignments, including customer-group receivable control GLs.</div>
            <button className="text-xs font-bold text-primary" onClick={() => exportCsv('set-of-books.csv', ['Company', 'Books ID', 'Description', 'Posting Count'], filteredBooks.map(b => [store.companies.find(c => c.id === b.companyCodeId)?.code || '', b.setOfBooksId, b.description, b.postingCount]))}>Export CSV</button>
            <div className="overflow-auto border border-gray-200"><table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Company</th><th className="p-2 text-left">Books ID</th><th className="p-2 text-left">Posting Count</th><th className="p-2 text-left">Audit</th><th className="p-2 text-left">Actions</th></tr></thead><tbody>{filteredBooks.map(b => <tr key={b.id} className="border-t"><td className="p-2">{store.companies.find(c => c.id === b.companyCodeId)?.code}</td><td className="p-2">{b.setOfBooksId}</td><td className="p-2">{b.postingCount}</td><td className="p-2">{b.updated_by}<br />{new Date(b.updated_at).toLocaleString()}</td><td className="p-2"><button className="text-primary font-bold" onClick={() => { setBooksForm({ companyCodeId: b.companyCodeId, setOfBooksId: b.setOfBooksId, description: b.description, defaultCurrency: b.defaultCurrency, defaultCustomerGLId: b.defaultCustomerGLId || '', defaultSupplierGLId: b.defaultSupplierGLId || '', defaultDemoBankGLId: b.defaultDemoBankGLId || '', defaultBankGLId: b.defaultBankGLId || '', activeStatus: b.activeStatus, postingCount: b.postingCount }); setEditingBooksId(b.id); }}>Edit</button><button className="ml-3 text-emerald-700 font-bold" onClick={() => runResetDefaults(b.id)}>Reset to Default</button></td></tr>)}</tbody></table></div>
          </div>
        )}

        {activeTab === 'gl' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              <select className="tally-input" value={glForm.setOfBooksId} onChange={e => setGlForm({ ...glForm, setOfBooksId: e.target.value })}><option value="">Set of Books*</option>{store.setOfBooks.map(b => <option key={b.id} value={b.id}>{b.setOfBooksId}</option>)}</select>
              <input className="tally-input" placeholder="GL Code*" value={glForm.glCode} onChange={e => setGlForm({ ...glForm, glCode: e.target.value })} />
              <input className="tally-input" placeholder="GL Name*" value={glForm.glName} onChange={e => setGlForm({ ...glForm, glName: e.target.value })} />
              <input className="tally-input" placeholder="Alias / Short Name" value={glForm.alias} onChange={e => setGlForm({ ...glForm, alias: e.target.value })} />
              <select className="tally-input" value={glForm.glType} onChange={e => setGlForm({ ...glForm, glType: e.target.value as GLType })}>{glTypes.map(t => <option key={t}>{t}</option>)}</select>
              <input className="tally-input" placeholder="Account Group" value={glForm.accountGroup} onChange={e => setGlForm({ ...glForm, accountGroup: e.target.value })} />
              <input className="tally-input" placeholder="Subgroup" value={glForm.subgroup} onChange={e => setGlForm({ ...glForm, subgroup: e.target.value })} />
              <input className="tally-input" placeholder="Mapping Structure" value={glForm.mappingStructure} onChange={e => setGlForm({ ...glForm, mappingStructure: e.target.value })} />
              <select className="tally-input" value={String(glForm.postingAllowed)} onChange={e => setGlForm({ ...glForm, postingAllowed: e.target.value === 'true' })}><option value="true">Posting Allowed: Yes</option><option value="false">Posting Allowed: No</option></select>
              <select className="tally-input" value={glForm.activeStatus} onChange={e => setGlForm({ ...glForm, activeStatus: e.target.value as Status })}><option>Active</option><option>Inactive</option></select>
              <button className="bg-primary text-white text-xs font-black uppercase px-3" onClick={onSaveGL}>{editingGlId ? 'Update' : 'Add'}</button>
            </div>
            <button className="text-xs font-bold text-primary" onClick={() => exportCsv('gl-master.csv', ['Books', 'GL Code', 'GL Name', 'Alias', 'Type', 'Group', 'Subgroup', 'Seeded'], filteredGL.map(g => [booksById.get(g.setOfBooksId)?.setOfBooksId || '', g.glCode, g.glName, g.alias || '', g.glType, g.accountGroup || '', g.subgroup || '', g.seeded_by_system]))}>Export CSV</button>
            <div className="overflow-auto border border-gray-200"><table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Books</th><th className="p-2 text-left">GL</th><th className="p-2 text-left">Type</th><th className="p-2 text-left">Group Mapping</th><th className="p-2 text-left">Flags</th><th className="p-2 text-left">Actions</th></tr></thead><tbody>{filteredGL.map(g => <tr key={g.id} className="border-t"><td className="p-2">{booksById.get(g.setOfBooksId)?.setOfBooksId}</td><td className="p-2">{g.glCode} - {g.glName}<br />{g.alias ? <span className="text-gray-500">Alias: {g.alias}</span> : null}</td><td className="p-2">{g.glType}</td><td className="p-2">{g.accountGroup || '-'} / {g.subgroup || '-'}<br />Map: {g.mappingStructure || '-'}</td><td className="p-2">Posting:{g.postingAllowed ? 'Yes' : 'No'}<br />Control:{g.controlAccount ? 'Yes' : 'No'}<br />Seeded:{g.seeded_by_system ? 'Yes' : 'No'}<br />Template:{g.template_version}</td><td className="p-2"><button className="text-primary font-bold" onClick={() => { setGlForm({ setOfBooksId: g.setOfBooksId, glCode: g.glCode, glName: g.glName, alias: g.alias || '', glType: g.glType, accountGroup: g.accountGroup || '', subgroup: g.subgroup || '', mappingStructure: g.mappingStructure || '', postingAllowed: g.postingAllowed, controlAccount: g.controlAccount, activeStatus: g.activeStatus, postingCount: g.postingCount }); setEditingGlId(g.id); }}>Edit</button><button className="ml-3 text-emerald-700 font-bold" onClick={() => onCopyGL(g)}>Copy GL</button></td></tr>)}</tbody></table></div>
          </div>
        )}


        {activeTab === 'customerGroupAssignment' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <select className="tally-input" value={customerGroupAssignmentForm.setOfBooksId} onChange={e => setCustomerGroupAssignmentForm({ ...customerGroupAssignmentForm, setOfBooksId: e.target.value, controlGL: '' })}><option value="">Set of Books*</option>{store.setOfBooks.map(b => <option key={b.id} value={b.id}>{b.setOfBooksId}</option>)}</select>
              <select className="tally-input" value={customerGroupAssignmentForm.customerGroup} onChange={e => setCustomerGroupAssignmentForm({ ...customerGroupAssignmentForm, customerGroup: e.target.value })}>{defaultCustomerGroupConfig.map(cfg => <option key={cfg.group} value={cfg.group}>{cfg.group}</option>)}</select>
              <select className="tally-input" value={customerGroupAssignmentForm.controlGL} onChange={e => setCustomerGroupAssignmentForm({ ...customerGroupAssignmentForm, controlGL: e.target.value })}><option value="">Default GL Code*</option>{customerGroupGlOptions.map(gl => <option key={gl.id} value={gl.id}>{gl.glCode} - {gl.glName}</option>)}</select>
              <button className="bg-primary text-white text-xs font-black uppercase px-3" onClick={onSaveCustomerGroupAssignment}>{editingCustomerGroupAssignmentId ? 'Update' : 'Add'}</button>
            </div>

            <div className="overflow-auto border border-gray-200"><table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Customer Group</th><th className="p-2 text-left">Default GL Code</th><th className="p-2 text-left">Default GL Name</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Actions</th></tr></thead><tbody>{filteredCustomerGroupAssignments.map(a => {
              const mappedGl = glById.get(a.controlGL || '');
              return <tr key={a.id} className="border-t"><td className="p-2">{a.partyGroup}</td><td className="p-2">{mappedGl?.glCode || '-'}</td><td className="p-2">{mappedGl?.glName || '-'}</td><td className="p-2">{mappedGl?.activeStatus || 'Active'}</td><td className="p-2"><button className="text-primary font-bold" onClick={() => { setCustomerGroupAssignmentForm({ setOfBooksId: a.setOfBooksId, customerGroup: a.partyGroup || 'Sundry Debtors', controlGL: a.controlGL || '' }); setEditingCustomerGroupAssignmentId(a.id); }}>Edit</button></td></tr>;
            })}</tbody></table></div>
          </div>
        )}

        {activeTab === 'bank' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              <select className="tally-input" value={bankForm.companyCodeId} onChange={e => setBankForm({ ...bankForm, companyCodeId: e.target.value })}><option value="">Company Code*</option>{activeCompanies.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}</select>
              <input className="tally-input" placeholder="Bank Name*" value={bankForm.bankName} onChange={e => setBankForm({ ...bankForm, bankName: e.target.value })} />
              <input className="tally-input" placeholder="Account Name*" value={bankForm.accountName} onChange={e => setBankForm({ ...bankForm, accountName: e.target.value })} />
              <select className="tally-input" value={bankForm.linkedBankGlId} onChange={e => setBankForm({ ...bankForm, linkedBankGlId: e.target.value })}><option value="">Linked Bank GL*</option>{bankGlOptionsForBankForm.map(g => <option key={g.id} value={g.id}>{g.glCode} - {g.glName}</option>)}</select>
              <input className="tally-input" placeholder="Account Number*" value={bankForm.accountNumber} onChange={e => setBankForm({ ...bankForm, accountNumber: e.target.value })} />
              <input className="tally-input" placeholder="IFSC Code" value={bankForm.ifscCode} onChange={e => setBankForm({ ...bankForm, ifscCode: e.target.value })} />
              <input className="tally-input" placeholder="Branch Name" value={bankForm.branchName} onChange={e => setBankForm({ ...bankForm, branchName: e.target.value })} />
              <select className="tally-input" value={bankForm.accountType} onChange={e => setBankForm({ ...bankForm, accountType: e.target.value as AccountType })}>{accountTypes.map(a => <option key={a}>{a}</option>)}</select>
              <input className="tally-input" type="number" placeholder="Opening Balance" value={bankForm.openingBalance} onChange={e => setBankForm({ ...bankForm, openingBalance: Number(e.target.value) || 0 })} />
              <input className="tally-input" type="date" value={bankForm.openingDate} onChange={e => setBankForm({ ...bankForm, openingDate: e.target.value })} />
              <select className="tally-input" value={bankForm.activeStatus} onChange={e => setBankForm({ ...bankForm, activeStatus: e.target.value as Status })}><option>Active</option><option>Inactive</option></select>
              <label className="flex items-center gap-2 text-xs font-black uppercase border border-gray-300 px-2"><input type="checkbox" checked={bankForm.defaultBank} onChange={e => setBankForm({ ...bankForm, defaultBank: e.target.checked })} />Default Bank</label>
              <button className="bg-primary text-white text-xs font-black uppercase px-3" onClick={onSaveBank}>{editingBankId ? 'Update' : 'Add'}</button>
            </div>
            <div className="overflow-auto border border-gray-200"><table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Company</th><th className="p-2 text-left">Bank</th><th className="p-2 text-left">Account</th><th className="p-2 text-left">Linked GL</th><th className="p-2 text-left">Type</th><th className="p-2 text-left">Opening</th><th className="p-2 text-left">Flags</th><th className="p-2 text-left">Actions</th></tr></thead><tbody>{filteredBanks.map(b => <tr key={b.id} className="border-t"><td className="p-2">{store.companies.find(c => c.id === b.companyCodeId)?.code || '-'}</td><td className="p-2">{b.bankName}<br />{b.branchName || '-'}</td><td className="p-2">{b.accountName}<br />{b.accountNumber}<br />{b.ifscCode || '-'}</td><td className="p-2">{store.glMasters.find(g => g.id === b.linkedBankGlId)?.glCode || '-'}<br />{store.glMasters.find(g => g.id === b.linkedBankGlId)?.glName || '-'}</td><td className="p-2">{b.accountType}</td><td className="p-2">{b.openingBalance} on {b.openingDate || '-'}</td><td className="p-2">Default:{b.defaultBank ? 'Yes' : 'No'}<br />Status:{b.activeStatus}</td><td className="p-2"><button className="text-primary font-bold" onClick={() => { setBankForm({ companyCodeId: b.companyCodeId, linkedBankGlId: b.linkedBankGlId || '', bankName: b.bankName, accountName: b.accountName, accountNumber: b.accountNumber, ifscCode: b.ifscCode, branchName: b.branchName, accountType: b.accountType, openingBalance: b.openingBalance, openingDate: b.openingDate, defaultBank: b.defaultBank, activeStatus: b.activeStatus }); setEditingBankId(b.id); }}>Edit</button></td></tr>)}</tbody></table></div>
          </div>
        )}


        {activeTab === 'supplierGroupAssignment' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              <select className="tally-input" value={supplierGroupAssignmentForm.setOfBooksId} onChange={e => setSupplierGroupAssignmentForm({ ...supplierGroupAssignmentForm, setOfBooksId: e.target.value, controlGL: '' })}><option value="">Set of Books*</option>{store.setOfBooks.map(b => <option key={b.id} value={b.id}>{b.setOfBooksId}</option>)}</select>
              <select className="tally-input" value={supplierGroupAssignmentForm.supplierGroup} onChange={e => setSupplierGroupAssignmentForm({ ...supplierGroupAssignmentForm, supplierGroup: e.target.value })}>{defaultSupplierGroupConfig.map(cfg => <option key={cfg.group} value={cfg.group}>{cfg.group}</option>)}</select>
              <select className="tally-input" value={supplierGroupAssignmentForm.controlGL} onChange={e => setSupplierGroupAssignmentForm({ ...supplierGroupAssignmentForm, controlGL: e.target.value })}><option value="">Default GL Code*</option>{supplierGroupGlOptions.map(gl => <option key={gl.id} value={gl.id}>{gl.glCode} - {gl.glName}</option>)}</select>
              <select className="tally-input" value={supplierGroupAssignmentForm.status} onChange={e => setSupplierGroupAssignmentForm({ ...supplierGroupAssignmentForm, status: e.target.value as Status })}><option>Active</option><option>Inactive</option></select>
              <button className="bg-primary text-white text-xs font-black uppercase px-3" onClick={onSaveSupplierGroupAssignment}>{editingSupplierGroupAssignmentId ? 'Update' : 'Add'}</button>
            </div>
            <div className="text-[11px] text-gray-500 font-bold uppercase p-2 border border-yellow-200 bg-yellow-50">Rule: One Supplier Group can be mapped with only one GL in a Set of Books.</div>
            <div className="overflow-auto border border-gray-200"><table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Supplier Group</th><th className="p-2 text-left">Default GL Code</th><th className="p-2 text-left">Default GL Name</th><th className="p-2 text-left">GL Type</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Actions</th></tr></thead><tbody>{filteredSupplierGroupAssignments.map(a => {
              const mapped = glById.get(a.controlGL || '');
              return <tr key={a.id} className="border-t"><td className="p-2">{a.partyGroup}</td><td className="p-2">{mapped?.glCode || '-'}</td><td className="p-2">{mapped?.glName || '-'}</td><td className="p-2">{mapped?.glType || '-'}</td><td className="p-2">{(a as any).activeStatus || 'Active'}</td><td className="p-2"><button className="text-primary font-bold" onClick={() => { setSupplierGroupAssignmentForm({ setOfBooksId: a.setOfBooksId, supplierGroup: a.partyGroup || 'Sundry Creditors', controlGL: a.controlGL || '', status: ((a as any).activeStatus || 'Active') as Status }); setEditingSupplierGroupAssignmentId(a.id); }}>Edit</button></td></tr>;
            })}</tbody></table></div>
          </div>
        )}

        {activeTab === 'assignment' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <select className="tally-input" value={assignmentForm.setOfBooksId} onChange={e => setAssignmentForm({ ...assignmentForm, setOfBooksId: e.target.value })}><option value="">Set of Books*</option>{store.setOfBooks.map(b => <option key={b.id} value={b.id}>{b.setOfBooksId}</option>)}</select>
              <select className="tally-input" value={assignmentForm.materialMasterType} onChange={e => setAssignmentForm({ ...assignmentForm, materialMasterType: e.target.value as MaterialType })}>{materialTypes.map(mt => <option key={mt}>{mt}</option>)}</select>
              <select className="tally-input" value={assignmentForm.inventoryGL} onChange={e => setAssignmentForm({ ...assignmentForm, inventoryGL: e.target.value })} disabled={!activeRule.inventoryRequired}><option value="">Inventory GL {activeRule.inventoryRequired ? '(Asset)' : '(Optional/Hidden)'}</option>{glForSelectedBooks.map(gl => <option key={gl.id} value={gl.id}>{gl.glCode} - {gl.glName}</option>)}</select>
              <select className="tally-input" value={assignmentForm.purchaseGL} onChange={e => setAssignmentForm({ ...assignmentForm, purchaseGL: e.target.value })}><option value="">Purchase GL (Expense)</option>{glForSelectedBooks.map(gl => <option key={gl.id} value={gl.id}>{gl.glCode} - {gl.glName}</option>)}</select>
              <select className="tally-input" value={assignmentForm.cogsGL} onChange={e => setAssignmentForm({ ...assignmentForm, cogsGL: e.target.value })}><option value="">COGS GL (Expense)</option>{glForSelectedBooks.map(gl => <option key={gl.id} value={gl.id}>{gl.glCode} - {gl.glName}</option>)}</select>
              <select className="tally-input" value={assignmentForm.salesGL} onChange={e => setAssignmentForm({ ...assignmentForm, salesGL: e.target.value })} disabled={!activeRule.salesRequired}><option value="">Sales GL {activeRule.salesRequired ? '(Income)' : '(Optional/Hidden)'}</option>{glForSelectedBooks.map(gl => <option key={gl.id} value={gl.id}>{gl.glCode} - {gl.glName}</option>)}</select>
              <select className="tally-input" value={assignmentForm.discountGL} onChange={e => setAssignmentForm({ ...assignmentForm, discountGL: e.target.value })}><option value="">Discount GL (Expense)</option>{glForSelectedBooks.map(gl => <option key={gl.id} value={gl.id}>{gl.glCode} - {gl.glName}</option>)}</select>
              <select className="tally-input" value={assignmentForm.taxGL} onChange={e => setAssignmentForm({ ...assignmentForm, taxGL: e.target.value })}><option value="">Tax GL (Liability)</option>{glForSelectedBooks.map(gl => <option key={gl.id} value={gl.id}>{gl.glCode} - {gl.glName}</option>)}</select>
              <button className="bg-primary text-white text-xs font-black uppercase px-3" onClick={onSaveAssignment}>{editingAssignmentId ? 'Update' : 'Add'}</button>
            </div>
            <div className="text-[11px] text-gray-500 font-bold uppercase p-2 border border-yellow-200 bg-yellow-50">Posting behavior: if mapping missing for selected Set of Books + Material Type, block posting with message: “GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.”</div>
            <button className="text-xs font-bold text-primary" onClick={() => exportCsv('gl-assignments.csv', ['Books', 'Material Type', 'Inventory', 'Purchase', 'COGS', 'Sales', 'Discount', 'Tax'], filteredAssignments.map(a => [booksById.get(a.setOfBooksId)?.setOfBooksId || '', a.materialMasterType, glById.get(a.inventoryGL || '')?.glCode || '', glById.get(a.purchaseGL || '')?.glCode || '', glById.get(a.cogsGL || '')?.glCode || '', glById.get(a.salesGL || '')?.glCode || '', glById.get(a.discountGL || '')?.glCode || '', glById.get(a.taxGL || '')?.glCode || '']))}>Export CSV</button>
            <div className="overflow-auto border border-gray-200"><table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Books</th><th className="p-2 text-left">Material</th><th className="p-2 text-left">GL Summary</th><th className="p-2 text-left">Actions</th></tr></thead><tbody>{filteredAssignments.map(a => <tr key={a.id} className="border-t"><td className="p-2">{booksById.get(a.setOfBooksId)?.setOfBooksId}</td><td className="p-2">{a.materialMasterType}</td><td className="p-2">Inv:{glById.get(a.inventoryGL || '')?.glCode || '-'} | Pur:{glById.get(a.purchaseGL || '')?.glCode} | COGS:{glById.get(a.cogsGL || '')?.glCode} | Sales:{glById.get(a.salesGL || '')?.glCode || '-'} | Tax:{glById.get(a.taxGL || '')?.glCode}</td><td className="p-2"><button className="text-primary font-bold" onClick={() => { setAssignmentForm({ setOfBooksId: a.setOfBooksId, materialMasterType: (a.materialMasterType || 'Trading Goods') as MaterialType, inventoryGL: a.inventoryGL || '', purchaseGL: a.purchaseGL || '', cogsGL: a.cogsGL || '', salesGL: a.salesGL || '', discountGL: a.discountGL || '', taxGL: a.taxGL || '' }); setEditingAssignmentId(a.id); }}>Edit</button></td></tr>)}</tbody></table></div>
          </div>
        )}

        {activeTab === 'wizard' && (
          <div className="space-y-3">
            <div className="text-xs text-gray-600 border border-gray-200 p-3 bg-gray-50">Reset to Default is allowed when no postings exist, or user confirms append mode. Audit fields are retained via seeded_by_system, template_version, created_at/by.</div>
            <div className="overflow-auto border border-gray-200"><table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Timestamp</th><th className="p-2 text-left">Books</th><th className="p-2 text-left">Action</th><th className="p-2 text-left">Message</th></tr></thead><tbody>{store.setupLogs.map(log => <tr key={log.id} className="border-t"><td className="p-2">{new Date(log.created_at).toLocaleString()}</td><td className="p-2">{booksById.get(log.setOfBooksId)?.setOfBooksId}</td><td className="p-2">{log.action}</td><td className="p-2">{log.message}</td></tr>)}</tbody></table></div>
            <h4 className="text-xs font-black uppercase">Assignment Change History (Future-effective changes)</h4>
            <div className="overflow-auto border border-gray-200"><table className="min-w-full text-xs"><thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Changed At</th><th className="p-2 text-left">Books</th><th className="p-2 text-left">Material</th><th className="p-2 text-left">Effective From</th></tr></thead><tbody>{store.assignmentHistory.map(h => <tr key={h.id} className="border-t"><td className="p-2">{new Date(h.changed_at).toLocaleString()}</td><td className="p-2">{booksById.get(h.setOfBooksId)?.setOfBooksId}</td><td className="p-2">{h.materialMasterType}</td><td className="p-2">{new Date(h.effective_from).toLocaleString()}</td></tr>)}</tbody></table></div>
          </div>
        )}
      </Card>
    </div>
  );
};

export default CompanyConfiguration;
