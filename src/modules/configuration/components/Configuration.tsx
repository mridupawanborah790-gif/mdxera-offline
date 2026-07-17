import React, { useState, useEffect, useRef, useMemo } from 'react';
import Card from '@core/components/ui/Card';
import type { AppConfigurations, ModuleConfig, InvoiceNumberConfig, DiscountRule, SlabRule, InventoryItem, Transaction, Purchase, RegisteredPharmacy, Medicine, Distributor, SupplierProductMap, Customer } from '@core/types';
import { configurableModules, MASTER_SHORTCUT_OPTIONS } from '@core/utils/constants';
import { 
    downloadMasterTemplate, downloadInventoryTemplate, downloadSupplierTemplate, 
    downloadCustomerTemplate, downloadNomenclatureTemplate, downloadSalesImportTemplate, 
    downloadPurchaseImportTemplate, parseInventoryCsv, parseDistributorCsv, 
    parseCustomerCsv, parsePurchaseCsv, parseSalesCsv, parseMedicineMasterCsv, parseNomenclatureCsv 
} from '@core/utils/csv';
import ImportPreviewModal from '@modules/inventory/components/ImportPreviewModal';
import DistributorImportPreviewModal from '@modules/suppliers/components/DistributorImportPreviewModal';
import CustomerImportPreviewModal from '@modules/customers/components/CustomerImportPreviewModal';
import PurchaseBillImportPreviewModal from '@modules/purchase/components/PurchaseBillImportPreviewModal';
import SalesBillImportPreviewModal from '@modules/sales/components/SalesBillImportPreviewModal';
import Modal from '@core/components/ui/Modal';
import MasterDataMigrationWizard from '@modules/inventory/components/MasterDataMigrationWizard';
import ModuleVisibility from '@modules/configuration/components/ModuleVisibility';
import { fuzzyMatch } from '@core/utils/search';
import { getFinancialYearLabel } from '@core/utils/invoice';
import { supabase } from '@core/db/supabaseClient';
import { reserveVoucherNumber, resetVoucherCursors, warmupVoucherSeries } from '@core/voucher/voucherService';
import { isOnline } from '@core/sync/networkMonitor';
import { normalizeStockHandlingConfig } from '@core/utils/stockHandling';

type DemoBusinessType = 'RETAIL' | 'DISTRIBUTOR';
type DuplicateHandlingMode = 'SKIP' | 'UPDATE';

type PharmacyDemoMaterial = {
    id: string;
    name: string;
    material_code: string;
    barcode?: string;
    brand?: string;
    manufacturer?: string;
    marketer?: string;
    composition?: string;
    pack?: string;
    description?: string;
    directions?: string;
    storage?: string;
    uses?: string;
    side_effects?: string;
    benefits?: string;
    mrp?: number;
    rate_a?: number;
    rate_b?: number;
    rate_c?: number;
    gst_rate?: number;
    hsn_code?: string;
    is_prescription_required?: boolean;
    is_active?: boolean;
    country_of_origin?: string;
    material_master_type?: string;
    is_inventorised?: boolean;
    is_sales_enabled?: boolean;
    is_purchase_enabled?: boolean;
    is_production_enabled?: boolean;
    is_internal_issue_enabled?: boolean;
    allow_packaging_sale?: boolean;
    duplicate_exists?: boolean;
};

type DemoMigrationAction = 'inserted' | 'skipped' | 'updated';

type DemoMigrationJob = {
    job_id: string;
    organization_id: string;
    user_id?: string;
    source_table: 'material_master_migration';
    target_table: 'material_master';
    duplicate_mode: DuplicateHandlingMode;
    timestamp: string;
    records_found: number;
    records_processed: number;
    imported_count: number;
    skipped_count: number;
    updated_count: number;
    status: 'COMPLETED' | 'FAILED';
    error_message?: string;
    row_mappings: Array<{ source_row_id: string; target_material_id?: string; action: DemoMigrationAction }>;
};


const Toggle: React.FC<{ label: string; enabled: boolean; setEnabled: (enabled: boolean) => void; description?: string }> = ({ label, enabled, setEnabled, description }) => (
    <div className="py-3 border-b border-gray-100 last:border-0 flex items-center justify-between group">
        <div className="flex flex-col">
             <span className="text-sm font-black text-gray-700 uppercase tracking-tight group-hover:text-primary transition-colors">{label}</span>
             {description && <p className="text-[10px] text-gray-400 mt-0.5 leading-none font-bold uppercase">{description}</p>}
        </div>
        <button 
            type="button" 
            onClick={() => setEnabled(!enabled)} 
            className={`${enabled ? 'bg-primary shadow-[0_0_10px_rgba(0,66,66,0.2)]' : 'bg-gray-300 dark:bg-gray-600'} relative inline-flex items-center h-6 rounded-none w-12 transition-all focus:outline-none ring-2 ring-transparent focus:ring-primary/20`}
        >
            <span className={`${enabled ? 'translate-x-6' : 'translate-x-1'} inline-block w-4 h-4 transform bg-white transition-transform shadow-sm`}/>
        </button>
    </div>
);

const getVoucherSchemeDefaults = (): InvoiceNumberConfig => ({
    fy: '',
    prefix: 'INV',
    startingNumber: 1,
    endNumber: undefined,
    paddingLength: 6,
    resetRule: 'financial-year',
    useFiscalYear: true,
    currentNumber: 1,
    activeMode: 'external'
});


const buildNumberPreview = (cfg: Partial<InvoiceNumberConfig>, number: number, fiscalYear?: string) => {
    const prefix = cfg.prefix || '';
    const padded = String(number).padStart(Math.max(1, Number(cfg.paddingLength) || 1), '0');
    const normalizedFiscalYear = (fiscalYear || '').trim();
    const shouldAppendFy = Boolean(cfg.useFiscalYear && normalizedFiscalYear);
    return `${prefix}${padded}${shouldAppendFy ? `-${normalizedFiscalYear}` : ''}`;
};

const FY_REGEX = /^(\d{4})$/;
const FISCAL_YEAR_ERROR_MESSAGE = 'Invalid fiscal year. Please enter only starting fiscal year in YYYY format.';

const toFiscalYearFromDates = (startDate?: string, endDate?: string) => {
    if (!startDate || !endDate) return null;
    if (endDate <= startDate) return null;
    return `${startDate.slice(0, 4)}`;
};

const toDatesFromFiscalYear = (fiscalYear?: string) => {
    const match = FY_REGEX.exec((fiscalYear || '').trim());
    if (!match) return null;
    const startYear = Number(match[1]);
    return {
        fiscalYearStartDate: `${startYear}-04-01`,
        fiscalYearEndDate: `${startYear + 1}-03-31`,
        currentFiscalYear: `${startYear}`,
    };
};

const resolveConfiguredFiscalYear = (configs: AppConfigurations) => (configs.fiscalYearConfig?.currentFiscalYear || '').trim();

function renderVoucherSeriesInput(label: string, key: keyof AppConfigurations, configs: AppConfigurations, onChange: (section: keyof AppConfigurations, field: string, value: any) => void, liveSequences: Record<string, { currentNumber: number, documentNumber: string }>, isLoadingLive: boolean, fiscalYear?: string) {
    const merged = { ...getVoucherSchemeDefaults(), ...(configs[key] as InvoiceNumberConfig || {}) };
    const configuredFiscalYear = (fiscalYear || '').trim();
    
    // Prioritize live data from database if available
    const live = liveSequences[key];
    const currentRunningNumber = live ? live.currentNumber : Number(merged.currentNumber || merged.startingNumber || 1);
    const lastUsedNumber = currentRunningNumber > (merged.startingNumber || 1) ? currentRunningNumber - 1 : null;
    const remainingCount = merged.endNumber ? Math.max(0, Number(merged.endNumber) - currentRunningNumber + 1) : null;

    const displayVal = (val: any) => isLoadingLive ? '...' : val;

    return (
        <div className="p-4 border border-gray-200 bg-gray-50 mb-4">
            <h3 className="text-xs font-black text-primary uppercase tracking-widest mb-3">{label}</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div><label className="text-[9px] font-black text-gray-400 uppercase">FY</label><input type="text" value={configuredFiscalYear} readOnly className="w-full tally-input uppercase bg-gray-100" placeholder="From Fiscal Year Configuration"/></div>
                <div><label className="text-[9px] font-black text-gray-400 uppercase">Prefix</label><input type="text" value={merged.prefix} onChange={e => onChange(key, 'prefix', e.target.value)} className="w-full tally-input uppercase"/></div>
                <div><label className="text-[9px] font-black text-gray-400 uppercase">Start No</label><input type="number" min={1} value={merged.startingNumber} onChange={e => onChange(key, 'startingNumber', parseInt(e.target.value || '1', 10))} className="w-full tally-input"/></div>
                <div><label className="text-[9px] font-black text-gray-400 uppercase">End No (Optional)</label><input type="number" min={1} value={merged.endNumber ?? ''} onChange={e => onChange(key, 'endNumber', e.target.value ? parseInt(e.target.value, 10) : undefined)} className="w-full tally-input"/></div>
                <div><label className="text-[9px] font-black text-gray-400 uppercase">Padding</label><input type="number" min={1} value={merged.paddingLength} onChange={e => onChange(key, 'paddingLength', parseInt(e.target.value || '1', 10))} className="w-full tally-input"/></div>
                <div><label className="text-[9px] font-black text-gray-400 uppercase">Reset Rule</label><input type="text" value="FY-wise" disabled className="w-full tally-input bg-gray-100"/></div>
                <div><label className="text-[9px] font-black text-gray-400 uppercase">Next Sequence No</label><input type="text" value={displayVal(currentRunningNumber)} readOnly className="w-full tally-input bg-gray-100 font-bold"/></div>
                <div className="pt-4"><Toggle label="Use FY in Number" enabled={merged.useFiscalYear} setEnabled={v => onChange(key, 'useFiscalYear', v)} /></div>
            </div>
            <div className="mt-4 p-3 border border-dashed border-gray-300 bg-white text-[10px] uppercase font-black tracking-wide grid grid-cols-1 md:grid-cols-4 gap-2">
                <div><span className="text-gray-500">Last Used:</span> {displayVal(lastUsedNumber ? buildNumberPreview(merged, lastUsedNumber, configuredFiscalYear) : 'None')}</div>
                <div><span className="text-gray-500">Current Running:</span> {displayVal(buildNumberPreview(merged, currentRunningNumber, configuredFiscalYear))}</div>
                <div><span className="text-gray-500">Preview (Next):</span> {displayVal(buildNumberPreview(merged, currentRunningNumber, configuredFiscalYear))}</div>
                <div><span className="text-gray-500">Remaining:</span> {displayVal(remainingCount === null ? 'Unlimited' : remainingCount)}</div>
            </div>
            {merged.useFiscalYear && !configuredFiscalYear && (<p className="mt-2 text-[10px] font-bold text-amber-700">Fiscal Year not configured. Voucher number will be generated without FY.</p>)}
        </div>
    );
}

const MedicineMasterImportPreviewModal = ({ isOpen, onClose, onSave, data, isSaving = false }: any) => (
    <Modal isOpen={isOpen} onClose={onClose} title="Material Master Preview" widthClass="max-w-5xl">
        <div className="p-4 overflow-auto max-h-[70vh]">
            <table className="min-w-full text-xs">
                <thead className="bg-gray-100 font-black uppercase"><tr><th className="p-2 text-left">Name</th><th className="p-2 text-left">Brand</th><th className="p-2 text-center">GST%</th></tr></thead>
                <tbody className="divide-y">
                    {data.map((m: any, i: number) => (<tr key={i}><td className="p-2 font-bold uppercase">{m.name}</td><td className="p-2">{m.brand}</td><td className="p-2 text-center">{m.gstRate}%</td></tr>))}
                </tbody>
            </table>
        </div>
        <div className="p-4 border-t flex justify-end gap-2 bg-gray-50"><button onClick={onClose} disabled={isSaving} className="px-4 py-2 border disabled:opacity-50">Cancel</button><button onClick={() => onSave(data)} disabled={isSaving} className="px-6 py-2 bg-primary text-white font-black uppercase text-xs disabled:opacity-50">{isSaving ? 'Processing…' : `Import ${data.length} Materials`}</button></div>
    </Modal>
);

