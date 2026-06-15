import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import AddMedicineModal from '@modules/inventory/components/AddMedicineModal';
import EditMedicineModal from '@modules/inventory/components/EditMedicineModal';
import { isDateInActiveFiscalYear, resolveFiscalYearConfig } from '@core/utils/fiscalYear';
import { AddSupplierModal } from '@modules/suppliers/components/AddSupplierModal';
import { extractPurchaseDetailsFromBill } from '@core/services/geminiService';
import type { Purchase, InventoryItem, Supplier, PurchaseItem, ModuleConfig, RegisteredPharmacy, PurchaseOrder, PurchaseOrderItem, SupplierProductMap, Medicine, AppConfigurations, FileInput, Transaction, LineAmountCalculationMode } from '@core/types';
import { handleEnterToNextField } from '@core/utils/navigation';
import WebcamCaptureModal from '@modules/inventory/components/WebcamCaptureModal';
import MobileSyncModal from '@modules/suppliers/components/MobileSyncModal';
import LinkToMasterModal from '@modules/inventory/components/LinkToMasterModal';
import { fuzzyMatch } from '@core/utils/search';
import { fetchPendingMobileBills, fetchSupplierProductMaps, fetchTransactions, generateUUID, getLatestSyncMessage, getOrCreateMobileDeviceId, listenForSyncMessage, markMobileBillImported, reserveVoucherNumber, saveData } from '@core/services/storageService';
import { parseNumber, normalizeImportDate, getOutstandingBalance } from '@core/utils/helpers';
import { resolveUnitsPerStrip, extractPackMultiplier } from '@core/utils/pack';
import SupplierLedgerModal from '@modules/suppliers/components/SupplierLedgerModal';
import SupplierSearchModal from '@modules/suppliers/components/SupplierSearchModal';
import type { SupplierQuickResult } from '@core/services/supplierService';
import JournalEntryViewerModal from '@modules/accounting/components/JournalEntryViewerModal';
import ProductInsightsPanel from '@modules/inventory/components/ProductInsightsPanel';
import { generateNewInvoiceId } from '@core/utils/invoice';
import { parseNetworkAndApiError } from '@core/utils/error';
import { prepareCapturedImageForAiExtraction, prepareFilesForAiExtraction } from '@core/utils/aiImagePrep';
import { getInventoryPolicy, getResolvedMedicinePolicy } from '@core/utils/materialType';
const UploadIcon = (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>;
const CameraIcon = (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="4" /></svg>;
const SmartphoneIcon = (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" ry="18" x2="12.01" y2="18" /></svg>;

const Spinner = () => (
    <svg className="animate-spin h-4 w-4 text-current" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
);

const uniformTextStyle = "text-2xl font-normal tracking-tight uppercase leading-tight";
const matrixRowTextStyle = "text-2xl font-normal tracking-tight uppercase leading-tight";
const EXPIRY_MM_YY_REGEX = /^(0[1-9]|1[0-2])\/\d{2}$/;
const currencyFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

const formatCurrency = (value: number) => currencyFormatter.format(Number.isFinite(value) ? value : 0);

const formatSignedCurrency = (value: number, sign: '+' | '-') => {
    const normalizedValue = Math.abs(Number.isFinite(value) ? value : 0);
    return `${sign}${formatCurrency(normalizedValue)}`;
};

const formatRoundOffCurrency = (value: number) => {
    if (!Number.isFinite(value) || value === 0) return formatCurrency(0);
    return `${value > 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
};

const formatExpiryToMMYY = (value?: string | null): string => {
    if (!value || String(value).toUpperCase() === 'N/A') return '';
    const clean = String(value).trim();
    const slashMatch = clean.match(/^(\d{1,2})[/-](\d{2}|\d{4})$/);
    if (slashMatch) {
        const month = Number(slashMatch[1]);
        if (month < 1 || month > 12) return '';
        const yearPart = slashMatch[2].slice(-2);
        return `${String(month).padStart(2, '0')}/${yearPart}`;
    }

    const dateLike = clean.split('T')[0].match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
    if (dateLike) {
        const month = Number(dateLike[2]);
        if (month < 1 || month > 12) return '';
        return `${String(month).padStart(2, '0')}/${dateLike[1].slice(-2)}`;
    }

    return EXPIRY_MM_YY_REGEX.test(clean) ? clean : '';
};

const normalizeExpiryInput = (rawValue: string): string => {
    const digits = rawValue.replace(/\D/g, '').slice(0, 4);
    if (digits.length <= 2) {
        if (digits.length === 2 && parseInt(digits) > 12) return digits[0];
        return digits;
    }
    const month = digits.slice(0, 2);
    if (parseInt(month) > 12) return month[0];
    return `${month}/${digits.slice(2)}`;
};

const normalizeSupplierKey = (value: string): string => (
    (value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
);

const normalizeItemKey = (value?: string | null): string => (
    String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
);

const createBlankItem = (): PurchaseItem => ({
    id: crypto.randomUUID(),
    name: '',
    brand: '',
    manufacturer: '',
    category: 'General',
    batch: '',
    expiry: '',
    quantity: 0,
    looseQuantity: 0,
    freeQuantity: 0,
    purchasePrice: 0,
    mrp: 0,
    gstPercent: 0,
    hsnCode: '',
    discountPercent: 0,
    schemeDiscountPercent: 0,
    schemeDiscountAmount: 0,
    matchStatus: 'pending',
    packType: '',
    unitsPerPack: 1
});

type MobileSyncStatus = 'pending' | 'syncing' | 'uploading' | 'synced' | 'imported' | 'failed';
type ImportWorkflowStage = 'idle' | 'importing' | 'validating-items' | 'opening-reconciliation';

interface PurchaseVoucherDraftState {
    supplier: string;
    supplierGst: string;
    invoiceNumber: string;
    date: string;
    items: PurchaseItem[];
}

interface MobileSyncPage {
    image: string;
    mimeType: string;
    pageNumber: number;
    capturedAt?: string;
}

interface MobileSyncInvoicePayload {
    type?: 'invoice-upload';
    invoiceId?: string;
    billId?: string;
    pages?: MobileSyncPage[];
    image?: string;
    mimeType?: string;
    metadata?: {
        organizationId?: string;
        userId?: string;
        deviceId?: string;
        sessionId?: string;
    };
}

type PurchaseLookupCandidate = Partial<Purchase> & {
    serial_id?: string;
    supplier_bill_id?: string;
    supplierBillId?: string;
};


const MOBILE_SYNC_DEVICE_ID_KEY = 'mdxera_mobile_sync_device_id';

const getOrCreateMobileSyncDeviceId = (): string => {
    if (typeof window === 'undefined') return crypto.randomUUID();
    const existing = window.localStorage.getItem(MOBILE_SYNC_DEVICE_ID_KEY);
    if (existing && existing.trim().length > 0) return existing;
    const next = crypto.randomUUID();
    window.localStorage.setItem(MOBILE_SYNC_DEVICE_ID_KEY, next);
    return next;
};

const getSyncStatusLabel = (status: MobileSyncStatus) => {
    switch (status) {
        case 'pending': return 'Pending';
        case 'syncing': return 'Syncing…';
        case 'uploading': return 'Uploading';
        case 'synced': return 'Synced';
        case 'imported': return 'Imported Successfully';
        case 'failed': return 'Failed';
    }
};

const resolvePurchaseLineAmountMode = (configurations?: AppConfigurations): LineAmountCalculationMode => (
    configurations?.displayOptions?.purchaseLineAmountCalculationMode || 'excluding_discount'
);

const calculatePurchaseLineBaseAmount = (item: PurchaseItem, mode: LineAmountCalculationMode): number => {
    const gross = (item.purchasePrice || 0) * (item.quantity || 0);
    if (mode === 'excluding_discount') return gross;
    const tradeDisc = gross * ((item.discountPercent || 0) / 100);
    const afterTrade = gross - tradeDisc;
    const schemeDiscPercentAmount = afterTrade * ((item.schemeDiscountPercent || 0) / 100);
    const schemeDisc = item.schemeDiscountAmount > 0 ? item.schemeDiscountAmount : schemeDiscPercentAmount;
    return Math.max(0, afterTrade - schemeDisc);
};

interface PurchaseFormProps {
    onAddPurchase: (purchase: any, supplierGst: string, nextCounter?: number) => Promise<void>;
    onUpdatePurchase: (purchase: Purchase, supplierGst?: string) => Promise<void>;
    inventory: InventoryItem[];
    suppliers: Supplier[];
    medicines?: Medicine[];
    mappings: SupplierProductMap[];
    purchases: Purchase[];
    sourcePO?: PurchaseOrder | null;
    purchaseToEdit: Purchase | null;
    draftItems: PurchaseOrderItem[] | null;
    draftSupplier?: string;
    draftInvoiceNumber?: string;
    draftDate?: string;
    draftSourceId?: string;
    linkedChallans?: string[];
    onClearDraft: () => void;
    currentUser: RegisteredPharmacy | null;
    onAddInventoryItem?: (item: Omit<InventoryItem, 'id'>) => Promise<InventoryItem>;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    onUpdateMedicineMaster?: (updatedMedicine: Medicine) => Promise<void>;
    onAddsupplier: (data: Omit<Supplier, 'id' | 'ledger' | 'organization_id'>, balance: number, date: string) => Promise<SupplierQuickResult>;
    onAddInventoryItemDirectly?: (item: Omit<InventoryItem, 'id'>) => Promise<InventoryItem>;
    onSaveMapping: (map: Partial<SupplierProductMap>) => Promise<void>;
    setIsDirty: (isDirty: boolean) => void;
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    title: string;
    className?: string;
    configurations: AppConfigurations;
    isReadOnly?: boolean;
    isManualEntry?: boolean;
    isChallan?: boolean;
    disableAIInput?: boolean;
    mobileSyncSessionId: string | null;
    setMobileSyncSessionId: (id: string | null) => void;
    config?: ModuleConfig;
    onCancel?: () => void;
    onPrint?: (purchase: Purchase) => void;
    organizationId: string;
}

const PurchaseForm = forwardRef<any, PurchaseFormProps>(({
    onAddPurchase, onUpdatePurchase, inventory, suppliers, medicines = [], mappings = [], purchases, purchaseToEdit, draftItems, draftSupplier, draftInvoiceNumber, draftDate, draftSourceId, onClearDraft, currentUser, onAddMedicineMaster, onUpdateMedicineMaster, onAddsupplier, onSaveMapping, onCancel, onPrint, title, className, configurations, addNotification, isReadOnly = false,
    isManualEntry = false, isChallan = false, disableAIInput = false, mobileSyncSessionId, setMobileSyncSessionId,
    organizationId, config,
}, ref) => {
    const isEditing = !!purchaseToEdit;
    const purchaseFields = useMemo(() => {
        if (config?.fields) return config.fields;
        return configurations.modules?.purchase?.fields;
    }, [config?.fields, configurations.modules]);

    const readPurchaseFieldVisibility = useCallback((fieldIds: string[], defaultVisible = true) => {
        if (!purchaseFields) return defaultVisible;
        for (const fieldId of fieldIds) {
            const value = purchaseFields[fieldId];
            if (typeof value !== 'undefined') return value !== false;
        }
        return defaultVisible;
    }, [purchaseFields]);

    const isFieldVisible = useCallback((fieldId: string) => {
        const purchaseFieldAliases: Record<string, string[]> = {
            colPQty: ['colPQty', 'col_p_qty'],
            colLQty: ['colLQty', 'col_l_qty'],
            colQty: ['colQty', 'col_qty'],
        };

        const aliasedFields = purchaseFieldAliases[fieldId] || [fieldId];
        const hasExplicitValue = aliasedFields.some(alias => typeof purchaseFields?.[alias] !== 'undefined');
        if (hasExplicitValue) return readPurchaseFieldVisibility(aliasedFields, true);

        if (fieldId === 'colPQty' || fieldId === 'colLQty') {
            return readPurchaseFieldVisibility(['colQty', 'col_qty'], true);
        }

        return readPurchaseFieldVisibility(aliasedFields, true);
    }, [purchaseFields, readPurchaseFieldVisibility]);

    const showPackQty = isFieldVisible('colPQty');
    const showLooseQty = isFieldVisible('colLQty');

    useEffect(() => {
        console.log('purchase field config', configurations?.modules?.purchase?.fields);
        console.log('col_p_qty', configurations?.modules?.purchase?.fields?.col_p_qty);
        console.log('col_l_qty', configurations?.modules?.purchase?.fields?.col_l_qty);
    }, [configurations?.modules?.purchase?.fields]);

    // Standard State
    const [supplier, setSupplier] = useState('');
    const [supplierGst, setSupplierGst] = useState('');
    const [invoiceNumber, setInvoiceNumber] = useState('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [items, setItems] = useState<PurchaseItem[]>([createBlankItem()]);
    const [activeRowId, setActiveRowId] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const isSubmittingRef = useRef(false);
    const [isUploading, setIsUploading] = useState(false);
    const [importWorkflowStage, setImportWorkflowStage] = useState<ImportWorkflowStage>('idle');
    const [importWorkflowError, setImportWorkflowError] = useState<string | null>(null);
    const [lastImportedFingerprint, setLastImportedFingerprint] = useState<string | null>(null);
    const [hasAutoOpenedReconciliation, setHasAutoOpenedReconciliation] = useState(false);
    const [pendingReconciliationItems, setPendingReconciliationItems] = useState<PurchaseItem[] | null>(null);
    const [voucherDraftCreated, setVoucherDraftCreated] = useState(false);
    const [lockImportUIReset, setLockImportUIReset] = useState(false);
    const [purchaseVoucherDraft, setPurchaseVoucherDraft] = useState<PurchaseVoucherDraftState | null>(null);
    const [previewVoucherNumber, setPreviewVoucherNumber] = useState<string>('');

    useEffect(() => {
        if (!isEditing && currentUser) {
            reserveVoucherNumber(isChallan ? 'delivery-challan' : 'purchase-entry', currentUser, true)
                .then(res => setPreviewVoucherNumber(res.documentNumber))
                .catch(err => console.error('Error fetching preview number:', err));
        }
    }, [isEditing, currentUser, isChallan]);

    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(isChallan);
    useEffect(() => {
        setIsSidebarCollapsed(isChallan);
    }, [isChallan]);

    // Matrix Props
    const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
    const [isInsightsOpen, setIsInsightsOpen] = useState(false);
    const [isKeywordFocused, setIsKeywordFocused] = useState(false);
    const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
    const purchaseLineAmountMode = useMemo(() => resolvePurchaseLineAmountMode(configurations), [configurations]);
    const [modalSearchTerm, setModalSearchTerm] = useState('');
    const [salesHistory, setSalesHistory] = useState<Transaction[]>([]);
    const [isInsightsLoading, setIsInsightsLoading] = useState(false);

    // Modal States
    const [isWebcamModalOpen, setIsWebcamModalOpen] = useState(false);
    const [isAddSupplierModalOpen, setIsAddSupplierModalOpen] = useState(false);
    const [isAddMedicineMasterModalOpen, setIsAddMedicineMasterModalOpen] = useState(false);
    const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
    const [isSupplierDropdownOpen, setIsSupplierDropdownOpen] = useState(false);
    const [selectedSupplierIndex, setSelectedSupplierIndex] = useState(0);
    const [isSupplierLedgerModalOpen, setIsSupplierLedgerModalOpen] = useState(false);
    const [supplierForLedger, setSupplierForLedger] = useState<Supplier | null>(null);
    const [supplierNameError, setSupplierNameError] = useState<string | null>(null);
    const [invoiceNumberError, setInvoiceNumberError] = useState<string | null>(null);
    const [isSupplierSearchModalOpen, setIsSupplierSearchModalOpen] = useState(false);
    const [isRateTierModalOpen, setIsRateTierModalOpen] = useState(false);
    const [activeRateTierRowId, setActiveRateTierRowId] = useState<string | null>(null);
    const [isEditMaterialModalOpen, setIsEditMaterialModalOpen] = useState(false);
    const [materialToEdit, setMaterialToEdit] = useState<Medicine | null>(null);
    const [materialEditRowId, setMaterialEditRowId] = useState<string | null>(null);

    useEffect(() => {
        setSelectedSearchIndex(0);
    }, [modalSearchTerm]);

    useEffect(() => {
        if (isSearchModalOpen && searchResultsRef.current) {
            const timer = setTimeout(() => {
                const selectedRow = searchResultsRef.current?.querySelector(`[data-index="${selectedSearchIndex}"]`);
                if (selectedRow) {
                    selectedRow.scrollIntoView({
                        block: 'nearest',
                        behavior: 'auto'
                    });
                }
            }, 0);
            return () => clearTimeout(timer);
        }
    }, [selectedSearchIndex, isSearchModalOpen]);

    const [rateTierDraft, setRateTierDraft] = useState({ rateA: '', rateB: '', rateC: '' });
    const [rateTierHandledRows, setRateTierHandledRows] = useState<Set<string>>(new Set());
    const [selectedRateTierAction, setSelectedRateTierAction] = useState<'skip' | 'save'>('save');
    const [mobileSyncStatus, setMobileSyncStatus] = useState<MobileSyncStatus>('pending');
    const [mobileSyncError, setMobileSyncError] = useState<string | null>(null);
    const [isMobileSyncing, setIsMobileSyncing] = useState(false);
    const [mobileInvoiceId, setMobileInvoiceId] = useState<string | null>(null);
    const [mobilePageCount, setMobilePageCount] = useState(0);
    const [mobileSyncDeviceId] = useState<string>(() => getOrCreateMobileSyncDeviceId());
    const [supplierQuickCreatePrefill, setSupplierQuickCreatePrefill] = useState<Partial<Supplier> | undefined>(undefined);
    const [isJournalModalOpen, setIsJournalModalOpen] = useState(false);
    const [selectedHistoryPurchaseId, setSelectedHistoryPurchaseId] = useState<string | null>(null);
    const [historyPreviewPurchase, setHistoryPreviewPurchase] = useState<Purchase | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const supplierNameInputRef = useRef<HTMLInputElement>(null);
    const invoiceNumberInputRef = useRef<HTMLInputElement>(null);
    const dateInputRef = useRef<HTMLInputElement>(null);
    const voucherGridRef = useRef<HTMLDivElement>(null);
    const modalSearchInputRef = useRef<HTMLInputElement>(null);
    const searchResultsRef = useRef<HTMLDivElement>(null);
    const lastSourceRef = useRef<string | null>(null);
    const rateAInputRef = useRef<HTMLInputElement>(null);
    const rateBInputRef = useRef<HTMLInputElement>(null);
    const rateCInputRef = useRef<HTMLInputElement>(null);
    const skipRateButtonRef = useRef<HTMLButtonElement>(null);
    const saveRateButtonRef = useRef<HTMLButtonElement>(null);

    const unresolvedReconciliationCount = useMemo(
        () => (pendingReconciliationItems || []).filter(item => item.matchStatus !== 'matched').length,
        [pendingReconciliationItems],
    );
    const reconciliationModalVisible = unresolvedReconciliationCount > 0;
    const voucherScreenOpen = voucherDraftCreated;

    const commitVoucherDraftAndOpen = useCallback((nextItems: PurchaseItem[]) => {
        const normalizedItems = [...nextItems, createBlankItem()];
        const draftState: PurchaseVoucherDraftState = {
            supplier: supplier,
            supplierGst,
            invoiceNumber,
            date,
            items: normalizedItems,
        };


        setItems(normalizedItems);
        setPurchaseVoucherDraft(draftState);
        setPendingReconciliationItems(null);
        setRateTierHandledRows(new Set());
        setIsLinkModalOpen(false);
        setVoucherDraftCreated(true);
        setLockImportUIReset(true);
    }, [supplier, supplierGst, invoiceNumber, date]);

    const getImportWorkflowLabel = useCallback((stage: ImportWorkflowStage) => {
        switch (stage) {
            case 'importing':
                return 'Importing…';
            case 'validating-items':
                return 'Validating Items…';
            case 'opening-reconciliation':
                return 'Opening Reconciliation…';
            default:
                return '';
        }
    }, []);

    const buildBillFingerprint = useCallback((bill: any, extractedItemCount: number) => {
        const normalizedSupplier = normalizeSupplierKey(String(bill?.supplier || ''));
        const normalizedInvoice = String(bill?.invoiceNumber || '').trim().toLowerCase();
        const normalizedDate = normalizeImportDate(String(bill?.date || '')) || '';
        return `${normalizedSupplier}|${normalizedInvoice}|${normalizedDate}|${extractedItemCount}`;
    }, []);

    const normalizeReconciliationError = useCallback((error: unknown) => {
        const baseMessage = parseNetworkAndApiError(error);
        const normalized = String(baseMessage || '').toLowerCase();
        if (normalized.includes('permission') || normalized.includes('rls') || normalized.includes('policy')) {
            return 'Permission/RLS denied for bill_items';
        }
        return `API error: ${baseMessage}`;
    }, []);

    const resetFormForNewEntry = useCallback(() => {
        setSupplier('');
        setSupplierGst('');
        setInvoiceNumber('');
        setDate(new Date().toISOString().split('T')[0]);
        setItems([createBlankItem()]);
        setPendingReconciliationItems(null);
        setPurchaseVoucherDraft(null);
        setVoucherDraftCreated(false);
        setLockImportUIReset(false);
        setRateTierHandledRows(new Set());
        setSupplierNameError(null);
        setInvoiceNumberError(null);
    }, []);

    const currentsupplier = useMemo(() => {
        const supplierKey = normalizeSupplierKey(supplier);
        if (!supplierKey) return null;

        const exact = suppliers.find(d => normalizeSupplierKey(d.name || '') === supplierKey);
        if (exact) return exact;

        return suppliers.find(d => fuzzyMatch(normalizeSupplierKey(d.name || ''), supplierKey)) || null;
    }, [suppliers, supplier]);

    const stats = useMemo(() => {
        const today = new Date().toISOString().slice(0, 10);
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        const startOfMonthStr = startOfMonth.toISOString().slice(0, 10);

        let filtered = purchases.filter(p => p.status !== 'cancelled');
        if (currentsupplier?.name) {
            filtered = filtered.filter(p => normalizeSupplierKey(p.supplier || '') === normalizeSupplierKey(currentsupplier.name));
        }

        const monthData = filtered.filter(p => p.date >= startOfMonthStr);
        const monthTotal = monthData.reduce((sum, p) => sum + (Number(p.totalAmount) || 0), 0);
        const todayTotal = filtered.filter(p => p.date === today).reduce((sum, p) => sum + (Number(p.totalAmount) || 0), 0);

        return {
            monthTotal,
            todayTotal,
            monthCount: monthData.length
        };
    }, [purchases, currentsupplier]);

    const historyItems = useMemo(() => {
        let filtered = [...purchases];
        if (currentsupplier?.name) {
            filtered = filtered.filter(p => normalizeSupplierKey(p.supplier || '') === normalizeSupplierKey(currentsupplier.name));
        }
        return filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 20);
    }, [purchases, currentsupplier]);

    const getPurchaseLookupKeys = useCallback((purchase: PurchaseLookupCandidate): string[] => {
        const keys = [
            String(purchase.id || ''),
            String(purchase.purchaseSerialId || ''),
            String(purchase.invoiceNumber || ''),
            String(purchase.serial_id || ''),
            String(purchase.supplier_bill_id || ''),
            String(purchase.supplierBillId || ''),
        ];
        return keys.map(key => key.trim()).filter(Boolean);
    }, []);

    const resolvePurchaseForPreview = useCallback((purchase: Purchase): Purchase | null => {
        const scopedPurchases = purchases.filter(entry => entry.organization_id === organizationId);
        const lookupKeys = new Set(getPurchaseLookupKeys(purchase));
        return scopedPurchases.find(entry => {
            const entryKeys = getPurchaseLookupKeys(entry);
            return entryKeys.some(key => lookupKeys.has(key));
        }) || null;
    }, [getPurchaseLookupKeys, organizationId, purchases]);

    const handleHistoryPurchasePreview = useCallback((purchase: Purchase) => {
        if (isReadOnly) return;
        setSelectedHistoryPurchaseId(purchase.id);
        const matchedPurchase = resolvePurchaseForPreview(purchase);
        if (!matchedPurchase) {
            addNotification('Purchase record not found', 'warning');
            return;
        }
        setHistoryPreviewPurchase(matchedPurchase);
    }, [addNotification, isReadOnly, resolvePurchaseForPreview]);

    const canOpenJournalEntry = Boolean(purchaseToEdit?.id);
    const isPostedVoucher = (purchaseToEdit?.status || '') === 'completed';
    const supplierPhoneDisplay = currentsupplier?.mobile || currentsupplier?.phone || '';
    const supplierPurchaseHistory = useMemo(() => {
        if (!supplier.trim()) return [];
        return purchases
            .filter(p => normalizeSupplierKey(p.supplier || '') === normalizeSupplierKey(supplier))
            .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    }, [purchases, supplier]);
    const lastPurchaseDate = supplierPurchaseHistory[0]?.date || '-';
    const lastPaymentDate = currentsupplier?.ledger
        ?.filter(entry => Number(entry.credit || 0) > 0 || Number(entry.debit || 0) > 0)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))?.[0]?.date || '-';


    const reconciliationSupplier = useMemo<Supplier | null>(() => {
        if (currentsupplier) return currentsupplier;
        if (!supplier.trim()) return null;
        return {
            id: 'temp',
            organization_id: organizationId,
            name: supplier.trim(),
            gst_number: supplierGst,
            pan_number: '',
            ledger: [],
            payment_details: {},
            is_active: true,
        } as Supplier;
    }, [currentsupplier, supplier, organizationId, supplierGst]);

    const findSupplierByName = useCallback((name?: string | null): Supplier | null => {
        const supplierKey = normalizeSupplierKey(name || '');
        if (!supplierKey) return null;

        const exact = suppliers.find(d => normalizeSupplierKey(d.name || '') === supplierKey);
        if (exact) return exact;

        return suppliers.find(d => fuzzyMatch(normalizeSupplierKey(d.name || ''), supplierKey)) || null;
    }, [suppliers]);


    const normalizeAlphaNum = useCallback((value?: string | null): string => (
        String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    ), []);

    const scoreSupplierAuxMatch = useCallback((candidate: Supplier, phone?: string, address?: string): number => {
        let score = 0;
        const normalizedPhone = String(phone || '').replace(/\D/g, '');
        const candidatePhones = [candidate.mobile, candidate.phone].map(v => String(v || '').replace(/\D/g, ''));
        if (normalizedPhone && candidatePhones.some(cp => cp && (cp.endsWith(normalizedPhone.slice(-10)) || normalizedPhone.endsWith(cp.slice(-10))))) {
            score += 2;
        }

        const normalizedAddress = normalizeSupplierKey(address || '');
        const candidateAddress = normalizeSupplierKey([candidate.address, candidate.address_line2, candidate.area].filter(Boolean).join(' '));
        if (normalizedAddress && candidateAddress && (candidateAddress.includes(normalizedAddress) || normalizedAddress.includes(candidateAddress) || fuzzyMatch(candidateAddress, normalizedAddress))) {
            score += 1;
        }

        return score;
    }, []);

    const matchSupplierFromExtractedData = useCallback((bill: {
        supplier?: string;
        supplierGstNumber?: string;
        supplierPanNumber?: string;
        supplierPhone?: string;
        supplierAddress?: string;
    }): { supplier: Supplier | null; reason: 'gst' | 'pan' | 'name' | 'none' } => {
        const gst = normalizeAlphaNum(bill.supplierGstNumber);
        if (gst) {
            const gstMatch = suppliers.find(s => normalizeAlphaNum(s.gst_number) === gst);
            if (gstMatch) return { supplier: gstMatch, reason: 'gst' };
        }

        const pan = normalizeAlphaNum(bill.supplierPanNumber || (gst.length >= 12 ? gst.slice(2, 12) : ''));
        if (pan) {
            const panMatch = suppliers.find(s => normalizeAlphaNum(s.pan_number) === pan);
            if (panMatch) return { supplier: panMatch, reason: 'pan' };
        }

        const supplierName = normalizeSupplierKey(bill.supplier || '');
        if (!supplierName) return { supplier: null, reason: 'none' };

        const ranked = suppliers
            .map(candidate => {
                const candidateName = normalizeSupplierKey(candidate.name || '');
                const nameMatched = candidateName === supplierName || fuzzyMatch(candidateName, supplierName) || fuzzyMatch(supplierName, candidateName);
                if (!nameMatched) return null;
                return {
                    candidate,
                    score: scoreSupplierAuxMatch(candidate, bill.supplierPhone, bill.supplierAddress),
                    exactName: candidateName === supplierName,
                };
            })
            .filter(Boolean) as { candidate: Supplier; score: number; exactName: boolean }[];

        if (ranked.length === 0) return { supplier: null, reason: 'none' };

        ranked.sort((a, b) => {
            if (a.exactName !== b.exactName) return a.exactName ? -1 : 1;
            return b.score - a.score;
        });

        return { supplier: ranked[0].candidate, reason: 'name' };
    }, [normalizeAlphaNum, suppliers, scoreSupplierAuxMatch]);

    const attemptAutoLink = useCallback((itemList: PurchaseItem[], targetsupplier: Supplier | null) => {
        if (!medicines.length) return itemList;

        return itemList.map(item => {
            const resolveManufacturer = (primary?: string, fallback?: string): string => (
                String(primary || fallback || '').trim()
            );

            if (item.inventoryItemId) {
                const linkedMedicine = medicines.find(m => m.id === item.inventoryItemId);
                if (!linkedMedicine) return item;
                return {
                    ...item,
                    manufacturer: resolveManufacturer(linkedMedicine.manufacturer, item.manufacturer),
                    brand: linkedMedicine.brand || item.brand,
                    hsnCode: linkedMedicine.hsnCode || item.hsnCode,
                    gstPercent: linkedMedicine.gstRate || item.gstPercent,
                    mrp: Number(linkedMedicine.mrp || item.mrp)
                };
            }

            const normalizedItemName = normalizeItemKey(item.name);
            const itemBarcode = String((item as any).barcode || '').trim();
            const itemCode = normalizeItemKey((item as any).itemCode || (item as any).materialCode || (item as any).code || '');
            const itemHsn = String(item.hsnCode || '').trim().toLowerCase();

            const applyMatch = (foundMed: Medicine): PurchaseItem => ({
                ...item,
                inventoryItemId: foundMed.id,
                materialCode: foundMed.materialCode,
                matchStatus: 'matched' as const,
                hsnCode: foundMed.hsnCode || item.hsnCode,
                gstPercent: foundMed.gstRate || item.gstPercent,
                manufacturer: resolveManufacturer(foundMed.manufacturer, item.manufacturer),
                brand: foundMed.brand || item.brand,
                mrp: Number(foundMed.mrp || item.mrp),
                discountPercent: Number(foundMed.productDiscount ?? item.discountPercent ?? 0)
            });

            if (targetsupplier) {
                const mapping = mappings.find(m =>
                    m.supplier_id === targetsupplier.id &&
                    normalizeItemKey(m.supplier_product_name) === normalizedItemName
                );
                if (mapping) {
                    const foundMed = medicines.find(m => m.id === mapping.master_medicine_id);
                    if (foundMed) {
                        return applyMatch(foundMed);
                    }
                }
            }

            const directMatch = medicines.find(m => normalizeItemKey(m.name) === normalizedItemName);
            if (directMatch) {
                return applyMatch(directMatch);
            }

            const barcodeMatch = medicines.find(m => itemBarcode && String(m.barcode || '').trim() === itemBarcode);
            if (barcodeMatch) {
                return applyMatch(barcodeMatch);
            }

            const materialCodeMatch = medicines.find(m => itemCode && normalizeItemKey(m.materialCode) === itemCode);
            if (materialCodeMatch) {
                return applyMatch(materialCodeMatch);
            }

            const hsnAndNameMatch = medicines.find(m => {
                const medHsn = String(m.hsnCode || '').trim().toLowerCase();
                return itemHsn && medHsn === itemHsn && normalizeItemKey(m.name) === normalizedItemName;
            });
            if (hsnAndNameMatch) {
                return applyMatch(hsnAndNameMatch);
            }

            const strongNameMatch = medicines.find(m => {
                const medName = normalizeItemKey(m.name);
                if (!normalizedItemName || !medName || normalizedItemName.length < 5) return false;
                return fuzzyMatch(medName, normalizedItemName) || fuzzyMatch(normalizedItemName, medName);
            });
            if (strongNameMatch) {
                return applyMatch(strongNameMatch);
            }

            return { ...item, matchStatus: 'unmatched' as const };
        });
    }, [medicines, mappings]);

    useEffect(() => {
        const sourceId = purchaseToEdit?.id || (draftSourceId ? `draft:${draftSourceId}` : (draftItems ? 'draft' : 'new'));

        if (!purchaseToEdit && !draftItems && lockImportUIReset && purchaseVoucherDraft) {
            setSupplier(purchaseVoucherDraft.supplier);
            setSupplierGst(purchaseVoucherDraft.supplierGst);
            setInvoiceNumber(purchaseVoucherDraft.invoiceNumber);
            setDate(purchaseVoucherDraft.date);
            setItems(purchaseVoucherDraft.items);
            setVoucherDraftCreated(true);
            return;
        }

        if (!purchaseToEdit && !draftItems && voucherScreenOpen) {
            return;
        }

        if (lastSourceRef.current === sourceId) return;
        lastSourceRef.current = sourceId;

        if (purchaseToEdit) {
            setSupplier(purchaseToEdit.supplier || '');
            setInvoiceNumber(purchaseToEdit.invoiceNumber || '');
            setDate(purchaseToEdit.date ? purchaseToEdit.date.split('T')[0] : new Date().toISOString().split('T')[0]);

            const matchedDist = suppliers.find(d => (d.name || '').toLowerCase().trim() === (purchaseToEdit.supplier || '').toLowerCase().trim());
            if (matchedDist) setSupplierGst(matchedDist.gst_number || '');
            else setSupplierGst('');

            const pItems = Array.isArray(purchaseToEdit.items) ? purchaseToEdit.items : [];
            const mappedItems = pItems.map(item => ({
                ...createBlankItem(),
                ...item,
                manufacturer: String(item.manufacturer || '').trim(),
                expiry: formatExpiryToMMYY(String(item.expiry || '')),
                quantity: Number(item.quantity || 0),
                looseQuantity: Number(item.looseQuantity || 0),
                freeQuantity: Number(item.freeQuantity || 0),
                purchasePrice: Number(item.purchasePrice || 0),
                mrp: Number(item.mrp || 0),
                gstPercent: Number(item.gstPercent || 0),
                discountPercent: Number(item.discountPercent || 0),
                schemeDiscountPercent: Number(item.schemeDiscountPercent || 0),
                schemeDiscountAmount: Number(item.schemeDiscountAmount || 0),
                lineBaseAmount: calculatePurchaseLineBaseAmount(item as PurchaseItem, purchaseLineAmountMode),
                matchStatus: (item.inventoryItemId) ? 'matched' as const : 'pending' as const
            }));

            const linked = attemptAutoLink(mappedItems as PurchaseItem[], matchedDist || null);
            setItems(linked.length > 0 ? [...linked, createBlankItem()] : [createBlankItem()]);
            setRateTierHandledRows(new Set());
        } else if (draftItems) {
            setSupplier(draftSupplier || '');
            setInvoiceNumber(draftInvoiceNumber || '');
            setDate(draftDate || new Date().toISOString().split('T')[0]);
            const matchedDist = suppliers.find(d => (d.name || '').toLowerCase().trim() === (draftSupplier || '').toLowerCase().trim());
            const newItems = Array.isArray(draftItems) ? draftItems.map(item => ({
                ...createBlankItem(), ...item, expiry: formatExpiryToMMYY(String(item.expiry || '')), quantity: item.quantity, freeQuantity: item.freeQuantity || 0, purchasePrice: item.purchasePrice, matchStatus: 'pending' as const
            })) : [];
            const linked = attemptAutoLink(newItems as PurchaseItem[], matchedDist || null);
            setItems([...linked, createBlankItem()]);
            setRateTierHandledRows(new Set());
        } else {
            resetFormForNewEntry();
            // Focus Date on new voucher
            setTimeout(() => dateInputRef.current?.focus(), 200);
        }
    }, [purchaseToEdit, draftItems, suppliers, draftSupplier, draftInvoiceNumber, draftDate, draftSourceId, attemptAutoLink, resetFormForNewEntry, lockImportUIReset, purchaseVoucherDraft, voucherScreenOpen, purchaseLineAmountMode]);

    const calculatedTotals = useMemo(() => {
        const billDiscount = 0;
        let subtotal = 0;
        let totalGst = 0;
        let grossAmount = 0;
        let totalItemDiscount = 0;
        let totalItemSchemeDiscount = 0;

        const validItems = items.filter(p => (p.name || '').trim() !== '');
        const itemsWithCalculations = validItems.map(p => {
            const gross = (p.purchasePrice || 0) * (p.quantity || 0);
            const tradeDisc = gross * ((p.discountPercent || 0) / 100);
            const afterTrade = gross - tradeDisc;
            const schemeDiscPercentAmount = afterTrade * ((p.schemeDiscountPercent || 0) / 100);
            const schemeDisc = p.schemeDiscountAmount > 0 ? p.schemeDiscountAmount : schemeDiscPercentAmount;
            const taxable = afterTrade - schemeDisc;
            const gst = taxable * ((p.gstPercent || 0) / 100);
            const total = taxable + gst;

            grossAmount += gross;
            subtotal += taxable;
            totalGst += gst;
            totalItemDiscount += tradeDisc;
            totalItemSchemeDiscount += schemeDisc;

            return {
                ...p,
                lineBaseAmount: calculatePurchaseLineBaseAmount(p, purchaseLineAmountMode),
                taxableValue: taxable,
                gstAmount: gst,
                itemGrossValue: gross,
                itemTradeDiscount: tradeDisc,
                itemSchemeDiscount: schemeDisc,
                lineTotal: total
            };
        });

        const preRoundTotal = subtotal + totalGst - billDiscount;
        const grandTotal = Math.round(preRoundTotal);
        const roundOff = Number((grandTotal - preRoundTotal).toFixed(2));

        return {
            itemsWithCalculations,
            grossAmount,
            subtotal,
            totalGst,
            billDiscount,
            preRoundTotal,
            roundOff,
            grandTotal,
            totalAmount: grandTotal,
            totalItemDiscount,
            totalItemSchemeDiscount
        };
    }, [items, purchaseLineAmountMode]);

    const hasDuplicateSupplierInvoice = useCallback(() => {
        const normalizedSupplier = supplier.toLowerCase().trim();
        const normalizedInvoice = invoiceNumber.toLowerCase().trim();
        if (!normalizedSupplier || !normalizedInvoice) return false;
        const inactiveStatuses = new Set(['cancelled', 'void', 'deleted']);

        const currentFy = (purchaseToEdit as any)?.fy;

        return purchases.some(p => {
            if (purchaseToEdit?.id && p.id === purchaseToEdit.id) return false;
            if ((p.organization_id || '').trim() !== (organizationId || '').trim()) return false;
            if (inactiveStatuses.has(String((p as any).status || 'completed').trim().toLowerCase())) return false;

            const sameSupplier = (p.supplier || '').toLowerCase().trim() === normalizedSupplier;
            const sameInvoice = (p.invoiceNumber || '').toLowerCase().trim() === normalizedInvoice;
            if (!sameSupplier || !sameInvoice) return false;

            const purchaseFy = (p as any).fy;
            if (currentFy && purchaseFy) return purchaseFy === currentFy;
            return true;
        });
    }, [supplier, invoiceNumber, purchaseToEdit, purchases, organizationId]);

    const handleSubmit = useCallback(async (forcedStatus?: 'completed' | 'hold' | 'draft') => {
        if (isSubmittingRef.current) return null;
        isSubmittingRef.current = true;
        setIsSubmitting(true);
        
        // Field Validations with Notifications
        if (!supplier.trim()) { 
            setSupplierNameError("Supplier name is required."); 
            addNotification("Please select or enter a Supplier name.", "warning");
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return null; 
        }
        if (!invoiceNumber.trim()) { 
            setInvoiceNumberError("Invoice number is required."); 
            addNotification("Supplier Invoice Number is required.", "warning");
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return null; 
        }
        
        if (hasDuplicateSupplierInvoice()) {
            const duplicateMessage = "Supplier Invoice Number already exists for this supplier. Duplicate entry not allowed.";
            setInvoiceNumberError(duplicateMessage);
            addNotification(duplicateMessage, "error");
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return null;
        }
        
        const activeItems = items.filter(p => (p.name || '').trim() !== '');
        if (activeItems.length === 0) { 
            addNotification("At least one item is required to save.", "error"); 
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return null; 
        }

        const invalidExpiryItem = activeItems.find(item => {
            const expiryValue = (item.expiry || '').trim();
            return expiryValue !== '' && !EXPIRY_MM_YY_REGEX.test(expiryValue);
        });
        if (invalidExpiryItem) {
            addNotification(`Invalid expiry for ${invalidExpiryItem.name}. Use MM/YY format (e.g., 01/25).`, "error");
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return null;
        }
        if (!isDateInActiveFiscalYear(date, configurations)) {
            addNotification('Selected date is outside the active fiscal year. Please select a valid date or change Fiscal Year Configuration.', 'error');
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return null;
        }
        const fyConfig = resolveFiscalYearConfig(configurations);
        if (fyConfig.lockPreviousFiscalYear && date < fyConfig.fiscalYearStartDate) {
            addNotification('Previous fiscal year is locked. Voucher modifications are not allowed for that year.', 'error');
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return null;
        }

        try {
            console.log('PurchaseForm: Starting submission...', { supplier, invoiceNumber, itemCount: activeItems.length, status: forcedStatus || 'completed' });
            let purchaseSerialId = purchaseToEdit?.purchaseSerialId;

            if (!purchaseToEdit && currentUser) {
                const reserved = await reserveVoucherNumber(isChallan ? 'delivery-challan' : 'purchase-entry', currentUser);
                purchaseSerialId = reserved.documentNumber;
            }

            const poSourceParts = (draftSourceId || '').split('|').map(part => part.trim());
            const poSourceNumber = poSourceParts.find(part => part.startsWith('po:'))?.replace(/^po:/, '');
            const poSourceId = poSourceParts.find(part => part.startsWith('poid:'))?.replace(/^poid:/, '');

            const payload = {
                purchaseSerialId: purchaseSerialId!,
                supplier: supplier,
                invoiceNumber: invoiceNumber.trim(),
                date,
                items: calculatedTotals.itemsWithCalculations.map(item => ({
                    ...item,
                    expiry: normalizeImportDate(item.expiry) || undefined
                })),
                subtotal: calculatedTotals.subtotal,
                totalGst: calculatedTotals.totalGst,
                totalAmount: calculatedTotals.totalAmount,
                totalItemDiscount: calculatedTotals.totalItemDiscount,
                totalItemSchemeDiscount: calculatedTotals.totalItemSchemeDiscount,
                status: forcedStatus || 'completed',
                organization_id: organizationId,
                roundOff: calculatedTotals.roundOff,
                schemeDiscount: 0,
                referenceDocNumber: poSourceNumber || undefined,
                sourcePurchaseOrderId: poSourceId || undefined,
                sourceReceiveMode: poSourceNumber || poSourceId ? 'POST_RECEIVED_ENTRY' : undefined
            };

            let saved: any;
            if (purchaseToEdit) {
                saved = await onUpdatePurchase({ ...purchaseToEdit, ...payload } as any, supplierGst);
            } else {
                saved = await onAddPurchase(payload, supplierGst);
            }
            
            console.log('PurchaseForm: Save successful', saved);
            onClearDraft();
            resetFormForNewEntry();
            return saved;
        } catch (e: any) {
            console.error('PurchaseForm: Save failed', e);
            addNotification(`Save Failed: ${parseNetworkAndApiError(e)}`, "error");
            return null;
        } finally {
            isSubmittingRef.current = false;
            setIsSubmitting(false);
        }
    }, [supplier, invoiceNumber, hasDuplicateSupplierInvoice, items, calculatedTotals, purchaseToEdit, currentUser, date, organizationId, onUpdatePurchase, supplierGst, onAddPurchase, onClearDraft, resetFormForNewEntry, addNotification]);

    const triggerSaveAction = useCallback(async (forcedStatus?: 'completed' | 'hold' | 'draft') => {
        const saved = await handleSubmit(forcedStatus);
        // handleSubmit returns null on any validation error or save failure.
        // On success it returns the saved object or undefined (when onAddPurchase is typed void).
        // Use `!== null` so navigation fires correctly even when the handler returns void/undefined.
        if (saved !== null && onCancel) {
            onCancel();
        }
        return saved;
    }, [handleSubmit, onCancel]);

    const handleDiscard = useCallback(() => {
        resetFormForNewEntry();
        onClearDraft();
        if (onCancel) onCancel();
    }, [onCancel, onClearDraft, resetFormForNewEntry]);

    useImperativeHandle(ref, () => ({
        handleSubmit,
        resetForm: handleDiscard,
        items,
        isDirty: items.length > 0 || supplier.trim() !== '' || invoiceNumber.trim() !== ''
    }), [handleSubmit, handleDiscard, items, supplier, invoiceNumber]);

    const deduplicatedSearchInventory = useMemo(() => {
        const grouped = new Map<string, { item: InventoryItem; batches: InventoryItem[] }>();
        const term = modalSearchTerm.toLowerCase().trim();

        // Pre-map medicines to easily resolve codes for inventory items missing them
        const medicineCodeMap = new Map<string, string>(); // materialId -> code
        const medicineKeyMap = new Map<string, string>(); // NAME|BRAND -> code
        medicines.forEach(m => {
            if (m.materialCode) {
                medicineCodeMap.set(m.id, m.materialCode);
                medicineKeyMap.set(`${m.name.toLowerCase()}|${m.brand?.toLowerCase() || ''}`, m.materialCode);
            }
        });

        // 1. First check the inventory
        inventory.forEach(i => {
            const policy = getInventoryPolicy(i, medicines);
            if (!policy.purchaseEnabled) return;

            const name = i.name.toLowerCase();
            const brand = (i.brand || '').toLowerCase();
            
            // Resolve code from inventory, or fallback to medicines map using materialId or name|brand
            let resolvedCode = i.code;
            if (!resolvedCode) {
                if ((i as any).materialId && medicineCodeMap.has((i as any).materialId)) {
                    resolvedCode = medicineCodeMap.get((i as any).materialId)!;
                } else if (medicineKeyMap.has(`${name}|${brand}`)) {
                    resolvedCode = medicineKeyMap.get(`${name}|${brand}`)!;
                }
            }
            const code = (resolvedCode || '').toLowerCase();
            const barcode = (i.barcode || '').toLowerCase();
            
            if (!term || name.includes(term) || code.includes(term) || barcode.includes(term)) {
                // Use code as primary key if available, otherwise name|brand
                const key = resolvedCode ? `CODE:${resolvedCode.toLowerCase()}` : `NAME:${name}|${brand}`;
                
                if (!grouped.has(key)) {
                    // Inject resolved code into the representative item if it was missing
                    const repItem = { ...i, code: resolvedCode || i.code };
                    grouped.set(key, { item: repItem, batches: [i] });
                } else {
                    const existing = grouped.get(key)!;
                    existing.batches.push(i);
                    // Ensure the representative item has the aggregated stock
                    existing.item = {
                        ...existing.item,
                        stock: existing.batches.reduce((sum, batch) => sum + (batch.stock || 0), 0),
                    };
                }
            }
        });

        // 2. Then check the material master (medicines)
        medicines.forEach(m => {
            const medPolicy = getResolvedMedicinePolicy(m);
            if (!medPolicy.purchaseEnabled) return;

            const name = m.name.toLowerCase();
            const materialCode = (m.materialCode || '').toLowerCase();
            const barcode = (m.barcode || '').toLowerCase();

            if (!term || name.includes(term) || materialCode.includes(term) || barcode.includes(term)) {
                const key = m.materialCode ? `CODE:${m.materialCode.toLowerCase()}` : `NAME:${m.name.toLowerCase()}|${m.brand?.toLowerCase() || ''}`;
                
                // Only add if not already present from inventory (prevents duplicates)
                if (!grouped.has(key)) {
                    const virtualItem: InventoryItem = {
                        id: m.id,
                        organization_id: m.organization_id || '',
                        name: m.name,
                        code: m.materialCode,
                        brand: m.brand || '',
                        category: 'Medicine',
                        manufacturer: m.manufacturer || '',
                        stock: 0,
                        unitsPerPack: resolveUnitsPerStrip(extractPackMultiplier(m.pack) ?? 1, m.pack),
                        packType: m.pack || '',
                        minStockLimit: 0,
                        batch: 'NEW-STOCK',
                        expiry: 'N/A',
                        purchasePrice: 0,
                        mrp: parseFloat(m.mrp || '0'),
                        gstPercent: m.gstRate || 0,
                        hsnCode: m.hsnCode || '',
                        composition: m.composition || '',
                        barcode: m.barcode || '',
                        is_active: true
                    };
                    grouped.set(key, { item: virtualItem, batches: [] });
                }
            }
        });

        return Array.from(grouped.values())
            .sort((a, b) => {
                // Priority 1: Items with stock first
                const stockA = a.item.stock || 0;
                const stockB = b.item.stock || 0;
                if (stockA > 0 && stockB <= 0) return -1;
                if (stockA <= 0 && stockB > 0) return 1;

                // Priority 2: Items in inventory (even if 0 stock) over virtual items
                const isInvA = a.batches.length > 0;
                const isInvB = b.batches.length > 0;
                if (isInvA && !isInvB) return -1;
                if (!isInvA && isInvB) return 1;

                // Priority 3: Alphabetical
                return a.item.name.localeCompare(b.item.name);
            })
            .slice(0, 30);
    }, [modalSearchTerm, inventory, medicines]);

    const activeRowCalculations = useMemo(() => {
        const p = items.find(item => item.id === activeRowId) || items.find(item => (item.name || '').trim() !== '');
        if (!p || !p.name.trim()) return null;

        const gross = (p.purchasePrice || 0) * (p.quantity || 0);
        const tradeDisc = gross * ((p.discountPercent || 0) / 100);
        const afterTrade = gross - tradeDisc;
        const schemeDiscPercentAmount = afterTrade * ((p.schemeDiscountPercent || 0) / 100);
        const schemeDisc = p.schemeDiscountAmount > 0 ? p.schemeDiscountAmount : schemeDiscPercentAmount;
        const taxable = afterTrade - schemeDisc;
        const gst = taxable * ((p.gstPercent || 0) / 100);
        const total = taxable + gst;

        return {
            grossAmount: gross,
            taxableValue: taxable,
            sgst: gst / 2,
            cgst: gst / 2,
            totalGst: gst,
            discount: tradeDisc + schemeDisc,
            netAmount: total,
            gstPercent: p.gstPercent || 0
        };
    }, [activeRowId, items]);

    const activeIntelItem = useMemo(() => {
        if (isSearchModalOpen && deduplicatedSearchInventory.length > 0) {
            return deduplicatedSearchInventory[selectedSearchIndex]?.item;
        }
        if (activeRowId) {
            const row = items.find(p => p.id === activeRowId);
            if (row && row.name.trim()) {
                const linkedInv = inventory.find(inv => inv.id === row.inventoryItemId);
                if (linkedInv) return linkedInv;
                return {
                    name: row.name,
                    brand: row.brand,
                    manufacturer: row.manufacturer,
                    batch: row.batch,
                    expiry: row.expiry,
                    mrp: row.mrp,
                    stock: 0
                } as any;
            }
        }
        return null;
    }, [isSearchModalOpen, deduplicatedSearchInventory, selectedSearchIndex, activeRowId, items, inventory]);

    const handleGlobalKeyDown = useCallback((e: KeyboardEvent) => {
        if (isSearchModalOpen || isWebcamModalOpen || isAddSupplierModalOpen || isAddMedicineMasterModalOpen || isLinkModalOpen || isRateTierModalOpen || isSupplierSearchModalOpen || isEditMaterialModalOpen) return;

        if (e.key === 'F8') {
            e.preventDefault();
            triggerSaveAction('hold');
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            triggerSaveAction();
            return;
        }

        if (e.altKey && e.key.toLowerCase() === 'h') {
            e.preventDefault();
            triggerSaveAction('hold');
            return;
        }

        const isInputFocused = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';

        if (!isInputFocused && activeRowId) {
            const rowIndex = items.findIndex(p => p.id === activeRowId);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const nextRow = items[rowIndex + 1];
                if (nextRow) setActiveRowId(nextRow.id);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prevRow = items[rowIndex - 1];
                if (prevRow) setActiveRowId(prevRow.id);
            } else if (e.key === 'Delete') {
                e.preventDefault();
                handleDeleteRow(activeRowId, rowIndex);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const nameInput = document.getElementById(`name-${activeRowId}`);
                nameInput?.focus();
                (nameInput as HTMLInputElement)?.select();
            }
        }
    }, [activeRowId, items, isSearchModalOpen, isWebcamModalOpen, isAddSupplierModalOpen, isAddMedicineMasterModalOpen, isLinkModalOpen, isRateTierModalOpen, isSupplierSearchModalOpen, isEditMaterialModalOpen, triggerSaveAction]);

    useEffect(() => {
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [handleGlobalKeyDown]);

    const handleDeleteRow = useCallback((id: string, index: number) => {
        if (isReadOnly) return;

        setItems(prev => {
            const newItems = prev.filter(item => item.id !== id);
            if (newItems.length === 0) return [createBlankItem()];
            
            const nextFocusIdx = index < newItems.length ? index : newItems.length - 1;
            const itemToFocus = newItems[nextFocusIdx];
            if (itemToFocus) {
                setTimeout(() => {
                    const qtyInput = document.getElementById(`qty-${itemToFocus.id}`) || document.getElementById(`name-${itemToFocus.id}`);
                    qtyInput?.focus();
                    if (qtyInput instanceof HTMLInputElement) qtyInput.select();
                }, 10);
            }
            return newItems;
        });
    }, [isReadOnly]);

    const clearItemSelection = useCallback((rowId: string) => {
        if (isReadOnly || !supplier.trim()) return;

        setItems(prev => prev.map(item => {
            if (item.id !== rowId) return item;
            return {
                ...item,
                name: '',
                packType: '',
                materialCode: '',
                inventoryItemId: undefined,
                matchStatus: 'pending'
            };
        }));
    }, [isReadOnly, supplier]);

    const handleGridKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, rowId: string, field: string) => {
        if (isReadOnly) return;

        if (field === 'name' && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            openMaterialEditOrSearch(rowId);
            return;
        }

        if (field === 'name' && (e.key === 'Delete' || e.key === 'Backspace')) {
            const row = items.find(item => item.id === rowId);
            if ((row?.name || '').trim() || (row?.packType || '').trim()) {
                e.preventDefault();
                clearItemSelection(rowId);
                return;
            }
        }

        if (e.key === 'Delete') {
            e.preventDefault();
            const index = items.findIndex(item => item.id === rowId);
            handleDeleteRow(rowId, index);
            return;
        }

        const fields = [
            'name',
            'mfr',
            'pack',
            'batch',
            'expiry',
            'mrp',
            ...(showPackQty ? ['qty'] : []),
            ...(showLooseQty ? ['lqty'] : []),
            'free',
            'rate',
            'disc',
            'sch',
            'gst'
        ];
        const currentIndex = fields.indexOf(field);
        const rowIndex = items.findIndex(p => p.id === rowId);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const nextRow = items[rowIndex + 1];
            if (nextRow) {
                const nextInput = document.getElementById(`${field}-${nextRow.id}`);
                nextInput?.focus();
                (nextInput as HTMLInputElement)?.select();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prevRow = items[rowIndex - 1];
            if (prevRow) {
                const prevInput = document.getElementById(`${field}-${prevRow.id}`);
                prevInput?.focus();
                (prevInput as HTMLInputElement)?.select();
            }
        } else if (e.key === 'ArrowRight') {
            const input = e.target as HTMLInputElement;
            if (input.selectionEnd === input.value.length || input.type === 'number') {
                const nextField = fields[currentIndex + 1];
                if (nextField) {
                    e.preventDefault();
                    const nextInput = document.getElementById(`${nextField}-${rowId}`);
                    nextInput?.focus();
                    (nextInput as HTMLInputElement)?.select();
                }
            }
        } else if (e.key === 'ArrowLeft') {
            const input = e.target as HTMLInputElement;
            if (input.selectionStart === 0 || input.type === 'number') {
                const prevField = fields[currentIndex - 1];
                if (prevField) {
                    e.preventDefault();
                    const prevInput = document.getElementById(`${prevField}-${rowId}`);
                    prevInput?.focus();
                    (prevInput as HTMLInputElement)?.select();
                }
            }
        }
    };

    const intelDetails = useMemo(() => {
        if (!activeIntelItem) return null;

        const matchingPurchases = (purchases || []).filter(p => {
            if (p.status === 'cancelled' || !p.items) return false;
            const items = Array.isArray(p.items) ? p.items : (typeof p.items === 'string' ? JSON.parse(p.items) : []);
            return Array.isArray(items) && items.some((i: any) => i.name === activeIntelItem.name);
        }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        const lastPurRate = matchingPurchases.length > 0
            ? (matchingPurchases[0].items.find((i: any) => i.name === activeIntelItem.name)?.purchasePrice || activeIntelItem.purchasePrice)
            : activeIntelItem.purchasePrice;

        const profitAmount = activeIntelItem.mrp - lastPurRate;
        const profitMargin = activeIntelItem.mrp > 0 ? (profitAmount / activeIntelItem.mrp) * 100 : 0;

        return { lastPurRate, profitAmount, profitMargin };
    }, [activeIntelItem, purchases]);

    const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'F4') {
            e.preventDefault();
            setIsInsightsOpen(true);
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            setIsSearchModalOpen(false);
            setIsAddMedicineMasterModalOpen(true);
            return;
        }

        if (deduplicatedSearchInventory.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedSearchIndex(prev => (prev + 1) % deduplicatedSearchInventory.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedSearchIndex(prev => (prev - 1 + deduplicatedSearchInventory.length) % deduplicatedSearchInventory.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const selectedWrapper = deduplicatedSearchInventory[selectedSearchIndex];
            if (selectedWrapper) triggerBatchSelection(selectedWrapper);
        }
    };

    useEffect(() => {
        if (!isInsightsOpen || !currentUser || salesHistory.length > 0) return;
        let isMounted = true;
        setIsInsightsLoading(true);

        fetchTransactions(currentUser)
            .then((rows) => {
                if (!isMounted) return;
                setSalesHistory((rows || []).filter((row: Transaction) => row.organization_id === currentUser.organization_id));
            })
            .finally(() => {
                if (isMounted) setIsInsightsLoading(false);
            });

        return () => {
            isMounted = false;
        };
    }, [isInsightsOpen, currentUser, salesHistory.length]);

    const triggerBatchSelection = (productWrapper: { item: InventoryItem; batches: InventoryItem[] }) => {
        addSelectedBatchToGrid(productWrapper.item);
    };

    const addSelectedBatchToGrid = (batch: InventoryItem) => {
        const targetRowId = activeRowId || crypto.randomUUID();
        const linkedMedicine = medicines.find((med) => med.id === batch.id || (med.materialCode || '').trim().toLowerCase() === (batch.code || '').trim().toLowerCase());
        const newItem: PurchaseItem = {
            id: targetRowId,
            inventoryItemId: batch.id,
            name: batch.name,
            brand: batch.brand || '',
            manufacturer: String(batch.manufacturer || '').trim(),
            category: batch.category || 'General',
            packType: batch.packType || '',
            unitsPerPack: batch.unitsPerPack || 1,
            batch: batch.batch || 'NEW-BATCH',
            expiry: formatExpiryToMMYY(batch.expiry ? String(batch.expiry) : ''),
            quantity: 1,
            looseQuantity: 0,
            freeQuantity: 0,
            purchasePrice: batch.purchasePrice || 0,
            mrp: batch.mrp || 0,
            rateA: batch.rateA,
            rateB: batch.rateB,
            rateC: batch.rateC,
            gstPercent: batch.gstPercent || 5,
            hsnCode: batch.hsnCode || '',
            materialCode: batch.code,
            discountPercent: Number(linkedMedicine?.productDiscount ?? 0),
            schemeDiscountPercent: 0,
            schemeDiscountAmount: 0,
            matchStatus: 'matched'
        };

        setItems(prev => {
            const index = prev.findIndex(p => p.id === activeRowId);
            if (activeRowId && index > -1) {
                const next = [...prev];
                next[index] = newItem;
                if (index === prev.length - 1) return [...next, createBlankItem()];
                return next;
            }
            return [...prev, newItem, createBlankItem()];
        });

        setModalSearchTerm('');
        setIsSearchModalOpen(false);
        setActiveRowId(targetRowId);

        setTimeout(() => {
            const qtyInput = document.getElementById(`qty-${targetRowId}`);
            if (qtyInput) {
                (qtyInput as HTMLInputElement).focus();
                (qtyInput as HTMLInputElement).select();
            }
        }, 50);
    };

    const handleMedicineSavedFromPurchase = useCallback((savedMedicine: Medicine) => {
        if (!savedMedicine?.name) return;

        const itemLikeMedicine: InventoryItem = {
            id: savedMedicine.id,
            organization_id: savedMedicine.organization_id || '',
            name: savedMedicine.name,
            code: savedMedicine.materialCode,
            brand: savedMedicine.brand || '',
            category: 'Medicine',
            manufacturer: savedMedicine.manufacturer || '',
            stock: 0,
            unitsPerPack: resolveUnitsPerStrip(extractPackMultiplier(savedMedicine.pack) ?? 1, savedMedicine.pack),
            packType: savedMedicine.pack || '',
            minStockLimit: 0,
            batch: 'NEW-STOCK',
            expiry: 'N/A',
            purchasePrice: Number(savedMedicine.rateA || 0),
            mrp: parseFloat(savedMedicine.mrp || '0'),
            rateA: Number(savedMedicine.rateA || 0),
            rateB: Number(savedMedicine.rateB || 0),
            rateC: Number(savedMedicine.rateC || 0),
            gstPercent: savedMedicine.gstRate || 0,
            hsnCode: savedMedicine.hsnCode || '',
            composition: savedMedicine.composition || '',
            barcode: savedMedicine.barcode || '',
            is_active: true,
        };

        addSelectedBatchToGrid(itemLikeMedicine);
    }, [addSelectedBatchToGrid]);

    const openSearchModal = useCallback((rowId: string, initialValue: string) => {
        if (isReadOnly) return;
        setActiveRowId(rowId);
        setModalSearchTerm(initialValue);
        setIsSearchModalOpen(true);
        setSelectedSearchIndex(0);
        setTimeout(() => modalSearchInputRef.current?.focus(), 150);
    }, [isReadOnly]);

    const shouldOpenSearchForRow = useCallback((item: PurchaseItem) => {
        const hasSelectedItem = Boolean((item.name || '').trim() || item.inventoryItemId || (item.packType || '').trim());
        return !hasSelectedItem;
    }, []);

    const findMedicineForPurchaseRow = useCallback((row: PurchaseItem): Medicine | null => {
        const rowName = (row.name || '').trim().toLowerCase();
        const rowCode = (row.materialCode || '').trim().toLowerCase();
        if (!rowName && !rowCode) return null;

        const byCode = rowCode
            ? medicines.find((med) => (med.materialCode || '').trim().toLowerCase() === rowCode)
            : undefined;
        if (byCode) return byCode;

        const inventoryItem = row.inventoryItemId ? inventory.find((inv) => inv.id === row.inventoryItemId) : undefined;
        const inventoryCode = (inventoryItem?.code || '').trim().toLowerCase();
        if (inventoryCode) {
            const byInventoryCode = medicines.find((med) => (med.materialCode || '').trim().toLowerCase() === inventoryCode);
            if (byInventoryCode) return byInventoryCode;
        }

        const rowPack = (row.packType || '').trim().toLowerCase();
        return medicines.find((med) => {
            const medName = (med.name || '').trim().toLowerCase();
            if (!medName || medName !== rowName) return false;
            if (!rowPack) return true;
            return (med.pack || '').trim().toLowerCase() === rowPack;
        }) || null;
    }, [inventory, medicines]);

    const openMaterialEditOrSearch = useCallback((rowId: string) => {
        if (isReadOnly || !supplier.trim()) return;

        const row = items.find(item => item.id === rowId);
        if (!row) return;

        if (!((row.name || '').trim())) {
            openSearchModal(rowId, '');
            return;
        }

        const materialRecord = findMedicineForPurchaseRow(row);
        if (!materialRecord) {
            addNotification('Material Master record not found for selected product.', 'warning');
            return;
        }

        setActiveRowId(rowId);
        setMaterialEditRowId(rowId);
        setMaterialToEdit(materialRecord);
        setIsEditMaterialModalOpen(true);
    }, [addNotification, findMedicineForPurchaseRow, isReadOnly, items, openSearchModal, supplier]);

    const handleUpdateMaterialFromPurchase = useCallback(async (updatedMedicine: Medicine) => {
        if (!onUpdateMedicineMaster) {
            addNotification('Material update action is unavailable in this view.', 'warning');
            return;
        }
        const targetRowId = materialEditRowId;
        if (!targetRowId) return;

        await onUpdateMedicineMaster(updatedMedicine);

        setItems(prev => prev.map(item => {
            if (item.id !== targetRowId) return item;
            const parsedMrp = parseFloat(String(updatedMedicine.mrp ?? ''));
            const parsedRateA = Number(updatedMedicine.rateA ?? 0);
            return {
                ...item,
                name: updatedMedicine.name || item.name,
                manufacturer: updatedMedicine.manufacturer || '',
                packType: updatedMedicine.pack || '',
                materialCode: updatedMedicine.materialCode || item.materialCode,
                hsnCode: updatedMedicine.hsnCode || '',
                gstPercent: Number(updatedMedicine.gstRate ?? 0),
                mrp: Number.isFinite(parsedMrp) ? parsedMrp : item.mrp,
                rateA: Number(updatedMedicine.rateA ?? item.rateA ?? 0),
                rateB: Number(updatedMedicine.rateB ?? item.rateB ?? 0),
                rateC: Number(updatedMedicine.rateC ?? item.rateC ?? 0),
                purchasePrice: parsedRateA > 0 ? parsedRateA : item.purchasePrice,
            };
        }));

        addNotification('Material Master updated and purchase line refreshed.', 'success');
    }, [addNotification, materialEditRowId, onUpdateMedicineMaster]);

    const handleUpdateItem = (id: string, field: keyof PurchaseItem, value: any) => {
        if (isReadOnly || !supplier.trim()) return;
        if (field === 'purchasePrice' && value !== '') {
            const parsed = parseFloat(String(value));
            const currentItem = items.find(p => p.id === id);
            if (currentItem && currentItem.mrp > 0 && !isNaN(parsed) && parsed > currentItem.mrp) {
                addNotification(`Rate cannot exceed MRP (₹${currentItem.mrp.toFixed(2)})`, 'warning');
                value = currentItem.mrp;
            }
        }
        setItems(prev => {
            const index = prev.findIndex(p => p.id === id); if (index === -1) return prev;
            let updatedItem = { ...prev[index], [field]: value };
            if (field === 'name' || field === 'batch') { 
                updatedItem.matchStatus = 'pending'; 
                updatedItem.inventoryItemId = undefined; 
            }
            if (field === 'expiry') { updatedItem.expiry = normalizeExpiryInput(String(value)); }
            if (['quantity', 'freeQuantity', 'purchasePrice', 'mrp', 'discountPercent', 'schemeDiscountPercent'].includes(field)) { (updatedItem as any)[field] = value === '' ? 0 : (parseFloat(value) || 0); }
            if (field === 'quantity' || field === 'purchasePrice') {
                updatedItem.lineBaseAmount = calculatePurchaseLineBaseAmount(updatedItem, purchaseLineAmountMode);
            }
            const wasEmpty = !prev[index].name && !prev[index].inventoryItemId;
            const updated = prev.map(p => p.id === id ? updatedItem : p);
            if (field === 'name' && (value || '').trim() !== '' && index === prev.length - 1 && wasEmpty) return [...updated, createBlankItem()];
            return updated;
        });
    };

    const moveToNextProductSelection = useCallback((rowId: string) => {
        let nextRowId: string | null = null;

        setItems(prev => {
            const currentIndex = prev.findIndex(p => p.id === rowId);
            if (currentIndex === -1) return prev;

            let nextItems = prev;
            if (currentIndex === prev.length - 1 && (prev[currentIndex].name || '').trim() !== '') {
                nextItems = [...prev, createBlankItem()];
            }

            nextRowId = nextItems[currentIndex + 1]?.id || null;
            return nextItems;
        });

        setTimeout(() => {
            if (!nextRowId) return;
            const nameInput = document.getElementById(`name-${nextRowId}`) as HTMLInputElement | null;
            nameInput?.focus();
            nameInput?.select();
        }, 50);
    }, []);

    const openRateTierModal = useCallback((rowId: string) => {
        const row = items.find(p => p.id === rowId);
        if (!row) return;
        const linkedInventory = row.inventoryItemId ? inventory.find(inv => inv.id === row.inventoryItemId) : undefined;

        setActiveRateTierRowId(rowId);
        setRateTierDraft({
            rateA: row.rateA !== undefined ? String(row.rateA) : (linkedInventory?.rateA !== undefined ? String(linkedInventory.rateA) : ''),
            rateB: row.rateB !== undefined ? String(row.rateB) : (linkedInventory?.rateB !== undefined ? String(linkedInventory.rateB) : ''),
            rateC: row.rateC !== undefined ? String(row.rateC) : (linkedInventory?.rateC !== undefined ? String(linkedInventory.rateC) : ''),
        });
        setSelectedRateTierAction('save');
        setIsRateTierModalOpen(true);
    }, [inventory, items]);

    useEffect(() => {
        if (!isRateTierModalOpen) return;
        setTimeout(() => {
            rateAInputRef.current?.focus();
            rateAInputRef.current?.select();
        }, 0);
    }, [isRateTierModalOpen]);

    const focusSelectedRateTierAction = useCallback((action: 'skip' | 'save') => {
        if (action === 'skip') {
            skipRateButtonRef.current?.focus();
            return;
        }
        saveRateButtonRef.current?.focus();
    }, []);

    const handleRateInputEnter = (e: React.KeyboardEvent<HTMLInputElement>, nextField?: 'rateB' | 'rateC' | 'action') => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();

        if (nextField === 'rateB') {
            rateBInputRef.current?.focus();
            rateBInputRef.current?.select();
            return;
        }
        if (nextField === 'rateC') {
            rateCInputRef.current?.focus();
            rateCInputRef.current?.select();
            return;
        }
        focusSelectedRateTierAction(selectedRateTierAction);
    };

    const handleRateActionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setSelectedRateTierAction('skip');
            focusSelectedRateTierAction('skip');
            return;
        }

        if (e.key === 'ArrowRight') {
            e.preventDefault();
            setSelectedRateTierAction('save');
            focusSelectedRateTierAction('save');
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (selectedRateTierAction === 'save') {
                saveTierRatesForRow();
            } else {
                skipTierRatesForRow();
            }
        }
    };

    const closeRateTierModal = () => {
        const currentRowId = activeRateTierRowId;
        setIsRateTierModalOpen(false);
        setActiveRateTierRowId(null);
        setTimeout(() => {
            if (!currentRowId) return;
            const schInput = document.getElementById(`sch-${currentRowId}`) as HTMLInputElement | null;
            schInput?.focus();
            schInput?.select();
        }, 50);
    };

    const saveTierRatesForRow = () => {
        if (!activeRateTierRowId) return;

        setItems(prev => prev.map(item => item.id === activeRateTierRowId ? {
            ...item,
            rateA: rateTierDraft.rateA === '' ? undefined : (parseFloat(rateTierDraft.rateA) || 0),
            rateB: rateTierDraft.rateB === '' ? undefined : (parseFloat(rateTierDraft.rateB) || 0),
            rateC: rateTierDraft.rateC === '' ? undefined : (parseFloat(rateTierDraft.rateC) || 0),
        } : item));
        setRateTierHandledRows(prev => new Set(prev).add(activeRateTierRowId));
        closeRateTierModal();
    };

    const skipTierRatesForRow = () => {
        if (activeRateTierRowId) {
            setRateTierHandledRows(prev => new Set(prev).add(activeRateTierRowId));
        }
        closeRateTierModal();
    };

    const handleRateTierLastFieldEnter = (e: React.KeyboardEvent<HTMLInputElement>, rowId: string) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();

        if (isReadOnly || !supplier.trim()) return;
        if (!rateTierHandledRows.has(rowId)) {
            openRateTierModal(rowId);
            return;
        }

        moveToNextProductSelection(rowId);
    };

    const processAiExtraction = useCallback(async (fileInputs: FileInput[]) => {
        if (!fileInputs || fileInputs.length === 0) return;
        console.log(`MDXERA AI: Starting extraction for ${fileInputs.length} page(s).`);

        setIsUploading(true);
        setImportWorkflowError(null);
        setImportWorkflowStage('importing');
        try {
            const bill = await extractPurchaseDetailsFromBill(fileInputs, currentUser?.pharmacy_name || '');
            if (bill.error) {
                throw new Error(String(bill.error));
            }

            const importStatus = String(bill.importStatus || 'success').toLowerCase();
            const extractedItemsCount = Number.isFinite(Number(bill.extractedItemsCount))
                ? Number(bill.extractedItemsCount)
                : (Array.isArray(bill.items) ? bill.items.length : 0);
            console.info('Bill OCR extraction completed', {
                importStatus,
                invoiceNumber: bill.invoiceNumber || '',
            });
            console.debug('[Purchase Import] Bill imported', {
                importStatus,
                invoiceNumber: bill.invoiceNumber || '',
                supplierDetected: Boolean((bill as any).supplierDetected ?? bill.supplier),
            });

            if (importStatus !== 'success') {
                throw new Error('Bill import failed. Please retry import.');
            }

            if (bill.invoiceNumber) setInvoiceNumber(bill.invoiceNumber);
            if (bill.date) setDate(normalizeImportDate(bill.date) || date);

            let linkedItems: PurchaseItem[] = [];
            const supplierMatch = matchSupplierFromExtractedData(bill);
            const matchedSupplier = supplierMatch.supplier;

            if (matchedSupplier) {
                setSupplier(matchedSupplier.name || '');
                setSupplierGst(matchedSupplier.gst_number || bill.supplierGstNumber || '');
                setSupplierNameError(null);
                console.info('Supplier detected', {
                    supplier: matchedSupplier.name || '',
                    supplierId: matchedSupplier.id,
                    matchedBy: supplierMatch.reason,
                });
                console.debug('[Purchase Import] Supplier detected', {
                    supplier: matchedSupplier.name || '',
                    supplierId: matchedSupplier.id,
                    matchedBy: supplierMatch.reason,
                });
                addNotification(`Supplier auto-matched by ${supplierMatch.reason.toUpperCase()}: ${matchedSupplier.name}`, 'success');
            } else {
                console.info('Supplier detected', {
                    supplier: bill.supplier || '',
                    supplierId: null,
                    matchedBy: 'unmatched',
                });
                console.debug('[Purchase Import] Supplier detected', {
                    supplier: bill.supplier || '',
                    supplierId: null,
                    matchedBy: 'unmatched',
                });
                setSupplier(bill.supplier || '');
                setSupplierGst(bill.supplierGstNumber || '');
                setSupplierNameError('Supplier Not Found');
                setSupplierQuickCreatePrefill({
                    name: bill.supplier || '',
                    gst_number: bill.supplierGstNumber || '',
                    pan_number: bill.supplierPanNumber || '',
                    phone: bill.supplierPhone || '',
                    mobile: bill.supplierPhone || '',
                    address: bill.supplierAddress || '',
                });
                addNotification('Supplier Not Found. Please select existing supplier or quick create before confirming import.', 'warning');
                setIsSupplierSearchModalOpen(true);
                setIsAddSupplierModalOpen(true);
            }

            setImportWorkflowStage('validating-items');
            console.info('Extracted item count', {
                extractedItemsCount,
                rawItemsCount: Array.isArray(bill.items) ? bill.items.length : 0,
            });
            console.debug('[Purchase Import] Extracted items count', {
                extractedItemsCount,
                rawItemsCount: Array.isArray(bill.items) ? bill.items.length : 0,
            });
            if (extractedItemsCount <= 0 || !bill.items || bill.items.length === 0) {
                const missingItemsMessage = 'No line items detected in scanned bill.';
                console.error(missingItemsMessage);
                setImportWorkflowError(missingItemsMessage);
                addNotification(missingItemsMessage, 'error');
                return {
                    linkedItems,
                    supplierForReconciliation: matchedSupplier,
                };
            }

            const newItems = bill.items.map(item => {
                const packTypeStr = String(item.packType || (item as any).pack || '').trim();
                return {
                    ...createBlankItem(),
                    ...item,
                    name: String(item.name || '').trim(),
                    manufacturer: String(item.manufacturer || '').trim(),
                    brand: String(item.brand || '').trim(),
                    packType: packTypeStr,
                    unitsPerPack: resolveUnitsPerStrip(parseNumber(item.unitsPerPack), packTypeStr),
                    batch: String(item.batch || '').trim(),
                    expiry: normalizeExpiryInput(formatExpiryToMMYY(String(item.expiry || ''))),
                    quantity: parseNumber(item.quantity),
                    freeQuantity: parseNumber(item.freeQuantity),
                    purchasePrice: parseNumber(item.purchasePrice || (item as any).rate),
                    mrp: parseNumber(item.mrp),
                    gstPercent: parseNumber(item.gstPercent) || 5,
                    discountPercent: parseNumber(item.discountPercent),
                    schemeDiscountPercent: parseNumber(item.schemeDiscountPercent || (item as any).scheme),
                    schemeDiscountAmount: parseNumber(item.schemeDiscountAmount),
                    matchStatus: 'pending' as const
                };
            });
            linkedItems = attemptAutoLink(newItems as PurchaseItem[], matchedSupplier || null);

            if (linkedItems.length === 0) {
                const emptyReconciliationMessage = 'Bill import saved but reconciliation fetch returned 0';
                console.error(emptyReconciliationMessage);
                setImportWorkflowError(emptyReconciliationMessage);
                addNotification(emptyReconciliationMessage, 'error');
            }

            const unresolvedCount = linkedItems.filter(item => item.matchStatus !== 'matched').length;
            const mappedItemsCount = linkedItems.length - unresolvedCount;
            console.info('Mapped item count', { mappedItemsCount });
            console.info('Unmatched item count', { unmatchedItemsCount: unresolvedCount });
            console.debug('[Purchase Import] Mapping summary', {
                mappedItemsCount,
                unmatchedItemsCount: unresolvedCount,
                extractedItemsCount,
            });
            const fingerprint = buildBillFingerprint(bill, linkedItems.length);
            const isDuplicateImport = hasAutoOpenedReconciliation && lastImportedFingerprint === fingerprint;
            setLastImportedFingerprint(fingerprint);

            if (unresolvedCount > 0) {
                if (voucherScreenOpen) {
                    addNotification('Voucher draft is already open. Ignoring import refresh reset.', 'warning');
                    return {
                        linkedItems,
                        supplierForReconciliation: matchedSupplier,
                    };
                }
                setPendingReconciliationItems(linkedItems);
                if (isDuplicateImport) {
                    addNotification('Bill already imported/reconciled. Use Reconcile Again to reopen worksheet.', 'warning');
                } else {
                    setImportWorkflowStage('opening-reconciliation');
                    try {
                        setIsLinkModalOpen(true);
                        setHasAutoOpenedReconciliation(true);
                    } catch (openError: any) {
                        const openMessage = normalizeReconciliationError(openError);
                        console.error(openMessage);
                        setImportWorkflowError(openMessage);
                        addNotification(openMessage, 'error');
                    }
                }
            } else {
                commitVoucherDraftAndOpen(linkedItems);
                console.info('Grid rows inserted', {
                    insertedRows: linkedItems.length,
                });
            }

            addNotification('AI Extracted bill details successfully.', 'success');
            return {
                linkedItems,
                supplierForReconciliation: matchedSupplier,
            };
        } catch (err: any) {
            const message = String(err?.message || err || parseNetworkAndApiError(err));
            addNotification(`AI Extraction failed: ${message}`, 'error');
            setImportWorkflowError(normalizeReconciliationError(err));
            throw new Error(message);
        } finally {
            setIsUploading(false);
            setImportWorkflowStage('idle');
        }
    }, [addNotification, attemptAutoLink, buildBillFingerprint, commitVoucherDraftAndOpen, currentUser?.pharmacy_name, date, hasAutoOpenedReconciliation, lastImportedFingerprint, matchSupplierFromExtractedData, normalizeReconciliationError, voucherScreenOpen]);


    const processMobileSyncPayload = useCallback(async (payload: MobileSyncInvoicePayload, options?: { skipSyncingStatus?: boolean }) => {
        const pages = Array.isArray(payload.pages) && payload.pages.length > 0
            ? payload.pages
            : (payload.image ? [{ image: payload.image, mimeType: payload.mimeType || 'image/jpeg', pageNumber: 1 }] : []);

        if (pages.length === 0) {
            setMobileSyncStatus('failed');
            setMobileSyncError('No bill pages found in mobile sync payload.');
            addNotification('Mobile sync failed: no pages received.', 'error');
            return;
        }

        const orderedPages = [...pages].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));
        setMobilePageCount(orderedPages.length);
        setMobileInvoiceId(payload.invoiceId || null);
        setMobileSyncError(null);
        if (!options?.skipSyncingStatus) setMobileSyncStatus('syncing');

        try {
            const fileInputs: FileInput[] = orderedPages.map((page, index) => ({
                data: page.image,
                mimeType: page.mimeType || 'image/jpeg',
                name: `mobile-${payload.invoiceId || 'invoice'}-page-${(page.pageNumber || index + 1)}.jpg`
            }));

            const extractionResult = await processAiExtraction(fileInputs);
            setMobileSyncStatus('imported');
            addNotification(`Imported ${orderedPages.length} mobile page(s) into draft purchase voucher.`, 'success');

            // Auto-close modal after successful import
            setTimeout(() => {
                setMobileSyncSessionId(null);
            }, 1500);

            const unresolvedCount = (extractionResult?.linkedItems || []).filter(item => item.matchStatus !== 'matched').length;
            if (unresolvedCount === 0) {
                addNotification('All imported items were auto-mapped. Opening draft purchase voucher directly.', 'success');
            }
        } catch (err: any) {
            const message = String(err?.message || err || parseNetworkAndApiError(err));
            setMobileSyncStatus('failed');
            setMobileSyncError(message);
            if (payload.billId) {
                markMobileBillImported(payload.billId, 'failed', message).catch(() => undefined);
            }
            addNotification(`Mobile sync import failed: ${message}`, 'error');
            throw new Error(message);
        }
    }, [addNotification, processAiExtraction]);

    const processMobileSyncPayloadRef = useRef(processMobileSyncPayload);
    useEffect(() => {
        processMobileSyncPayloadRef.current = processMobileSyncPayload;
    }, [processMobileSyncPayload]);

    useEffect(() => {
        if (!mobileSyncSessionId) {
            setMobileSyncStatus('pending');
            setMobileSyncError(null);
            setMobileInvoiceId(null);
            setMobilePageCount(0);
            return;
        }

        // Only set pending if we're not already in a progress state
        setMobileSyncStatus(prev => (prev === 'imported' || prev === 'failed') ? prev : 'pending');
        
        const channel = listenForSyncMessage(mobileSyncSessionId, (payload: MobileSyncInvoicePayload) => {
            setMobileSyncStatus('uploading');
            setMobileSyncError(null);
            const pageCount = Array.isArray(payload.pages) ? payload.pages.length : (payload.image ? 1 : 0);
            setMobilePageCount(pageCount);
            setMobileInvoiceId(payload.invoiceId || null);
            
            if (pageCount > 0) {
                processMobileSyncPayloadRef.current(payload).catch(err => {
                    console.error('Auto-sync error:', err);
                });
            }
        });

        return () => {
            if (channel && typeof (channel as any).unsubscribe === 'function') {
                (channel as any).unsubscribe();
            }
        };
    }, [mobileSyncSessionId]);

    const handleSyncBill = useCallback(async () => {
        if (!mobileSyncSessionId || !currentUser) {
            setMobileSyncStatus('failed');
            setMobileSyncError('Open Magic Mobile Link first to sync a bill.');
            addNotification('Please open Magic Mobile Link before syncing bill.', 'warning');
            return;
        }

        setIsMobileSyncing(true);
        setMobileSyncStatus('syncing');
        setMobileSyncError(null);

        try {
            const pendingServerBills = await fetchPendingMobileBills({
                organizationId,
                userId: currentUser.user_id || mobileSyncSessionId,
                deviceId: mobileSyncDeviceId,
                sessionId: mobileSyncSessionId,
            });

            let latestPayload = (pendingServerBills[0]?.payload || null) as MobileSyncInvoicePayload | null;
            let latestBillId = pendingServerBills[0]?.id;

            if (!latestPayload) {
                latestPayload = getLatestSyncMessage(mobileSyncSessionId) as MobileSyncInvoicePayload | null;
            }

            if (!latestPayload) {
                setMobileSyncStatus('failed');
                const notFoundError = 'No mobile bill found yet. Upload bill pages from mobile and retry Sync Bill.';
                setMobileSyncError(notFoundError);
                addNotification(`Sync Bill failed: ${notFoundError}`, 'error');
                return;
            }

            await processMobileSyncPayload({ ...latestPayload, billId: latestBillId }, { skipSyncingStatus: true });
            if (latestBillId) {
                await markMobileBillImported(latestBillId, 'imported');
            }
        } catch (err: any) {
            const message = parseNetworkAndApiError(err);
            setMobileSyncStatus('failed');
            setMobileSyncError(message);
            addNotification(`Sync Bill failed: ${message}`, 'error');
        } finally {
            setIsMobileSyncing(false);
        }
    }, [addNotification, currentUser, mobileSyncSessionId, organizationId, processMobileSyncPayload]);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        try {
            const fileInputs = await prepareFilesForAiExtraction(files);
            await processAiExtraction(fileInputs);
        } catch (err: any) {
            addNotification(parseNetworkAndApiError(err), 'error');
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleWebcamCapture = async (data: string, mimeType: string) => {
        try {
            const optimized = await prepareCapturedImageForAiExtraction(data, mimeType);
            await processAiExtraction([optimized]);
        } catch (err: any) {
            addNotification(parseNetworkAndApiError(err), 'error');
        }
    };

    const focusFirstLineItemField = () => {
        const firstRow = items[0];
        if (!firstRow) return;
        const firstNameInput = document.getElementById(`name-${firstRow.id}`) as HTMLInputElement | null;
        firstNameInput?.focus();
        firstNameInput?.select();
    };

    const handleSupplierSelect = (d: Supplier) => {
        setSupplier(d.name);
        setSupplierGst(d.gst_number || '');
        setIsSupplierDropdownOpen(false);
        setIsSupplierSearchModalOpen(false);
        setIsAddSupplierModalOpen(false);
        setSupplierQuickCreatePrefill(undefined);
        setSelectedSupplierIndex(0);
        setSupplierNameError(null);
        setTimeout(() => {
            focusFirstLineItemField();
        }, 0);
    };

    const handleQuickCreateSupplier = (supplierNameOverride?: string) => {
        if (isReadOnly) return;
        const supplierName = (supplierNameOverride ?? supplier).trim();
        setSupplierQuickCreatePrefill({
            name: supplierName,
            gst_number: supplierGst || '',
            supplier_group: 'Sundry Creditors',
        });
        setIsSupplierDropdownOpen(false);
        setIsSupplierSearchModalOpen(false);
        setIsAddSupplierModalOpen(true);
    };

    const handleSupplierKeyDown = (e: React.KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            const exact = suppliers.find(d => normalizeSupplierKey(d.name || '') === normalizeSupplierKey(supplier));
            if (exact) {
                handleSupplierSelect(exact);
                return;
            }
            handleQuickCreateSupplier();
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const filtered = suppliers.filter(d => fuzzyMatch(d.name, supplier)).slice(0, 10);
            setSelectedSupplierIndex(prev => (prev + 1) % Math.max(1, filtered.length));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const filtered = suppliers.filter(d => fuzzyMatch(d.name, supplier)).slice(0, 10);
            setSelectedSupplierIndex(prev => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            setIsSupplierDropdownOpen(false);
            setIsSupplierSearchModalOpen(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setIsSupplierDropdownOpen(false);
            setIsAddSupplierModalOpen(false);
        }
    };

    const memoizedScannedItems = useMemo(() => 
        (pendingReconciliationItems || items).filter(i => (i.name || "").trim()),
        [pendingReconciliationItems, items]
    );

    return (
        <div className="flex h-full overflow-hidden bg-app-bg">
            <div className={`flex-1 flex flex-col min-w-0 overflow-hidden relative ${className || ''}`} onKeyDown={handleEnterToNextField}>
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <div className="flex items-center gap-3">
                    <span className="text-[10px] font-black uppercase tracking-widest">{isChallan ? 'Delivery Challan Entry' : 'Purchase Voucher Creation'}</span>
                    <button
                        type="button"
                        onClick={() => setIsJournalModalOpen(true)}
                        disabled={!canOpenJournalEntry || !isPostedVoucher}
                        title={isPostedVoucher ? 'View journal entry' : 'Journal not generated yet.'}
                        className="px-2 py-0.5 border border-white/60 text-white text-[9px] font-black uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        View Journal Entry
                    </button>
                    <button
                        type="button"
                        onClick={() => setIsSidebarCollapsed(prev => !prev)}
                        className="px-2 py-0.5 border border-white/60 text-white text-[9px] font-black uppercase tracking-widest hover:bg-white/10 transition-colors"
                    >
                        {isSidebarCollapsed ? 'Show Insights' : 'Hide Insights'}
                    </button>
                </div>
                <span className="text-[10px] font-black uppercase text-accent">No. {isEditing ? purchaseToEdit?.purchaseSerialId : (previewVoucherNumber || 'Loading...')}</span>
            </div>
            <div className="p-2 flex-1 flex flex-col gap-2 overflow-hidden">
                <div className="sticky top-0 z-30 p-2 bg-white dark:bg-card-bg border border-app-border rounded-none grid grid-cols-1 md:grid-cols-12 gap-2 items-end flex-shrink-0 min-h-[84px]">
                    {isFieldVisible('fieldDate') && (
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Date</label>
                            <input
                                ref={dateInputRef}
                                type="date"
                                value={date}
                                onChange={(e) => setDate(e.target.value)}
                                className="w-full border border-gray-400 p-2 text-sm font-bold outline-none disabled:bg-gray-50"
                                disabled={isReadOnly}
                            />
                        </div>
                    )}
                    {isFieldVisible('fieldInvoiceNo') && (
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Invoice #</label>
                            <input
                                ref={invoiceNumberInputRef}
                                type="text"
                                value={invoiceNumber}
                                onChange={(e) => { setInvoiceNumber(e.target.value); setInvoiceNumberError(null); }}
                                className={`w-full border p-2 text-sm font-bold uppercase outline-none disabled:bg-gray-50 ${invoiceNumberError ? 'border-red-500' : 'border-gray-400 focus:border-primary'}`}
                                placeholder="Supplier Inv #..."
                                disabled={isReadOnly}
                            />
                        </div>
                    )}
                    {isFieldVisible('fieldSupplier') && (
                        <div className="md:col-span-6 relative">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Particulars (Supplier Name)</label>
                            <input
                                ref={supplierNameInputRef}
                                type="text"
                                value={supplier}
                                autoComplete="off"
                                onChange={e => { setSupplier(e.target.value); setSupplierNameError(null); setIsSupplierDropdownOpen(true); }}
                                onKeyDown={handleSupplierKeyDown}
                                className={`w-full border p-2 text-sm font-bold uppercase outline-none disabled:bg-gray-50 ${supplierNameError ? 'border-red-500' : 'border-gray-400 focus:border-primary'}`}
                                placeholder="Enter for selection, Esc to skip..."
                                disabled={isReadOnly}
                            />
                            {isSupplierDropdownOpen && supplier.length > 0 && (
                                <div className="absolute top-full left-0 w-full bg-white border border-primary shadow-2xl z-[200] overflow-hidden rounded-none">
                                    {suppliers.filter(d => fuzzyMatch(d.name, supplier)).slice(0, 10).map((d, sIdx) => (
                                        <div
                                            key={d.id}
                                            onClick={() => handleSupplierSelect(d)}
                                            onMouseEnter={() => setSelectedSupplierIndex(sIdx)}
                                            className={`p-3 cursor-pointer flex justify-between items-center border-b border-gray-100 ${sIdx === selectedSupplierIndex ? 'bg-primary text-white' : 'hover:bg-gray-50'}`}
                                        >
                                            <span className="text-xs font-bold uppercase">{d.name}</span>
                                            <span className={`text-[9px] font-black ${sIdx === selectedSupplierIndex ? 'text-white' : 'text-primary opacity-50'}`}>Balance: ₹{(getOutstandingBalance(d) || 0).toFixed(2)}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {isFieldVisible('fieldSupplier') && (
                        <div className="md:col-span-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Phone</label>
                            <input
                                type="text"
                                value={supplierPhoneDisplay}
                                readOnly
                                className="w-full border p-2 text-sm font-bold outline-none border-gray-400 bg-gray-50 truncate"
                            />
                        </div>
                    )}
                </div>

                {!isEditing && !disableAIInput && !isManualEntry && (
                    <>
                    <div className="flex space-x-2 flex-shrink-0 px-2">
                        <button onClick={() => setIsWebcamModalOpen(true)} className="px-3 py-1.5 text-[10px] font-black uppercase bg-white text-primary border border-primary flex items-center gap-2 hover:bg-primary/5 transition-colors"><CameraIcon /> Webcam Scan</button>
                        <button onClick={() => { setMobileSyncStatus('pending'); setMobileSyncError(null); setMobilePageCount(0); setMobileInvoiceId(null); setMobileSyncSessionId(generateUUID()); }} className="px-3 py-1.5 text-[10px] font-black uppercase bg-white text-primary border border-primary flex items-center gap-2 hover:bg-primary/5 transition-colors"><SmartphoneIcon /> Mobile Sync</button>
                        <button onClick={handleSyncBill} disabled={!mobileSyncSessionId || isMobileSyncing} className="px-3 py-1.5 text-[10px] font-black uppercase bg-white text-primary border border-primary flex items-center gap-2 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">{isMobileSyncing ? <Spinner /> : <SmartphoneIcon />} Sync Bill</button>
                        <button onClick={() => fileInputRef.current?.click()} className="px-3 py-1.5 text-[10px] font-black uppercase bg-white text-primary border border-primary flex items-center gap-2 hover:bg-primary/5 transition-colors"><UploadIcon /> {isUploading ? <Spinner /> : 'Import Document'}</button>
                        <button
                            type="button"
                            onClick={() => {
                                if (!reconciliationModalVisible) return;
                                setIsLinkModalOpen(true);
                            }}
                            disabled={!items.some(item => (item.name || '').trim() && item.matchStatus !== 'matched')}
                            className="px-3 py-1.5 text-[10px] font-black uppercase bg-white text-primary border border-primary flex items-center gap-2 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Reconcile Again
                        </button>
                        <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="image/*,application/pdf" />
                    </div>

                    {(importWorkflowStage !== 'idle' || importWorkflowError) && (
                        <div className="mx-2 mt-2 border border-amber-300 bg-amber-50 px-3 py-2 flex flex-wrap items-center gap-2 text-[10px] font-black uppercase">
                            {importWorkflowStage !== 'idle' && (
                                <>
                                    <Spinner />
                                    <span className="text-amber-900">{getImportWorkflowLabel(importWorkflowStage)}</span>
                                </>
                            )}
                            {importWorkflowError && <span className="text-red-700 normal-case">{importWorkflowError}</span>}
                        </div>
                    )}

                    {!!mobileSyncSessionId && (
                        <div className="mx-2 mt-2 border border-primary/20 bg-primary/5 px-3 py-2 flex flex-wrap items-center gap-2 text-[10px] font-black uppercase">
                            <span className="text-gray-600">Mobile Sync Status:</span>
                            <span className="px-2 py-0.5 border border-primary text-primary bg-white">{getSyncStatusLabel(mobileSyncStatus)}</span>
                            {mobilePageCount > 0 && <span className="text-gray-500">Pages: {mobilePageCount}</span>}
                            {mobileInvoiceId && <span className="text-gray-500">Invoice ID: {mobileInvoiceId}</span>}
                            {mobileSyncError && <span className="text-red-600 normal-case">{mobileSyncError}</span>}
                        </div>
                    )}
                    </>
                )}

                <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white dark:bg-zinc-800">
                    <div ref={voucherGridRef} tabIndex={-1} className="flex-1 overflow-auto min-h-[200px]">
                        <table className="min-w-full border-collapse text-sm">
                            <thead className="sticky top-0 bg-gray-100 dark:bg-zinc-900 border-b border-gray-400 z-10">
                                <tr className="text-[10px] font-black uppercase text-gray-600 h-9">
                                    <th className="p-2 border-r border-gray-400 text-left w-10">Sl.</th>
                                    {isFieldVisible('colName') && <th className="p-2 border-r border-gray-400 text-left w-72">Name of Item</th>}
                                    {isFieldVisible('colBrand') && <th className="p-2 border-r border-gray-400 text-left w-24">MFR</th>}
                                    {isFieldVisible('colPack') && <th className="p-2 border-r border-gray-400 text-center w-16">Pack</th>}
                                    {isFieldVisible('colBatch') && <th className="p-2 border-r border-gray-400 text-center w-24">Batch</th>}
                                    {isFieldVisible('colExpiry') && <th className="p-2 border-r border-gray-400 text-center w-20">Expiry</th>}
                                    {isFieldVisible('colMrp') && <th className="p-2 border-r border-gray-400 text-right w-24">MRP</th>}
                                    {showPackQty && <th className="p-2 border-r border-gray-400 text-center w-16">P.Qty</th>}
                                    {showLooseQty && <th className="p-2 border-r border-gray-400 text-center w-16">L.Qty</th>}
                                    {isFieldVisible('colFree') && <th className="p-2 border-r border-gray-400 text-center w-16">FREE</th>}
                                    {isFieldVisible('colPurRate') && <th className="p-2 border-r border-gray-400 text-right w-24">Rate</th>}
                                    {isFieldVisible('colDisc') && <th className="p-2 border-r border-gray-400 text-center w-16">Disc%</th>}
                                    {isFieldVisible('colSch') && <th className="p-2 border-r border-gray-400 text-center w-16">SCH%</th>}
                                    {isFieldVisible('colGst') && <th className="p-2 border-r border-gray-400 text-center w-16">GST%</th>}
                                    {isFieldVisible('colAmount') && <th className="p-2 text-right w-32">Amount</th>}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {items.map((p, idx) => {
                                    const isActive = activeRowId === p.id;
                                    return (
                                        <tr 
                                            key={p.id} 
                                            onClick={() => setActiveRowId(p.id)}
                                            style={isActive ? { backgroundColor: '#004242', color: 'white' } : {}}
                                            className={`group h-10 cursor-pointer transition-colors ${isActive ? 'shadow-md' : 'hover:bg-primary hover:text-white'}`}
                                        >
                                            <td 
                                                className={`p-1 border-r border-gray-200 text-center cursor-pointer hover:bg-red-600 hover:text-white transition-colors group/del ${isActive ? 'text-white' : 'text-gray-400'} ${uniformTextStyle}`}
                                                onClick={(e) => { e.stopPropagation(); handleDeleteRow(p.id, idx); }}
                                                title="Click to delete this line item"
                                            >
                                                <span className="group-hover/del:hidden">{idx + 1}</span>
                                                <span className="hidden group-hover/del:inline">✕</span>
                                            </td>
                                            {isFieldVisible('colName') && (
                                                <td className={`p-1 border-r border-gray-200 uppercase relative min-w-[200px] ${uniformTextStyle} ${isActive ? 'text-white' : 'text-primary'}`}>
                                                    <input
                                                        type="text"
                                                        id={`name-${p.id}`}
                                                        value={p.name}
                                                        autoComplete="off"
                                                        readOnly
                                                        onFocus={() => {
                                                            setActiveRowId(p.id);
                                                            if (!isReadOnly && supplier.trim() && shouldOpenSearchForRow(p)) {
                                                                openSearchModal(p.id, p.name || '');
                                                            }
                                                        }}
                                                        onClick={() => {
                                                            if (!isReadOnly && supplier.trim() && shouldOpenSearchForRow(p)) {
                                                                openSearchModal(p.id, p.name || '');
                                                            }
                                                        }}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'name')}
                                                        className={`w-full bg-transparent outline-none ${shouldOpenSearchForRow(p) ? 'cursor-pointer' : 'cursor-default'} ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colBrand') && (
                                                <td className={`p-1 border-r border-gray-400 ${uniformTextStyle}`}>
                                                    <input
                                                        type="text"
                                                        id={`mfr-${p.id}`}
                                                        value={p.manufacturer || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'manufacturer', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'mfr')}
                                                        className={`w-full bg-transparent outline-none ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colPack') && (
                                                <td className={`p-1 border-r border-gray-200 text-center ${uniformTextStyle}`}>
                                                    <input
                                                        type="text"
                                                        id={`pack-${p.id}`}
                                                        value={p.packType}
                                                        readOnly
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'pack')}
                                                        className={`w-full text-center bg-transparent outline-none ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colBatch') && (
                                                <td className={`p-1 border-r border-gray-200 text-center font-mono uppercase ${uniformTextStyle}`}>
                                                    <input
                                                        type="text"
                                                        id={`batch-${p.id}`}
                                                        value={p.batch}
                                                        onChange={e => handleUpdateItem(p.id, 'batch', e.target.value.toUpperCase())}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'batch')}
                                                        className={`w-full text-center bg-transparent outline-none ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colExpiry') && (
                                                <td className={`p-1 border-r border-gray-200 text-center ${uniformTextStyle}`}>
                                                    <input
                                                        type="text"
                                                        id={`expiry-${p.id}`}
                                                        value={p.expiry}
                                                        onChange={e => handleUpdateItem(p.id, 'expiry', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'expiry')}
                                                        placeholder="MM/YY"
                                                        inputMode="numeric"
                                                        maxLength={5}
                                                        pattern="(0[1-9]|1[0-2])/[0-9]{2}"
                                                        className={`w-full text-center bg-transparent outline-none ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colMrp') && (
                                                <td className={`p-1 border-r border-gray-400 text-right font-mono whitespace-nowrap ${uniformTextStyle}`}>
                                                    <input
                                                        type="number"
                                                        id={`mrp-${p.id}`}
                                                        value={p.mrp || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'mrp', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'mrp')}
                                                        className={`w-full text-right bg-transparent outline-none no-spinner ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {showPackQty && (
                                                <td className={`p-1 border-r border-gray-400 text-center font-black ${uniformTextStyle}`}>
                                                    <input
                                                        type="number"
                                                        id={`qty-${p.id}`}
                                                        value={p.quantity || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'quantity', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'qty')}
                                                        className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {showLooseQty && (
                                                <td className={`p-1 border-r border-gray-400 text-center ${isActive ? 'text-white/80' : 'text-gray-500'} ${uniformTextStyle}`}>
                                                    <input
                                                        type="number"
                                                        id={`lqty-${p.id}`}
                                                        value={p.looseQuantity || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'looseQuantity', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'lqty')}
                                                        className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colFree') && (
                                                <td className={`p-1 border-r border-gray-400 text-center font-bold ${isActive ? 'text-emerald-300' : 'text-emerald-600'} ${uniformTextStyle}`}>
                                                    <input
                                                        type="number"
                                                        id={`free-${p.id}`}
                                                        value={p.freeQuantity || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'freeQuantity', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'free')}
                                                        className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colPurRate') && (
                                                <td className={`p-1 border-r border-gray-400 text-right font-bold ${isActive ? 'text-white' : 'text-blue-900'} ${uniformTextStyle}`}>
                                                    <input
                                                        type="number"
                                                        id={`rate-${p.id}`}
                                                        value={p.purchasePrice || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'purchasePrice', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'rate')}
                                                        className={`w-full text-right bg-transparent outline-none no-spinner font-mono ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colDisc') && (
                                                <td className={`p-1 border-r border-gray-200 text-center ${isActive ? 'text-red-300' : 'text-red-600'} ${uniformTextStyle}`}>
                                                    <input
                                                        type="number"
                                                        id={`disc-${p.id}`}
                                                        value={p.discountPercent || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'discountPercent', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'disc')}
                                                        className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colSch') && (
                                                <td className={`p-1 border-r border-gray-200 text-center ${isActive ? 'text-red-300' : 'text-red-600'} ${uniformTextStyle}`}>
                                                    <input
                                                        type="number"
                                                        id={`sch-${p.id}`}
                                                        value={p.schemeDiscountPercent || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'schemeDiscountPercent', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => handleGridKeyDown(e, p.id, 'sch')}
                                                        className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colGst') && (
                                                <td className={`p-1 border-r border-gray-400 text-center ${isActive ? 'text-gray-300' : 'text-gray-600'} ${uniformTextStyle}`}>
                                                    <input
                                                        type="number"
                                                        id={`gst-${p.id}`}
                                                        value={p.gstPercent || ''}
                                                        onChange={e => handleUpdateItem(p.id, 'gstPercent', e.target.value)}
                                                        onFocus={() => setActiveRowId(p.id)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') handleRateTierLastFieldEnter(e, p.id);
                                                            else handleGridKeyDown(e, p.id, 'gst');
                                                        }}
                                                        className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${isActive ? 'text-white placeholder:text-white/50 focus:bg-primary-dark' : 'focus:bg-yellow-100 focus:text-gray-900'} ${uniformTextStyle}`}
                                                        disabled={isReadOnly || !supplier.trim()}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colAmount') && <td className={`p-1 text-right font-black font-mono whitespace-nowrap ${isActive ? 'text-white' : 'text-gray-950'} ${uniformTextStyle}`}>₹{calculatePurchaseLineBaseAmount(p, purchaseLineAmountMode).toFixed(2)}</td>}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </Card>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-2 flex-shrink-0">
                    <div className="md:col-span-4 lg:col-span-5 bg-[#e5f0f0] px-3 py-2 tally-border !rounded-none shadow-sm min-h-[100px] xl:min-h-[140px] flex flex-col justify-center">
                        <div className="text-[11px] xl:text-[14px] font-bold uppercase space-y-1 xl:space-y-2">
                            <div className="flex border-b border-gray-300 pb-0.5"><span className="w-16 xl:w-24 text-gray-500">Item :</span> <span className="text-primary truncate">{activeIntelItem?.name || '-'}</span></div>
                            <div className="flex border-b border-gray-300 pb-0.5"><span className="w-16 xl:w-24 text-gray-500">Batch :</span> <span className="text-primary">{activeIntelItem?.batch || '-'}</span></div>
                            <div className="flex border-b border-gray-300 pb-0.5"><span className="w-16 xl:w-24 text-gray-500">Expiry :</span> <span className="text-primary">{activeIntelItem?.expiry || '-'}</span></div>
                            <div className="flex border-b border-gray-300 pb-0.5"><span className="w-16 xl:w-24 text-gray-500">Stock :</span> <span className="text-primary">{activeIntelItem?.stock ?? 0}</span></div>
                            <div className="flex"><span className="w-16 xl:w-24 text-gray-500">MRP :</span> <span className="text-primary">₹{(activeIntelItem?.mrp || 0).toFixed(2)}</span></div>
                        </div>
                    </div>

                    <div className="md:col-span-5 lg:col-span-4 bg-[#e5f0f0] px-3 py-2 tally-border !rounded-none shadow-sm min-h-[100px] xl:min-h-[140px]">
                        <div className="text-[10px] xl:text-[12px] font-black uppercase text-gray-500 mb-1 border-b border-gray-200 pb-1">Line Item Details</div>
                        <div className="grid grid-cols-1 xl:grid-cols-2 xl:gap-x-8 xl:gap-y-2 text-[11px] xl:text-[14px] font-bold uppercase">
                            <div className="space-y-1">
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>MRP Value</span><span>₹{(activeRowCalculations?.grossAmount || 0).toFixed(2)}</span></div>
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>Taxable Value</span><span>₹{(activeRowCalculations?.taxableValue || 0).toFixed(2)}</span></div>
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>Discount</span><span className="text-red-600">- ₹{(activeRowCalculations?.discount || 0).toFixed(2)}</span></div>
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>SGST ({(activeRowCalculations?.gstPercent || 0) / 2}%)</span><span>₹{(activeRowCalculations?.sgst || 0).toFixed(2)}</span></div>
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>CGST ({(activeRowCalculations?.gstPercent || 0) / 2}%)</span><span>₹{(activeRowCalculations?.cgst || 0).toFixed(2)}</span></div>
                                <div className="flex justify-between font-black text-blue-900 pt-1"><span>Line Net Amt</span><span>₹{(activeRowCalculations?.netAmount || 0).toFixed(2)}</span></div>
                            </div>
                        </div>
                    </div>

                    <div className="md:col-span-3 lg:col-span-3 bg-white p-2 tally-border !rounded-none shadow-sm min-h-[100px] xl:min-h-[140px]">
                        <div className="text-[10px] xl:text-[12px] font-black uppercase text-gray-500 mb-1 border-b border-gray-200 pb-1 flex justify-between"><span>Supplier Info</span> <span className="text-[8px] xl:text-[10px] text-primary bg-primary/10 px-1">ACTIVE</span></div>
                        <div className="text-[11px] xl:text-[14px] font-bold uppercase space-y-0.5 xl:space-y-1">
                            <div className="truncate">Area: <span className="text-gray-600">{currentsupplier?.area || '-'}</span></div>
                            <div className="truncate">Route: <span className="text-gray-600">{currentsupplier?.city || '-'}</span></div>
                            <div className="truncate">Last Purchase: <span className="text-gray-600">{lastPurchaseDate}</span></div>
                            <div className="text-[9px] xl:text-[11px] mt-1 text-gray-400">Last Payment: {lastPaymentDate}</div>
                        </div>
                    </div>

                    <div className="col-span-12 bg-[#255d55] px-2 py-1.5 text-white flex items-center gap-1 overflow-x-auto">
                        <div className="flex gap-1">
                            {isReadOnly ? (
                                <button
                                    onClick={handleDiscard}
                                    className="px-3 py-0.5 border border-white/40 text-[10px] font-black uppercase whitespace-nowrap hover:bg-white hover:text-[#255d55] transition-colors"
                                >
                                    CLOSE (Esc)
                                </button>
                            ) : (
                                ['SALE', 'PURC', 'SC', 'PC', 'COPY BILL', 'PASTE', 'SR', 'PR', 'CASH', 'HOLD', 'SAVE', 'PRINT', 'RETURN'].map(btn => (
                                    <button
                                        key={btn}
                                        onClick={async () => {
                                            if (btn === 'SAVE') {
                                                console.log('PurchaseForm: Save clicked');
                                                await triggerSaveAction();
                                            }
                                            if (btn === 'HOLD') {
                                                console.log('PurchaseForm: Hold clicked');
                                                await triggerSaveAction('hold');
                                            }
                                            if (btn === 'PRINT') {
                                                console.log('PurchaseForm: Print clicked');
                                                const activeItems = items.filter(p => (p.name || '').trim() !== '');
                                                if (!supplier.trim() || !invoiceNumber.trim() || activeItems.length === 0) {
                                                    addNotification("Please complete required fields (Supplier, Invoice #, Items) before printing.", "warning");
                                                    return;
                                                }
                                                const saved = await triggerSaveAction();
                                                if (saved) {
                                                    if (onPrint) onPrint(saved);
                                                }
                                            }
                                            if (btn === 'RETURN') handleDiscard();
                                        }}
                                        disabled={isSubmitting && (btn === 'SAVE' || btn === 'PRINT' || btn === 'HOLD')}
                                        className={`px-3 py-0.5 border border-white/40 text-[10px] font-black uppercase whitespace-nowrap transition-colors 
                                            ${btn === 'PURC' ? 'bg-white text-[#255d55]' : ''} 
                                            ${btn === 'HOLD' ? 'bg-amber-600 text-white border-amber-400' : ''}
                                            ${btn === 'SAVE' ? 'bg-emerald-700 text-white border-emerald-500' : ''}
                                            ${isSubmitting && (btn === 'SAVE' || btn === 'PRINT' || btn === 'HOLD') ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white hover:text-[#255d55]'}`}
                                    >
                                        {btn === 'HOLD' ? 'HOLD (F8/Alt+H)' : (btn === 'SAVE' ? 'SAVE (Ctrl+S)' : btn)}
                                    </button>
                                ))
                            )}
                        </div>
                        
                        <div className="ml-auto flex items-center gap-6 pr-2">
                            <div className="flex gap-4 border-r border-white/20 pr-6">
                                {isFieldVisible('sumGross') && (
                                    <div className="text-right">
                                        <div className="text-[9px] uppercase font-bold opacity-80">Gross</div>
                                        <div className="text-sm font-black">₹{(calculatedTotals.grossAmount || 0).toFixed(2)}</div>
                                    </div>
                                )}
                                {isFieldVisible('sumTradeDisc') && (
                                    <div className="text-right">
                                        <div className="text-[9px] uppercase font-bold opacity-80">Trade Disc</div>
                                        <div className="text-sm font-black text-red-300">₹{(calculatedTotals.totalItemDiscount || 0).toFixed(2)}</div>
                                    </div>
                                )}
                                {isFieldVisible('sumSchDisc') && (
                                    <div className="text-right">
                                        <div className="text-[9px] uppercase font-bold opacity-80">Sch Disc</div>
                                        <div className="text-sm font-black text-red-300">₹{(calculatedTotals.totalItemSchemeDiscount || 0).toFixed(2)}</div>
                                    </div>
                                )}
                                {isFieldVisible('sumTaxable') && (
                                    <div className="text-right">
                                        <div className="text-[9px] uppercase font-bold opacity-80">Taxable</div>
                                        <div className="text-sm font-black">₹{(calculatedTotals.subtotal || 0).toFixed(2)}</div>
                                    </div>
                                )}
                                {isFieldVisible('sumGst') && (
                                    <>
                                        <div className="text-right">
                                            <div className="text-[9px] uppercase font-bold opacity-80">SGST</div>
                                            <div className="text-sm font-black">₹{((calculatedTotals.totalGst || 0) / 2).toFixed(2)}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-[9px] uppercase font-bold opacity-80">CGST</div>
                                            <div className="text-sm font-black">₹{((calculatedTotals.totalGst || 0) / 2).toFixed(2)}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-[9px] uppercase font-bold opacity-80">Total GST</div>
                                            <div className="text-sm font-black">₹{(calculatedTotals.totalGst || 0).toFixed(2)}</div>
                                        </div>
                                    </>
                                )}
                            </div>
                            <div className="text-right">
                                <div className="text-[11px] uppercase font-bold">Purchase Total</div>
                                <div className="text-2xl font-black text-accent">₹{(calculatedTotals.grandTotal || 0).toFixed(2)}</div>
                            </div>
                        </div>
                    </div>
                </div>

            </div>

            {isWebcamModalOpen && <WebcamCaptureModal isOpen={isWebcamModalOpen} onClose={() => setIsWebcamModalOpen(false)} onCapture={handleWebcamCapture} />}
            {isAddSupplierModalOpen && <AddSupplierModal isOpen={isAddSupplierModalOpen} onClose={() => { setIsAddSupplierModalOpen(false); setSupplierQuickCreatePrefill(undefined); }} onAdd={onAddsupplier} onDuplicate={handleSupplierSelect} organizationId={organizationId} prefillData={supplierQuickCreatePrefill} />}
            {isAddMedicineMasterModalOpen && (
                <AddMedicineModal
                    isOpen={isAddMedicineMasterModalOpen}
                    onClose={() => setIsAddMedicineMasterModalOpen(false)}
                    onAddMedicine={onAddMedicineMaster}
                    onMedicineSaved={handleMedicineSavedFromPurchase}
                    initialName={modalSearchTerm.trim() || undefined}
                    organizationId={organizationId}
                />
            )}
            {isEditMaterialModalOpen && materialToEdit && (
                <EditMedicineModal
                    isOpen={isEditMaterialModalOpen}
                    onClose={() => {
                        setIsEditMaterialModalOpen(false);
                        setMaterialToEdit(null);
                        setMaterialEditRowId(null);
                    }}
                    medicine={materialToEdit}
                    onSave={handleUpdateMaterialFromPurchase}
                />
            )}
            {isLinkModalOpen && reconciliationModalVisible && reconciliationSupplier && (
                <LinkToMasterModal
                    isOpen={isLinkModalOpen} onClose={() => setIsLinkModalOpen(false)} supplier={reconciliationSupplier as any} medicines={medicines} mappings={mappings}
                    onLink={onSaveMapping}
                    scannedItems={(pendingReconciliationItems || items).filter(i => (i.name || "").trim())}
                    onFinalize={(reconciled) => {
                        commitVoucherDraftAndOpen(reconciled);
                        addNotification('Reconciliation completed. Items added to Purchase Voucher.', 'success');
                        requestAnimationFrame(() => voucherGridRef.current?.focus());
                    }}
                    onAddMedicineMaster={onAddMedicineMaster}
                    organizationId={organizationId}
                />
            )}
            {isSupplierLedgerModalOpen && supplierForLedger && <SupplierLedgerModal isOpen={isSupplierLedgerModalOpen} onClose={() => setIsSupplierLedgerModalOpen(false)} supplier={supplierForLedger} />}
            <MobileSyncModal isOpen={!!mobileSyncSessionId} onClose={() => setMobileSyncSessionId(null)} sessionId={mobileSyncSessionId} orgId={organizationId} userId={currentUser?.user_id || ''} deviceId={mobileSyncDeviceId} status={mobileSyncStatus} errorMessage={mobileSyncError} pageCount={mobilePageCount} invoiceId={mobileInvoiceId} />

            <Modal
                isOpen={isSearchModalOpen}
                onClose={() => { setIsSearchModalOpen(false); setIsInsightsOpen(false); }}
                title="Product selection Matrix"
            >
                <div className="flex flex-col h-full bg-[#fffde7] dark:bg-zinc-950 font-normal outline-none" onKeyDown={handleSearchKeyDown}>
                    <div className="py-1.5 px-4 bg-primary text-white flex-shrink-0 flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                            <span className="text-xs font-black uppercase tracking-[0.2em]">Material Discovery Engine</span>
                        </div>
                        <span className="text-[10px] font-bold uppercase opacity-70">↑/↓ Navigate | F4 Product Details | Enter Select | Ctrl+Enter New Material</span>
                    </div>

                    <div className="flex flex-1 overflow-hidden relative">
                        <div className="flex-1 flex flex-col overflow-hidden">
                            <div className="p-2 bg-white dark:bg-zinc-900 border-b-2 border-primary/10">
                                <input
                                    ref={modalSearchInputRef}
                                    type="text"
                                    value={modalSearchTerm}
                                    onChange={e => setModalSearchTerm(e.target.value)}
                                    onFocus={() => setIsKeywordFocused(true)}
                                    onBlur={() => setIsKeywordFocused(false)}
                                    placeholder="Type medicine name or code..."
                                    className={`w-full p-2 border-2 border-primary/20 bg-white text-base font-black focus:border-primary outline-none shadow-inner uppercase tracking-tighter`}
                                />
                                {isKeywordFocused && (
                                    <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-primary/80">F4: Product Details | Ctrl+Enter: Register Material</p>
                                )}
                            </div>

                            <div className="flex-1 overflow-auto bg-white" ref={searchResultsRef}>
                                {deduplicatedSearchInventory.length > 0 ? (
                                    <table className="min-w-full border-collapse">
                                        <thead className="sticky top-0 z-10 bg-gray-100 border-b border-gray-400 shadow-sm">
                                            <tr className={`text-[10px] font-black uppercase text-gray-500 tracking-widest`}>
                                                <th className="p-1.5 px-3 text-left border-r border-gray-200">Description of Medicine</th>
                                                <th className="p-1.5 px-3 text-left border-r border-gray-200 w-32 text-center">Code</th>
                                                <th className="p-1.5 px-3 text-left border-r border-gray-200">MFR / Brand</th>
                                                <th className="p-1.5 px-3 text-center border-r border-gray-200">Strips Stock</th>
                                                <th className="p-1.5 px-3 text-center border-r border-gray-200">Loose Stock</th>
                                                <th className="p-1.5 px-3 text-center border-r border-gray-200">Total Stock</th>
                                                <th className="p-1.5 px-3 text-right">MRP</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {deduplicatedSearchInventory.map((res, sIdx) => {
                                                const isSelected = sIdx === selectedSearchIndex;
                                                const item = res.item;
                                                const totalStock = res.batches.reduce((sum, batch) => sum + (batch.stock || 0), 0);
                                                const unitsPerPack = item.unitsPerPack || 1;
                                                const stripsStock = Math.floor(totalStock / unitsPerPack);
                                                const looseStock = totalStock % unitsPerPack;
                                                return (
                                                    <tr
                                                        key={item.id}
                                                        data-index={sIdx}
                                                        onClick={() => triggerBatchSelection(res)}
                                                        onMouseEnter={() => setSelectedSearchIndex(sIdx)}
                                                        className={`cursor-pointer transition-all border-b border-gray-100 ${isSelected ? 'bg-primary text-white scale-[1.01] z-10 shadow-xl' : 'hover:bg-yellow-50'}`}
                                                    >
                                                        <td className="p-1.5 px-3 border-r border-gray-200">
                                                            <p className={`leading-none ${matrixRowTextStyle} ${isSelected ? 'text-white' : 'text-gray-950'}`}>{item.name}</p>
                                                        </td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center font-mono ${matrixRowTextStyle} ${isSelected ? 'text-white' : 'text-primary'}`}>
                                                            {item.code}
                                                        </td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 ${matrixRowTextStyle} ${isSelected ? 'text-white/80' : 'text-gray-500'}`}>{item.manufacturer || item.brand}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (totalStock <= 0 ? 'text-red-500' : 'text-emerald-700')}`}>{stripsStock}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (totalStock <= 0 ? 'text-red-500' : 'text-emerald-700')}`}>{looseStock}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (totalStock <= 0 ? 'text-red-500' : 'text-emerald-700')}`}>{totalStock}</td>
                                                        <td className={`p-1.5 px-3 text-right ${matrixRowTextStyle} ${isSelected ? 'text-white' : 'text-gray-900'}`}>₹{(item.mrp || 0).toFixed(2)}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div className="h-full flex flex-col items-center justify-center opacity-20 p-20 text-center">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mb-6"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                                        <p className="text-4xl font-black uppercase tracking-widest">No Matches</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        <ProductInsightsPanel
                            isOpen={isInsightsOpen}
                            product={activeIntelItem}
                            purchases={purchases}
                            sales={salesHistory}
                            loading={isInsightsLoading}
                            onClose={() => setIsInsightsOpen(false)}
                        />

                        <div className="w-80 bg-[#f9f7d9] dark:bg-zinc-900 border-l-2 border-primary/10 flex flex-col overflow-y-auto">
                            {activeIntelItem ? (
                                <div className="flex-1 flex flex-col p-6 animate-in slide-in-from-right-4 duration-300">
                                    <div className="mb-8 pb-4 border-b border-primary/10">
                                        <div className="flex items-center gap-2 mb-4">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-primary"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                                            <span className="text-xs font-black uppercase tracking-[0.25em] text-primary">Intelligence Hub</span>
                                        </div>
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Current Stock Level</p>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-6xl font-black text-emerald-700 tracking-tighter">{activeIntelItem.stock}</span>
                                            <span className="text-xs font-bold text-emerald-600 uppercase">Units</span>
                                        </div>
                                    </div>

                                    <div className="space-y-6">
                                        <div className="bg-white/50 dark:bg-zinc-800/50 p-4 border border-primary/5 shadow-sm">
                                            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2 opacity-60">Identity & Validity</p>
                                            <p className="text-lg font-black text-gray-900 dark:text-white font-mono leading-none truncate">{activeIntelItem.batch} | {activeIntelItem.code}</p>
                                            <p className="text-[10px] font-bold text-gray-500 uppercase mt-1">Batch: {activeIntelItem.batch}</p>
                                            <p className="text-xs font-bold text-red-600 uppercase mt-2">Exp: {activeIntelItem.expiry ? String(activeIntelItem.expiry) : 'N/A'}</p>
                                        </div>

                                        <div className="bg-white/50 dark:bg-zinc-800/50 p-4 border border-primary/5 shadow-sm">
                                            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2 opacity-60">Pricing Vector</p>
                                            <div className="flex justify-between items-end">
                                                <div>
                                                    <p className="text-[10px] font-bold text-gray-400 uppercase">Pur Rate</p>
                                                    <p className="text-xl font-black text-blue-700">₹{(intelDetails?.lastPurRate ?? 0).toFixed(2)}</p>
                                                </div>
                                                <div className="text-right">
                                                    <p className="text-[10px] font-bold text-gray-400 uppercase">M.R.P</p>
                                                    <p className="text-xl font-black text-gray-900 dark:text-white">₹{(activeIntelItem.mrp || 0).toFixed(2)}</p>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="bg-white/50 dark:bg-zinc-800/50 p-4 border border-primary/5 shadow-sm">
                                            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-3 opacity-70">Profit Quotient</p>
                                            <div className="flex justify-between items-center mb-2">
                                                <span className="text-[11px] font-bold text-gray-500 uppercase">Net Margin</span>
                                                <span className="text-xl font-black text-emerald-600">{(intelDetails?.profitMargin ?? 0).toFixed(1)}%</span>
                                            </div>
                                            <div className="flex justify-between items-center">
                                                <span className="text-[11px] font-bold text-gray-500 uppercase">Per Unit</span>
                                                <span className="text-xl font-black text-emerald-600">₹{(intelDetails?.profitAmount ?? 0).toFixed(2)}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-auto pt-6 opacity-40">
                                        <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest text-center italic">Updated in Real-time</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center opacity-20">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-4"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
                                    <p className="text-xs font-black uppercase tracking-widest">Select item for live intelligence</p>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="p-4 bg-slate-100 border-t border-app-border flex justify-end gap-3 flex-shrink-0">
                        <button onClick={() => setIsSearchModalOpen(false)} className="px-8 py-3 text-[11px] font-black uppercase tracking-widest text-gray-500 hover:text-black">Discard (Esc)</button>
                        <button
                            onClick={() => {
                                const selection = deduplicatedSearchInventory[selectedSearchIndex];
                                if (selection) triggerBatchSelection(selection);
                            }}
                            className="px-16 py-4 bg-primary text-white text-[12px] font-black uppercase tracking-[0.3em] shadow-2xl active:translate-y-1 transform transition-all"
                        >
                            Select Material (Enter)
                        </button>
                    </div>
                </div>
            </Modal>

            <Modal isOpen={isRateTierModalOpen} onClose={skipTierRatesForRow} title="Maintain Tier Rates" widthClass="max-w-md">
                <div className="space-y-4 p-2">
                    <p className="text-xs font-bold text-gray-600 uppercase">Maintain Tier A / B / C rates for this product.</p>
                    <div className="grid grid-cols-1 gap-3">
                        <div>
                            <label className="text-[11px] font-bold uppercase text-gray-500">Rate A</label>
                            <input
                                ref={rateAInputRef}
                                type="number"
                                value={rateTierDraft.rateA}
                                onChange={(e) => setRateTierDraft(prev => ({ ...prev, rateA: e.target.value }))}
                                onKeyDown={(e) => handleRateInputEnter(e, 'rateB')}
                                className="w-full border border-gray-400 p-2 outline-none"
                            />
                        </div>
                        <div>
                            <label className="text-[11px] font-bold uppercase text-gray-500">Rate B</label>
                            <input
                                ref={rateBInputRef}
                                type="number"
                                value={rateTierDraft.rateB}
                                onChange={(e) => setRateTierDraft(prev => ({ ...prev, rateB: e.target.value }))}
                                onKeyDown={(e) => handleRateInputEnter(e, 'rateC')}
                                className="w-full border border-gray-400 p-2 outline-none"
                            />
                        </div>
                        <div>
                            <label className="text-[11px] font-bold uppercase text-gray-500">Rate C</label>
                            <input
                                ref={rateCInputRef}
                                type="number"
                                value={rateTierDraft.rateC}
                                onChange={(e) => setRateTierDraft(prev => ({ ...prev, rateC: e.target.value }))}
                                onKeyDown={(e) => handleRateInputEnter(e, 'action')}
                                className="w-full border border-gray-400 p-2 outline-none"
                            />
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            ref={skipRateButtonRef}
                            type="button"
                            onFocus={() => setSelectedRateTierAction('skip')}
                            onKeyDown={handleRateActionKeyDown}
                            onClick={skipTierRatesForRow}
                            className={`px-4 py-2 border text-xs font-black uppercase ${selectedRateTierAction === 'skip' ? 'border-primary text-primary' : 'border-gray-400 text-gray-700'}`}
                        >
                            Skip
                        </button>
                        <button
                            ref={saveRateButtonRef}
                            type="button"
                            onFocus={() => setSelectedRateTierAction('save')}
                            onKeyDown={handleRateActionKeyDown}
                            onClick={saveTierRatesForRow}
                            className={`px-4 py-2 text-xs font-black uppercase ${selectedRateTierAction === 'save' ? 'bg-primary text-white' : 'bg-gray-200 text-gray-700'}`}
                        >
                            Save Rates
                        </button>
                    </div>
                </div>
            </Modal>


            <SupplierSearchModal
                isOpen={isSupplierSearchModalOpen}
                onClose={() => setIsSupplierSearchModalOpen(false)}
                suppliers={suppliers}
                onSelect={handleSupplierSelect}
                onQuickCreateSupplier={handleQuickCreateSupplier}
                initialSearch={supplier}
            />

            <JournalEntryViewerModal
                isOpen={isJournalModalOpen}
                onClose={() => setIsJournalModalOpen(false)}
                invoiceId={purchaseToEdit?.id}
                invoiceNumber={purchaseToEdit?.invoiceNumber || invoiceNumber}
                documentType="PURCHASE"
                currentUser={currentUser}
                isPosted={isPostedVoucher}
            />
        </div>

        {!isSidebarCollapsed && (
            <div className="w-64 h-full bg-white flex flex-col overflow-hidden shadow-xl shrink-0 border-l border-gray-200">
                <div className="bg-gray-800 text-white h-7 flex items-center px-4 shrink-0">
                    <span className="text-[10px] font-black uppercase tracking-widest">Purchase Insights</span>
                </div>
                
                <div className="p-3 border-b border-gray-200 bg-gray-50 flex flex-col gap-2">
                    <div className="flex gap-2">
                        <div className="flex-1 bg-white p-2 border border-gray-300 shadow-sm">
                            <div className="text-[9px] font-bold text-gray-500 uppercase">This Month</div>
                            <div className="text-xs font-black text-primary">₹{stats.monthTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                        </div>
                        <div className="flex-1 bg-white p-2 border border-gray-300 shadow-sm">
                            <div className="text-[9px] font-bold text-gray-500 uppercase">Today</div>
                            <div className="text-xs font-black text-emerald-600">₹{stats.todayTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                        </div>
                    </div>
                    <div className="bg-white p-2 border border-gray-300 shadow-sm flex justify-between items-center">
                        <div className="text-[9px] font-bold text-gray-500 uppercase">Bills Count (MTD)</div>
                        <div className="text-sm font-black text-gray-800">{stats.monthCount}</div>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 bg-gray-50/50">
                    <div className="text-[10px] font-black text-gray-400 uppercase mb-2 ml-1">{currentsupplier ? 'Supplier History' : 'Last 20 Purchases'}</div>
                    <div className="space-y-1.5">
                        {historyItems.map((pur) => (
                            <div
                                key={pur.id}
                                onClick={() => handleHistoryPurchasePreview(pur)}
                                className={`p-2 border transition-colors cursor-pointer text-[11px] shadow-sm ${selectedHistoryPurchaseId === pur.id ? 'bg-teal-600/10 border-teal-600' : 'bg-white border-gray-200 hover:border-primary/50 hover:bg-emerald-50'}`}
                            >
                                <div className="flex justify-between items-start mb-0.5">
                                    <span className="font-black text-gray-800 uppercase truncate pr-2 flex-1" title={pur.supplier}>{pur.supplier}</span>
                                    <span className="shrink-0 font-black text-primary">₹{(pur.totalAmount || 0).toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between text-[9px] text-gray-400 font-bold uppercase">
                                    <span>{pur.invoiceNumber || pur.purchaseSerialId}</span>
                                    <span>{(pur.date || '').split('T')[0]}</span>
                                </div>
                            </div>
                        ))}
                        {historyItems.length === 0 && (
                            <div className="text-center py-10 text-gray-400 text-xs italic">No recent purchases</div>
                        )}
                    </div>
                </div>
            </div>
        )}

        {historyPreviewPurchase && (
            <Modal
                isOpen={!!historyPreviewPurchase}
                onClose={() => setHistoryPreviewPurchase(null)}
                title={`View Purchase: ${historyPreviewPurchase.purchaseSerialId}`}
            >
                <div className="h-[90vh] overflow-hidden flex flex-col">
                    <PurchaseForm
                        onAddPurchase={() => Promise.resolve()}
                        onUpdatePurchase={onUpdatePurchase}
                        inventory={inventory}
                        suppliers={suppliers}
                        medicines={medicines}
                        mappings={[]}
                        purchases={purchases}
                        purchaseToEdit={historyPreviewPurchase}
                        draftItems={null}
                        onClearDraft={() => {}}
                        currentUser={currentUser}
                        onAddMedicineMaster={onAddMedicineMaster}
                        onAddsupplier={async () => ({} as any)}
                        onSaveMapping={async (map) => onSaveMapping(map as SupplierProductMap)}
                        setIsDirty={() => {}}
                        addNotification={addNotification}
                        title="View Purchase"
                        configurations={configurations}
                        isReadOnly={true}
                        mobileSyncSessionId={null}
                        setMobileSyncSessionId={() => {}}
                        onCancel={() => setHistoryPreviewPurchase(null)}
                        onPrint={onPrint}
                        organizationId={organizationId}
                    />
                </div>
            </Modal>
        )}
    </div>
    );
});

export default PurchaseForm;