const MappingImportPreviewModal = ({ isOpen, onClose, onSave, data, distributors, medicines, mappings, isSaving = false }: any) => (
    <Modal isOpen={isOpen} onClose={onClose} title="Nomenclature Rule Preview" widthClass="max-w-4xl">
        <div className="p-4 overflow-auto max-h-[70vh]">
            <table className="min-w-full text-xs">
                <thead className="bg-gray-100 font-black uppercase"><tr><th className="p-2 text-left">Supplier</th><th className="p-2 text-left">Their Nomenclature</th><th className="p-2 text-left">Your SKU</th></tr></thead>
                <tbody className="divide-y">
                    {data.map((m: any, i: number) => (
                        <tr key={i}>
                            <td className="p-2 font-bold">{m.supplier_id}</td>
                            <td className="p-2 font-mono text-blue-600">{m.supplier_product_name}</td>
                            <td className="p-2 text-emerald-700">{m.master_medicine_id}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        <div className="p-4 border-t flex justify-end gap-2 bg-gray-50">
            <button onClick={onClose} disabled={isSaving} className="px-4 py-2 border disabled:opacity-50">Cancel</button>
            <button onClick={() => {
                const resolved = data.map((d: any) => {
                    const dist = distributors.find((s: any) => fuzzyMatch(s.name, d.supplier_id));
                    const med = medicines.find((m: any) => fuzzyMatch(m.name, d.master_medicine_id));
                    
                    if (!dist || !med) return null;

                    const existing = (mappings || []).find((em: any) => 
                        em.supplier_id === dist.id && 
                        em.supplier_product_name.toLowerCase().trim() === d.supplier_product_name.toLowerCase().trim()
                    );

                    return { 
                        ...d, 
                        supplier_id: dist.id, 
                        master_medicine_id: med.id,
                        id: existing ? existing.id : crypto.randomUUID() 
                    } as SupplierProductMap;
                }).filter(Boolean);
                onSave(resolved);
            }} disabled={isSaving} className="px-6 py-2 bg-primary text-white font-black uppercase text-xs disabled:opacity-50">{isSaving ? 'Processing…' : 'Import Rules'}</button>
        </div>
    </Modal>
);

type ConfigSection = 'general' | 'posConfig' | 'purchaseConfig' | 'invoiceNumbering' | 'dashboardShortcuts' | 'moduleVisibility' | 'displayOptions' | 'discountMaster' | 'dataManagement' | 'whatsappConfig';

interface ConfigurationPageProps {
    configurations: AppConfigurations;
    onUpdateConfigurations: (configs: AppConfigurations) => Promise<void>;
    addNotification: (message: string, type: 'success' | 'error' | 'warning') => void;
    currentUser: RegisteredPharmacy | null;
    inventory: InventoryItem[];
    transactions: Transaction[];
    purchases: Purchase[];
    distributors: Distributor[];
    customers: Customer[];
    medicines: Medicine[];
    onBulkAddInventory: (list: any[]) => void;
    onBulkAddDistributors: (list: any[]) => void;
    onBulkAddCustomers: (list: any[]) => void;
    onBulkAddPurchases: (list: any[]) => void;
    onBulkAddSales: (list: any[]) => void;
    onBulkAddMedicines: (list: any[]) => void;
    onBulkAddMappings: (list: any[]) => void;
    mappings: SupplierProductMap[];
    onMigrationLockChange?: (locked: boolean) => void;
    onMigrationStateChange?: (state: { active: boolean; minimized: boolean; module: string; progressPercent: number; status: 'Processing…' | 'Completed' | 'Cancelled' }) => void;
    forceShowMigrationPopupToken?: number;
    isActive?: boolean;
}

const ConfigurationPage: React.FC<ConfigurationPageProps> = ({
    configurations, onUpdateConfigurations, addNotification, currentUser,
    inventory, transactions, purchases, distributors, customers, medicines,
    onBulkAddInventory, onBulkAddDistributors, onBulkAddCustomers, onBulkAddPurchases, onBulkAddSales,
    onBulkAddMedicines, onBulkAddMappings, mappings, onMigrationLockChange, onMigrationStateChange, forceShowMigrationPopupToken,
    isActive = true,
}) => {
    const MAX_DASHBOARD_SHORTCUTS = 12;
    const [activeSection, setActiveSection] = useState<ConfigSection>('general');
    const [localConfigs, setLocalConfigs] = useState<AppConfigurations>(configurations || { organization_id: currentUser?.organization_id || 'MDXERA' });
    const [showApiKey, setShowApiKey] = useState(false);

    // Live sequences fetched from DB for the numbering screen
    const [liveSequences, setLiveSequences] = useState<Record<string, { currentNumber: number, documentNumber: string }>>({});
    const [isLoadingLive, setIsLoadingLive] = useState(false);
    const [isFetchingVouchers, setIsFetchingVouchers] = useState(false);

    // Deep merge voucher sequences from configurations prop to stay in sync with POS saves
    // while preserving other unsaved local edits in the Configuration screen.
    useEffect(() => {
        if (configurations) {
            setLocalConfigs(prev => {
                const voucherKeys: Array<keyof AppConfigurations> = ['invoiceConfig', 'nonGstInvoiceConfig', 'purchaseConfig', 'purchaseOrderConfig', 'salesChallanConfig', 'deliveryChallanConfig', 'physicalInventoryConfig'];
                const updated = { ...prev, ...configurations };
                
                voucherKeys.forEach(key => {
                    const prevVal = prev[key];
                    const configVal = configurations[key];
                    if (configVal && prevVal) {
                        (updated as any)[key] = {
                            ...(prevVal as any),
                            ...(configVal as any),
                        };
                    }
                });
                
                return updated;
            });
        }
    }, [configurations]);

    // Fetch live DB sequence numbers when the numbering section is opened
    useEffect(() => {
        if (activeSection === 'invoiceNumbering' && currentUser) {
            const fetchLiveSequences = async () => {
                setIsLoadingLive(true);
                const voucherKeysMap: Record<string, 'sales-gst' | 'sales-non-gst' | 'purchase-entry' | 'purchase-order' | 'sales-challan' | 'delivery-challan' | 'physical-inventory'> = {
                    'invoiceConfig': 'sales-gst',
                    'nonGstInvoiceConfig': 'sales-non-gst',
                    'purchaseConfig': 'purchase-entry',
                    'purchaseOrderConfig': 'purchase-order',
                    'salesChallanConfig': 'sales-challan',
                    'deliveryChallanConfig': 'delivery-challan',
                    'physicalInventoryConfig': 'physical-inventory'
                };

                const currentFyInUi = (localConfigs.fiscalYearConfig?.currentFiscalYear || '').trim();

                const results: Record<string, any> = {};
                for (const [configKey, docType] of Object.entries(voucherKeysMap)) {
                    try {
                        const preview = await reserveVoucherNumber(docType, currentUser, true);
                        results[configKey] = {
                            currentNumber: preview.usedNumber,
                            documentNumber: preview.documentNumber,
                        };
                    } catch (e) {
                        console.error(`Failed to fetch live sequence for ${docType}`, e);
                    }
                }
                setLiveSequences(results);
                setIsLoadingLive(false);
            };
            fetchLiveSequences();
        }
    }, [
        activeSection, 
        currentUser, 
        localConfigs.fiscalYearConfig?.currentFiscalYear,
        localConfigs.invoiceConfig?.prefix, localConfigs.invoiceConfig?.startingNumber,
        localConfigs.nonGstInvoiceConfig?.prefix, localConfigs.nonGstInvoiceConfig?.startingNumber,
        localConfigs.purchaseConfig?.prefix, localConfigs.purchaseConfig?.startingNumber,
        localConfigs.purchaseOrderConfig?.prefix, localConfigs.purchaseOrderConfig?.startingNumber,
        localConfigs.salesChallanConfig?.prefix, localConfigs.salesChallanConfig?.startingNumber,
        localConfigs.deliveryChallanConfig?.prefix, localConfigs.deliveryChallanConfig?.startingNumber,
        localConfigs.physicalInventoryConfig?.prefix, localConfigs.physicalInventoryConfig?.startingNumber
    ]);

    // Fetch voucher cursors from Supabase and re-seed local state
    const handleFetchVouchersFromServer = async () => {
        if (!currentUser) return;
        setIsFetchingVouchers(true);
        try {
            await resetVoucherCursors(currentUser.organization_id);
            await warmupVoucherSeries(currentUser.organization_id);
            // Refresh the live sequence display after re-seeding
            setIsLoadingLive(true);
            const voucherKeysMap: Record<string, 'sales-gst' | 'sales-non-gst' | 'purchase-entry' | 'purchase-order' | 'sales-challan' | 'delivery-challan' | 'physical-inventory'> = {
                'invoiceConfig': 'sales-gst',
                'nonGstInvoiceConfig': 'sales-non-gst',
                'purchaseConfig': 'purchase-entry',
                'purchaseOrderConfig': 'purchase-order',
                'salesChallanConfig': 'sales-challan',
                'deliveryChallanConfig': 'delivery-challan',
                'physicalInventoryConfig': 'physical-inventory',
            };
            const results: Record<string, any> = {};
            for (const [configKey, docType] of Object.entries(voucherKeysMap)) {
                try {
                    const preview = await reserveVoucherNumber(docType, currentUser, true);
                    results[configKey] = { currentNumber: preview.usedNumber, documentNumber: preview.documentNumber };
                } catch (e) {
                    console.error(`Failed to refresh sequence for ${docType}`, e);
                }
            }
            setLiveSequences(results);
            setIsLoadingLive(false);
            addNotification('Voucher cursors synced from server successfully.', 'success');
        } catch (e: any) {
            addNotification('Failed to sync voucher cursors: ' + (e?.message || 'Unknown error'), 'error');
            setIsLoadingLive(false);
        } finally {
            setIsFetchingVouchers(false);
        }
    };

    // Import State
    const [importType, setImportType] = useState<string | null>(null);
    const [previewData, setPreviewData] = useState<any[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const pharmacyLogoInputRef = useRef<HTMLInputElement>(null);
    const dashboardLogoInputRef = useRef<HTMLInputElement>(null);

    const [demoBusinessType, setDemoBusinessType] = useState<DemoBusinessType>('RETAIL');
    const [duplicateHandlingMode, setDuplicateHandlingMode] = useState<DuplicateHandlingMode>('SKIP');
    const [isMigrationRunning, setIsMigrationRunning] = useState(false);
    const [migrationModule, setMigrationModule] = useState<string>('');
    const [migrationStats, setMigrationStats] = useState({ totalRows: 0, processed: 0, imported: 0, updated: 0, skipped: 0, failed: 0 });
    const [migrationStatus, setMigrationStatus] = useState<'Processing…' | 'Completed' | 'Cancelled'>('Processing…');
    const [isMigrationInitializing, setIsMigrationInitializing] = useState(false);
    const [isMigrationPopupMinimized, setIsMigrationPopupMinimized] = useState(false);
    const cancelMigrationRef = useRef(false);

    useEffect(() => () => onMigrationLockChange?.(false), [onMigrationLockChange]);
    useEffect(() => {
        if (typeof forceShowMigrationPopupToken === 'number') {
            setIsMigrationPopupMinimized(false);
        }
    }, [forceShowMigrationPopupToken]);

    useEffect(() => {
        const active = migrationStats.totalRows > 0 && (isMigrationRunning || migrationStatus !== 'Processing…');
        const progressPercent = Math.min(100, Math.round((migrationStats.processed / Math.max(migrationStats.totalRows, 1)) * 100));
        onMigrationStateChange?.({
            active,
            minimized: isMigrationPopupMinimized,
            module: migrationModule,
            progressPercent,
            status: migrationStatus
        });
    }, [isMigrationPopupMinimized, isMigrationRunning, migrationModule, migrationStats.processed, migrationStats.totalRows, migrationStatus, onMigrationStateChange]);
    const [demoPreviewRows, setDemoPreviewRows] = useState<PharmacyDemoMaterial[]>([]);
    const [demoMigrationLogs, setDemoMigrationLogs] = useState<DemoMigrationJob[]>([]);
    const scopedDemoRows = useMemo(() => demoPreviewRows, [demoPreviewRows]);
    const duplicatesInPreview = useMemo(() => scopedDemoRows.filter(row => row.duplicate_exists).length, [scopedDemoRows]);

    const runDemoMigrationRpcWithFallback = async () => {
        const args = {
            duplicateMode: duplicateHandlingMode
        };

        const attempts: Array<Record<string, string | boolean>> = [
            {
                p_duplicate_mode: args.duplicateMode,
            },
            {
                duplicate_mode: args.duplicateMode,
            }
        ];

        if (!isOnline()) {
            return { data: null, error: { message: 'Internet connection required to run the material master migration.' } };
        }

        let lastError: any = null;
        for (const payload of attempts) {
            const response = await supabase.rpc('run_default_material_master_migration', payload);
            if (!response.error) {
                return response;
            }

            lastError = response.error;
            if (!response.error.message?.includes('Could not find the function public.run_default_material_master_migration')) {
                return response;
            }
        }

        return { data: null, error: lastError };
    };

    const previewDefaultDemoMigration = async () => {
        if (!isOnline()) {
            addNotification('Internet connection required to preview the material master migration.', 'error');
            return;
        }
        const { data, error } = await supabase.rpc('preview_default_material_master_migration');

        if (error) {
            addNotification(`Failed to preview source data: ${error.message}`, 'error');
            return;
        }

        const rows = (data || []) as PharmacyDemoMaterial[];
        setDemoPreviewRows(rows);
        addNotification(`Preview ready. ${rows.length} records found in material_master_migration.`, 'success');
    };

    const runDefaultDemoMigration = async () => {
        if (!currentUser?.organization_id) {
            addNotification('Missing organization context for migration.', 'error');
            return;
        }

        const { data, error } = await runDemoMigrationRpcWithFallback();

        if (error) {
            addNotification(`Demo migration failed: ${error.message}`, 'error');
            return;
        }

        const result = Array.isArray(data) ? data[0] : data;
        const timestamp = new Date().toISOString();

        try {
            const insertedRows = Number(result?.imported_count || 0);
            const updatedRows = Number(result?.updated_count || 0);
            const skippedRows = Number(result?.skipped_count || 0);
            const foundRows = Number(result?.found_count || 0);
            const duplicates = Number(result?.duplicates_count || 0);
            const readyRows = Number(result?.ready_count || 0);

            const job: DemoMigrationJob = {
                job_id: `DEMO-MAT-${Date.now()}`,
                organization_id: currentUser.organization_id,
                user_id: currentUser.id,
                source_table: 'material_master_migration',
                target_table: 'material_master',
                duplicate_mode: duplicateHandlingMode,
                timestamp,
                records_found: foundRows,
                records_processed: readyRows,
                imported_count: insertedRows,
                skipped_count: skippedRows,
                updated_count: updatedRows,
                status: 'COMPLETED',
                row_mappings: []
            };

            setDemoMigrationLogs(prev => [job, ...prev]);
            addNotification(`Default demo migration complete. Found ${foundRows}, Duplicates ${duplicates}, Ready ${readyRows}, Imported ${insertedRows}, Updated ${updatedRows}, Skipped ${skippedRows}.`, 'success');
            await previewDefaultDemoMigration();
        } catch (error: any) {
            const failedJob: DemoMigrationJob = {
                job_id: `DEMO-MAT-${Date.now()}`,
                organization_id: currentUser.organization_id,
                user_id: currentUser.id,
                source_table: 'material_master_migration',
                target_table: 'material_master',
                duplicate_mode: duplicateHandlingMode,
                timestamp,
                records_found: scopedDemoRows.length,
                records_processed: 0,
                imported_count: 0,
                skipped_count: 0,
                updated_count: 0,
                status: 'FAILED',
                error_message: error?.message || 'Unknown migration error.',
                row_mappings: []
            };
            setDemoMigrationLogs(prev => [failedJob, ...prev]);
            addNotification(`Demo migration failed: ${failedJob.error_message}`, 'error');
        }
    };

    useEffect(() => {
        if (configurations) {
            setLocalConfigs(normalizeStockHandlingConfig(configurations));
        }
    }, [configurations]);

    const handleConfigChange = (section: keyof AppConfigurations, field: string, value: any) => {
        setLocalConfigs(prev => {
            const currentSectionData = (prev[section] as any) || {};
            let updatedSectionData = { ...currentSectionData };
            
            if (field.includes('.')) {
                const [parent, child] = field.split('.');
                updatedSectionData[parent] = { ...(updatedSectionData[parent] || {}), [child]: value };
            } else {
                updatedSectionData[field] = value;
            }

            if (section === 'displayOptions') {
                const isStrictStock = field === 'strictStock';
                const isEnableNegativeStock = field === 'enableNegativeStock';

                if (isStrictStock) {
                    updatedSectionData.enableNegativeStock = !value;
                }

                if (isEnableNegativeStock) {
                    updatedSectionData.strictStock = !value;
                }
            }

            if (section === 'fiscalYearConfig') {
                if (field === 'currentFiscalYear') {
                    const derivedDates = toDatesFromFiscalYear(String(value || '').trim());
                    if (derivedDates) {
                        updatedSectionData = { ...updatedSectionData, ...derivedDates };
                    }
                }

                if (field === 'fiscalYearStartDate' || field === 'fiscalYearEndDate') {
                    const derivedFiscalYear = toFiscalYearFromDates(updatedSectionData.fiscalYearStartDate, updatedSectionData.fiscalYearEndDate);
                    if (derivedFiscalYear) {
                        updatedSectionData.currentFiscalYear = derivedFiscalYear;
                    }
                }
            }
            
            return { ...prev, [section]: updatedSectionData, _isDirty: true };
        });
    };

    const handleModuleFieldToggle = (moduleId: string, fieldId: string) => {
        setLocalConfigs(prev => {
            const modules = { ...(prev.modules || {}) };
            const moduleConfig = modules[moduleId] || { visible: true, fields: {} };
            const fields = { ...(moduleConfig.fields || {}) };
            
            fields[fieldId] = fields[fieldId] === false ? true : false;
            
            modules[moduleId] = { ...moduleConfig, fields };
            return { ...prev, modules, _isDirty: true };
        });
    };

    const handleShortcutToggle = (id: string) => {
        setLocalConfigs(prev => {
            const current = prev.masterShortcuts || [];
            const currentOrder = { ...(prev.masterShortcutOrder || {}) };
            const isSelected = current.includes(id);

            if (isSelected) {
                const updated = current.filter(s => s !== id);
                delete currentOrder[id];
                return { ...prev, masterShortcuts: updated, masterShortcutOrder: currentOrder, _isDirty: true };
            }

            if (current.length >= MAX_DASHBOARD_SHORTCUTS) {
                addNotification(`Maximum ${MAX_DASHBOARD_SHORTCUTS} gateway shortcuts can be enabled.`, 'warning');
                return prev;
            }

            const updated = [...current, id];
            const usedOrders = new Set(Object.values(currentOrder).filter(order => Number.isInteger(order) && order >= 1 && order <= MAX_DASHBOARD_SHORTCUTS));
            const nextOrder = Array.from({ length: MAX_DASHBOARD_SHORTCUTS }, (_, i) => i + 1).find(order => !usedOrders.has(order));
            if (nextOrder) {
                currentOrder[id] = nextOrder;
            }

            return { ...prev, masterShortcuts: updated, masterShortcutOrder: currentOrder, _isDirty: true };
        });
    };

    const handleShortcutOrderChange = (id: string, orderValue: string) => {
        setLocalConfigs(prev => {
            const selected = prev.masterShortcuts || [];
            if (!selected.includes(id)) {
                addNotification('Display order can only be set for enabled modules.', 'warning');
                return prev;
            }

            const parsedOrder = Number(orderValue);
            if (!Number.isInteger(parsedOrder) || parsedOrder < 1 || parsedOrder > MAX_DASHBOARD_SHORTCUTS) {
                addNotification(`Display order must be between 1 and ${MAX_DASHBOARD_SHORTCUTS}.`, 'warning');
                return prev;
            }

            const orderMap = { ...(prev.masterShortcutOrder || {}) };
            const duplicateShortcut = Object.entries(orderMap).find(([shortcutId, order]) => shortcutId !== id && order === parsedOrder && selected.includes(shortcutId));
            if (duplicateShortcut) {
                addNotification(`Display order ${parsedOrder} is already assigned to another module.`, 'warning');
                return prev;
            }

            orderMap[id] = parsedOrder;
            return { ...prev, masterShortcutOrder: orderMap, _isDirty: true };
        });
    };

    const handleMoveShortcut = (id: string, direction: 'up' | 'down') => {
        setLocalConfigs(prev => {
            const currentShortcuts = prev.masterShortcuts || [];
            if (currentShortcuts.length === 0) return prev;

            const currentOrder = { ...(prev.masterShortcutOrder || {}) };
            
            // 1. Get current ordered list of selected shortcuts
            // Fallback to 999 so new items go to the end
            const orderedItems = MASTER_SHORTCUT_OPTIONS
                .filter(opt => currentShortcuts.includes(opt.id))
                .sort((a, b) => (currentOrder[a.id] || 999) - (currentOrder[b.id] || 999));

            // 2. Normalize: Ensure every selected item has a sequential order (1, 2, 3...)
            // This fixes cases where orders were undefined or had gaps
            const normalizedOrder: Record<string, number> = {};
            orderedItems.forEach((item, idx) => {
                normalizedOrder[item.id] = idx + 1;
            });

            // 3. Find the index in our normalized list
            const index = orderedItems.findIndex(item => item.id === id);
            if (index === -1) return prev;

            const targetIndex = direction === 'up' ? index - 1 : index + 1;
            if (targetIndex < 0 || targetIndex >= orderedItems.length) return prev;

            // 4. Swap the normalized orders
            const itemA = orderedItems[index];
            const itemB = orderedItems[targetIndex];
            
            const tempOrder = normalizedOrder[itemA.id];
            normalizedOrder[itemA.id] = normalizedOrder[itemB.id];
            normalizedOrder[itemB.id] = tempOrder;

            return { ...prev, masterShortcutOrder: normalizedOrder, _isDirty: true };
        });
    };

    const groupedShortcutOptions = useMemo(() => {
        return MASTER_SHORTCUT_OPTIONS.reduce((acc, option) => {
            if (!acc[option.group]) {
                acc[option.group] = [];
            }
            acc[option.group].push(option);
            return acc;
        }, {} as Record<string, typeof MASTER_SHORTCUT_OPTIONS>);
    }, []);

    const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>, type: string) => {
        if (isMigrationRunning) {
            addNotification('Migration in progress. Please wait or cancel.', 'warning');
            return;
        }
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        const lines = text.split(/\r\n|\n/).filter(l => l.trim() !== '');
        if (lines.length < 2) { addNotification("Empty file or header only", "error"); return; }

        setImportType(type);
        try {
            switch(type) {
                case 'master': setPreviewData(parseMedicineMasterCsv(lines)); break;
                case 'inventory': setPreviewData(parseInventoryCsv(lines)); break;
                case 'suppliers': setPreviewData(parseDistributorCsv(lines)); break;
                case 'customers': setPreviewData(parseCustomerCsv(lines)); break;
                case 'nomenclature': setPreviewData(parseNomenclatureCsv(lines)); break;
                case 'purchases': setPreviewData(parsePurchaseCsv(lines)); break;
                case 'sales': setPreviewData(parseSalesCsv(lines)); break;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to parse CSV format";
            addNotification(message, "error");
        }
        e.target.value = '';
    };

    const runManagedMigration = async (type: string, rows: any[], saver: (chunk: any[]) => any, successMessage: string) => {
        if (!rows.length || isMigrationRunning || isMigrationInitializing) return;
        setIsMigrationInitializing(true);
        setIsMigrationRunning(true);
        onMigrationLockChange?.(true);
        setMigrationModule(type);
        setMigrationStatus('Processing…');
        setMigrationStats({ totalRows: rows.length, processed: 0, imported: 0, updated: 0, skipped: 0, failed: 0 });
        setIsMigrationPopupMinimized(false);
        cancelMigrationRef.current = false;
        setImportType(null);
        setPreviewData([]);

        // Pre-build indexes for fast O(1) lookups during migration
        const medicineCodes = new Set<string>();
        const medicineBarcodes = new Set<string>();
        const medicineNames = new Set<string>();

        const inventoryKeys = new Set<string>();

        const supplierGsts = new Set<string>();
        const supplierMobiles = new Set<string>();
        const supplierNames = new Set<string>();

        const customerPhones = new Set<string>();
        const customerNames = new Set<string>();

        const mappingKeys = new Set<string>();

        if (type === 'master') {
            medicines.forEach(m => {
                if (m.materialCode) medicineCodes.add(m.materialCode);
                if (m.barcode) medicineBarcodes.add(m.barcode);
                if (m.name) medicineNames.add(m.name.toLowerCase());
            });
        } else if (type === 'inventory') {
            inventory.forEach(i => {
                if (i.name && i.batch) inventoryKeys.add(`${i.name.toLowerCase()}_${i.batch}`);
            });
        } else if (type === 'suppliers') {
            distributors.forEach(s => {
                if (s.gst_number) supplierGsts.add(s.gst_number);
                if (s.mobile) supplierMobiles.add(s.mobile);
                if (s.name) supplierNames.add(s.name.toLowerCase());
            });
        } else if (type === 'customers') {
            customers.forEach(c => {
                if (c.phone) customerPhones.add(c.phone);
                if (c.name) customerNames.add(c.name.toLowerCase());
            });
        } else if (type === 'nomenclature') {
            (mappings || []).forEach(m => {
                if (m.supplier_id && m.supplier_product_name) {
                    mappingKeys.add(`${m.supplier_id}_${m.supplier_product_name.toLowerCase().trim()}`);
                }
            });
        }

        const classifyActionFast = (row: any): 'imported' | 'updated' | 'skipped' => {
            if (type === 'master') {
                const found = medicineCodes.has(row.materialCode) || 
                              (!!row.barcode && medicineBarcodes.has(row.barcode)) || 
                              (!!row.name && medicineNames.has(row.name.toLowerCase()));
                return found ? 'updated' : 'imported';
            }
            if (type === 'inventory') {
                const key = `${(row.name || '').toLowerCase()}_${row.batch || ''}`;
                const found = inventoryKeys.has(key);
                return found ? 'updated' : 'imported';
            }
            if (type === 'suppliers') {
                const found = (!!row.gst_number && supplierGsts.has(row.gst_number)) || 
                              (!!row.mobile && supplierMobiles.has(row.mobile)) || 
                              (!!row.name && supplierNames.has(row.name.toLowerCase()));
                return found ? 'updated' : 'imported';
            }
            if (type === 'customers') {
                const found = (!!row.phone && customerPhones.has(row.phone)) || 
                              (!!row.name && customerNames.has(row.name.toLowerCase()));
                return found ? 'updated' : 'imported';
            }
            if (type === 'nomenclature') {
                const key = `${row.supplier_id || ''}_${(row.supplier_product_name || '').toLowerCase().trim()}`;
                const found = mappingKeys.has(key);
                return found ? 'updated' : 'imported';
            }
            if (type === 'sales' || type === 'purchases') return 'imported';
            return 'skipped';
        };

        // Ensure progress popup renders before any save work begins.
        await new Promise(resolve => setTimeout(resolve, 0));

        const CHUNK_SIZE = 50;
        let processed = 0;
        let imported = 0;
        let updated = 0;
        let skipped = 0;
        let failed = 0;

        try {
            for (let idx = 0; idx < rows.length; idx += CHUNK_SIZE) {
                if (cancelMigrationRef.current) break;
                const chunk = rows.slice(idx, idx + CHUNK_SIZE);
                chunk.forEach(row => {
                    const action = classifyActionFast(row);
                    if (action === 'imported') imported += 1;
                    if (action === 'updated') updated += 1;
                    if (action === 'skipped') skipped += 1;
                });
                try {
                    await Promise.resolve(saver(chunk));
                } catch {
                    failed += chunk.length;
                    imported = Math.max(0, imported - chunk.length);
                }
                processed += chunk.length;
                setMigrationStats({ totalRows: rows.length, processed, imported, updated, skipped, failed });
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            const wasCancelled = cancelMigrationRef.current;
            setMigrationStatus(wasCancelled ? 'Cancelled' : 'Completed');
            const summary = `Total: ${rows.length}, Processed: ${processed}, Imported: ${imported}, Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`;
            addNotification(wasCancelled ? `Migration cancelled. ${summary}` : `${successMessage} ${summary}`, wasCancelled ? 'warning' : 'success');
        } finally {
            setIsMigrationInitializing(false);
            setIsMigrationRunning(false);
        }
    };




    const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: 'pharmacy_logo_url' | 'dashboard_logo_url') => {
        const file = e.target.files?.[0];
        if (!file) return;

        const allowedTypes = ['image/png', 'image/jpg', 'image/jpeg'];
        if (!allowedTypes.includes(file.type.toLowerCase())) {
            addNotification('Invalid file format. Please upload PNG, JPG, or JPEG image only.', 'error');
            e.target.value = '';
            return;
        }

        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Unable to read selected image.'));
            reader.readAsDataURL(file);
        }).catch((error: Error) => {
            addNotification(error.message || 'Unable to upload image.', 'error');
            return '';
        });

        if (!dataUrl) return;

        // Directly update the configuration
        setLocalConfigs(prev => {
            const currentDisplayOptions = (prev.displayOptions || {}) as any;
            const updatedDisplayOptions = { ...currentDisplayOptions, [target]: dataUrl };
            const updated = { ...prev, displayOptions: updatedDisplayOptions, _isDirty: true };
            
            // Perform the actual persistence
            onUpdateConfigurations(updated);
            
            return updated;
        });
        
        addNotification(`${target === 'pharmacy_logo_url' ? 'Pharmacy logo' : 'Dashboard logo'} updated and saved.`, 'success');
        e.target.value = '';
    };

    const handleLogoRemove = (target: 'pharmacy_logo_url' | 'dashboard_logo_url') => {
        setLocalConfigs(prev => {
            const currentDisplayOptions = (prev.displayOptions || {}) as any;
            const updatedDisplayOptions = { ...currentDisplayOptions, [target]: undefined };
            const updated = { ...prev, displayOptions: updatedDisplayOptions, _isDirty: true };
            
            // Perform the actual persistence
            onUpdateConfigurations(updated);
            
            return updated;
        });
        addNotification(`${target === 'pharmacy_logo_url' ? 'Pharmacy logo' : 'Dashboard logo'} removed and saved.`, 'success');
    };
    const validateVoucherSchemes = (): string | null => {
        const targets: Array<[keyof AppConfigurations, string]> = [
            ['invoiceConfig', 'Sales Bill (GST)'],
            ['nonGstInvoiceConfig', 'Sales Bill (Non-GST)'],
            ['purchaseConfig', 'Purchase Entry / Supplier Invoice'],
            ['purchaseOrderConfig', 'Purchase Order'],
            ['salesChallanConfig', 'Sales Challan'],
            ['deliveryChallanConfig', 'Delivery Challan'],
            ['physicalInventoryConfig', 'Physical Inventory']
        ];

        const seen = new Set<string>();
        const configuredFiscalYear = resolveConfiguredFiscalYear(localConfigs);
        for (const [key, label] of targets) {
            const cfg = { ...getVoucherSchemeDefaults(), ...(localConfigs[key] as InvoiceNumberConfig || {}) };
            if (cfg.endNumber && cfg.endNumber < cfg.startingNumber) return `${label}: End No cannot be less than Start No.`;
            if (cfg.currentNumber < cfg.startingNumber) return `${label}: Current Running No cannot be less than Start No.`;
            if (cfg.endNumber && cfg.currentNumber > cfg.endNumber) return `${label}: Number range exhausted. Increase End No before saving.`;
            const overlapKey = `${configuredFiscalYear || 'NO-FY'}|${cfg.prefix || ''}`.toUpperCase();
            if (seen.has(overlapKey)) return `${label}: Overlapping configuration detected (same FY + Prefix).`;
            seen.add(overlapKey);
        }

        return null;
    };

    const MigrationCard = ({ title, desc, onTemplate, type }: { title: string, desc: string, onTemplate: () => void, type: string }) => (
        <Card className="p-4 border-2 border-gray-200 hover:border-primary/40 transition-all group rounded-none bg-white">
            <div className="flex justify-between items-start mb-3">
                <h3 className="font-black uppercase text-sm text-gray-900 leading-none">{title}</h3>
                <div className="p-2 bg-gray-50 rounded-none"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
            </div>
            <p className="text-[10px] font-bold text-gray-400 uppercase leading-tight mb-6 h-8 overflow-hidden">{desc}</p>
            <div className="flex gap-2">
                <button onClick={onTemplate} disabled={isMigrationRunning} className="flex-1 py-2 text-[9px] font-black uppercase border-2 border-gray-300 hover:bg-gray-50 tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Template</button>
                <button onClick={() => { setImportType(type); fileInputRef.current?.click(); }} disabled={isMigrationRunning} className="flex-1 py-2 text-[9px] font-black uppercase bg-primary text-white shadow-lg hover:bg-primary-dark tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed">Import</button>
            </div>
        </Card>
    );

    const posModule = configurableModules.find(m => m.id === 'pos');
    const purchaseModule = configurableModules.find(m => m.id === 'purchase');

    return (
        <div className="flex flex-col h-full bg-app-bg overflow-hidden font-sans">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Global ERP Configuration (Control Room)</span>
                <span className="text-[10px] font-black uppercase text-accent">Org: {currentUser?.pharmacy_name}</span>
            </div>

            <div className="p-4 flex-1 flex gap-4 overflow-hidden">
                <Card className="w-64 flex flex-col p-0 tally-border bg-white !rounded-none shadow-lg">
                    <div className="bg-primary p-2 text-white text-[10px] font-black uppercase text-center tracking-widest">Settings Menu</div>
                    <nav className="flex-1 overflow-y-auto py-2">
                        {[
                            { id: 'general', name: 'General Settings', icon: '⚙️' },
                            { id: 'posConfig', name: 'POS Sales', icon: '🛒' },
                            { id: 'purchaseConfig', name: 'Purchase Entry', icon: '📦' },
                            { id: 'dataManagement', name: 'Data Migration', icon: '💾' },
                            { id: 'discountMaster', name: 'Discount Master', icon: '🏷️' },
                            { id: 'invoiceNumbering', name: 'Voucher Series', icon: '🔢' },
                            { id: 'dashboardShortcuts', name: 'Gateway Shortcuts', icon: '🚀' },
                            { id: 'moduleVisibility', name: 'Module Hide / Unhide  (Locked)', icon: '🔒' },
                            { id: 'displayOptions', name: 'Printing & Display', icon: '🖥️' },
                            { id: 'whatsappConfig', name: 'WhatsApp API', icon: '💬' },
                        ].map(item => (
                            <button 
                                key={item.id} 
                                onClick={() => setActiveSection(item.id as ConfigSection)} 
                                disabled={isMigrationRunning}
                                className={`w-full text-left px-4 py-2.5 text-xs font-bold uppercase border-b border-gray-50 transition-colors ${activeSection === item.id ? 'bg-primary text-white shadow-[inset_4px_0_0_0_#ffcc00]' : 'text-gray-800 hover:bg-primary hover:text-white'}`}
                            >
                                <span className={`mr-3 ${activeSection === item.id ? 'opacity-100' : 'opacity-60'}`}>{item.icon}</span>{item.name}
                            </button>
                        ))}
                    </nav>
                </Card>

                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    <Card className="p-8 tally-border bg-white !rounded-none shadow-xl min-h-full flex flex-col">
                        <input type="file" ref={fileInputRef} className="hidden" accept=".csv" onChange={e => importType && handleFileImport(e, importType)} />
                        
                        {activeSection === 'general' && (
                            <div className="space-y-8 animate-in fade-in duration-300 max-w-3xl">
                                <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter border-b-2 border-primary pb-2">Business Logic Settings</h2>
                                
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                                    <div className="space-y-4">
                                        <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mb-4">General Settings</h3>
                                        
                                        <div className="flex flex-col gap-1.5 mb-4">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Connection Mode</label>
                                            <select 
                                                value={localConfigs.displayOptions?.networkMode || 'auto'}
                                                onChange={e => handleConfigChange('displayOptions', 'networkMode', e.target.value as 'auto' | 'online' | 'offline')}
                                                className="w-full tally-input !text-sm font-bold"
                                            >
                                                <option value="auto">Automatic (Based on Internet Connection)</option>
                                                <option value="online">Force Online (Always sync & use Supabase)</option>
                                                <option value="offline">Force Offline (Work locally only)</option>
                                            </select>
                                        </div>

                                        <Toggle 
                                            label="Ask Calculation on Billing" 
                                            enabled={localConfigs.displayOptions?.askCalculationOnBilling ?? true}
                                            setEnabled={(v) => handleConfigChange('displayOptions', 'askCalculationOnBilling', v)}
                                            description="Prompt for tax calculation basis (Inc/Excl) during Sale entry."
                                        />

                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Scheme Discount Calculation Base</label>
                                            <select 
                                                value={localConfigs.displayOptions?.schemeDiscountCalculationBase || 'ask_user'}
                                                onChange={e => handleConfigChange('displayOptions', 'schemeDiscountCalculationBase', e.target.value)}
                                                className="w-full tally-input !text-sm"
                                            >
                                                <option value="ask_user">Always Ask User (Recommended)</option>
                                                <option value="after_trade_discount">After Discount (apply scheme on discounted value)</option>
                                                <option value="subtotal">Before Discount / Same Level (apply scheme on original value)</option>
                                            </select>
                                        </div>

                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Tax Calculation Base</label>
                                            <select 
                                                value={localConfigs.displayOptions?.taxCalculationBase || 'after_all_discounts'}
                                                onChange={e => handleConfigChange('displayOptions', 'taxCalculationBase', e.target.value)}
                                                className="w-full tally-input !text-sm"
                                            >
                                                <option value="subtotal">Subtotal</option>
                                                <option value="after_trade_discount">After Trade Discount</option>
                                                <option value="after_all_discounts">After All Discounts (Recommended Default)</option>
                                            </select>
                                        </div>

                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Purchase Entry Calculation Mode</label>
                                            <select
                                                value={localConfigs.displayOptions?.purchaseLineAmountCalculationMode || 'excluding_discount'}
                                                onChange={e => handleConfigChange('displayOptions', 'purchaseLineAmountCalculationMode', e.target.value)}
                                                className="w-full tally-input !text-sm"
                                            >
                                                <option value="excluding_discount">Excluding Discount (Recommended) — Amount = Qty × Rate</option>
                                                <option value="including_discount">Including Discount — Amount = Qty × Rate − Discount</option>
                                            </select>
                                        </div>

                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">POS Sales Calculation Mode</label>
                                            <select
                                                value={localConfigs.displayOptions?.posLineAmountCalculationMode || 'excluding_discount'}
                                                onChange={e => handleConfigChange('displayOptions', 'posLineAmountCalculationMode', e.target.value)}
                                                className="w-full tally-input !text-sm"
                                            >
                                                <option value="excluding_discount">Excluding Discount (Recommended) — Amount = Qty × Rate</option>
                                                <option value="including_discount">Including Discount — Amount = Qty × Rate − Discount</option>
                                            </select>
                                        </div>
                                        
                                        <div className="py-4 border-b border-gray-100 flex items-center justify-between">
                                            <div>
                                                <span className="text-sm font-black text-gray-700 uppercase tracking-tight">Calculation Mode</span>
                                                <p className="text-[10px] text-gray-400 mt-0.5 font-bold uppercase">Switch between Standard and Rounded (Mode 8) logic.</p>
                                            </div>
                                            <select 
                                                value={localConfigs.displayOptions?.calculationMode || 'standard'}
                                                onChange={e => handleConfigChange('displayOptions', 'calculationMode', e.target.value)}
                                                className="p-2 border-2 border-gray-400 font-black text-xs uppercase focus:border-primary outline-none"
                                            >
                                                <option value="standard">Standard Accounting</option>
                                                <option value="8">Mode 8 (Auto-Rounding)</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mb-4">Stock Handling</h3>
                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Near Expiry Threshold (Days)</label>
                                            <input 
                                                type="number" 
                                                value={localConfigs.displayOptions?.expiryThreshold ?? 90}
                                                onChange={e => handleConfigChange('displayOptions', 'expiryThreshold', parseInt(e.target.value) || 0)}
                                                className="w-full tally-input !text-lg"
                                            />
                                        </div>
                                        <Toggle 
                                            label="Strict Stock Enforcement" 
                                            enabled={localConfigs.displayOptions?.strictStock ?? true}
                                            setEnabled={(v) => handleConfigChange('displayOptions', 'strictStock', v)}
                                            description="Prevent billing of items with zero/negative stock."
                                        />
                                        <Toggle 
                                            label="Enable Negative Stock" 
                                            enabled={localConfigs.displayOptions?.enableNegativeStock ?? false}
                                            setEnabled={(v) => handleConfigChange('displayOptions', 'enableNegativeStock', v)}
                                            description="Allow inventory to drop below zero if needed."
                                        />
                                    </div>


                                    <div className="space-y-4 md:col-span-2">
                                        <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mb-4">Fiscal Year Configuration</h3>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div className="flex flex-col gap-1.5"><label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Fiscal Year Start Date</label><input type="date" value={localConfigs.fiscalYearConfig?.fiscalYearStartDate || ''} onChange={e => handleConfigChange('fiscalYearConfig', 'fiscalYearStartDate', e.target.value)} className="w-full tally-input !text-sm"/></div>
                                            <div className="flex flex-col gap-1.5"><label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Fiscal Year End Date</label><input type="date" value={localConfigs.fiscalYearConfig?.fiscalYearEndDate || ''} onChange={e => handleConfigChange('fiscalYearConfig', 'fiscalYearEndDate', e.target.value)} className="w-full tally-input !text-sm"/></div>
                                            <div className="flex flex-col gap-1.5"><label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Current Fiscal Year</label><input type="text" value={localConfigs.fiscalYearConfig?.currentFiscalYear || ''} onChange={e => handleConfigChange('fiscalYearConfig', 'currentFiscalYear', e.target.value)} placeholder="2026" className="w-full tally-input !text-sm"/></div>
                                            <div className="flex flex-col gap-1.5"><label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Voucher Numbering Mode</label><select value={localConfigs.fiscalYearConfig?.voucherNumberingMode || 'reset'} onChange={e => handleConfigChange('fiscalYearConfig', 'voucherNumberingMode', e.target.value)} className="w-full tally-input !text-sm"><option value="reset">Reset each fiscal year</option><option value="continue">Continue sequence</option></select></div>
                                        </div>
                                        <Toggle label="Auto Fiscal Year Detection" enabled={localConfigs.fiscalYearConfig?.autoFiscalYearDetection ?? true} setEnabled={(v) => handleConfigChange('fiscalYearConfig', 'autoFiscalYearDetection', v)} />
                                        <Toggle label="Allow Backdated Entry" enabled={localConfigs.fiscalYearConfig?.allowBackdatedEntry ?? true} setEnabled={(v) => handleConfigChange('fiscalYearConfig', 'allowBackdatedEntry', v)} />
                                        <Toggle label="Lock Previous Fiscal Year" enabled={localConfigs.fiscalYearConfig?.lockPreviousFiscalYear ?? false} setEnabled={(v) => handleConfigChange('fiscalYearConfig', 'lockPreviousFiscalYear', v)} description="Disallow create/update/delete of vouchers in prior fiscal years." />
                                    </div>

                                    <div className="space-y-4 md:col-span-2">
                                        <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mb-4">Invoice Preferences</h3>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-4">
                                            <div className="flex flex-col gap-1.5">
                                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Default Rate Tier</label>
                                                <select 
                                                    value={localConfigs.displayOptions?.defaultRateTier || 'mrp'}
                                                    onChange={e => handleConfigChange('displayOptions', 'defaultRateTier', e.target.value)}
                                                    className="w-full tally-input !text-sm"
                                                >
                                                    <option value="mrp">Maximum Retail Price (MRP)</option>
                                                    <option value="ptr">Price to Retailer (PTR)</option>
                                                    <option value="rateA">Tier A Rate</option>
                                                    <option value="rateB">Tier B Rate</option>
                                                    <option value="rateC">Tier C Rate</option>
                                                </select>
                                            </div>
                                            <div className="flex flex-col gap-1.5">
                                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Customer Pricing Behavior</label>
                                                <select 
                                                    value={localConfigs.displayOptions?.customerPricingMode || 'disabled'}
                                                    onChange={e => handleConfigChange('displayOptions', 'customerPricingMode', e.target.value)}
                                                    className="w-full tally-input !text-sm"
                                                >
                                                    <option value="disabled">Disabled (Use Inventory Tiers)</option>
                                                    <option value="standard">Standard (Override Rate and Amount)</option>
                                                    <option value="fk">FK Price (Override Summary Total only)</option>
                                                </select>
                                            </div>
                                            <div className="flex flex-col gap-1.5">
                                                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Default Print Copies</label>
                                                <input 
                                                    type="number" 
                                                    value={localConfigs.displayOptions?.printCopies ?? 1}
                                                    onChange={e => handleConfigChange('displayOptions', 'printCopies', parseInt(e.target.value) || 1)}
                                                    className="w-full tally-input !text-lg"
                                                />
                                            </div>
                                            <div className="md:col-span-2">
                                                <Toggle 
                                                    label="Show Bill Discount on Print" 
                                                    enabled={localConfigs.displayOptions?.showBillDiscountOnPrint ?? true}
                                                    setEnabled={(v) => handleConfigChange('displayOptions', 'showBillDiscountOnPrint', v)}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeSection === 'posConfig' && posModule && (
                             <div className="space-y-8 animate-in fade-in duration-300">
                                <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter border-b-2 border-primary pb-2">POS Module Configuration</h2>
                                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-6">Enable or disable specific UI components and table columns for the Point of Sale screen.</p>
                                <div className="bg-gray-50/50 p-6 border border-gray-100 max-w-2xl">
                                    <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mb-4">Billing Grid Columns</h3>
                                    {(posModule.fields || []).filter(f => f.id.startsWith('col')).map(field => (
                                        <Toggle 
                                            key={field.id}
                                            label={field.name}
                                            enabled={(localConfigs.modules?.['pos']?.fields?.[field.id]) !== false}
                                            setEnabled={() => handleModuleFieldToggle('pos', field.id)}
                                        />
                                    ))}

                                    <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mt-8 mb-4">Intelligence & Utility Panels</h3>
                                    {(posModule.fields || []).filter(f => !f.id.startsWith('col')).map(field => (
                                        <Toggle 
                                            key={field.id}
                                            label={field.name}
                                            enabled={(localConfigs.modules?.['pos']?.fields?.[field.id]) !== false}
                                            setEnabled={() => handleModuleFieldToggle('pos', field.id)}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                        {activeSection === 'purchaseConfig' && purchaseModule && (
                             <div className="space-y-8 animate-in fade-in duration-300">
                                <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter border-b-2 border-primary pb-2">Purchase Entry Configuration</h2>
                                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-6">Manage field visibility for manual and automated purchase inward bills.</p>
                                <div className="bg-gray-50/50 p-6 border border-gray-100 max-w-2xl">
                                    <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mb-4">Voucher Header & Grid Fields</h3>
                                    {(purchaseModule.fields || []).filter(f => !f.id.startsWith('sum')).map(field => (
                                        <Toggle 
                                            key={field.id}
                                            label={field.name}
                                            enabled={(localConfigs.modules?.['purchase']?.fields?.[field.id]) !== false}
                                            setEnabled={() => handleModuleFieldToggle('purchase', field.id)}
                                        />
                                    ))}

                                    <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mt-8 mb-4">Summary Section Totals</h3>
                                    {(purchaseModule.fields || []).filter(f => f.id.startsWith('sum')).map(field => (
                                        <Toggle 
                                            key={field.id}
                                            label={field.name}
                                            enabled={(localConfigs.modules?.['purchase']?.fields?.[field.id]) !== false}
                                            setEnabled={() => handleModuleFieldToggle('purchase', field.id)}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                        {activeSection === 'dashboardShortcuts' && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter border-b-2 border-primary pb-2 mb-6">Configure Gateway Shortcuts</h2>
                                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-6">Enable up to 12 right sidebar modules for Dashboard Quick Access and set their display sequence.</p>
                                
                                {/* Current Selection & Order Manager */}
                                <div className="bg-gray-50 border-2 border-primary/20 p-4 mb-8">
                                    <div className="flex justify-between items-center mb-4">
                                        <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">Active Selection & Sequence</h3>
                                        <div className="text-[10px] font-black uppercase tracking-widest text-primary bg-primary/5 border border-primary/20 px-3 py-1">
                                            Selected: {(localConfigs.masterShortcuts || []).length} / {MAX_DASHBOARD_SHORTCUTS}
                                        </div>
                                    </div>
                                    
                                    {(localConfigs.masterShortcuts || []).length === 0 ? (
                                        <div className="text-center py-8 border-2 border-dashed border-gray-200">
                                            <p className="text-[10px] font-bold text-gray-400 uppercase italic">No shortcuts selected. Select from the modules below.</p>
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                            {MASTER_SHORTCUT_OPTIONS
                                                .filter(opt => (localConfigs.masterShortcuts || []).includes(opt.id))
                                                .sort((a, b) => (localConfigs.masterShortcutOrder?.[a.id] || 999) - (localConfigs.masterShortcutOrder?.[b.id] || 999))
                                                .map((opt, idx, arr) => (
                                                    <div key={opt.id} className="flex items-center gap-2 p-2 bg-white border border-primary/30 shadow-sm">
                                                        <div className="w-6 h-6 flex items-center justify-center bg-primary text-white text-[10px] font-black">
                                                            {localConfigs.masterShortcutOrder?.[opt.id] || idx + 1}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-[10px] font-black uppercase truncate">{opt.label}</p>
                                                        </div>
                                                        <div className="flex gap-1">
                                                            <button 
                                                                onClick={() => handleMoveShortcut(opt.id, 'up')}
                                                                disabled={idx === 0}
                                                                className="p-1 hover:bg-gray-100 disabled:opacity-20 text-primary transition-colors"
                                                                title="Move Up"
                                                            >
                                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="18 15 12 9 6 15"/></svg>
                                                            </button>
                                                            <button 
                                                                onClick={() => handleMoveShortcut(opt.id, 'down')}
                                                                disabled={idx === arr.length - 1}
                                                                className="p-1 hover:bg-gray-100 disabled:opacity-20 text-primary transition-colors"
                                                                title="Move Down"
                                                            >
                                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="6 9 12 15 18 9"/></svg>
                                                            </button>
                                                            <button 
                                                                onClick={() => handleShortcutToggle(opt.id)}
                                                                className="p-1 hover:bg-red-50 text-red-500 transition-colors"
                                                                title="Remove"
                                                            >
                                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))
                                            }
                                        </div>
                                    )}
                                </div>

                                <div className="space-y-6">
                                    {Object.entries(groupedShortcutOptions).map(([group, options]) => (
                                        <div key={group} className="space-y-2">
                                            <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">{group}</h3>
                                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                                {options.map(opt => {
                                                    const isSelected = (localConfigs.masterShortcuts || []).includes(opt.id);
                                                    const order = localConfigs.masterShortcutOrder?.[opt.id] || '';

                                                    return (
                                                        <div 
                                                            key={opt.id}
                                                            className={`p-3 border-2 transition-all ${isSelected ? 'bg-primary/5 border-primary text-primary' : 'bg-gray-50 border-gray-200 text-gray-600'}`}
                                                        >
                                                            <button
                                                                onClick={() => handleShortcutToggle(opt.id)}
                                                                className="w-full text-left flex items-center gap-3"
                                                            >
                                                                <div className={`p-2 rounded-none ${isSelected ? 'bg-primary/10' : 'bg-white border border-gray-200'}`}>
                                                                    {opt.icon}
                                                                </div>
                                                                <div className="flex-1">
                                                                    <p className="text-xs font-black uppercase tracking-tight leading-none">{opt.label}</p>
                                                                    <p className={`text-[9px] mt-1 font-bold ${isSelected ? 'text-primary/70' : 'text-gray-400'}`}>
                                                                        {isSelected ? 'ENABLED' : 'DISABLED'}
                                                                    </p>
                                                                </div>
                                                            </button>

                                                            <div className="mt-3">
                                                                <label className="block text-[9px] font-black text-gray-500 uppercase mb-1 tracking-wider">
                                                                    Display Order (1-{MAX_DASHBOARD_SHORTCUTS})
                                                                </label>
                                                                <input
                                                                    type="number"
                                                                    min={1}
                                                                    max={MAX_DASHBOARD_SHORTCUTS}
                                                                    disabled={!isSelected}
                                                                    value={order}
                                                                    onChange={e => handleShortcutOrderChange(opt.id, e.target.value)}
                                                                    className="w-full tally-input text-center font-black disabled:opacity-40 disabled:cursor-not-allowed"
                                                                />
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide border-t border-gray-200 pt-3">
                                    If display order is not assigned manually, sequence is auto-assigned in module selection order.
                                </div>
                            </div>
                        )}

                        {activeSection === 'moduleVisibility' && (
                            <div className="-m-8 flex-1 flex flex-col min-h-0">
                                <ModuleVisibility
                                    key={activeSection}
                                    currentUser={currentUser}
                                    addNotification={addNotification}
                                    onCancel={() => setActiveSection('general')}
                                    isActive={isActive}
                                />
                            </div>
                        )}

                        {activeSection === 'displayOptions' && (
                            <div className="space-y-8 animate-in fade-in duration-300 max-w-3xl">
                                <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter border-b-2 border-primary pb-2">Printing & Display Defaults</h2>
                                
                                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest max-w-xl">
                                    Print layout and output presets remain available in this section.
                                </p>

                                <input
                                    ref={pharmacyLogoInputRef}
                                    type="file"
                                    accept=".png,.jpg,.jpeg,image/png,image/jpg,image/jpeg"
                                    className="hidden"
                                    onChange={e => handleLogoUpload(e, 'pharmacy_logo_url')}
                                />
                                <input
                                    ref={dashboardLogoInputRef}
                                    type="file"
                                    accept=".png,.jpg,.jpeg,image/png,image/jpg,image/jpeg"
                                    className="hidden"
                                    onChange={e => handleLogoUpload(e, 'dashboard_logo_url')}
                                />

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                    <div className="border border-gray-200 bg-gray-50 p-4 space-y-3">
                                        <h3 className="text-xs font-black text-primary uppercase tracking-widest">Pharmacy Logo Upload</h3>
                                        <div className="flex flex-col gap-0.5 mb-2">
                                            <p className="text-[10px] font-bold text-gray-500 uppercase leading-none">Used in invoice / bill print templates.</p>
                                            <p className="text-[9px] font-black text-emerald-600 uppercase leading-none">Recommended: 400 × 200 px (2:1 Ratio)</p>
                                        </div>
                                        <div className="h-28 border bg-white grid place-items-center overflow-hidden tally-shadow-inner">
                                            {localConfigs.displayOptions?.pharmacy_logo_url ? (
                                                <img src={localConfigs.displayOptions.pharmacy_logo_url} alt="Pharmacy logo preview" className="h-full w-full object-contain" />
                                            ) : (
                                                <span className="text-[10px] font-black text-gray-400 uppercase">No logo uploaded</span>
                                            )}
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={() => pharmacyLogoInputRef.current?.click()} className="px-4 py-2 tally-button-primary text-[10px]">Upload Image</button>
                                            {!!localConfigs.displayOptions?.pharmacy_logo_url && (
                                                <button onClick={() => handleLogoRemove('pharmacy_logo_url')} className="px-4 py-2 border border-red-300 text-red-600 text-[10px] font-black uppercase">Remove</button>
                                            )}
                                        </div>
                                        <p className="text-[9px] font-bold text-gray-400 uppercase tracking-tighter opacity-70">PNG / JPG / JPEG allowed</p>
                                    </div>

                                    <div className="border border-gray-200 bg-gray-50 p-4 space-y-3">
                                        <h3 className="text-xs font-black text-primary uppercase tracking-widest">Dashboard Logo Upload</h3>
                                        <div className="flex flex-col gap-0.5 mb-2">
                                            <p className="text-[10px] font-bold text-gray-500 uppercase leading-none">Used in Central Dashboard Display.</p>
                                            <p className="text-[9px] font-black text-emerald-600 uppercase leading-none">Recommended: 1200 × 600 px (2:1 Ratio)</p>
                                        </div>
                                        <div className="h-28 border bg-white grid place-items-center overflow-hidden tally-shadow-inner">
                                            {localConfigs.displayOptions?.dashboard_logo_url ? (
                                                <img src={localConfigs.displayOptions.dashboard_logo_url} alt="Dashboard logo preview" className="h-full w-full object-contain" />
                                            ) : (
                                                <span className="text-[10px] font-black text-gray-400 uppercase">No logo uploaded</span>
                                            )}
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={() => dashboardLogoInputRef.current?.click()} className="px-4 py-2 tally-button-primary text-[10px]">Upload Image</button>
                                            {!!localConfigs.displayOptions?.dashboard_logo_url && (
                                                <button onClick={() => handleLogoRemove('dashboard_logo_url')} className="px-4 py-2 border border-red-300 text-red-600 text-[10px] font-black uppercase">Remove</button>
                                            )}
                                        </div>
                                        <p className="text-[9px] font-bold text-gray-400 uppercase tracking-tighter opacity-70">PNG / JPG / JPEG allowed</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeSection === 'whatsappConfig' && (
                            <div className="space-y-8 animate-in fade-in duration-300 max-w-3xl">
                                <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter border-b-2 border-primary pb-2">WhatsApp Business API (AiSensy)</h2>
                                
                                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest max-w-xl">
                                    Configure WhatsApp API credentials to send digital invoices to customers via AiSensy.com.
                                </p>

                                <div className="border border-gray-200 bg-gray-50 p-6 space-y-6">
                                    <Toggle 
                                        label="Enable WhatsApp API Integration" 
                                        enabled={localConfigs.displayOptions?.whatsappEnabled ?? false}
                                        setEnabled={(v) => handleConfigChange('displayOptions', 'whatsappEnabled', v)}
                                        description="If enabled, sales invoices can be sent automatically via your AiSensy Campaign."
                                    />

                                    <div className="space-y-4 pt-6 border-t border-gray-200">
                                        <div className="flex flex-col gap-1.5 relative">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">
                                                AiSensy API Campaign Key
                                            </label>
                                            <div className="relative flex items-center">
                                                <input
                                                    type={showApiKey ? "text" : "password"}
                                                    value={localConfigs.displayOptions?.aisensyApiKey || ''}
                                                    onChange={e => handleConfigChange('displayOptions', 'aisensyApiKey', e.target.value)}
                                                    placeholder="Enter your Developer API Key"
                                                    className="w-full tally-input !text-sm pr-10"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => setShowApiKey(!showApiKey)}
                                                    className="absolute right-3 text-gray-500 hover:text-gray-700 focus:outline-none"
                                                >
                                                    {showApiKey ? (
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                                                    ) : (
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                                    )}
                                                </button>
                                            </div>
                                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-tighter opacity-70">
                                                Copy the "API Campaign Key" from Developer Hub in AiSensy.
                                            </p>
                                        </div>

                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">
                                                AiSensy API Campaign Name
                                            </label>
                                            <input
                                                type="text"
                                                value={localConfigs.displayOptions?.aisensyCampaignName || ''}
                                                onChange={e => handleConfigChange('displayOptions', 'aisensyCampaignName', e.target.value)}
                                                placeholder="e.g. send_invoice"
                                                className="w-full tally-input !text-sm"
                                            />
                                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-tighter opacity-70">
                                                The exact name of the Live API Campaign created in your AiSensy dashboard.
                                            </p>
                                        </div>

                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">
                                                WhatsApp Template Type
                                            </label>
                                            <select 
                                                value={localConfigs.displayOptions?.whatsappTemplateType || 'document'}
                                                onChange={e => handleConfigChange('displayOptions', 'whatsappTemplateType', e.target.value)}
                                                className="w-full tally-input !text-sm"
                                            >
                                                <option value="text">Text Template (5 Variables: Customer, Pharmacy, Inv#, Total, Date)</option>
                                                <option value="document">Document Template (PDF Attachment + 4 Variables)</option>
                                            </select>
                                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-tighter opacity-70">
                                                Select "Text Template" if your template does not accept a PDF attachment, or "Document Template" to send the PDF invoice.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeSection === 'dataManagement' && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter border-b-2 border-primary pb-2 mb-6">Central Data Migration Center</h2>
                                <MasterDataMigrationWizard
                                    currentUser={currentUser}
                                    suppliers={distributors}
                                    customers={customers}
                                    medicines={medicines}
                                    inventory={inventory}
                                    addNotification={addNotification}
                                />
                                <div className="p-4 border-2 border-primary/20 bg-primary/5 space-y-4">
                                    <h3 className="text-sm font-black uppercase tracking-widest">Master Data Migration Default</h3>
                                    <p className="text-[11px] text-gray-600 font-bold uppercase">Default migration from central material master migration source.</p>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[10px] font-black uppercase">
                                        <div>Total records found: {scopedDemoRows.length}</div>
                                        <div>Duplicates detected: {duplicatesInPreview}</div>
                                        <div>Ready to import/update: {scopedDemoRows.length - (duplicateHandlingMode === 'SKIP' ? duplicatesInPreview : 0)}</div>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="text-[10px] font-black uppercase">Duplicate Handling</label>
                                            <select className="w-full tally-input" value={duplicateHandlingMode} onChange={e => setDuplicateHandlingMode(e.target.value as DuplicateHandlingMode)}>
                                                <option value="SKIP">Skip duplicates (Default)</option>
                                                <option value="UPDATE">Update duplicates</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button onClick={previewDefaultDemoMigration} className="px-3 py-2 bg-primary text-white text-[10px] font-black uppercase">Run Default Demo Migration</button>
                                        {demoPreviewRows.length > 0 && (
                                            <button onClick={runDefaultDemoMigration} className="px-3 py-2 bg-green-700 text-white text-[10px] font-black uppercase animate-pulse">Accept Migration (Import {demoPreviewRows.length} Records)</button>
                                        )}
                                    </div>
                                    <div className="border bg-white p-2 max-h-48 overflow-auto">
                                        <div className="text-[10px] font-black uppercase mb-1">Preview Grid (material_master_migration → material_master)</div>
                                        <table className="w-full text-[10px]">
                                            <thead className="bg-gray-100 font-black uppercase">
                                                <tr>
                                                    <th className="p-1 text-left">Name</th>
                                                    <th className="p-1 text-left">Pack</th>
                                                    <th className="p-1 text-left">HSN</th>
                                                    <th className="p-1 text-left">GST</th>
                                                    <th className="p-1 text-left">Manufacturer / Brand</th>
                                                    <th className="p-1 text-left">Category</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {demoPreviewRows.slice(0, 100).map(row => (
                                                    <tr key={row.id} className="border-t">
                                                        <td className="p-1">{row.name}</td>
                                                        <td className="p-1">{row.pack}</td>
                                                        <td className="p-1">{row.hsn_code}</td>
                                                        <td className="p-1">{row.gst_rate}</td>
                                                        <td className="p-1">{row.manufacturer || row.brand}</td>
                                                        <td className="p-1">{row.description}</td>
                                                    </tr>
                                                ))}
                                                {demoPreviewRows.length === 0 && <tr><td className="p-2 text-gray-500" colSpan={6}>Click "Run Default Demo Migration" to load records from material_master_migration dataset.</td></tr>}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="border bg-white p-2 max-h-48 overflow-auto">
                                        <div className="text-[10px] font-black uppercase mb-1">Migration Run Log</div>
                                        <table className="w-full text-[10px]">
                                            <thead className="bg-gray-100 font-black uppercase">
                                                <tr>
                                                    <th className="p-1 text-left">Timestamp</th>
                                                    <th className="p-1 text-left">Organization</th>
                                                    <th className="p-1 text-left">User</th>
                                                    <th className="p-1 text-right">Found</th>
                                                    <th className="p-1 text-right">Imported</th>
                                                    <th className="p-1 text-right">Skipped</th>
                                                    <th className="p-1 text-right">Updated</th>
                                                    <th className="p-1 text-left">Status</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {demoMigrationLogs.map(log => (
                                                    <tr key={log.job_id} className="border-t">
                                                        <td className="p-1">{new Date(log.timestamp).toLocaleString()}</td>
                                                        <td className="p-1">{log.organization_id}</td>
                                                        <td className="p-1">{log.user_id || '-'}</td>
                                                        <td className="p-1 text-right">{log.records_found}</td>
                                                        <td className="p-1 text-right">{log.imported_count}</td>
                                                        <td className="p-1 text-right">{log.skipped_count}</td>
                                                        <td className="p-1 text-right">{log.updated_count}</td>
                                                        <td className="p-1">{log.status}{log.error_message ? `: ${log.error_message}` : ''}</td>
                                                    </tr>
                                                ))}
                                                {demoMigrationLogs.length === 0 && <tr><td className="p-2 text-gray-500" colSpan={8}>No migration run yet.</td></tr>}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                    <MigrationCard title="Material Master" desc="Global SKU catalog including composition, HSN, and Tax details." onTemplate={downloadMasterTemplate} type="master" />
                                    <MigrationCard title="Inventory (Stock)" desc="Batch-wise physical stock data with expiry and purchase rates." onTemplate={downloadInventoryTemplate} type="inventory" />
                                    <MigrationCard title="Supplier Master" desc="Ledger accounts for pharmaceutical distributors and vendors." onTemplate={downloadSupplierTemplate} type="suppliers" />
                                    <MigrationCard title="Customer Master" desc="Patient and Retailer accounts for sales and receivables." onTemplate={downloadCustomerTemplate} type="customers" />
                                    <MigrationCard title="Vendor Sync" desc="Nomenclature rules mapping vendor names to your master SKUs." onTemplate={downloadNomenclatureTemplate} type="nomenclature" />
                                    <MigrationCard title="Sales Import" desc="Bulk import historical sales vouchers or external billing data." onTemplate={downloadSalesImportTemplate} type="sales" />
                                    <MigrationCard title="Purchase Import" desc="Bulk import supplier inward bills and historical purchases." onTemplate={downloadPurchaseImportTemplate} type="purchases" />
                                </div>
                            </div>
                        )}

                        {activeSection === 'invoiceNumbering' && (
                            <div className="space-y-4 animate-in fade-in duration-300">
                                <div className="flex items-center justify-between border-b-2 border-primary pb-2 mb-6">
                                    <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter">Voucher Numbering Schemes</h2>
                                    <button
                                        onClick={handleFetchVouchersFromServer}
                                        disabled={isFetchingVouchers || !isOnline()}
                                        className="px-3 py-1.5 text-[10px] font-black uppercase tracking-wide bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                                        title="Reset local voucher cursors and re-seed from the highest numbers on the server. Use this to fix a cursor that jumped ahead or behind."
                                    >
                                        {isFetchingVouchers ? (
                                            <><span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>
                                        ) : (
                                            <>↓ Sync Cursors from Server</>
                                        )}
                                    </button>
                                </div>
                                {renderVoucherSeriesInput('Sales Bill (GST)', 'invoiceConfig', localConfigs, handleConfigChange, liveSequences, isLoadingLive, resolveConfiguredFiscalYear(localConfigs))}
                                {renderVoucherSeriesInput('Sales Bill (Non-GST)', 'nonGstInvoiceConfig', localConfigs, handleConfigChange, liveSequences, isLoadingLive, resolveConfiguredFiscalYear(localConfigs))}
                                {renderVoucherSeriesInput('Purchase Entry / Supplier Invoice', 'purchaseConfig', localConfigs, handleConfigChange, liveSequences, isLoadingLive, resolveConfiguredFiscalYear(localConfigs))}
                                {renderVoucherSeriesInput('Purchase Order', 'purchaseOrderConfig', localConfigs, handleConfigChange, liveSequences, isLoadingLive, resolveConfiguredFiscalYear(localConfigs))}
                                {renderVoucherSeriesInput('Sales Challan', 'salesChallanConfig', localConfigs, handleConfigChange, liveSequences, isLoadingLive, resolveConfiguredFiscalYear(localConfigs))}
                                {renderVoucherSeriesInput('Delivery Challan', 'deliveryChallanConfig', localConfigs, handleConfigChange, liveSequences, isLoadingLive, resolveConfiguredFiscalYear(localConfigs))}
                                {renderVoucherSeriesInput('Physical Inventory', 'physicalInventoryConfig', localConfigs, handleConfigChange, liveSequences, isLoadingLive, resolveConfiguredFiscalYear(localConfigs))}
                            </div>
                        )}

                        {activeSection === 'discountMaster' && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                <div className="flex justify-between items-center border-b-2 border-primary pb-2 mb-6">
                                    <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter">Discount Strategy Matrix</h2>
                                    <button onClick={() => setLocalConfigs(p => ({ ...p!, discountRules: [...(p?.discountRules || []), { id: crypto.randomUUID(), name: 'New Rule', type: 'flat', level: 'line', value: 0, calculationBase: 'mrp', enabled: true, shortcutKey: 'F', allowManualOverride: true, applyBeforeTax: true }], _isDirty: true }))} className="px-6 py-2 tally-button-primary text-[10px]">Add Rule</button>
                                </div>
                                <div className="space-y-4">
                                    {(localConfigs.discountRules || []).map(rule => (
                                        <div key={rule.id} className="p-4 border-2 border-gray-200 bg-gray-50 rounded-none relative">
                                            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                                <div className="md:col-span-1"><label className="block text-[9px] font-black text-gray-400 uppercase mb-1">Rule Name</label><input type="text" value={rule.name} onChange={e => setLocalConfigs(p => ({ ...p!, discountRules: (p?.discountRules || []).map(r => r.id === rule.id ? { ...r, name: e.target.value } : r), _isDirty: true }))} className="w-full tally-input uppercase"/></div>
                                                <div><label className="block text-[9px] font-black text-gray-400 uppercase mb-1">Type</label><select value={rule.type} onChange={e => setLocalConfigs(p => ({ ...p!, discountRules: (p?.discountRules || []).map(r => r.id === rule.id ? { ...r, type: e.target.value as any } : r), _isDirty: true }))} className="w-full tally-input uppercase"><option value="flat">Flat ₹</option><option value="percentage">Percent %</option></select></div>
                                                <div><label className="block text-[9px] font-black text-gray-400 uppercase mb-1">Level</label><select value={rule.level} onChange={e => setLocalConfigs(p => ({ ...p!, discountRules: (p?.discountRules || []).map(r => r.id === rule.id ? { ...r, level: e.target.value as any } : r), _isDirty: true }))} className="w-full tally-input uppercase"><option value="line">Line</option><option value="invoice">Invoice</option></select></div>
                                                <div><label className="block text-[9px] font-black text-gray-400 uppercase mb-1">Key</label><input type="text" value={rule.shortcutKey} onChange={e => setLocalConfigs(p => ({ ...p!, discountRules: (p?.discountRules || []).map(r => r.id === rule.id ? { ...r, shortcutKey: e.target.value } : r), _isDirty: true }))} className="w-full tally-input uppercase text-center font-black"/></div>
                                            </div>
                                            <button onClick={() => setLocalConfigs(p => ({ ...p!, discountRules: p?.discountRules?.filter(r => r.id !== rule.id), _isDirty: true }))} className="absolute -top-2 -right-2 w-6 h-6 bg-red-600 text-white rounded-full font-black text-xs">✕</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="mt-auto pt-10 border-t border-gray-200 flex justify-end gap-4">
                            <button onClick={() => setLocalConfigs(configurations)} className="px-10 py-3 tally-border bg-white text-gray-500 font-black uppercase text-[11px] hover:bg-red-50 transition-colors">Discard</button>
                            <button onClick={() => {
                                const error = validateVoucherSchemes();
                                if (error) {
                                    addNotification(error, 'error');
                                    return;
                                }

                                // 1. Sanitize shortcuts: Only keep IDs that exist in our master options
                                const validIds = new Set(MASTER_SHORTCUT_OPTIONS.map(opt => opt.id));
                                const sanitizedShortcuts = (localConfigs.masterShortcuts || []).filter(id => validIds.has(id));
                                
                                // 2. Ensure orders are also cleaned up
                                const sanitizedOrder = { ...(localConfigs.masterShortcutOrder || {}) };
                                Object.keys(sanitizedOrder).forEach(id => {
                                    if (!validIds.has(id)) delete sanitizedOrder[id];
                                });

                                const fyConfig = localConfigs.fiscalYearConfig || {};
                                const derivedFiscalYear = toFiscalYearFromDates(fyConfig.fiscalYearStartDate, fyConfig.fiscalYearEndDate);

                                const voucherConfigKeys: Array<keyof AppConfigurations> = ['invoiceConfig', 'nonGstInvoiceConfig', 'purchaseConfig', 'purchaseOrderConfig', 'salesChallanConfig', 'deliveryChallanConfig', 'physicalInventoryConfig'];
                                const normalizedConfigs = voucherConfigKeys.reduce((acc, configKey) => {
                                    const existing = ((localConfigs[configKey] as InvoiceNumberConfig) || getVoucherSchemeDefaults());
                                    
                                    // Use live sequence number if available (it handles audit-based resumes and resets).
                                    // This prevents the UI from saving a stale 'currentNumber' from a different FY.
                                    const liveVal = liveSequences[configKey]?.currentNumber;
                                    const safeCurrent = liveVal !== undefined 
                                        ? Math.max(Number(liveVal), Number(existing.startingNumber || 1))
                                        : Math.max(Number(existing.currentNumber || existing.startingNumber || 1), Number(existing.startingNumber || 1));

                                    return {
                                        ...acc,
                                        [configKey]: {
                                            ...existing,
                                            // Do NOT write fy here — the SQL function owns that field.
                                            // Overwriting it on save would hide the FY change from the
                                            // resume/reset logic in reserve_voucher_number.
                                            currentNumber: safeCurrent,
                                            resetRule: 'financial-year'
                                        }
                                    };
                                }, { 
                                    ...localConfigs, 
                                    masterShortcuts: sanitizedShortcuts,
                                    masterShortcutOrder: sanitizedOrder 
                                } as AppConfigurations);

                                const isDatesValid = !!derivedFiscalYear;
                                const isCurrentYearValid = !!toDatesFromFiscalYear(fyConfig.currentFiscalYear);

                                if (!isDatesValid || !isCurrentYearValid) {
                                    addNotification(FISCAL_YEAR_ERROR_MESSAGE, 'error');
                                    return;
                                }

                                const parsedFiscalYearDates = toDatesFromFiscalYear(fyConfig.currentFiscalYear)!;
                                const syncedFiscalYearConfig = {
                                    ...fyConfig,
                                    ...parsedFiscalYearDates,
                                    currentFiscalYear: derivedFiscalYear
                                };

                                onUpdateConfigurations(normalizeStockHandlingConfig({
                                    ...normalizedConfigs,
                                    fiscalYearConfig: syncedFiscalYearConfig
                                }));
                                    addNotification('Accepted Changes and sanitized shortcut list.', 'success');
                            }} className="px-16 py-4 tally-button-primary shadow-2xl uppercase text-[11px] font-black tracking-[0.3em] active:scale-95">Accept (Enter)</button>
                        </div>
                    </Card>
                </div>
            </div>

            {/* Import Previews */}
            {importType === 'inventory' && previewData.length > 0 && <ImportPreviewModal isOpen={!!importType} onClose={() => { if (!isMigrationRunning && !isMigrationInitializing) { setImportType(null); setPreviewData([]); } }} onSave={() => void runManagedMigration('inventory', previewData, onBulkAddInventory, 'Inventory migration completed.')} isSaving={isMigrationRunning || isMigrationInitializing} data={previewData} />}
            {importType === 'suppliers' && previewData.length > 0 && <DistributorImportPreviewModal isOpen={!!importType} onClose={() => { if (!isMigrationRunning && !isMigrationInitializing) { setImportType(null); setPreviewData([]); } }} onSave={(d: any) => void runManagedMigration('suppliers', d, onBulkAddDistributors, 'Supplier migration completed.')} isSaving={isMigrationRunning || isMigrationInitializing} data={previewData} />}
            {importType === 'customers' && previewData.length > 0 && <CustomerImportPreviewModal isOpen={!!importType} onClose={() => { if (!isMigrationRunning && !isMigrationInitializing) { setImportType(null); setPreviewData([]); } }} onSave={(d: any) => void runManagedMigration('customers', d, onBulkAddCustomers, 'Customer migration completed.')} isSaving={isMigrationRunning || isMigrationInitializing} data={previewData} />}
            {importType === 'purchases' && previewData.length > 0 && <PurchaseBillImportPreviewModal isOpen={!!importType} onClose={() => { if (!isMigrationRunning && !isMigrationInitializing) { setImportType(null); setPreviewData([]); } }} onSave={(d: any) => void runManagedMigration('purchases', d, onBulkAddPurchases, 'Purchase migration completed.')} isSaving={isMigrationRunning || isMigrationInitializing} data={previewData} inventory={inventory} distributors={distributors} />}
            {importType === 'sales' && previewData.length > 0 && <SalesBillImportPreviewModal isOpen={!!importType} onClose={() => { if (!isMigrationRunning && !isMigrationInitializing) { setImportType(null); setPreviewData([]); } }} onSave={(d: any) => void runManagedMigration('sales', d, onBulkAddSales, 'Sales migration completed.')} isSaving={isMigrationRunning || isMigrationInitializing} data={previewData} inventory={inventory} customers={customers} />}
            {importType === 'master' && previewData.length > 0 && <MedicineMasterImportPreviewModal isOpen={!!importType} onClose={() => { if (!isMigrationRunning && !isMigrationInitializing) { setImportType(null); setPreviewData([]); } }} onSave={(d: any) => void runManagedMigration('master', d, onBulkAddMedicines, 'Material master migration completed.')} isSaving={isMigrationRunning || isMigrationInitializing} data={previewData} />}
            {importType === 'nomenclature' && previewData.length > 0 && <MappingImportPreviewModal isOpen={!!importType} onClose={() => { if (!isMigrationRunning && !isMigrationInitializing) { setImportType(null); setPreviewData([]); } }} onSave={(d: any) => void runManagedMigration('nomenclature', d, onBulkAddMappings, 'Vendor sync migration completed.')} isSaving={isMigrationRunning || isMigrationInitializing} data={previewData} distributors={distributors} medicines={medicines} mappings={mappings} />}
            {(isMigrationRunning || migrationStatus !== 'Processing…') && migrationStats.totalRows > 0 && !isMigrationPopupMinimized && (
                <div className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-4">
                    <div className="w-full max-w-2xl bg-white border-2 border-primary shadow-2xl">
                        <div className="px-4 py-3 bg-primary text-white text-xs font-black uppercase tracking-widest">Migration Progress - {migrationModule}</div>
                        <div className="p-4 space-y-4">
                            {migrationStats.processed === 0 && isMigrationRunning ? (
                                <div className="text-[11px] font-black uppercase text-yellow-700 animate-pulse">Initializing migration…</div>
                            ) : (
                                <p className="text-[11px] font-black uppercase text-yellow-700">Migration in progress. Please wait or cancel.</p>
                            )}
                            <div className="w-full h-4 border border-gray-300 bg-gray-100">
                                <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.round((migrationStats.processed / Math.max(migrationStats.totalRows, 1)) * 100))}%` }} />
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px] font-bold uppercase">
                                <div>Total Rows: {migrationStats.totalRows}</div>
                                <div>Processed: {migrationStats.processed}</div>
                                <div>Imported: {migrationStats.imported}</div>
                                <div>Updated: {migrationStats.updated}</div>
                                <div>Skipped: {migrationStats.skipped}</div>
                                <div>Failed: {migrationStats.failed}</div>
                            </div>
                            <div className="text-[11px] font-black uppercase">Status: {migrationStatus}</div>
                            <div className="flex justify-end gap-2">
                                {isMigrationRunning && (
                                    <button
                                        onClick={() => setIsMigrationPopupMinimized(true)}
                                        className="px-4 py-2 border text-[10px] font-black uppercase"
                                    >
                                        Minimize / Hide
                                    </button>
                                )}
                                {isMigrationRunning && (
                                    <button
                                        onClick={() => {
                                            if (!window.confirm('Cancel migration?')) return;
                                            cancelMigrationRef.current = true;
                                            setMigrationStatus('Cancelled');
                                        }}
                                        className="px-4 py-2 bg-red-600 text-white text-[10px] font-black uppercase"
                                    >
                                        Cancel Migration
                                    </button>
                                )}
                                {!isMigrationRunning && (
                                    <button
                                        onClick={() => {
                                            setMigrationStats({ totalRows: 0, processed: 0, imported: 0, updated: 0, skipped: 0, failed: 0 });
                                            setMigrationStatus('Processing…');
                                            setIsMigrationPopupMinimized(false);
                                            onMigrationLockChange?.(false);
                                        }}
                                        className="px-4 py-2 border text-[10px] font-black uppercase"
                                    >
                                        Close Summary
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ConfigurationPage;
