
import React, { useState, useRef, useEffect, useMemo, useCallback, useImperativeHandle, forwardRef } from 'react';
import Card from '@core/components/ui/Card';
import SchemeModal from '../components/SchemeModal';
import SchemeCalculatorModal from '../components/SchemeCalculatorModal';
import Modal from '@core/components/ui/Modal';
import AddMedicineModal from '@modules/inventory/components/AddMedicineModal';
import AddProductModal from '@modules/inventory/components/AddProductModal';
import EditMedicineModal from '@modules/inventory/components/EditMedicineModal';
import AddCustomerModal from '@modules/customers/components/AddCustomerModal';
import BatchSelectionModal from '@modules/inventory/components/BatchSelectionModal';
import WebcamCaptureModal from '@modules/inventory/components/WebcamCaptureModal';
import CustomerSearchModal from '@modules/customers/components/CustomerSearchModal';
import JournalEntryViewerModal from '@modules/accounting/components/JournalEntryViewerModal';
import ProductInsightsPanel from '@modules/inventory/components/ProductInsightsPanel';
import { isDateInActiveFiscalYear, resolveFiscalYearConfig } from '@core/utils/fiscalYear';
import { extractPrescription } from '@core/services/geminiService';
import * as storage from '@core/services/storageService';
import { supabase } from '@core/db/supabaseClient';
import { InventoryItem, Customer, Transaction, BillItem, AppConfigurations, RegisteredPharmacy, Medicine, Purchase, FileInput, MasterPriceMaintainRecord, SalesChallan, DoctorMaster, OrganizationMember } from '@core/types';
import { handleEnterToNextField } from '@core/utils/navigation';
import { fuzzyMatch } from '@core/utils/search';
import { calculateCustomerReceivableBreakdown, formatExpiryToMMYY, getOutstandingBalance, parseNumber, checkIsExpired, formatVoucherNo } from '@core/utils/helpers';
import { calculateBillingTotals, resolveBillingSettings, calculateLineNetAmount, isRateFieldAvailable } from '@core/utils/billing';
import { extractPackMultiplier, isLiquidOrWeightPack, resolveUnitsPerStrip } from '@core/utils/pack';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';
import { evaluateCustomerCredit } from '@core/utils/creditControl';
import { getInventoryPolicy, getResolvedMedicinePolicy } from '@core/utils/materialType';

interface POSProps {
    inventory: InventoryItem[];
    purchases: Purchase[];
    medicines: Medicine[];
    customers: Customer[];
    transactions?: Transaction[];
    doctors?: DoctorMaster[];
    onSaveOrUpdateTransaction: (transaction: Transaction, isUpdate: boolean, nextCounter?: number) => Promise<void>;
    onPrintBill: (transaction: Transaction) => void;
    currentUser: RegisteredPharmacy | null;
    config: any;
    configurations: AppConfigurations;
    billType?: 'regular' | 'non-gst';
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    transactionToEdit?: Transaction | null;
    conversionDraft?: Transaction | null;
    isReadOnly?: boolean;
    onCancel?: () => void;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    onAddInventoryItem?: (item: Omit<InventoryItem, 'id'>) => Promise<InventoryItem>;
    onUpdateMedicineMaster?: (updatedMedicine: Medicine) => Promise<void>;
    onQuickAddCustomer?: (data: {
        name: string;
        phone?: string;
        address?: string;
        gstNumber?: string;
        customerGroup?: string;
    }) => Promise<{ customer: Customer; isDuplicate: boolean }>;
    onAddCustomer?: (data: Omit<Customer, 'id' | 'ledger' | 'organization_id'>, balance: number, date: string) => Promise<Customer | undefined>;
    teamMembers?: OrganizationMember[];
    defaultCustomerControlGlId?: string;
    onRefreshConfig?: () => void;
    openChallanExposure?: number;
    salesChallans?: SalesChallan[];
    isChallan?: boolean;
}

interface UploadedFile {
    id: string;
    data: string;
    type: 'image' | 'pdf';
    name: string;
}

type SchemeCalculationBasis = 'before_discount' | 'after_discount';

interface PendingSchemeApplication {
    itemId: string;
    schemeQty: number;
    mode: 'flat' | 'percent' | 'price_override' | 'free_qty' | 'qty_ratio';
    value: number;
    discountAmount: number;
    discountPercent: number;
    freeQuantity: number;
    schemeTotalQty?: number;
    schemeDisplayPercent?: number;
}

interface StockValidationIssue {
    itemId: string;
    itemName: string;
    batch: string;
    available: number;
    required: number;
    reason: 'insufficient' | 'no_stock' | 'batch_missing';
}

type PrescriptionAlertAction = 'proceed' | 'cancel';

const uniformTextStyle = "text-sm font-bold tracking-tight uppercase leading-tight";
const matrixRowTextStyle = "text-base font-bold tracking-tight uppercase leading-tight";
const NO_BATCH_PLACEHOLDERS = new Set(['', 'N/A', 'NA', 'NEW-STOCK', 'NEW-BATCH', 'UNSET', 'NO BATCH', 'NO-BATCH']);

const normalizeBatchToken = (batchNo?: string | null) => (batchNo || '').trim().toUpperCase();
const isRealBatch = (batchNo?: string | null) => !NO_BATCH_PLACEHOLDERS.has(normalizeBatchToken(batchNo));

const isGstInclusiveMrp = (taxBasis?: string) => taxBasis === 'I-Incl.MRP';

const calculateRateExcludingGst = (mrp: number, gstPercent: number): number => {
    const safeMrp = Number(mrp) || 0;
    const safeGst = Number(gstPercent) || 0;
    if (safeMrp <= 0) return 0;
    if (safeGst <= 0) return safeMrp;
    return parseFloat((safeMrp / (1 + (safeGst / 100))).toFixed(2));
};

const parseExpiryForSort = (expiry?: string | null): number => {
    const formatted = formatExpiryToMMYY(expiry || '');
    const [monthText, yearText] = formatted.split('/');
    const month = Number(monthText);
    const year = Number(yearText);
    if (!month || !year) return Number.MAX_SAFE_INTEGER;
    return (year * 100) + month;
};

const normalizeLookupToken = (value?: string | null): string => (value || '').trim().toLowerCase();
const isValidTenDigitPhone = (value?: string | null): boolean => /^\d{10}$/.test(String(value || '').trim());

const resolveSearchPriority = (item: InventoryItem, searchTerm: string): number => {
    const term = normalizeLookupToken(searchTerm);
    if (!term) return 5;

    const barcode = normalizeLookupToken(item.barcode);
    const code = normalizeLookupToken(item.code);
    const name = normalizeLookupToken(item.name);
    const manufacturer = normalizeLookupToken(item.manufacturer);
    const brand = normalizeLookupToken(item.brand);

    if (barcode && barcode === term) return 1;
    if (code && code.includes(term)) return 2;
    if (name && name.includes(term)) return 3;
    if ((brand && brand.includes(term)) || (manufacturer && manufacturer.includes(term))) return 4;
    return 5;
};

const resolveCustomerTierRate = (item: Pick<InventoryItem, 'rateA' | 'rateB' | 'rateC'>, customerTier?: Customer['defaultRateTier']): number | null => {
    if (customerTier === 'rateA' && Number(item.rateA) > 0) return Number(item.rateA);
    if (customerTier === 'rateB' && Number(item.rateB) > 0) return Number(item.rateB);
    if (customerTier === 'rateC' && Number(item.rateC) > 0) return Number(item.rateC);
    return null;
};

const resolveSalesRate = (
    item: Pick<InventoryItem, 'mrp' | 'gstPercent' | 'rateA' | 'rateB' | 'rateC'>,
    customerTier?: Customer['defaultRateTier']
): number => {
    const tierRate = resolveCustomerTierRate(item, customerTier);
    if (tierRate !== null) return tierRate;
    return calculateRateExcludingGst(item.mrp, item.gstPercent);
};

const medicinesMapCache = new WeakMap<Medicine[], {
    byId: Map<string, Medicine>;
    byCode: Map<string, Medicine>;
    byName: Map<string, Medicine[]>;
}>();

const getMedicineByIdOrCode = (medicines: Medicine[], id?: string, code?: string): Medicine | undefined => {
    let cached = medicinesMapCache.get(medicines);
    if (!cached) {
        const byId = new Map<string, Medicine>();
        const byCode = new Map<string, Medicine>();
        const byName = new Map<string, Medicine[]>();
        (medicines || []).forEach(m => {
            if (m.id) byId.set(m.id, m);
            const c = (m.materialCode || '').trim().toLowerCase();
            if (c && !byCode.has(c)) byCode.set(c, m);
            const n = (m.name || '').trim().toLowerCase();
            if (n) {
                let list = byName.get(n);
                if (!list) {
                    list = [];
                    byName.set(n, list);
                }
                list.push(m);
            }
        });
        cached = { byId, byCode, byName };
        medicinesMapCache.set(medicines, cached);
    }
    if (id) {
        const m = cached.byId.get(id);
        if (m) return m;
    }
    if (code) {
        const cleanCode = code.trim().toLowerCase();
        return cached.byCode.get(cleanCode);
    }
    return undefined;
};

const getMedicinesByName = (medicines: Medicine[], name: string): Medicine[] => {
    getMedicineByIdOrCode(medicines); // ensure cache built
    const cached = medicinesMapCache.get(medicines);
    return cached?.byName.get(name.trim().toLowerCase()) || [];
};

const resolveMedicineForInventoryItem = (
    medicines: Medicine[],
    item?: InventoryItem,
    billItemName?: string,
    billItemBrand?: string,
    inventoryItemId?: string
): Medicine | undefined => {
    getMedicineByIdOrCode(medicines); // ensure cache built
    if (item) {
        const materialId = (item as any).materialId || (item as any).material_id;
        if (materialId) {
            const med = getMedicineByIdOrCode(medicines, materialId);
            if (med) return med;
        }
        const code = (item.code || '').trim().toLowerCase();
        if (code) {
            const med = getMedicineByIdOrCode(medicines, undefined, code);
            if (med) return med;
        }
    }

    if (inventoryItemId && inventoryItemId.startsWith('MM-')) {
        const medId = inventoryItemId.substring(3);
        const med = getMedicineByIdOrCode(medicines, medId);
        if (med) return med;
    }

    const name = (item?.name || billItemName || '').trim().toLowerCase();
    const brand = (item?.brand || billItemBrand || '').trim().toLowerCase();
    if (name) {
        const matched = getMedicinesByName(medicines, name);
        if (matched.length > 0) {
            const best = matched.find(m => (m.brand || '').trim().toLowerCase() === brand);
            if (best) return best;
            return matched[0];
        }
    }

    return undefined;
};

const inventoryMapCache = new WeakMap<InventoryItem[], Map<string, InventoryItem>>();

const getInventoryItemById = (inventory: InventoryItem[], id?: string): InventoryItem | undefined => {
    if (!id) return undefined;
    let map = inventoryMapCache.get(inventory);
    if (!map) {
        map = new Map();
        (inventory || []).forEach(i => {
            if (i.id) map!.set(i.id, i);
        });
        inventoryMapCache.set(inventory, map);
    }
    return map.get(id);
};

const resolveActivePriceRecord = (batch: InventoryItem, medicines: Medicine[], transactionDate: string): MasterPriceMaintainRecord | null => {
    const normalizedCode = (batch.code || '').trim().toLowerCase();
    const effectiveDate = transactionDate || new Date().toISOString().slice(0, 10);
    const med = getMedicineByIdOrCode(medicines, undefined, normalizedCode);
    if (!med) return null;
    return (med.masterPriceMaintains || [])
        .filter(r =>
        r.status === 'active' &&
        effectiveDate >= r.validFrom &&
        effectiveDate <= r.validTo
        )
        .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0] || null;
};

const normalizePackConversion = (item: BillItem): BillItem => {
    const unitsPerPack = resolveUnitsPerStrip(item.unitsPerPack, item.packType);
    const isPackBasedItem = unitsPerPack > 1 && !isLiquidOrWeightPack(item.packType);

    const parsedPacks = Math.max(0, Math.floor(Number(item.quantity || 0)));
    const parsedLoose = Math.max(0, Math.floor(Number(item.looseQuantity || 0)));

    if (!isPackBasedItem) {
        return { ...item, quantity: parsedPacks, looseQuantity: parsedLoose };
    }

    const totalUnits = (parsedPacks * unitsPerPack) + parsedLoose;
    const normalizedPacks = Math.floor(totalUnits / unitsPerPack);
    const normalizedLoose = totalUnits % unitsPerPack;

    return {
        ...item,
        quantity: normalizedPacks,
        looseQuantity: normalizedLoose
    };
};

const createBlankItem = (): BillItem => ({
    id: crypto.randomUUID(),
    inventoryItemId: '',
    name: '',
    mrp: 0,
    quantity: 0,
    looseQuantity: 0,
    unit: 'pack',
    gstPercent: 0,
    discountPercent: 0,
    itemFlatDiscount: 0,
});

const getBilledQuantity = (item: BillItem): number => {
    const unitsPerPack = resolveUnitsPerStrip(item.unitsPerPack, item.packType);
    return Math.max(0, (item.quantity || 0) + ((item.looseQuantity || 0) / (unitsPerPack || 1)));
};

const getDisplaySchemePercent = (item?: Partial<BillItem> | null): number => {
    if (!item) return 0;
    if (typeof item.schemeDisplayPercent === 'number') return item.schemeDisplayPercent;
    return Number(item.schemeDiscountPercent || 0);
};

const recalculateSchemeFields = (item: BillItem): BillItem => {
    if (!item.schemeMode) return item;

    const billedQty = getBilledQuantity(item);
    const baseRate = Number(item.rate || item.mrp || 0);
    const gross = billedQty * baseRate;
    const tradeDiscountPercent = Number(item.discountPercent || 0);
    const tradeDiscountAmount = gross * (tradeDiscountPercent / 100);
    const flatDiscountAmount = Math.max(0, Number(item.itemFlatDiscount || 0));
    const afterTradeAmount = Math.max(0, gross - tradeDiscountAmount - flatDiscountAmount);
    const schemeBasis: SchemeCalculationBasis = item.schemeCalculationBasis === 'before_discount' ? 'before_discount' : 'after_discount';
    const schemeBaseAmount = schemeBasis === 'before_discount' ? gross : afterTradeAmount;
    const schemeUnitRate = billedQty > 0 ? (schemeBaseAmount / billedQty) : 0;
    const appliedQty = Math.max(0, Number(item.schemeQty || 0));
    const schemeValue = Math.max(0, Number(item.schemeValue || 0));
    const schemeTotalQty = Math.max(0, Number(item.schemeTotalQty || 0));

    let freeQuantity = 0;
    let calculatedTotalDiscount = 0;

    if (item.schemeMode === 'free_qty') {
        freeQuantity = Math.min(appliedQty, billedQty);
        calculatedTotalDiscount = freeQuantity * schemeUnitRate;
    } else if (item.schemeMode === 'qty_ratio' && schemeTotalQty > 0) {
        const applications = Math.floor(billedQty / schemeTotalQty);
        freeQuantity = applications * appliedQty;
        calculatedTotalDiscount = freeQuantity * schemeUnitRate;
    } else if (item.schemeMode === 'flat') {
        calculatedTotalDiscount = Math.min(appliedQty, billedQty) * schemeValue;
        freeQuantity = schemeUnitRate > 0 ? calculatedTotalDiscount / schemeUnitRate : 0;
    } else if (item.schemeMode === 'percent') {
        const effectiveQty = Math.min(appliedQty || billedQty, billedQty);
        calculatedTotalDiscount = Math.min(schemeBaseAmount, effectiveQty * (schemeUnitRate * (schemeValue / 100)));
        freeQuantity = schemeUnitRate > 0 ? calculatedTotalDiscount / schemeUnitRate : 0;
    } else if (item.schemeMode === 'price_override') {
        calculatedTotalDiscount = Math.min(appliedQty, billedQty) * Math.max(0, schemeUnitRate - schemeValue);
        freeQuantity = schemeUnitRate > 0 ? calculatedTotalDiscount / schemeUnitRate : 0;
    }

    const schemeDiscountAmount = Math.max(0, Math.min(calculatedTotalDiscount, afterTradeAmount));
    const schemeDiscountPercent = schemeBaseAmount > 0 ? (schemeDiscountAmount / schemeBaseAmount) * 100 : 0;

    return {
        ...item,
        freeQuantity,
        schemeDiscountAmount,
        schemeDiscountPercent,
    };
};

const POS = forwardRef<any, POSProps>(({
    inventory,
    purchases,
    medicines,
    customers,
    transactions = [],
    doctors = [],
    onSaveOrUpdateTransaction,
    onPrintBill,
    currentUser,
    config,
    configurations,
    billType = 'regular',
    addNotification,
    transactionToEdit,
    conversionDraft,
    isReadOnly,
    onCancel,
    onAddMedicineMaster,
    onAddInventoryItem,
    onUpdateMedicineMaster,
    onQuickAddCustomer,
    onAddCustomer,
    teamMembers = [],
    defaultCustomerControlGlId,
    onRefreshConfig,
    openChallanExposure = 0,
    salesChallans = [],
    isChallan = false
}, ref) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
    const [customerSearch, setCustomerSearch] = useState('');
    const [customerPhone, setCustomerPhone] = useState('');
    const [customerAddress, setCustomerAddress] = useState('');
    const billCategorySelectRef = useRef<HTMLSelectElement>(null);
    const customerSearchInputRef = useRef<HTMLInputElement>(null);
    const productSearchInputRef = useRef<HTMLInputElement>(null);
    const modalSearchInputRef = useRef<HTMLInputElement>(null);
    const searchResultsRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dateInputRef = useRef<HTMLInputElement>(null);
    const addressInputRef = useRef<HTMLInputElement>(null);
    const phoneInputRef = useRef<HTMLInputElement>(null);
    const doctorSearchInputRef = useRef<HTMLInputElement>(null);

    const [billCategory, setBillCategory] = useState<'Cash' | 'Credit'>('Cash');
    const [billMode, setBillMode] = useState<'GST' | 'EST'>(billType === 'non-gst' ? 'EST' : 'GST');
    const [referredBy, setReferredBy] = useState('');
    const [doctorId, setDoctorId] = useState<string | null>(null);
    const [isDoctorQuickAddOpen, setIsDoctorQuickAddOpen] = useState(false);
    const [isDoctorPickerOpen, setIsDoctorPickerOpen] = useState(false);
    const [doctorSearchTerm, setDoctorSearchTerm] = useState('');
    const [doctorHighlightedIndex, setDoctorHighlightedIndex] = useState(0);
    const [quickDoctorName, setQuickDoctorName] = useState('');
    const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
    const [cartItems, setCartItems] = useState<BillItem[]>([]);
    const [prescriptions, setPrescriptions] = useState<UploadedFile[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [reservedVoucherNumber, setReservedVoucherNumber] = useState<string | null>(null);
    const [isReservedPreview, setIsReservedPreview] = useState<boolean>(true);
    const [nextVoucherNumberHint, setNextVoucherNumberHint] = useState<number | null>(null);
    const lastReservedType = useRef<'sales-gst' | 'sales-non-gst' | 'sales-challan' | null>(null);
    const [isProcessingRx, setIsProcessingRx] = useState(false);
    const [isWebcamOpen, setIsWebcamOpen] = useState(false);
    const [lumpsumDiscount, setLumpsumDiscount] = useState<number>(0);
    const [adjustment, setAdjustment] = useState<number>(0);
    const [narration, setNarration] = useState<string>('');
    const [localPricingMode, setLocalPricingMode] = useState<'mrp' | 'rate'>(transactionToEdit?.pricingMode || configurations?.displayOptions?.pricingMode || 'mrp');
    const rateFieldAvailable = useMemo(() => isRateFieldAvailable(configurations), [configurations]);
    const activeDoctors = useMemo(
        () => doctors.filter(d => d.is_active !== false).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
        [doctors]
    );

    const filteredDoctors = useMemo(() => {
        const term = doctorSearchTerm.trim().toLowerCase();
        if (!term) return activeDoctors;
        return activeDoctors.filter((doctor) => {
            const doctorName = (doctor.name || '').toLowerCase();
            const mobile = (doctor.mobile || '').toLowerCase();
            return doctorName.includes(term) || mobile.includes(term);
        });
    }, [activeDoctors, doctorSearchTerm]);

    useEffect(() => {
        if (!isDoctorPickerOpen) return;
        setDoctorSearchTerm(referredBy || '');
        setDoctorHighlightedIndex(0);
        setTimeout(() => doctorSearchInputRef.current?.focus(), 0);
    }, [isDoctorPickerOpen, referredBy]);

    useEffect(() => {
        if (!rateFieldAvailable) {
            setLocalPricingMode('mrp');
        } else if (currentUser?.organization_type === 'Distributor') {
            setLocalPricingMode('rate');
        } else if (transactionToEdit?.pricingMode) {
            setLocalPricingMode(transactionToEdit.pricingMode);
        } else if (configurations?.displayOptions?.pricingMode) {
            setLocalPricingMode(configurations.displayOptions.pricingMode);
        }
    }, [currentUser?.organization_type, configurations?.displayOptions?.pricingMode, transactionToEdit?.pricingMode, rateFieldAvailable]);

    const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
    const [isAddMedicineMasterModalOpen, setIsAddMedicineMasterModalOpen] = useState(false);
    const [isAddInventoryModalOpen, setIsAddInventoryModalOpen] = useState(false);
    const [newlyCreatedMedicine, setNewlyCreatedMedicine] = useState<Medicine | null>(null);
    const [isInsightsOpen, setIsInsightsOpen] = useState(false);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(isChallan);
    useEffect(() => {
        setIsSidebarCollapsed(isChallan);
    }, [isChallan]);
    const [isKeywordFocused, setIsKeywordFocused] = useState(false);
    const [salesHistory, setSalesHistory] = useState<Transaction[]>([]);
    const [viewingHistorySale, setViewingHistorySale] = useState<Transaction | null>(null);
    const [historyPreviewLoadingId, setHistoryPreviewLoadingId] = useState<string | null>(null);
    const [stats, setStats] = useState({ monthTotal: 0, todayTotal: 0, monthCount: 0 });

    const fetchStats = useCallback(async () => {
        if (!currentUser) return;
        try {
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const tomorrowStart = new Date(todayStart);
            tomorrowStart.setDate(tomorrowStart.getDate() + 1);
            const todayStartIso = todayStart.toISOString();
            const tomorrowStartIso = tomorrowStart.toISOString();
            const startOfMonth = new Date();
            startOfMonth.setDate(1);
            const startOfMonthStr = startOfMonth.toISOString().slice(0, 10);

            let monthQuery = supabase
                .from('sales_bill')
                .select('total, date')
                .eq('organization_id', currentUser.organization_id)
                .in('status', ['completed', 'Completed'])
                .gte('date', startOfMonthStr);

            if (selectedCustomer?.id) {
                monthQuery = monthQuery.eq('customer_id', selectedCustomer.id);
            }

            let todayQuery = supabase
                .from('sales_bill')
                .select('total')
                .eq('organization_id', currentUser.organization_id)
                .in('status', ['completed', 'Completed'])
                .gte('date', todayStartIso)
                .lt('date', tomorrowStartIso);

            if (selectedCustomer?.id) {
                todayQuery = todayQuery.eq('customer_id', selectedCustomer.id);
            }

            const [{ data: todayData }, { data: monthData }] = await Promise.all([todayQuery, monthQuery]);

            const safeMonthData = monthData || [];
            if (safeMonthData.length || (todayData || []).length) {
                const monthTotal = safeMonthData.reduce((sum, s) => sum + (Number(s.total) || 0), 0);
                const todayTotal = (todayData || []).reduce((sum, s) => sum + (Number(s.total) || 0), 0);
                setStats({
                    monthTotal,
                    todayTotal,
                    monthCount: safeMonthData.length
                });
            }

            let historyQuery = supabase
                .from('sales_bill')
                .select('*')
                .eq('organization_id', currentUser.organization_id)
                .in('status', ['completed', 'Completed'])
                .order('created_at', { ascending: false })
                .limit(20);

            if (selectedCustomer?.id) {
                historyQuery = historyQuery.eq('customer_id', selectedCustomer.id);
            }

            const { data: recent } = await historyQuery;
            if (recent) setSalesHistory(recent.map(r => storage.toCamel(r)));
        } catch (e) {
            console.error('Error fetching stats:', e);
        }
    }, [currentUser, selectedCustomer?.id]);

    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    const handleOpenRecentSalePreview = useCallback(async (sale: Transaction) => {
        if (!sale?.id) return;

        if (!currentUser?.organization_id) {
            setViewingHistorySale(sale);
            return;
        }

        setHistoryPreviewLoadingId(sale.id);
        try {
            const { data, error } = await supabase
                .from('sales_bill')
                .select('*')
                .eq('organization_id', currentUser.organization_id)
                .eq('id', sale.id)
                .single();

            if (error) throw error;
            setViewingHistorySale(data ? storage.toCamel(data) : sale);
        } catch (error) {
            console.error('Error opening invoice preview from Last 20 Sales:', error);
            addNotification('Unable to open invoice preview. Please try again.', 'error');
        } finally {
            setHistoryPreviewLoadingId(null);
        }
    }, [addNotification, currentUser?.organization_id]);

    const [isInsightsLoading, setIsInsightsLoading] = useState(false);
    const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
    const [modalSearchTerm, setModalSearchTerm] = useState('');
    const [isEditMaterialModalOpen, setIsEditMaterialModalOpen] = useState(false);
    const [materialToEdit, setMaterialToEdit] = useState<Medicine | null>(null);
    const [materialEditRowId, setMaterialEditRowId] = useState<string | null>(null);
    const [isCustomerSearchModalOpen, setIsCustomerSearchModalOpen] = useState(false);
    const [isAddCustomerModalOpen, setIsAddCustomerModalOpen] = useState(false);
    const [pendingBatchSelection, setPendingBatchSelection] = useState<{ item: InventoryItem; batches: InventoryItem[] } | null>(null);
    const [schemeItem, setSchemeItem] = useState<BillItem | null>(null);
    const [roundOff, setRoundOff] = useState(0);
    const [isRoundOffManuallyEdited, setIsRoundOffManuallyEdited] = useState(false);
    const [isJournalModalOpen, setIsJournalModalOpen] = useState(false);
    const [isSchemeCalcOpen, setIsSchemeCalcOpen] = useState(false);
    const [activeSchemeCalcRowId, setActiveSchemeCalcRowId] = useState<string | null>(null);
    const [selectedRowIndex, setSelectedRowIndex] = useState(0);
    const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
    const [stockValidationIssues, setStockValidationIssues] = useState<StockValidationIssue[]>([]);
    const [isStockIssueModalOpen, setIsStockIssueModalOpen] = useState(false);
    const [isPrescriptionAlertOpen, setIsPrescriptionAlertOpen] = useState(false);
    const [prescriptionAlertShown, setPrescriptionAlertShown] = useState(false);
    const [pendingPrescriptionItemId, setPendingPrescriptionItemId] = useState<string | null>(null);

    const activeRowIdRef = useRef<string | null>(null);
    const isProcessingBarcodeRef = useRef(false);
    const lastProcessedBarcodeRef = useRef<{ token: string; timestamp: number } | null>(null);

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

    const isNonGst = billMode === 'EST';
    const canOpenJournalEntry = Boolean(transactionToEdit?.id);
    const isPostedVoucher = (transactionToEdit?.status || '') === 'completed';
    const strictStock = configurations.displayOptions?.strictStock ?? true;
    const enableNegativeStock = configurations.displayOptions?.enableNegativeStock ?? false;
    const shouldPreventNegativeStock = strictStock && !enableNegativeStock;

    const isFieldVisible = (fieldId: string) => config?.fields?.[fieldId] !== false;
    const isValidExpiry = useCallback((expiry: string) => /^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry), []);

    const formatExpiryForInput = useCallback((expiry: string | undefined | null) => {
        if (!expiry) return '';
        const formatted = formatExpiryToMMYY(expiry);
        return isValidExpiry(formatted) ? formatted : '';
    }, [isValidExpiry]);

    const normalizeExpiryInput = useCallback((value: string) => {
        const digits = value.replace(/\D/g, '').slice(0, 4);
        if (digits.length <= 2) {
            if (digits.length === 2 && parseInt(digits) > 12) return digits[0];
            return digits;
        }
        const month = digits.slice(0, 2);
        if (parseInt(month) > 12) return month[0];
        return `${month}/${digits.slice(2)}`;
    }, []);

    const isValidRateInput = useCallback((value: string) => {
        if (value === '') return true;
        return /^\d{0,6}(\.\d{0,2})?$/.test(value);
    }, []);

    const isBarcodeLikeGridEntry = useCallback((field: keyof BillItem, rawValue: string) => {
        const value = String(rawValue || '').trim();
        if (!value) return false;

        const guardedFields: Array<keyof BillItem> = [
            'quantity',
            'looseQuantity',
            'freeQuantity',
            'discountPercent',
            'gstPercent',
            'rate',
            'mrp',
            'itemFlatDiscount',
        ];
        if (!guardedFields.includes(field)) return false;

        const compact = value.replace(/\s+/g, '');
        const numericOnly = /^[0-9]+$/.test(compact);
        return numericOnly && compact.length >= 8;
    }, []);

    useEffect(() => {
        const handleGlobalKeyDown = () => {
            setHoveredRowId(null);
        };
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, []);

    const billingSettings = useMemo(() => resolveBillingSettings(configurations), [configurations]);

    const totals = useMemo(() => calculateBillingTotals({
        items: cartItems,
        billDiscount: lumpsumDiscount,
        isNonGst,
        configurations,
        organizationType: currentUser?.organization_type,
        pricingMode: localPricingMode
    }), [cartItems, lumpsumDiscount, isNonGst, configurations, currentUser?.organization_type, localPricingMode]);

    useEffect(() => {
        if (!isRoundOffManuallyEdited) {
            setRoundOff(totals.autoRoundOff);
        }
    }, [totals.autoRoundOff, isRoundOffManuallyEdited]);

    useEffect(() => {
        if (cartItems.length === 0) {
            setSelectedRowIndex(0);
            return;
        }

        setSelectedRowIndex(prev => Math.min(prev, cartItems.length - 1));
    }, [cartItems.length]);

    const grandTotal = useMemo(() => {
        return parseFloat((totals.baseTotal + roundOff + adjustment).toFixed(2));
    }, [totals.baseTotal, roundOff, adjustment]);

    const effectiveOpenChallanExposure = useMemo(() => {
        if (!selectedCustomer?.id) return Number(openChallanExposure || 0);
        const fromList = salesChallans
            .filter(challan => challan.customerId === selectedCustomer.id && challan.status === 'open')
            .reduce((sum, challan) => sum + Number(challan.totalAmount || 0), 0);
        return fromList || Number(openChallanExposure || 0);
    }, [salesChallans, selectedCustomer?.id, openChallanExposure]);

    const creditCheck = useMemo(() => evaluateCustomerCredit({
        customer: selectedCustomer,
        currentTransactionAmount: grandTotal,
        openChallanExposure: effectiveOpenChallanExposure,
        moduleName: 'POS'
    }), [selectedCustomer, grandTotal, effectiveOpenChallanExposure]);

    const hasPrescriptionItem = useMemo(() => {
        if (cartItems.length === 0) return false;
        return cartItems.some((item) => {
            const inventoryRow = getInventoryItemById(inventory, item.inventoryItemId);
            const medicine = resolveMedicineForInventoryItem(medicines, inventoryRow, item.name, item.brand, item.inventoryItemId);
            return !!medicine?.isPrescriptionRequired;
        });
    }, [cartItems, inventory, medicines]);


    const activeBillItem = useMemo(() => {
        if (cartItems.length === 0) return null;

        // Prioritize hovered row for insights
        if (hoveredRowId) {
            const match = cartItems.find(item => item.id === hoveredRowId);
            if (match) return match;
        }

        // Fallback to currently selected row index
        if (selectedRowIndex >= 0 && selectedRowIndex < cartItems.length) {
            return cartItems[selectedRowIndex];
        }

        return cartItems[cartItems.length - 1];
    }, [cartItems, hoveredRowId, selectedRowIndex]);

    const activeLineTotals = useMemo(() => {
        if (!activeBillItem) return null;
        return calculateBillingTotals({
            items: [activeBillItem],
            billDiscount: 0,
            isNonGst,
            configurations,
            organizationType: currentUser?.organization_type,
            pricingMode: localPricingMode
        });
    }, [activeBillItem, isNonGst, configurations, currentUser?.organization_type, localPricingMode]);

    const activeLineSummary = useMemo(() => {
        if (!activeBillItem || !activeLineTotals) return null;
        const effectiveSchemeRule = activeBillItem.schemeCalculationBasis || (billingSettings.schemeBase === 'subtotal' ? 'before_discount' : 'after_discount');
        const value = activeLineTotals.gross || 0;
        const discount = (activeLineTotals.tradeDiscount || 0) + (activeLineTotals.lineFlatDiscount || 0);
        const amountAfterDiscount = activeLineTotals.subtotal || 0;
        const schemeDiscount = activeLineTotals.schemeTotal || 0;
        const taxableValue = activeLineTotals.taxableValue || 0;
        const gst = activeLineTotals.tax || 0;
        const finalLineTotal = activeLineTotals.baseTotal || 0;

        return {
            rule: effectiveSchemeRule,
            value,
            discount,
            amountAfterDiscount,
            schemeDiscount,
            taxableValue,
            gst,
            finalLineTotal
        };
    }, [activeBillItem, activeLineTotals, billingSettings.schemeBase]);


    const customerSnapshot = useMemo(() => {
        if (!selectedCustomer) {
            return {
                area: '-',
                route: '-',
                collectionDays: '-',
                lastSale: '-',
                lastReceipt: '-',
                avgPaymentDays: '-'
            };
        }

        const customerTransactions = salesHistory
            .filter(tx => tx.customerId === selectedCustomer.id)
            .sort((a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime());

        const lastSale = customerTransactions[0];

        return {
            area: selectedCustomer.area || '-',
            route: selectedCustomer.assignedStaffName || '-',
            collectionDays: selectedCustomer.customerGroup || '-',
            lastSale: lastSale ? new Date(lastSale.date).toLocaleDateString('en-GB') : '-',
            lastReceipt: '-',
            avgPaymentDays: '-'
        };
    }, [selectedCustomer, salesHistory]);

    const activeStockSnapshot = useMemo(() => {
        if (!activeBillItem) return null;
        const matchingInventory = inventory.filter(inv => {
            if (activeBillItem.inventoryItemId && inv.id === activeBillItem.inventoryItemId) return true;
            return (inv.name || '').toLowerCase() === (activeBillItem.name || '').toLowerCase() && (inv.batch || '') === (activeBillItem.batch || '');
        });
        const selectedBatchInventory = matchingInventory[0];
        return {
            item: activeBillItem.name || '-',
            batch: activeBillItem.batch || selectedBatchInventory?.batch || '-',
            expiry: activeBillItem.expiry || formatExpiryToMMYY(selectedBatchInventory?.expiry || '') || '-',
            stock: selectedBatchInventory?.stock ?? 0,
            mrp: activeBillItem.mrp || selectedBatchInventory?.mrp || 0
        };
    }, [activeBillItem, inventory]);

    useEffect(() => {
        setBillMode(billType === 'non-gst' ? 'EST' : 'GST');
    }, [billType]);

    useEffect(() => {
        const sourceTx = transactionToEdit || conversionDraft;
        if (sourceTx) {
            setSelectedCustomer(customers.find(c => c.id === sourceTx.customerId) || null);
            setCustomerSearch(sourceTx.customerName || '');
            setCustomerPhone(sourceTx.customerPhone || '');
            setCustomerAddress((sourceTx as any).customerAddress || '');
            setReferredBy(sourceTx.referredBy || '');
            setDoctorId(sourceTx.doctorId || null);
            setInvoiceDate(sourceTx.date.split('T')[0]);
            setCartItems((sourceTx.items || []).map(item => {
                const normalizedItem = normalizePackConversion(item);
                if (!isGstInclusiveMrp(normalizedItem.taxBasis)) return normalizedItem;
                return {
                    ...normalizedItem,
                    rate: calculateRateExcludingGst(normalizedItem.mrp, normalizedItem.gstPercent),
                };
            }));
            setLumpsumDiscount(sourceTx.schemeDiscount || 0);
            setAdjustment(sourceTx.adjustment || 0);
            setNarration(sourceTx.narration || '');
            setRoundOff(sourceTx.roundOff || 0);
            setBillCategory(String(sourceTx.paymentMode || '').toLowerCase() === 'credit' ? 'Credit' : 'Cash');
            setIsRoundOffManuallyEdited(true);
        } else {
            setIsRoundOffManuallyEdited(false);
            setRoundOff(0);
            setAdjustment(0);
            setNarration('');
            setBillCategory('Cash');
            // Default focus to Date field as requested
            setTimeout(() => dateInputRef.current?.focus(), 150);
        }
    }, [transactionToEdit, conversionDraft, customers]);

    const currentInvoiceNo = useMemo(() => {
        if (transactionToEdit) return transactionToEdit.id;
        if (reservedVoucherNumber) return reservedVoucherNumber;
        return 'Reserving...';
    }, [transactionToEdit, reservedVoucherNumber]);

    const reserveNextVoucherNumber = useCallback(async (force: boolean = false, isPreview: boolean = true): Promise<{ documentNumber: string; nextNumber: number } | null> => {
        if (transactionToEdit || !currentUser) return null;
        
        const docType = isChallan ? 'sales-challan' : (isNonGst ? 'sales-non-gst' : 'sales-gst');
        
        // Prevent redundant reservation/preview if we already have a valid one for this type
        // However, if we're moving from preview to real reservation, we must force it
        if (!force && reservedVoucherNumber && lastReservedType.current === docType && isReservedPreview === isPreview) {
            return { documentNumber: reservedVoucherNumber, nextNumber: nextVoucherNumberHint || 0 };
        }

        try {
            const reservation = await storage.reserveVoucherNumber(docType, currentUser, isPreview);
            setReservedVoucherNumber(reservation.documentNumber);
            setNextVoucherNumberHint(reservation.nextNumber);
            setIsReservedPreview(isPreview);
            lastReservedType.current = docType;

            // If we just reserved a real number, we need to refresh the global config 
            // so other parts of the app know the counter has incremented.
            if (!isPreview && onRefreshConfig) {
                onRefreshConfig();
            }

            return { documentNumber: reservation.documentNumber, nextNumber: reservation.nextNumber };
        } catch (reservationError: any) {
            const errorMessage = reservationError?.message || 'Voucher reservation failed';
            addNotification(`Unable to reserve voucher number. ${errorMessage}`, 'error');
            return null;
        }
    }, [transactionToEdit, currentUser, isNonGst, isChallan, addNotification, reservedVoucherNumber, nextVoucherNumberHint, isReservedPreview, onRefreshConfig]);

    // Initial reservation and handling type switches - ALWAYS use preview mode here
    useEffect(() => {
        if (transactionToEdit || !currentUser) return;
        
        const docType = isChallan ? 'sales-challan' : (isNonGst ? 'sales-non-gst' : 'sales-gst');
        
        // If we don't have a number, or it's for a different type, fetch a preview
        if (!reservedVoucherNumber || lastReservedType.current !== docType) {
            // Set a placeholder to prevent immediate re-triggering while the request is in flight
            // or if it fails.
            if (!reservedVoucherNumber) {
                setReservedVoucherNumber('PENDING');
            }
            reserveNextVoucherNumber(false, true);
        }
    }, [transactionToEdit, currentUser, isNonGst, isChallan, reserveNextVoucherNumber, reservedVoucherNumber]);

    useEffect(() => {
        if (transactionToEdit || nextVoucherNumberHint === null) return;

        const configKey = isChallan ? 'salesChallanConfig' : (isNonGst ? 'nonGstInvoiceConfig' : 'invoiceConfig');
        const configCurrentNumber = Number((configurations[configKey] as any)?.currentNumber || 0);

        // Clear the local hint only after app configuration catches up to or moves beyond it.
        if (configCurrentNumber >= nextVoucherNumberHint) {
            setNextVoucherNumberHint(null);
        }
    }, [transactionToEdit, nextVoucherNumberHint, isNonGst, isChallan, configurations]);

    const getCustomerInvoiceOutstandingTotal = useCallback(async (customer: Customer): Promise<number> => {
        if (!currentUser?.organization_id) return 0;
        const allTransactions = await storage.getData('sales_bill', [{ organization_id: currentUser.organization_id }], currentUser) as Transaction[];
        const customerName = (customer.name || '').trim().toLowerCase();
        const sales = (allTransactions || [])
            .filter((t) => t && t.status !== 'cancelled')
            .filter((t) => t.customerId === customer.id || ((t.customerName || '').trim().toLowerCase() === customerName))
            .map((t) => ({
                id: t.id,
                invoiceNumber: String(t.invoiceNumber || '').trim().toLowerCase(),
                invoiceAmount: Number(t.total || 0),
                received: 0,
                balance: Number(t.total || 0),
                paymentMode: String(t.paymentMode || 'Credit').trim().toLowerCase(),
            }));

        if (sales.length === 0) return 0;

        const byInvoiceId = new Map(sales.map((row) => [row.id, row]));
        const byInvoiceNumber = new Map(sales.filter((row) => row.invoiceNumber).map((row) => [row.invoiceNumber, row.id]));
        const ledger = Array.isArray(customer.ledger) ? customer.ledger : [];
        const touchedInvoiceIds = new Set<string>();

        for (const entry of ledger) {
            if (!entry || entry.type !== 'payment' || (entry.status === 'cancelled' && entry.type !== 'payment')) continue;
            const entryCategory = String(entry.entryCategory || '');
            if (!['invoice_payment_adjustment', 'down_payment_adjustment', 'invoice_payment_adjustment_reversal', 'down_payment_adjustment_reversal'].includes(entryCategory)) continue;

            const invoiceId = entry.referenceInvoiceId || byInvoiceNumber.get(String(entry.referenceInvoiceNumber || '').trim().toLowerCase()) || '';
            const target = invoiceId ? byInvoiceId.get(invoiceId) : undefined;
            if (!target) continue;

            const adjustedAmount = Number(entry.adjustedAmount || 0);
            target.received += adjustedAmount;
            target.balance = Number((target.invoiceAmount - target.received).toFixed(2));
            if (target.balance < 0) target.balance = 0;
            touchedInvoiceIds.add(target.id);
        }

        for (const sale of sales) {
            if (touchedInvoiceIds.has(sale.id)) continue;
            if (['cash', 'card', 'upi', 'bank'].includes(sale.paymentMode)) {
                sale.balance = 0;
            }
        }

        return Number(sales.reduce((sum, row) => sum + Number(row.balance || 0), 0).toFixed(2));
    }, [currentUser]);

    const handleSave = useCallback(async (forcedStatus?: 'completed' | 'hold' | 'draft') => {
        if (isSaving || cartItems.length === 0) return;
        setIsSaving(true);

        const targetStatus = forcedStatus || 'completed';

        if (targetStatus === 'completed') {
            if (creditCheck && !creditCheck.canProceed) {
                const formatted = `Credit Limit ₹${creditCheck.details.creditLimit.toFixed(2)} | Outstanding ₹${creditCheck.details.currentOutstanding.toFixed(2)} | Open Challan ₹${creditCheck.details.openChallanExposure.toFixed(2)} | Bill ₹${creditCheck.details.currentTransactionAmount.toFixed(2)} | Projected ₹${creditCheck.details.projectedExposure.toFixed(2)}`;
                if (creditCheck.mode === 'warning_only') {
                    const proceed = window.confirm(`${creditCheck.message}\n\n${formatted}\n\nDo you want to continue?`);
                    if (!proceed) {
                        setIsSaving(false);
                        return;
                    }
                } else {
                    addNotification(`${creditCheck.message} ${formatted}`, 'error');
                    setIsSaving(false);
                    return;
                }
            }

            if (shouldPreventNegativeStock) {
                const issues: StockValidationIssue[] = [];
                const inventoryMapById = new Map<string, InventoryItem>();
                const inventoryGroupedByName = new Map<string, InventoryItem[]>();
                inventory.forEach(i => {
                    if (i.id) inventoryMapById.set(i.id, i);
                    const nameKey = (i.name || '').trim().toLowerCase();
                    if (nameKey) {
                        let list = inventoryGroupedByName.get(nameKey);
                        if (!list) {
                            list = [];
                            inventoryGroupedByName.set(nameKey, list);
                        }
                        list.push(i);
                    }
                });

                for (const item of cartItems) {
                    const normalizedBatch = (item.batch || '').trim();
                    const normalizedItemName = (item.name || '').trim().toLowerCase();
                    const normalizedItemBrand = (item.brand || '').trim().toLowerCase();
                    const currentInvItem = item.inventoryItemId ? inventoryMapById.get(item.inventoryItemId) : undefined;
                    const byNameRows = inventoryGroupedByName.get(normalizedItemName) || [];
                    const relatedInventoryRows = byNameRows.filter(i => {
                        const sameId = item.inventoryItemId && i.id === item.inventoryItemId;
                        const sameBrand = normalizedItemBrand === '' || (i.brand || '').trim().toLowerCase() === normalizedItemBrand;
                        return sameId || sameBrand;
                    });
                    if (currentInvItem && !relatedInventoryRows.some(i => i.id === currentInvItem.id)) {
                        relatedInventoryRows.unshift(currentInvItem);
                    }
                    const hasRealBatchStock = relatedInventoryRows.some(i => isRealBatch(i.batch));

                    let invItem: InventoryItem | undefined;
                    if (isRealBatch(normalizedBatch)) {
                        invItem = currentInvItem && isRealBatch(currentInvItem.batch)
                            ? currentInvItem
                            : relatedInventoryRows.find(i => isRealBatch(i.batch) && normalizeBatchToken(i.batch) === normalizeBatchToken(normalizedBatch));
                    } else {
                        invItem = (currentInvItem && !isRealBatch(currentInvItem.batch))
                            ? currentInvItem
                            : relatedInventoryRows.find(i => !isRealBatch(i.batch));
                    }

                    if (!normalizedBatch && hasRealBatchStock && !invItem) {
                        issues.push({
                            itemId: item.id,
                            itemName: item.name || 'Unknown Item',
                            batch: 'Not selected',
                            available: 0,
                            required: Math.max(0, Number(item.quantity || 0) + Number(item.looseQuantity || 0)),
                            reason: 'batch_missing',
                        });
                        continue;
                    }

                    if (!invItem) {
                        const displayBatch = isRealBatch(normalizedBatch) ? normalizedBatch : 'NO BATCH';
                        issues.push({
                            itemId: item.id,
                            itemName: item.name || 'Unknown Item',
                            batch: displayBatch,
                            available: 0,
                            required: Math.max(0, Number(item.quantity || 0) + Number(item.looseQuantity || 0)),
                            reason: 'no_stock',
                        });
                        continue;
                    }

                    const unitsPerPack = resolveUnitsPerStrip(invItem.unitsPerPack, invItem.packType);
                    const requiredUnits = Math.max(0, (Number(item.quantity || 0) * unitsPerPack) + Number(item.looseQuantity || 0));
                    const availableUnits = Math.max(0, Number(invItem.stock || 0));

                    if (availableUnits <= 0) {
                        const displayBatch = isRealBatch(normalizedBatch || invItem.batch) ? (normalizedBatch || invItem.batch || 'N/A') : 'NO BATCH';
                        issues.push({
                            itemId: item.id,
                            itemName: item.name || invItem.name || 'Unknown Item',
                            batch: displayBatch,
                            available: availableUnits,
                            required: requiredUnits,
                            reason: 'no_stock',
                        });
                        continue;
                    }

                    if (requiredUnits > availableUnits) {
                        const displayBatch = isRealBatch(normalizedBatch || invItem.batch) ? (normalizedBatch || invItem.batch || 'N/A') : 'NO BATCH';
                        issues.push({
                            itemId: item.id,
                            itemName: item.name || invItem.name || 'Unknown Item',
                            batch: displayBatch,
                            available: availableUnits,
                            required: requiredUnits,
                            reason: 'insufficient',
                        });
                    }
                }

                if (issues.length > 0) {
                    setStockValidationIssues(issues);
                    setIsStockIssueModalOpen(true);
                    const firstIssue = issues[0];
                    const firstIssueIndex = cartItems.findIndex(ci => ci.id === firstIssue.itemId);
                    if (firstIssueIndex >= 0) setSelectedRowIndex(firstIssueIndex);

                    if (issues.length === 1) {
                        const issue = issues[0];
                        const singleMessage = issue.reason === 'batch_missing'
                            ? `Please select batch for item: ${issue.itemName}`
                            : issue.reason === 'no_stock'
                                ? `No stock available for: Item: ${issue.itemName} | Batch: ${issue.batch}`
                                : `Insufficient stock for:\nItem: ${issue.itemName}\nBatch: ${issue.batch}\nAvailable: ${issue.available}\nRequired: ${issue.required}`;
                        addNotification(issue.reason === 'batch_missing' ? singleMessage : `Insufficient stock for ${issue.itemName}. Available: ${issue.available}, Required: ${issue.required}`, 'error');
                    } else {
                        addNotification(`Stock issue in ${issues.length} items. Click to view details.`, 'error');
                    }

                    setTimeout(() => {
                        const rowEl = document.getElementById(`cart-row-${firstIssue.itemId}`);
                        rowEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });

                        const preferredFieldId = firstIssue.reason === 'batch_missing'
                            ? `batch-${firstIssue.itemId}`
                            : `qty-p-${firstIssue.itemId}`;
                        const preferredField = document.getElementById(preferredFieldId) as HTMLInputElement | HTMLButtonElement | null;
                        preferredField?.focus();
                    }, 0);
                    setIsSaving(false);
                    return;
                }
                setStockValidationIssues([]);
                setIsStockIssueModalOpen(false);
            }
        }

        let generatedId = transactionToEdit?.id;
        let invoiceNumber = transactionToEdit?.invoiceNumber;
        let reservedNextNumber = nextVoucherNumberHint;

        // For new bills, we MUST perform a real reservation (isPreview: false) at the moment of save
        // to ensure we get a unique number and increment the counter atomically.
        if (!transactionToEdit) {
            const reservation = await reserveNextVoucherNumber(true, false);
            if (!reservation) {
                setIsSaving(false);
                return;
            }
            generatedId = crypto.randomUUID();
            invoiceNumber = reservation.documentNumber;
            reservedNextNumber = reservation.nextNumber;
        }

        if (!generatedId) {
            addNotification('Unable to determine voucher number for save.', 'error');
            setIsSaving(false);
            return;
        }

        if (hasPrescriptionItem) {
            addNotification('This bill contains prescription medicines. Customer details are required to continue.', 'warning');
            const organizationType = currentUser?.organization_type || 'Retail';
            const normalizedName = (customerSearch || selectedCustomer?.name || '').trim();
            const normalizedPhone = (customerPhone || selectedCustomer?.phone || '').trim();
            const normalizedAddress = (customerAddress || (selectedCustomer as any)?.address || '').trim();

            if (organizationType === 'Retail') {
                if (!normalizedName) {
                    addNotification("Customer Name is required for prescription medicines. Please enter the customer's name to proceed.", 'error');
                    setIsSaving(false);
                    return;
                }
                if (!normalizedAddress) {
                    addNotification('Customer Address is required for prescription medicines. Please enter the customer address to proceed.', 'error');
                    setIsSaving(false);
                    return;
                }
                if (!normalizedPhone) {
                    addNotification('Customer Phone Number is required for prescription medicines. Please enter a valid phone number.', 'error');
                    setIsSaving(false);
                    return;
                }
                if (!isValidTenDigitPhone(normalizedPhone)) {
                    addNotification('Please enter a valid 10-digit phone number for prescription medicines.', 'error');
                    setIsSaving(false);
                    return;
                }
            }

            if (organizationType === 'Distributor') {
                if (!selectedCustomer?.id) {
                    addNotification('Customer selection is required for prescription medicines. Please select a customer from Customer Master.', 'error');
                    setIsSaving(false);
                    return;
                }
                if ((customerSearch || '').trim() !== (selectedCustomer.name || '').trim()) {
                    addNotification('Manual customer entry is not allowed for prescription medicines. Please select a customer from the list.', 'error');
                    setIsSaving(false);
                    return;
                }
                if (!normalizedPhone) {
                    addNotification('Customer phone number is missing. Please update the customer details in Customer Master.', 'error');
                    setIsSaving(false);
                    return;
                }
            }
        }

        if (billCategory === 'Credit' && !selectedCustomer?.id) {
            addNotification('Customer selection is required for Credit bill.', 'error');
            setIsSaving(false);
            return;
        }

        if (!isDateInActiveFiscalYear(invoiceDate, configurations)) {
            addNotification('Selected date is outside the active fiscal year. Please select a valid date or change Fiscal Year Configuration.', 'error');
            setIsSaving(false);
            return;
        }

        const fyConfig = resolveFiscalYearConfig(configurations);
        if (fyConfig.lockPreviousFiscalYear && invoiceDate < fyConfig.fiscalYearStartDate) {
            addNotification('Previous fiscal year is locked. Voucher modifications are not allowed for that year.', 'error');
            setIsSaving(false);
            return;
        }

        const finalPaymentMode = billCategory === 'Credit' ? 'Credit' : 'Cash';
        const previousBalanceBeforeBill = selectedCustomer?.id
            ? calculateCustomerReceivableBreakdown(
                selectedCustomer,
                await getCustomerInvoiceOutstandingTotal(selectedCustomer)
            ).netOutstanding
            : 0;
        const balanceAfterBill = (finalPaymentMode === 'Credit' && targetStatus === 'completed')
            ? Number((previousBalanceBeforeBill + grandTotal).toFixed(2))
            : Number(previousBalanceBeforeBill.toFixed(2));

        const transaction: Transaction = {
            id: generatedId,
            invoiceNumber,
            organization_id: currentUser?.organization_id || '',
            user_id: currentUser?.user_id, // Clerk identifier for audit
            date: new Date(invoiceDate).toISOString(),
            customerName: selectedCustomer?.name || customerSearch || 'Walking Customer',
            customerId: selectedCustomer?.id,
            customerPhone: customerPhone || selectedCustomer?.phone,
            customerAddress: customerAddress || (selectedCustomer as any)?.address || '',
            referredBy: referredBy || '',
            doctorId: doctorId || null,
            items: cartItems,
            total: grandTotal,
            subtotal: parseFloat(totals.subtotal.toFixed(2)),
            totalItemDiscount: totals.tradeDiscount,
            totalGst: totals.tax,
            schemeDiscount: lumpsumDiscount,
            adjustment,
            narration,
            roundOff,
            status: targetStatus,
            paymentMode: finalPaymentMode,
            billType: isNonGst ? 'non-gst' : 'regular',
            itemCount: cartItems.length,
            pricingMode: localPricingMode,
            // p.data is the raw base64 payload (the data: URI prefix is stripped
            // before sending to Gemini). Re-wrap it as a full data URI so the
            // Sales History preview can render it with <img src>.
            prescriptionImages: prescriptions.map(p => {
                if (typeof p.data !== 'string') return p.data;
                if (p.data.startsWith('data:')) return p.data;
                const mime = p.type === 'pdf' ? 'application/pdf' : 'image/png';
                return `data:${mime};base64,${p.data}`;
            }),
            previousBalanceBeforeBill: Number(previousBalanceBeforeBill.toFixed(2)),
            balanceAfterBill,
            linkedChallans: conversionDraft?.linkedChallans || undefined,
        };

        try {
            await onSaveOrUpdateTransaction(transaction, !!transactionToEdit, reservedNextNumber ?? undefined);
            if (targetStatus === 'completed' && onPrintBill) onPrintBill(transaction);
            
            // Stats will refresh automatically via useEffect dependency on selectedCustomer change,
            // but we call it explicitly to be sure and to update global stats.
            fetchStats();
            resetForm();
            if (onCancel) {
                onCancel();
            } else {
                
                // Clear current reservation before getting next
                setReservedVoucherNumber(null);
                lastReservedType.current = null;
                
                if (!transactionToEdit) {
                    await reserveNextVoucherNumber(true);
                } else if (reservedNextNumber) {
                    setNextVoucherNumberHint(reservedNextNumber);
                }
            }
        } catch (e: any) {
            console.error("POS Save failure:", e);
            if (e.message?.includes('already exists')) {
                setReservedVoucherNumber(null);
                setNextVoucherNumberHint(null);
                lastReservedType.current = null;
            }
            addNotification("Failed to save: " + e.message, "error");
        } finally {
            setIsSaving(false);
        }
    }, [cartItems, totals, selectedCustomer, invoiceDate, configurations, isNonGst, isSaving, onSaveOrUpdateTransaction, transactionToEdit, currentUser, customerSearch, customerPhone, onPrintBill, addNotification, lumpsumDiscount, billCategory, referredBy, prescriptions, shouldPreventNegativeStock, inventory, roundOff, grandTotal, reservedVoucherNumber, nextVoucherNumberHint, reserveNextVoucherNumber, creditCheck, doctorId, narration, adjustment, getCustomerInvoiceOutstandingTotal, onCancel, fetchStats, hasPrescriptionItem]);

    const resetForm = useCallback(() => {
        setCartItems([]);
        setPrescriptions([]);
        setSelectedCustomer(null);
        setCustomerSearch('');
        setCustomerPhone('');
        setCustomerAddress('');
        setReferredBy('');
        setDoctorId(null);
        setLumpsumDiscount(0);
        setAdjustment(0);
        setNarration('');
        setRoundOff(0);
        setIsRoundOffManuallyEdited(false);
        setReservedVoucherNumber(null);
        setNextVoucherNumberHint(null);
        lastReservedType.current = null;
        setPrescriptionAlertShown(false);
        setIsPrescriptionAlertOpen(false);
        setPendingPrescriptionItemId(null);
    }, []);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isCustomerSearchModalOpen || schemeItem || pendingBatchSelection || isSearchModalOpen || isSchemeCalcOpen || isAddCustomerModalOpen || isEditMaterialModalOpen) return;
            
            if (!shouldHandleScreenShortcut(e, ['pos', 'nonGstPos'], { allowWhenInputFocused: true })) return;
            if (e.ctrlKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                handleSave();
                return;
            }

            const activeTag = document.activeElement?.tagName.toLowerCase();
            const isInputFocused = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || (activeTag === 'button' && (document.activeElement?.id?.includes('-') || (document.activeElement as HTMLElement)?.innerText?.includes('Apply')));

            if (!isInputFocused && cartItems.length > 0) {
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSelectedRowIndex(prev => Math.max(0, prev - 1));
                    return;
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSelectedRowIndex(prev => Math.min(cartItems.length - 1, prev + 1));
                    return;
                } else if (e.key === 'Delete') {
                    e.preventDefault();
                    const item = cartItems[selectedRowIndex];
                    if (item) {
                        handleDeleteRow(item.id, selectedRowIndex);
                    }
                    return;
                } else if (e.key === 'Enter') {
                    const item = cartItems[selectedRowIndex];
                    if (item) {
                        e.preventDefault();
                        focusFirstEditableFieldInRow(item.id);
                    }
                    return;
                }
            }

            switch (e.key) {
                case 'Escape':
                    e.preventDefault();
                    if (isSearchModalOpen) {
                        setIsSearchModalOpen(false);
                        setIsInsightsOpen(false);
                    } else if (isCustomerSearchModalOpen) {
                        setIsCustomerSearchModalOpen(false);
                    } else if (isAddCustomerModalOpen) {
                        setIsAddCustomerModalOpen(false);
                    } else if (onCancel) {
                        onCancel();
                    }
                    return;
                case 'F2':
                    e.preventDefault();
                    setIsCustomerSearchModalOpen(true);
                    return;
                case 'F3':
                    e.preventDefault();
                    productSearchInputRef.current?.focus();
                    return;
                case 'F5':
                    e.preventDefault();
                    if (cartItems.length > 0) {
                        const last = cartItems[cartItems.length - 1];
                        const batches = inventory.filter(inv => inv.name === last.name && getInventoryPolicy(inv, medicines).salesEnabled).sort((a, b) => parseExpiryForSort(String(a.expiry || '')) - parseExpiryForSort(String(b.expiry || '')));
                        if (batches.length > 0) triggerBatchSelection({ item: batches[0], batches });
                    }
                    return;
                case 'F6':
                    e.preventDefault();
                    if (cartItems.length > 0) {
                        const targetItem = cartItems[cartItems.length - 1];
                        setSchemeItem(targetItem);
                    }
                    return;
                case 'F8':
                    e.preventDefault();
                    if (transactionToEdit) onPrintBill(transactionToEdit);
                    return;
                case 'F10':
                    e.preventDefault();
                    handleSave();
                    return;
                default:
                    return;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleSave, cartItems, inventory, customerSearch, customerPhone, billMode, billCategory, invoiceDate, referredBy, addNotification, isCustomerSearchModalOpen, schemeItem, pendingBatchSelection, isSearchModalOpen, isEditMaterialModalOpen]);

    useImperativeHandle(ref, () => ({
        handleSave,
        resetForm,
        setCartItems,
        cartItems,
        isDirty: cartItems.length > 0 || customerPhone.trim() !== '' || referredBy.trim() !== ''
    }), [handleSave, resetForm, cartItems, customerPhone, referredBy]);


    const handleProcessPrescription = async (fileInput: FileInput, fileName: string) => {
        setIsProcessingRx(true);
        try {
            const result = await extractPrescription(fileInput, currentUser?.pharmacy_name || 'Medimart');
            if (result.error) throw new Error(result.error);

            if (result.customerName && !selectedCustomer) {
                setCustomerSearch(result.customerName);
            }

            if (result.items && result.items.length > 0) {
                const newBillItems: BillItem[] = [];
                const salesEnabledInventory = inventory.filter(inv => getInventoryPolicy(inv, medicines).salesEnabled);
                for (const aiItem of result.items) {
                    const match = salesEnabledInventory.find(inv => fuzzyMatch(inv.name, aiItem.name));
                    if (match) {
                        const unitsPerPack = match.unitsPerPack || 1;
                        const qty = Math.floor((aiItem.quantity || 0) / unitsPerPack);
                        const loose = (aiItem.quantity || 0) % unitsPerPack;

                        newBillItems.push({
                            id: crypto.randomUUID(),
                            inventoryItemId: match.id,
                            name: match.name,
                            brand: match.brand,
                            mrp: match.mrp,
                            quantity: qty || 1,
                            looseQuantity: loose,
                            unit: 'pack',
                            gstPercent: match.gstPercent,
                            discountPercent: selectedCustomer?.defaultDiscount || 0,
                            itemFlatDiscount: 0,
                            batch: match.batch,
                            expiry: match.expiry,
                            taxBasis: match.taxBasis,
                            rate: resolveSalesRate(match, selectedCustomer?.defaultRateTier),
                            unitsPerPack,
                            packType: match.packType
                        });
                    } else {
                        newBillItems.push({
                            ...createBlankItem(),
                            name: aiItem.name || 'Unknown Item',
                            quantity: aiItem.quantity || 1
                        });
                    }
                }
                setCartItems(prev => [...prev.filter(i => i.name !== ''), ...newBillItems.map(normalizePackConversion)]);
                addNotification(`Extracted ${result.items.length} items from prescription.`, "success");
            }

            setPrescriptions(prev => [...prev, {
                id: crypto.randomUUID(),
                data: fileInput.data,
                type: fileInput.mimeType.includes('pdf') ? 'pdf' : 'image',
                name: fileName
            }]);
        } catch (err: any) {
            addNotification("Prescription analysis failed. Adding as attachment only.", "warning");
            setPrescriptions(prev => [...prev, {
                id: crypto.randomUUID(),
                data: fileInput.data,
                type: fileInput.mimeType.includes('pdf') ? 'pdf' : 'image',
                name: fileName
            }]);
        } finally {
            setIsProcessingRx(false);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { files } = e.target;
        if (!files) return;
        Array.from(files).forEach((file: File) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = (reader.result as string).split(',')[1];
                handleProcessPrescription({ data: base64, mimeType: file.type }, file.name);
            };
            reader.readAsDataURL(file);
        });
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleWebcamCapture = (data: string, mimeType: string) => {
        handleProcessPrescription({ data, mimeType }, `Camera_${Date.now()}.jpg`);
        setIsWebcamOpen(false);
    };

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
            if (!policy.salesEnabled) return;

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
            const manufacturer = (i.manufacturer || '').toLowerCase();
            
            if (!term || name.includes(term) || code.includes(term) || barcode.includes(term) || brand.includes(term) || manufacturer.includes(term)) {
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
            if (!medPolicy.salesEnabled) return;

            const name = m.name.toLowerCase();
            const materialCode = (m.materialCode || '').toLowerCase();
            const barcode = (m.barcode || '').toLowerCase();
            const brand = (m.brand || '').toLowerCase();
            const manufacturer = (m.manufacturer || '').toLowerCase();

            if (!term || name.includes(term) || materialCode.includes(term) || barcode.includes(term) || brand.includes(term) || manufacturer.includes(term)) {
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
                        unitsPerPack: parseInt(m.pack?.match(/\d+/)?.[0] || '10', 10),
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
                const priorityA = resolveSearchPriority(a.item, term);
                const priorityB = resolveSearchPriority(b.item, term);
                if (priorityA !== priorityB) return priorityA - priorityB;

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

    const tryAutoPickByBarcode = useCallback((rawValue: string): boolean => {
        const token = normalizeLookupToken(rawValue);
        if (!token) return false;

        const exactMatches = deduplicatedSearchInventory.filter(wrapper => {
            const itemBarcode = normalizeLookupToken(wrapper.item.barcode);
            const batchBarcodeMatch = wrapper.batches.some(batch => normalizeLookupToken(batch.barcode) === token);
            return itemBarcode === token || batchBarcodeMatch;
        });

        if (exactMatches.length === 1) {
            triggerBatchSelection(exactMatches[0]);
            return true;
        }

        if (exactMatches.length > 1) {
            addNotification('Duplicate barcode found. Please select product manually.', 'warning');
            return true;
        }

        return false;
    }, [addNotification, deduplicatedSearchInventory]);

    const processBarcodeScanFromMatrix = useCallback((rawValue: string): boolean => {
        const token = normalizeLookupToken(rawValue);
        if (!token) return false;

        if (isProcessingBarcodeRef.current) return true;

        const lastProcessed = lastProcessedBarcodeRef.current;
        const now = Date.now();
        if (lastProcessed && lastProcessed.token === token && (now - lastProcessed.timestamp) < 500) {
            return true;
        }

        const scannedByBarcode = tryAutoPickByBarcode(token);
        if (!scannedByBarcode) return false;

        isProcessingBarcodeRef.current = true;
        lastProcessedBarcodeRef.current = { token, timestamp: now };
        setModalSearchTerm('');

        window.setTimeout(() => {
            isProcessingBarcodeRef.current = false;
        }, 250);

        return true;
    }, [tryAutoPickByBarcode]);

    const activeIntelItem = useMemo(() => {
        if (isSearchModalOpen && deduplicatedSearchInventory.length > 0) {
            return deduplicatedSearchInventory[selectedSearchIndex]?.item;
        }
        return null;
    }, [isSearchModalOpen, deduplicatedSearchInventory, selectedSearchIndex]);

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
            const typedName = modalSearchTerm.trim();
            if (!typedName) {
                addNotification('Please type product name first to create new material.', 'warning');
                return;
            }
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
            if (processBarcodeScanFromMatrix(modalSearchTerm)) {
                return;
            }
            const selectedWrapper = deduplicatedSearchInventory[selectedSearchIndex];
            if (selectedWrapper) triggerBatchSelection(selectedWrapper);
        }
    };

    const handleCreateMaterialFromMatrixKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            const typedName = modalSearchTerm.trim();
            if (!typedName) {
                addNotification('Please type product name first to create new material.', 'warning');
                return;
            }
            setIsAddMedicineMasterModalOpen(true);
        }
    };

    const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            customerSearchInputRef.current?.focus();
        }
    };

    const handleCustomerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            if (!onAddCustomer) {
                addNotification('Full customer registration is not available in this screen.', 'warning');
                return;
            }
            if (!customerSearch.trim()) {
                addNotification('Enter customer name before registering.', 'warning');
                return;
            }
            const exactMatch = customers.find(c => (c.name || '').trim().toLowerCase() === customerSearch.trim().toLowerCase());
            if (exactMatch) {
                setIsCustomerSearchModalOpen(true);
                addNotification(`Customer "${exactMatch.name}" already exists. Please select from suggestions.`, 'warning');
                return;
            }
            setIsAddCustomerModalOpen(true);
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            setIsCustomerSearchModalOpen(true);
        } else if (e.key === 'Escape') {
            // User doesn't want to select customer, move to next field
            e.preventDefault();
            addressInputRef.current?.focus();
        }
    };

    const handleAddCustomerModalSave = async (data: Omit<Customer, 'id' | 'ledger' | 'organization_id'>, balance: number, date: string) => {
        if (!onAddCustomer) return;
        try {
            const newCust = await onAddCustomer(data, balance, date);
            if (newCust) {
                handleSelectCustomer(newCust);
            }
            setIsAddCustomerModalOpen(false);
        } catch (error) {
            console.error('Failed to add customer from modal:', error);
        }
    };

    const handleSelectCustomer = (c: Customer) => {
        setSelectedCustomer(c);
        setCustomerSearch(c.name);
        setCustomerPhone(c.phone || '');
        setCustomerAddress((c as any).address || '');
        setIsCustomerSearchModalOpen(false);

        // Move to next field (Phone input)
        setTimeout(() => {
            addressInputRef.current?.focus();
        }, 100);
    };

    const sortBatchesForSelection = (batches: InventoryItem[]) => {
        return [...batches].sort((a, b) => {
            const qtyA = Number((a as any).availableQty ?? (a as any).available_qty ?? a.stock ?? 0);
            const qtyB = Number((b as any).availableQty ?? (b as any).available_qty ?? b.stock ?? 0);

            const aHasStock = qtyA > 0;
            const bHasStock = qtyB > 0;

            if (aHasStock && !bHasStock) return -1;
            if (!aHasStock && bHasStock) return 1;

            const expA = parseExpiryForSort(a.expiry ? String(a.expiry) : '');
            const expB = parseExpiryForSort(b.expiry ? String(b.expiry) : '');
            return expA - expB;
        });
    };
    const triggerBatchSelection = (productWrapper: { item: InventoryItem; batches: InventoryItem[] }) => {
        const candidateBatches = productWrapper.batches
            .filter(b => isRealBatch(b.batch));

        if (candidateBatches.length === 1) {
            addSelectedBatchToGrid(candidateBatches[0]);
            return;
        }

        if (candidateBatches.length > 1) {
            const sortedBatches = sortBatchesForSelection(candidateBatches);
            setPendingBatchSelection({ item: sortedBatches[0], batches: sortedBatches });
            setIsSearchModalOpen(false);
            return;
        }

        const itemName = (productWrapper.item.name || '').toLowerCase().trim();
        const itemBrand = (productWrapper.item.brand || '').toLowerCase().trim();
        const itemCode = (productWrapper.item.code || '').toLowerCase().trim();

        const fallbackBatches = inventory.filter(inv => {
            if (!isRealBatch(inv.batch)) return false;

            const invName = (inv.name || '').toLowerCase().trim();
            const invBrand = (inv.brand || '').toLowerCase().trim();
            const invCode = (inv.code || '').toLowerCase().trim();

            const codeMatch = itemCode !== '' && invCode !== '' && invCode === itemCode;
            const nameBrandMatch = invName === itemName && invBrand === itemBrand;

            return codeMatch || nameBrandMatch;
        });

        if (fallbackBatches.length === 1) {
            addSelectedBatchToGrid(fallbackBatches[0]);
            return;
        }

        if (fallbackBatches.length > 1) {
            const sortedBatches = sortBatchesForSelection(fallbackBatches);
            setPendingBatchSelection({ item: sortedBatches[0], batches: sortedBatches });
            setIsSearchModalOpen(false);
            return;
        }

        addSelectedBatchToGrid(productWrapper.item);
    };

    const addSelectedBatchToGrid = (batch: InventoryItem) => {
        const batchPolicy = getInventoryPolicy(batch, medicines);
        if (!batchPolicy.salesEnabled) {
            addNotification(`Item ${batch.name} is inactive or not enabled for sales.`, 'error');
            return;
        }

        if (checkIsExpired(batch.expiry ? String(batch.expiry) : '')) {
            addNotification(`Item ${batch.name} (Batch: ${batch.batch}) is expired and cannot be sold.`, 'error');
            return;
        }

        if (shouldPreventNegativeStock && Number(batch.stock || 0) <= 0) {
            addNotification('Insufficient stock in selected batch. Billing not allowed due to Strict Stock Enforcement.', 'error');
            return;
        }

        const activePriceRecord = resolveActivePriceRecord(batch, medicines, invoiceDate);
        const linkedMedicine = resolveMedicineForInventoryItem(medicines, batch, batch.name, batch.brand, batch.id);
        const pricingSource = activePriceRecord ? {
            mrp: Number(activePriceRecord.mrp || batch.mrp || 0),
            gstPercent: batch.gstPercent,
            rateA: Number(activePriceRecord.rateA || batch.rateA || 0),
            rateB: Number(activePriceRecord.rateB || batch.rateB || 0),
            rateC: Number(activePriceRecord.rateC || batch.rateC || 0),
        } : batch;
        const rateValue = resolveSalesRate(pricingSource, selectedCustomer?.defaultRateTier);

        const newItemId = crypto.randomUUID();
        const selectedItem: BillItem = {
            id: newItemId,
            inventoryItemId: batch.id,
            name: batch.name,
            brand: batch.brand,
            mrp: Number(activePriceRecord?.mrp || batch.mrp),
            quantity: 1,
            looseQuantity: 0,
            freeQuantity: 0,
            unit: 'pack',
            gstPercent: batch.gstPercent,
            discountPercent: Number(activePriceRecord?.defaultDiscountPercent ?? linkedMedicine?.productDiscount ?? selectedCustomer?.defaultDiscount ?? 0),
            itemFlatDiscount: 0,
            taxBasis: batch.taxBasis,
            batch: ['NEW-STOCK', 'NEW-BATCH'].includes((batch.batch || '').trim().toUpperCase()) ? '' : (batch.batch || ''),
            expiry: formatExpiryForInput(batch.expiry ? String(batch.expiry) : ''),
            rate: rateValue,
            schemeDiscountPercent: Number(activePriceRecord?.schemePercent || 0),
            schemeDisplayPercent: Number(activePriceRecord?.schemePercent || 0),
            schemeCalculationBasis: (activePriceRecord?.schemeCalculationBasis || activePriceRecord?.schemeType) === 'before_discount' ? 'before_discount' : 'after_discount',
            schemeFormat: activePriceRecord?.schemeFormat || '',
            schemeRate: Number(activePriceRecord?.schemeRate || 0),
            unitsPerPack: resolveUnitsPerStrip(batch.unitsPerPack, batch.packType),
            packType: batch.packType
        };

        const newItem = normalizePackConversion(selectedItem);
        const isPrescriptionItem = !!linkedMedicine?.isPrescriptionRequired;

        setCartItems(prev => {
            const index = prev.findIndex(p => p.id === activeRowIdRef.current);
            if (activeRowIdRef.current && index > -1) {
                const next = [...prev];
                next[index] = newItem;
                return next;
            }
            return [...prev, newItem];
        });
        if (isPrescriptionItem && !prescriptionAlertShown) {
            setIsPrescriptionAlertOpen(true);
            setPrescriptionAlertShown(true);
            setPendingPrescriptionItemId(newItem.id);
        }

        setSearchTerm('');
        setIsSearchModalOpen(false);
        setPendingBatchSelection(null);
        activeRowIdRef.current = null;

        setTimeout(() => {
            const firstEditableField =
                document.getElementById(`qty-p-${newItemId}`) ||
                document.getElementById(`expiry-${newItemId}`);

            if (firstEditableField) {
                firstEditableField.focus();
                if (firstEditableField instanceof HTMLInputElement) {
                    firstEditableField.select();
                }
            }
        }, 50);
    };

    const handleMedicineSavedFromSales = useCallback((savedMedicine: Medicine) => {
        if (!savedMedicine?.name) return;
        setIsAddMedicineMasterModalOpen(false);
        setNewlyCreatedMedicine(savedMedicine);
        setIsAddInventoryModalOpen(true);
    }, []);

    const handleAddInventoryForNewMedicine = useCallback(async (newProduct: Omit<InventoryItem, 'id'>) => {
        if (!onAddInventoryItem) {
            addNotification('Inventory creation is not available in this screen.', 'warning');
            return;
        }
        const savedInventory = await onAddInventoryItem(newProduct);
        setIsAddInventoryModalOpen(false);
        setNewlyCreatedMedicine(null);
        setIsSearchModalOpen(false);
        addSelectedBatchToGrid(savedInventory);
    }, [addNotification, addSelectedBatchToGrid, onAddInventoryItem]);

    const handleUpdateCartItem = useCallback((id: string, field: keyof BillItem, value: any) => {
        setCartItems(prev => prev.map(item => {
            if (item.id === id) {
                if (isBarcodeLikeGridEntry(field, String(value ?? ''))) {
                    addNotification('Barcode scanning is allowed only in Product Selection Matrix search.', 'warning');
                    return item;
                }
                const isSelectedProductRow = Boolean((item.inventoryItemId || '').trim());
                if (field === 'name' && isSelectedProductRow) {
                    return item;
                }
                const updated = { ...item, [field]: value };
                if (field === 'expiry') {
                    updated.expiry = normalizeExpiryInput(String(value || ''));
                    return updated;
                }
                if (field === 'rate') {
                    const rateText = String(value || '');
                    if (!isValidRateInput(rateText)) return item;
                    const parsedRate = rateText === '' ? 0 : (parseFloat(rateText) || 0);
                    updated.rate = Math.min(parsedRate, 999999.99);
                    updated.schemeBaseRate = undefined;
                    return updated.schemeMode ? recalculateSchemeFields(updated) : updated;
                }
                if (['quantity', 'looseQuantity', 'freeQuantity', 'discountPercent', 'rate', 'itemFlatDiscount', 'mrp', 'gstPercent'].includes(field as string)) {
                    (updated as any)[field] = value === '' ? 0 : (parseFloat(value) || 0);
                }

                if ((field === 'mrp' || field === 'gstPercent') && isGstInclusiveMrp(updated.taxBasis)) {
                    updated.rate = calculateRateExcludingGst(updated.mrp, updated.gstPercent);
                }

                if (updated.schemeMode && ['quantity', 'looseQuantity', 'discountPercent', 'rate', 'mrp', 'schemeMode', 'schemeQty', 'schemeTotalQty', 'schemeValue'].includes(field as string)) {
                    return recalculateSchemeFields(updated);
                }

                if (field === 'looseQuantity' || field === 'packType' || field === 'unitsPerPack') {
                    const normalized = normalizePackConversion(updated);
                    return normalized.schemeMode ? recalculateSchemeFields(normalized) : normalized;
                }
                return updated;
            }
            return item;
        }));
    }, [addNotification, isBarcodeLikeGridEntry, isValidRateInput, normalizeExpiryInput]);

    const clearSelectedProductFromRow = useCallback((rowId: string) => {
        setCartItems(prev => prev.map(item => {
            if (item.id !== rowId) return item;
            return {
                ...createBlankItem(),
                id: rowId,
            };
        }));
    }, []);

    const handleLooseQtyFinalize = useCallback((id: string) => {
        setCartItems(prev => prev.map(item => item.id === id ? normalizePackConversion(item) : item));
    }, []);

    const handleExpiryBlur = useCallback((id: string, value: string) => {
        if (!value) return;
        if (!isValidExpiry(value)) {
            addNotification('Expiry must be in MM/YY format with month between 01 and 12.', 'error');
            setCartItems(prev => prev.map(item => item.id === id ? { ...item, expiry: '' } : item));
        }
    }, [addNotification, isValidExpiry]);

    // const handleExpiryBlur = useCallback((id: string, value: string) => {
    //     if (!value) return;
    //     if (!isValidExpiry(value)) {
    //         addNotification('Expiry must be in MM/YY format with month between 01 and 12.', 'error');
    //         setCartItems(prev => prev.map(item => item.id === id ? { ...item, expiry: '' } : item));
    //     }
    // }, [addNotification, isValidExpiry]);

    const applySchemeToLine = useCallback((payload: PendingSchemeApplication, schemeCalculationBasis: SchemeCalculationBasis) => {
        setCartItems(prev => prev.map(item => {
            if (item.id === payload.itemId) {
                const updatedItem: BillItem = {
                    ...item,
                    schemeQty: payload.schemeQty,
                    schemeMode: payload.mode,
                    schemeValue: payload.value,
                    freeQuantity: payload.freeQuantity,
                    schemeDiscountAmount: payload.discountAmount,
                    schemeDiscountPercent: payload.discountPercent,
                    schemeTotalQty: payload.schemeTotalQty,
                    schemeDisplayPercent: payload.schemeDisplayPercent,
                    schemeCalculationBasis,
                };
                return recalculateSchemeFields(updatedItem);
            }
            return item;
        }));
        setSchemeItem(null);
        setTimeout(() => productSearchInputRef.current?.focus(), 100);
    }, []);

    const handleApplyScheme = useCallback((itemId: string, schemeQty: number, mode: 'flat' | 'percent' | 'price_override' | 'free_qty' | 'qty_ratio', value: number, discountAmount: number, discountPercent: number, freeQuantity: number, schemeCalculationBasis: SchemeCalculationBasis, schemeTotalQty?: number, schemeDisplayPercent?: number) => {
        applySchemeToLine({
            itemId,
            schemeQty,
            mode,
            value,
            discountAmount,
            discountPercent,
            freeQuantity,
            schemeTotalQty,
            schemeDisplayPercent,
        }, schemeCalculationBasis);
    }, [applySchemeToLine]);

    const openSchemeFlow = useCallback((item: BillItem) => {
        setSchemeItem(item);
    }, []);

    const handleClearScheme = useCallback((itemId: string) => {
        setCartItems(prev => prev.map(item => {
            if (item.id === itemId) {
                const { schemeQty, schemeMode, schemeValue, schemeDiscountAmount, schemeDiscountPercent, schemeDisplayPercent, schemeTotalQty, schemeBaseRate, schemeCalculationBasis, ...rest } = item;
                return { ...rest };
            }
            return item;
        }));
        setSchemeItem(null);
        setTimeout(() => productSearchInputRef.current?.focus(), 100);
    }, []);

    const openSearchModal = useCallback((rowId: string, initialValue: string) => {
        if (isReadOnly) return;
        activeRowIdRef.current = rowId;
        setModalSearchTerm(initialValue);
        setIsSearchModalOpen(true);
        setSelectedSearchIndex(0);
        setTimeout(() => modalSearchInputRef.current?.focus(), 150);
    }, [isReadOnly]);

    const findMedicineForSalesRow = useCallback((row: BillItem): Medicine | null => {
        const rowName = (row.name || '').trim().toLowerCase();
        if (!rowName) return null;

        const inventoryItem = getInventoryItemById(inventory, row.inventoryItemId);
        const resolved = resolveMedicineForInventoryItem(medicines, inventoryItem, row.name, row.brand, row.inventoryItemId);
        if (resolved) return resolved;

        const rowPack = (row.packType || '').trim().toLowerCase();
        const matchedMedicines = getMedicinesByName(medicines, rowName);
        return matchedMedicines.find((med) => {
            if (!rowPack) return true;
            return (med.pack || '').trim().toLowerCase() === rowPack;
        }) || null;
    }, [inventory, medicines]);

    const openMaterialEditOrSearch = useCallback((rowId: string) => {
        if (isReadOnly) return;
        const row = cartItems.find(item => item.id === rowId);
        if (!row) return;

        const isSelectedProductRow = Boolean((row.inventoryItemId || '').trim());
        if (!isSelectedProductRow) {
            openSearchModal(rowId, (row.name || '').trim());
            return;
        }

        const materialRecord = findMedicineForSalesRow(row);
        if (!materialRecord) {
            addNotification('Material Master record not found for selected product.', 'warning');
            return;
        }

        activeRowIdRef.current = rowId;
        setMaterialEditRowId(rowId);
        setMaterialToEdit(materialRecord);
        setIsEditMaterialModalOpen(true);
    }, [addNotification, cartItems, findMedicineForSalesRow, isReadOnly, openSearchModal]);

    const handleUpdateMaterialFromSales = useCallback(async (updatedMedicine: Medicine) => {
        if (!onUpdateMedicineMaster) {
            addNotification('Material update action is unavailable in this view.', 'warning');
            return;
        }
        const targetRowId = materialEditRowId;
        if (!targetRowId) return;

        await onUpdateMedicineMaster(updatedMedicine);

        setCartItems(prev => prev.map(item => {
            if (item.id !== targetRowId) return item;

            const parsedMrp = parseFloat(String(updatedMedicine.mrp ?? ''));
            const nextMrp = Number.isFinite(parsedMrp) ? parsedMrp : Number(item.mrp || 0);
            const nextGst = Number(updatedMedicine.gstRate ?? item.gstPercent ?? 0);
            const nextRate = resolveSalesRate({
                mrp: nextMrp,
                gstPercent: nextGst,
                rateA: Number(updatedMedicine.rateA ?? item.rate ?? 0),
                rateB: Number(updatedMedicine.rateB ?? 0),
                rateC: Number(updatedMedicine.rateC ?? 0),
            }, selectedCustomer?.defaultRateTier);

            return {
                ...item,
                name: updatedMedicine.name || item.name,
                packType: updatedMedicine.pack || item.packType,
                hsnCode: updatedMedicine.hsnCode || item.hsnCode,
                gstPercent: nextGst,
                mrp: nextMrp,
                rate: nextRate,
            };
        }));

        addNotification('Material Master updated and sales line refreshed.', 'success');
    }, [addNotification, materialEditRowId, onUpdateMedicineMaster, selectedCustomer?.defaultRateTier]);

    const closeInsightsPanel = useCallback(() => {
        setIsInsightsOpen(false);
        if (!isSearchModalOpen) return;
        setTimeout(() => modalSearchInputRef.current?.focus(), 0);
    }, [isSearchModalOpen]);

    const handleDeleteRow = useCallback((id: string, index: number) => {
        if (isReadOnly) return;

        setCartItems(prev => {
            const newItems = prev.filter(item => item.id !== id);
            
            const nextFocusIdx = index < newItems.length ? index : newItems.length - 1;
            const itemToFocus = newItems[nextFocusIdx];
            if (itemToFocus) {
                setTimeout(() => {
                    const qtyInput = document.getElementById(`qty-p-${itemToFocus.id}`);
                    qtyInput?.focus();
                    if (qtyInput instanceof HTMLInputElement) qtyInput.select();
                }, 10);
            } else {
                // If no items left, focus the search input
                setTimeout(() => productSearchInputRef.current?.focus(), 10);
            }
            return newItems;
        });
    }, [isReadOnly]);

    const focusFirstEditableFieldInRow = useCallback((rowId: string) => {
        const firstEditableField = [
            `name-${rowId}`,
            `batch-${rowId}`,
            `expiry-${rowId}`,
            `mrp-${rowId}`,
            `qty-p-${rowId}`,
            `qty-l-${rowId}`,
            `free-${rowId}`,
            `rate-${rowId}`,
            `disc-${rowId}`,
            `gst-${rowId}`,
            `scheme-${rowId}`
        ]
            .map(fieldId => document.getElementById(fieldId))
            .find(el => el && !el.hasAttribute('disabled'));

        firstEditableField?.focus();
        if (firstEditableField instanceof HTMLInputElement) firstEditableField.select();
    }, []);

    const handleItemKeyDown = (e: React.KeyboardEvent, id: string, index: number) => {
        if (e.key === 'Delete') {
            e.preventDefault();
            handleDeleteRow(id, index);
        }
        // Removed Backspace row deletion logic as per request
    };

    const handleRowKeyNavigation = useCallback((e: React.KeyboardEvent, id: string) => {
        const fieldPrefixes = ['name', 'batch', 'expiry', 'mrp', 'rate', 'qty-p', 'qty-l', 'free', 'disc', 'gst', 'scheme'];
        const target = e.target as HTMLElement;
        const activeElement = target.closest('input, button') as HTMLElement | null;
        const currentId = activeElement?.id || target.id || '';
        const currentFieldPrefix = fieldPrefixes.find(prefix => currentId.startsWith(`${prefix}-`)) || 'name';

        const getAvailableRowFields = (rowId: string) => (
            [
                `name-${rowId}`,
                `batch-${rowId}`,
                `expiry-${rowId}`,
                `mrp-${rowId}`,
                `rate-${rowId}`,
                `qty-p-${rowId}`,
                `qty-l-${rowId}`,
                `free-${rowId}`,
                `disc-${rowId}`,
                `gst-${rowId}`,
                `scheme-${rowId}`
            ].filter(fieldId => {
                const el = document.getElementById(fieldId);
                return el && !el.hasAttribute('disabled');
            })
        );

        const fields = getAvailableRowFields(id);
        const currentIndex = fields.indexOf(currentId);
        const itemIdx = cartItems.findIndex(i => i.id === id);

        if (itemIdx === -1) return;

        const moveRow = (direction: -1 | 1) => {
            const nextRowIndex = itemIdx + direction;
            if (nextRowIndex < 0 || nextRowIndex >= cartItems.length) return;

            e.preventDefault();
            e.stopPropagation();

            const nextId = cartItems[nextRowIndex].id;
            const nextFieldId = `${currentFieldPrefix}-${nextId}`;
            let nextEl = document.getElementById(nextFieldId);

            if (!nextEl || nextEl.hasAttribute('disabled')) {
                const nextRowFields = getAvailableRowFields(nextId);
                nextEl = document.getElementById(nextRowFields[0]);
            }

            setSelectedRowIndex(nextRowIndex);
            nextEl?.focus();
            if (nextEl instanceof HTMLInputElement) nextEl.select();
        };

        const moveNext = () => {
            if (currentIndex !== -1 && currentIndex < fields.length - 1) {
                e.preventDefault();
                e.stopPropagation();
                const nextEl = document.getElementById(fields[currentIndex + 1]);
                nextEl?.focus();
                if (nextEl instanceof HTMLInputElement) nextEl.select();
            } else {
                if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (itemIdx < cartItems.length - 1) {
                        const nextId = cartItems[itemIdx + 1].id;
                        const nextNameEl = document.getElementById(`name-${nextId}`);
                        setSelectedRowIndex(itemIdx + 1);
                        nextNameEl?.focus();
                        if (nextNameEl instanceof HTMLInputElement) nextNameEl.select();
                    } else {
                        productSearchInputRef.current?.focus();
                    }
                }
            }
        };

        const movePrev = () => {
            if (currentIndex > 0) {
                e.preventDefault();
                e.stopPropagation();
                const prevEl = document.getElementById(fields[currentIndex - 1]);
                prevEl?.focus();
                if (prevEl instanceof HTMLInputElement) prevEl.select();
            } else {
                if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
                    if (itemIdx > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        const prevId = cartItems[itemIdx - 1].id;
                        const prevLastField = `scheme-${prevId}`;
                        const prevLastEl = document.getElementById(prevLastField);
                        setSelectedRowIndex(itemIdx - 1);
                        prevLastEl?.focus();
                    }
                }
            }
        };

        if (e.key === 'ArrowUp') {
            moveRow(-1);
        } else if (e.key === 'ArrowDown') {
            moveRow(1);
        } else if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter' || e.key === 'ArrowRight') {
            moveNext();
        } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
            movePrev();
        }
    }, [cartItems]);

    const handleRowFocus = useCallback((index: number) => {
        setSelectedRowIndex(index);
    }, []);

    const handleReferredByChange = (value: string, id?: string) => {
        setReferredBy(value);
        if (id) {
            setDoctorId(id);
        } else {
            const matchedDoctor = activeDoctors.find(d => (d.name || '').trim().toLowerCase() === value.trim().toLowerCase());
            setDoctorId(matchedDoctor?.id || null);
        }
    };

    const handleDoctorSelect = useCallback((doctor: DoctorMaster) => {
        handleReferredByChange(doctor.name || '', doctor.id);
        setIsDoctorPickerOpen(false);
    }, [handleReferredByChange]);

    const handleUseTypedDoctorName = useCallback(() => {
        const typedValue = doctorSearchTerm.trim();
        if (!typedValue) return;
        handleReferredByChange(typedValue);
        setIsDoctorPickerOpen(false);
    }, [doctorSearchTerm, handleReferredByChange]);

    const handleAddTypedDoctorToMaster = useCallback(async () => {
        if (!currentUser) return;
        const typedValue = doctorSearchTerm.trim();
        if (!typedValue) return;
        const payload: DoctorMaster = {
            id: crypto.randomUUID(),
            organization_id: currentUser.organization_id,
            doctorCode: '',
            name: typedValue,
            mobile: '',
            specialization: '',
            is_active: true,
        };
        await storage.saveData('doctor_master', payload, currentUser);
        handleReferredByChange(payload.name, payload.id);
        setIsDoctorPickerOpen(false);
        addNotification('Doctor added to master and selected.', 'success');
    }, [addNotification, currentUser, doctorSearchTerm, handleReferredByChange]);

    const handleQuickDoctorSave = async () => {
        if (!currentUser || !quickDoctorName.trim()) return;
        const payload: DoctorMaster = {
            id: crypto.randomUUID(),
            organization_id: currentUser.organization_id,
            doctorCode: '',
            name: quickDoctorName.trim(),
            mobile: '',
            specialization: '',
            is_active: true,
        };
        await storage.saveData('doctor_master', payload, currentUser);
        setReferredBy(payload.name);
        setDoctorId(payload.id);
        setIsDoctorQuickAddOpen(false);
        addNotification('Doctor saved and selected.', 'success');
    };

    const handleReferredByKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            setQuickDoctorName(referredBy || '');
            setIsDoctorQuickAddOpen(true);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            setIsDoctorPickerOpen(true);
        }
    };

    return (
        <div className="flex flex-row h-full bg-app-bg overflow-hidden">
            <div className="flex-1 flex flex-col h-full overflow-hidden border-r border-gray-300" onKeyDown={handleEnterToNextField}>
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest">
                        {isChallan ? 'Sales Challan Entry' : (isNonGst ? 'Estimate Billing (Non-GST)' : 'Accounting Voucher Creation (Sales)')}
                    </span>
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
                    {currentUser?.organization_type === 'Retail' && (
                        <button
                            type="button"
                            onClick={() => !isReadOnly && rateFieldAvailable && setLocalPricingMode(prev => prev === 'mrp' ? 'rate' : 'mrp')}
                            disabled={isReadOnly || !rateFieldAvailable}
                            className={`px-2 py-0.5 border text-white text-[9px] font-black uppercase tracking-widest transition-colors ${localPricingMode === 'mrp' ? 'bg-accent border-accent text-primary' : 'bg-transparent border-white/60'} ${isReadOnly ? 'opacity-80 cursor-default' : ''}`}
                            title={isReadOnly ? "Pricing mode cannot be changed for existing bills" : (!rateFieldAvailable ? "Rate column is disabled in POS configuration, so billing is locked to MRP mode." : "Switch between MRP Based (Inclusive) and Rate Based (Exclusive) pricing")}
                        >
                            Mode: {localPricingMode === 'mrp' ? 'MRP (INCL)' : 'RATE (EXT)'}
                        </button>
                    )}
                </div>
                <span className="text-[10px] font-black uppercase text-accent">No. {currentInvoiceNo}</span>
            </div>

            <div className="p-2 flex-1 flex flex-col gap-2 overflow-hidden">
                <Card className="p-1.5 bg-white dark:bg-card-bg border border-app-border rounded-none flex flex-nowrap items-end gap-2 w-full overflow-x-auto flex-shrink-0">
                    {isFieldVisible('colDate') && (
                        <div style={{ width: '11%', minWidth: '120px' }}>
                            <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Date</label>
                            <input
                                ref={dateInputRef}
                                type="date"
                                value={invoiceDate}
                                onChange={e => setInvoiceDate(e.target.value)}
                                onKeyDown={handleDateKeyDown}
                                className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none focus:bg-yellow-50"
                                disabled={isReadOnly}
                            />
                        </div>
                    )}
                    {isFieldVisible('colCustomer') && (
                        <div className="relative" style={{ width: '24%', minWidth: '220px', flexGrow: 1 }}>
                            <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Particulars (Customer Name)</label>
                            <input
                                ref={customerSearchInputRef}
                                type="text"
                                className="w-full h-8 border border-gray-400 p-1 text-xs font-bold uppercase focus:bg-yellow-50 outline-none"
                                value={customerSearch}
                                onChange={e => {
                                    setCustomerSearch(e.target.value);
                                    setSelectedCustomer(null);
                                }}
                                onKeyDown={handleCustomerKeyDown}
                                autoComplete="off"
                                placeholder="Enter for selection, Esc to skip..."
                                disabled={isReadOnly}
                            />
                        </div>
                    )}
                    <div className="relative" style={{ width: '22%', minWidth: '180px', flexShrink: 3 }}>
                        <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Address</label>
                        <input
                            ref={addressInputRef}
                            type="text"
                            value={customerAddress}
                            onChange={e => setCustomerAddress(e.target.value)}
                            className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none focus:bg-yellow-50"
                            placeholder="Customer Address"
                            disabled={isReadOnly || ((currentUser?.organization_type || 'Retail') === 'Distributor' && !!selectedCustomer?.id)}
                        />
                    </div>
                    {isFieldVisible('colPhone') && (
                        <div className="relative" style={{ width: '14%', minWidth: '150px' }}>
                            <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Phone Number</label>
                            <input
                                ref={phoneInputRef}
                                type="text"
                                value={customerPhone}
                                onChange={e => setCustomerPhone(e.target.value)}
                                className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none focus:bg-yellow-50"
                                placeholder="Customer Phone"
                                disabled={isReadOnly}
                            />
                        </div>
                    )}
                    {isFieldVisible('colReferred') && (
                        <div style={{ width: '17%', minWidth: '170px', flexGrow: 1 }}>
                            <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Referred By</label>
                            <input
                                type="text"
                                value={referredBy}
                                onChange={e => handleReferredByChange(e.target.value)}
                                onClick={() => !isReadOnly && setIsDoctorPickerOpen(true)}
                                onKeyDown={handleReferredByKeyDown}
                                placeholder="Doctor Name"
                                disabled={isReadOnly}
                                className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none uppercase focus:bg-yellow-50"
                                autoComplete="off"
                            />
                        </div>
                    )}
                    <div style={{ width: '12%', minWidth: '140px' }}>
                        <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Bill Category</label>
                        <select
                            ref={billCategorySelectRef}
                            value={billCategory}
                            onChange={e => setBillCategory(e.target.value as 'Cash' | 'Credit')}
                            className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none uppercase focus:bg-yellow-50"
                            disabled={isReadOnly}
                        >
                            <option value="Cash">Cash</option>
                            <option value="Credit">Credit</option>
                        </select>
                    </div>
                    {isFieldVisible('optPrescription') && (
                        <div className="flex gap-1 h-8">
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="flex-1 bg-gray-100 hover:bg-gray-200 border border-gray-400 text-[10px] font-black uppercase flex items-center justify-center gap-1"
                                title="Upload Prescription"
                                disabled={isReadOnly || isProcessingRx}
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                RX
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsWebcamOpen(true)}
                                className="flex-1 bg-gray-100 hover:bg-gray-200 border border-gray-400 text-[10px] font-black uppercase flex items-center justify-center gap-1"
                                title="Scan Prescription"
                                disabled={isReadOnly || isProcessingRx}
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                                CAM
                            </button>
                            {prescriptions.length > 0 && (
                                <div className="flex items-center px-1 bg-emerald-50 border border-emerald-200 text-emerald-700 text-[9px] font-black">
                                    {prescriptions.length} ATTACHED
                                </div>
                            )}
                        </div>
                    )}
                </Card>

                {selectedCustomer && creditCheck && (
                    <Card className="p-2 bg-amber-50 border border-amber-300 rounded-none flex-shrink-0">
                        <div className="text-[9px] font-black uppercase tracking-widest text-amber-800">Credit Control</div>
                        <div className="text-[10px] font-semibold text-amber-900 mt-0.5">
                            Limit: ₹{creditCheck.details.creditLimit.toFixed(2)} | Outstanding: ₹{creditCheck.details.currentOutstanding.toFixed(2)} | Available: ₹{(creditCheck.details.creditLimit - creditCheck.details.currentOutstanding).toFixed(2)}
                        </div>
                        <div className="text-[10px] font-semibold text-amber-900">
                            Current Bill: ₹{creditCheck.details.currentTransactionAmount.toFixed(2)} | Open Challan: ₹{creditCheck.details.openChallanExposure.toFixed(2)} | Projected Exposure: ₹{creditCheck.details.projectedExposure.toFixed(2)}
                        </div>
                    </Card>
                )}

                <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white dark:bg-zinc-800">
                    <div className="flex-1 overflow-auto">
                        <table className="min-w-full border-collapse text-sm">
                            <thead className="sticky top-0 bg-gray-100 dark:bg-zinc-900 border-b border-gray-400 z-10">
                                <tr className="text-[10px] font-black uppercase text-gray-600 h-9">
                                    <th className="p-2 border-r border-gray-400 text-left w-10">Sl.</th>
                                    {isFieldVisible('colName') && <th className="p-2 border-r border-gray-400 text-left w-72">Name of Item</th>}
                                    {isFieldVisible('colBatch') && <th className="p-2 border-r border-gray-400 text-center w-24">Batch</th>}
                                    {isFieldVisible('colExpiry') && <th className="p-2 border-r border-gray-400 text-center w-20">Expiry</th>}
                                    {isFieldVisible('colPack') && <th className="p-2 border-r border-gray-400 text-center w-16">Pack</th>}
                                    {isFieldVisible('colMrp') && <th className="p-2 border-r border-gray-400 text-right w-20">MRP</th>}
                                    {isFieldVisible('colRate') && <th className="p-2 border-r border-gray-400 text-right w-24">Rate</th>}
                                    {isFieldVisible('colPQty') && <th className="p-2 border-r border-gray-400 text-center w-16">P.Qty</th>}
                                    {isFieldVisible('colLQty') && <th className="p-2 border-r border-gray-400 text-center w-16">L.Qty</th>}
                                    {isFieldVisible('colFree') && <th className="p-2 border-r border-gray-400 text-center w-16">Free</th>}
                                    {isFieldVisible('colDisc') && <th className="p-2 border-r border-gray-400 text-center w-16">Disc%</th>}
                                    {isFieldVisible('colGst') && <th className="p-2 border-r border-gray-400 text-center w-16">GST%</th>}
                                    {isFieldVisible('colSch') && <th className="p-2 border-r border-gray-400 text-center w-20">Sch%</th>}
                                    {isFieldVisible('colAmount') && <th className="p-2 text-right w-32">Amount</th>}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {cartItems.map((item, idx) => {
                                    const lineAmount = calculateLineNetAmount(item, configurations, currentUser?.organization_type, localPricingMode);
                                    const rowIssue = stockValidationIssues.find(issue => issue.itemId === item.id);

                                    return (
                                        <tr 
                                            key={item.id} 
                                            id={`cart-row-${item.id}`}
                                            onMouseEnter={() => setHoveredRowId(item.id)}
                                            onMouseLeave={() => setHoveredRowId(null)}
                                            onClick={() => {
                                                if (selectedRowIndex !== idx) {
                                                    setSelectedRowIndex(idx);
                                                }
                                                // Removed focusFirstEditableFieldInRow to allow direct cell click
                                            }}
                                            onFocusCapture={() => {
                                                if (selectedRowIndex !== idx) {
                                                    setSelectedRowIndex(idx);
                                                }
                                            }}
                                            title={rowIssue ? `Available: ${rowIssue.available} | Required: ${rowIssue.required}` : undefined}
                                            className={`group h-10 cursor-pointer transition-colors hover:bg-primary hover:text-white ${selectedRowIndex === idx ? 'bg-primary text-white shadow-md' : ''} ${rowIssue ? 'bg-red-100 border border-red-400' : ''}`}
                                        >
                                            <td 
                                                className={`p-2 border-r border-gray-200 text-center cursor-pointer hover:bg-red-600 hover:text-white transition-colors group/del ${selectedRowIndex === idx ? 'text-white' : 'group-hover:text-white text-gray-400'} ${uniformTextStyle}`}
                                                onClick={(e) => { e.stopPropagation(); handleDeleteRow(item.id, idx); }}
                                                title="Click to delete this line item"
                                            >
                                                <span className="group-hover/del:hidden">{idx + 1}</span>
                                                <span className="hidden group-hover/del:inline">✕</span>
                                            </td>
                                            {isFieldVisible('colName') && (
                                                <td className={`p-2 border-r border-gray-200 uppercase w-72 truncate ${uniformTextStyle} ${selectedRowIndex === idx ? 'text-white' : 'group-hover:text-white text-primary'}`} title={item.name}>
                                                    {(() => {
                                                        const isSelectedProductRow = Boolean((item.inventoryItemId || '').trim());
                                                        const canOpenMatrix = !isReadOnly && !isSelectedProductRow && !(item.name || '').trim();
                                                        return (
                                                    <input
                                                        id={`name-${item.id}`}
                                                        type="text"
                                                        value={item.name}
                                                        onChange={e => {
                                                            if (isSelectedProductRow) return;
                                                            handleUpdateCartItem(item.id, 'name', e.target.value);
                                                        }}
                                                        onClick={() => {
                                                            if (canOpenMatrix) {
                                                                openSearchModal(item.id, '');
                                                            }
                                                        }}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onKeyDown={e => {
                                                            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                openMaterialEditOrSearch(item.id);
                                                                return;
                                                            }
                                                            if (e.key === 'Enter' && canOpenMatrix) {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                openSearchModal(item.id, '');
                                                                return;
                                                            }
                                                            if ((e.ctrlKey || e.metaKey) && e.key === 'Backspace' && isSelectedProductRow) {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                clearSelectedProductFromRow(item.id);
                                                                return;
                                                            }
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className={`w-full bg-transparent border-none outline-none ${selectedRowIndex === idx ? 'text-white placeholder:text-white/50' : 'group-hover:text-white text-primary placeholder:text-gray-400'} ${uniformTextStyle}`}
                                                        readOnly={isReadOnly || isSelectedProductRow}
                                                        disabled={isReadOnly}
                                                    />
                                                        );
                                                    })()}
                                                </td>
                                            )}
                                            {isFieldVisible('colBatch') && (
                                                <td className={`p-2 border-r border-gray-200 text-center font-mono ${uniformTextStyle}`}>
                                                    <button
                                                        id={`batch-${item.id}`}
                                                        onClick={() => {
                                                            if (isReadOnly) return;
                                                            const batches = inventory.filter(inv => inv.name === item.name).sort((a, b) => parseExpiryForSort(String(a.expiry || '')) - parseExpiryForSort(String(b.expiry || '')));
                                                            if (batches.length > 0) setPendingBatchSelection({ item: batches[0], batches });
                                                            activeRowIdRef.current = item.id;
                                                        }}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                const batches = inventory.filter(inv => inv.name === item.name).sort((a, b) => parseExpiryForSort(String(a.expiry || '')) - parseExpiryForSort(String(b.expiry || '')));
                                                                if (batches.length > 0) setPendingBatchSelection({ item: batches[0], batches });
                                                                activeRowIdRef.current = item.id;
                                                            } else {
                                                                handleItemKeyDown(e, item.id, idx);
                                                                handleRowKeyNavigation(e, item.id);
                                                            }
                                                        }}
                                                        className={`w-full text-center transition-colors outline-none rounded px-1 ${selectedRowIndex === idx ? 'hover:bg-white/20 hover:text-white focus:bg-white/20 focus:text-white' : 'hover:bg-sky-200 hover:text-primary focus:bg-sky-200 focus:text-primary'}`}
                                                        disabled={isReadOnly}
                                                    >
                                                        {item.batch || 'N/A'}
                                                    </button>
                                                </td>
                                            )}
                                            {isFieldVisible('colExpiry') && (
                                                <td className={`p-2 border-r border-gray-200 text-center font-mono ${uniformTextStyle}`}>
                                                    <input
                                                        id={`expiry-${item.id}`}
                                                        type="text"
                                                        value={item.expiry}
                                                        onChange={e => handleUpdateCartItem(item.id, 'expiry', e.target.value)}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onBlur={(e) => handleExpiryBlur(item.id, e.target.value)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        placeholder="MM/YY"
                                                        className={`w-full text-center bg-transparent outline-none ${selectedRowIndex === idx ? 'text-white placeholder:text-white/50' : 'group-hover:text-white placeholder:text-gray-400'}`}
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colPack') && (
                                                <td className={`p-2 border-r border-gray-200 text-center font-mono ${uniformTextStyle} ${selectedRowIndex === idx ? 'text-white' : 'group-hover:text-white'}`}>
                                                    {(() => {
                                                        const inventoryPack = inventory.find(inv => inv.id === item.inventoryItemId)?.packType?.trim();
                                                        return item.packType?.trim() || inventoryPack || '—';
                                                    })()}
                                                </td>
                                            )}
                                            {isFieldVisible('colMrp') && (
                                                <td className={`p-2 border-r border-gray-200 text-right ${uniformTextStyle}`}>
                                                    <input
                                                        id={`mrp-${item.id}`}
                                                        type="number"
                                                        value={item.mrp === 0 ? '' : item.mrp}
                                                        onChange={e => handleUpdateCartItem(item.id, 'mrp', e.target.value)}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className={`w-full text-right bg-transparent outline-none ${selectedRowIndex === idx ? 'text-white' : 'group-hover:text-white'}`}
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colRate') && (
                                                <td className={`p-2 border-r border-gray-200 text-right font-normal ${uniformTextStyle}`}>
                                                    <div className="flex items-center justify-end">
                                                        <span className={`mr-0.5 text-[10px] ${selectedRowIndex === idx ? 'text-white/40' : 'opacity-40'}`}>₹</span>
                                                        <input
                                                            id={`rate-${item.id}`}
                                                            type="number"
                                                            value={item.rate === 0 ? '' : item.rate}
                                                            onChange={e => handleUpdateCartItem(item.id, 'rate', e.target.value)}
                                                            onFocus={() => handleRowFocus(idx)}
                                                            onKeyDown={e => {
                                                                if (e.ctrlKey && (e.key === 'Enter' || e.keyCode === 13)) {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    setActiveSchemeCalcRowId(item.id);
                                                                    setIsSchemeCalcOpen(true);
                                                                } else {
                                                                    handleItemKeyDown(e, item.id, idx);
                                                                    handleRowKeyNavigation(e, item.id);
                                                                }
                                                            }}
                                                            className={`w-24 text-right bg-transparent font-black no-spinner outline-none border-b border-dashed ${selectedRowIndex === idx ? 'text-white border-white/30 focus:border-white' : 'group-hover:text-white border-gray-300 focus:border-primary'}`} 
                                                            min="0"
                                                            max="999999.99"
                                                            step="0.01"
                                                            disabled={isReadOnly}
                                                        />
                                                    </div>
                                                </td>
                                            )}
                                            {isFieldVisible('colPQty') && (
                                                <td className={`p-2 border-r border-gray-200 text-center ${uniformTextStyle}`}>
                                                    <input
                                                        id={`qty-p-${item.id}`}
                                                        type="number"
                                                        value={item.quantity === 0 ? '' : item.quantity}
                                                        onChange={e => handleUpdateCartItem(item.id, 'quantity', e.target.value)}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className={`w-full text-center bg-transparent font-normal no-spinner outline-none ${selectedRowIndex === idx ? 'text-white placeholder:text-white/50' : 'group-hover:text-white placeholder:text-gray-400'}`}
                                                        placeholder="0"
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colLQty') && (
                                                <td className={`p-2 border-r border-gray-200 text-center ${uniformTextStyle}`}>
                                                    <input
                                                        id={`qty-l-${item.id}`}
                                                        type="number"
                                                        value={item.looseQuantity === 0 ? '' : item.looseQuantity}
                                                        onChange={e => handleUpdateCartItem(item.id, 'looseQuantity', e.target.value)}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onInput={e => handleUpdateCartItem(item.id, 'looseQuantity', (e.target as HTMLInputElement).value)}
                                                        onBlur={() => handleLooseQtyFinalize(item.id)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') {
                                                                handleLooseQtyFinalize(item.id);
                                                            }
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className={`w-full text-center bg-transparent font-normal no-spinner outline-none ${selectedRowIndex === idx ? 'text-white/70 placeholder:text-white/30' : 'group-hover:text-white text-gray-500 placeholder:text-gray-300'}`}
                                                        placeholder="0"
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colFree') && (
                                                <td className={`p-2 border-r border-gray-200 text-center ${uniformTextStyle}`}>
                                                    <input
                                                        id={`free-${item.id}`}
                                                        type="number"
                                                        value={item.freeQuantity === 0 ? '' : item.freeQuantity}
                                                        onChange={e => handleUpdateCartItem(item.id, 'freeQuantity', e.target.value)}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className={`w-12 text-center bg-transparent font-normal no-spinner outline-none ${selectedRowIndex === idx ? 'text-white' : 'group-hover:text-white text-emerald-700'}`}
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colDisc') && (
                                                <td className={`p-2 border-r border-gray-200 text-center ${uniformTextStyle}`}>
                                                    <input
                                                        id={`disc-${item.id}`}
                                                        type="number"
                                                        value={item.discountPercent === 0 ? '' : item.discountPercent}
                                                        onChange={e => handleUpdateCartItem(item.id, 'discountPercent', e.target.value)}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className={`w-12 text-center bg-transparent font-normal no-spinner outline-none ${selectedRowIndex === idx ? 'text-white' : 'group-hover:text-white text-red-700'}`}
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colGst') && (
                                                <td className={`p-2 border-r border-gray-200 text-center ${uniformTextStyle}`}>
                                                    <input
                                                        id={`gst-${item.id}`}
                                                        type="number"
                                                        value={item.gstPercent === 0 ? '' : item.gstPercent}
                                                        onChange={e => handleUpdateCartItem(item.id, 'gstPercent', e.target.value)}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className={`w-12 text-center bg-transparent font-normal no-spinner outline-none ${selectedRowIndex === idx ? 'text-white' : 'group-hover:text-white text-gray-600'}`}
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colSch') && (
                                                <td
                                                    className={`p-2 border-r border-gray-400 text-center ${uniformTextStyle}`}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (isReadOnly) return;
                                                        handleRowFocus(idx);
                                                        openSchemeFlow(item);
                                                    }}
                                                >
                                                    <button
                                                        id={`scheme-${item.id}`}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            if (isReadOnly) return;
                                                            handleRowFocus(idx);
                                                            openSchemeFlow(item);
                                                        }}
                                                        onFocus={() => handleRowFocus(idx)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                openSchemeFlow(item);
                                                            } else {
                                                                handleItemKeyDown(e, item.id, idx);
                                                                handleRowKeyNavigation(e, item.id);
                                                            }
                                                        }}
                                                        className={`w-full px-2 py-0.5 text-[10px] font-normal uppercase rounded border border-dashed transition-all ${item.schemeMode ? (selectedRowIndex === idx ? 'bg-white/20 text-white border-white/40' : 'bg-emerald-50 text-emerald-700 border-emerald-300') : (selectedRowIndex === idx ? 'bg-white/10 text-white border-white/20' : 'bg-gray-50 text-gray-400 border-gray-300 hover:text-primary hover:border-primary')}`}
                                                        disabled={isReadOnly}
                                                    >
                                                        {getDisplaySchemePercent(item).toFixed(1)}%
                                                    </button>
                                                </td>
                                            )}
                                            {isFieldVisible('colAmount') && <td className={`p-2 text-right ${selectedRowIndex === idx ? 'text-white' : 'group-hover:text-white text-gray-900'} ${uniformTextStyle}`}>₹{(lineAmount || 0).toFixed(2)}</td>}
                                        </tr>
                                    );
                                })}
                                {!isReadOnly && (
                                    <tr className="bg-yellow-50/30 h-10">
                                        <td className={`p-2 border-r border-gray-200 text-center text-gray-400 ${uniformTextStyle}`}>{cartItems.length + 1}</td>
                                        <td className="p-2 border-r border-gray-200 relative w-72">
                                            <input
                                                ref={productSearchInputRef}
                                                type="text"
                                                className={`w-full bg-transparent outline-none ${uniformTextStyle}`}
                                                placeholder="Type item name or code..."
                                                value={searchTerm}
                                                onChange={e => {
                                                    const val = e.target.value;
                                                    setSearchTerm(val);
                                                    if (!activeRowIdRef.current) {
                                                        const tempId = crypto.randomUUID();
                                                        activeRowIdRef.current = tempId;
                                                        setCartItems(prev => [...prev, { ...createBlankItem(), id: tempId, name: val }]);
                                                        openSearchModal(tempId, val);
                                                    } else {
                                                        openSearchModal(activeRowIdRef.current, val);
                                                    }
                                                }}
                                                onFocus={(e) => {
                                                    const val = e.target.value;
                                                    const tempId = crypto.randomUUID();
                                                    activeRowIdRef.current = tempId;
                                                    openSearchModal(tempId, val);
                                                }}
                                                autoComplete="off"
                                            />
                                        </td>
                                        <td colSpan={11} className="border-r border-gray-200"></td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </Card>

                <div className="grid grid-cols-12 gap-2 flex-shrink-0 min-h-[145px] xl:min-h-[170px]">
                    <div className="col-span-2 bg-[#f8fcfc] px-2 py-1.5 tally-border !rounded-none shadow-sm flex flex-col overflow-hidden">
                        <div className="text-[9px] xl:text-[10px] font-black uppercase text-teal-700 border-b border-teal-100 pb-1 mb-2">Stock Snapshot</div>
                        <div className="space-y-1 text-[10px] xl:text-[11px] font-bold uppercase">
                            <div className="truncate flex justify-between gap-1">
                                <span className="text-gray-400 shrink-0">Item:</span>
                                <span className="text-primary truncate" title={activeStockSnapshot?.item || '-'}>{activeStockSnapshot?.item || '-'}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-400">Batch:</span>
                                <span className="text-primary">{activeStockSnapshot?.batch || '-'}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-400">Expiry:</span>
                                <span className="text-primary">{activeStockSnapshot?.expiry || '-'}</span>
                            </div>
                            <div className="flex justify-between border-t border-teal-50 pt-0.5">
                                <span className="text-gray-400">Stock:</span>
                                <span className="text-emerald-700 font-black">{activeStockSnapshot?.stock ?? 0}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-400">MRP:</span>
                                <span className="text-primary">₹{(activeStockSnapshot?.mrp || 0).toFixed(2)}</span>
                            </div>
                        </div>
                    </div>

                    <div className="col-span-7 bg-[#f8fcfc] px-3 py-1.5 tally-border !rounded-none shadow-sm">
                        <h4 className="text-[8px] xl:text-[10px] font-black text-gray-500 uppercase tracking-[0.16em] mb-1 border-b border-gray-200 pb-0.5">{activeLineTotals ? 'Item Summary' : 'Bill Summary'}</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 md:gap-x-4 gap-y-0.5 text-[8px] xl:text-[11px] font-bold uppercase tracking-tight leading-tight">
                            <div className="space-y-0.5">
                                {activeLineTotals && (
                                    <>
                                        <div className="flex items-center justify-between text-blue-800"><span>Unit Rate</span> <span className="font-mono">₹{(activeBillItem?.rate || 0).toFixed(2)}</span></div>
                                        <div className="flex items-center justify-between text-emerald-700"><span>Scheme Rule</span> <span className="font-mono">{activeLineSummary?.rule === 'before_discount' ? 'At Same Level / Before Discount' : 'After Disc%'}</span></div>
                                    </>
                                )}
                                {activeLineTotals ? (
                                    <>
                                        <div className="flex justify-between"><span>Value</span><span>₹{(activeLineSummary?.value || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between text-red-600"><span>Discount</span><span>₹{(activeLineSummary?.discount || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between"><span>Amount After Discount</span><span>₹{(activeLineSummary?.amountAfterDiscount || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between text-red-600"><span>Scheme Discount</span><span>₹{(activeLineSummary?.schemeDiscount || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between"><span>Taxable Value After Scheme</span><span>₹{(activeLineSummary?.taxableValue || 0).toFixed(2)}</span></div>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex justify-between"><span>MRP Value</span><span>₹{(totals.gross ?? 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between"><span>Value of Goods</span><span>₹{(totals.subtotal ?? 0).toFixed(2)}</span></div>
                                    </>
                                )}
                            </div>
                            <div className="space-y-0.5">
                                <div className="flex justify-between text-blue-700"><span>SGST</span><span>₹{((activeLineSummary?.gst ?? activeLineTotals?.tax ?? totals.tax ?? 0) / 2).toFixed(2)}</span></div>
                                <div className="flex justify-between text-blue-700"><span>CGST</span><span>₹{((activeLineSummary?.gst ?? activeLineTotals?.tax ?? totals.tax ?? 0) / 2).toFixed(2)}</span></div>
                                {activeLineTotals && <div className="flex justify-between text-blue-700"><span>GST</span><span>₹{(activeLineSummary?.gst || 0).toFixed(2)}</span></div>}
                                <div className="flex justify-between text-red-600">
                                    <span>Discount</span>
                                    <span>₹{activeLineTotals 
                                        ? ((activeLineTotals.tradeDiscount || 0) + (activeLineTotals.schemeTotal || 0) + (activeLineTotals.lineFlatDiscount || 0)).toFixed(2)
                                        : ((totals?.tradeDiscount || 0) + (totals?.schemeTotal || 0) + (totals?.lineFlatDiscount || 0) + (lumpsumDiscount || 0)).toFixed(2)
                                    }</span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between text-indigo-700 gap-1 py-0.5 md:col-span-2 border-t border-gray-300 mt-0.5">
                                <span className="xl:text-[12px]">Bill Discount</span>
                                <input
                                    type="number"
                                    value={lumpsumDiscount === 0 ? '' : lumpsumDiscount}
                                    onChange={e => setLumpsumDiscount(parseFloat(e.target.value) || 0)}
                                    className="w-16 text-right bg-white border border-gray-300 font-normal text-[8px] xl:text-[10px] no-spinner outline-none px-1 h-4"
                                    disabled={isReadOnly}
                                />
                            </div>
                            <div className="flex items-center justify-between text-indigo-700 gap-1 py-0.5 md:col-span-2 border-t border-gray-300">
                                <span className="xl:text-[12px]">Adjustment</span>
                                <input
                                    type="number"
                                    value={adjustment === 0 ? '' : adjustment}
                                    onChange={e => setAdjustment(parseFloat(e.target.value) || 0)}
                                    className="w-16 text-right bg-white border border-gray-300 font-normal text-[8px] xl:text-[10px] no-spinner outline-none px-1 h-4"
                                    disabled={isReadOnly}
                                />
                            </div>
                            <div className="flex justify-between">
                                <span>GST%</span>
                                <span>{(() => {
                                    const sub = activeLineTotals?.taxableValue ?? totals?.taxableValue ?? 0;
                                    const tx = activeLineTotals?.tax ?? totals?.tax ?? 0;
                                    return sub > 0 ? ((tx / sub) * 100).toFixed(2) : '0.00';
                                })()}%</span>
                            </div>
                            <div className="flex justify-between font-black text-primary border-t border-gray-300 pt-0.5 mt-0.5">
                                <span>{activeLineTotals ? 'Line Total' : 'Bill Balance'}</span>
                                <span>₹{(activeLineTotals ? (activeLineSummary?.finalLineTotal ?? 0) : (grandTotal ?? 0)).toFixed(2)}</span>
                            </div>
                            {activeLineTotals && (
                                <div className="flex justify-between font-black text-indigo-900 border-t border-gray-400 pt-0.5 mt-0.5 md:col-span-2">
                                    <span>Net Bill Balance</span>
                                    <span>₹{(grandTotal ?? 0).toFixed(2)}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="col-span-3 flex flex-col gap-2">
                        <div className="bg-white px-2 py-1.5 tally-border !rounded-none shadow-sm flex flex-col overflow-hidden">
                            <div className="text-[9px] xl:text-[10px] font-black uppercase text-gray-500 border-b border-gray-100 pb-1 mb-1.5">Customer Info</div>
                            <div className="grid grid-cols-2 gap-2 text-[9px] xl:text-[10px] font-bold uppercase leading-tight">
                                <div className="truncate">
                                    <span className="text-[7px] text-gray-400 block mb-0.5">Area</span>
                                    <span className="text-gray-800" title={customerSnapshot.area}>{customerSnapshot.area}</span>
                                </div>
                                <div className="truncate">
                                    <span className="text-[7px] text-gray-400 block mb-0.5">Route</span>
                                    <span className="text-gray-800" title={customerSnapshot.route}>{customerSnapshot.route}</span>
                                </div>
                            </div>
                        </div>

                        <div className="flex-1 bg-white px-2 py-1.5 tally-border !rounded-none shadow-sm flex flex-col min-h-0">
                            <div className="text-[9px] xl:text-[10px] font-black uppercase text-gray-500 mb-0.5 border-b border-gray-100 pb-1">Narration</div>
                            <textarea
                                value={narration}
                                onChange={e => setNarration(e.target.value)}
                                className="flex-1 w-full p-1 text-[10px] xl:text-[11px] font-bold uppercase border-none outline-none focus:bg-yellow-50 resize-none leading-tight"
                                placeholder="Type narration here..."
                                disabled={isReadOnly}
                            />
                        </div>
                    </div>

                    <div className="col-span-12 bg-[#255d55] px-2 py-1.5 text-white flex items-center gap-1 overflow-x-auto">
                        {isReadOnly ? (
                            <>
                                <button
                                    onClick={() => onPrintBill && transactionToEdit && onPrintBill(transactionToEdit)}
                                    className="px-3 py-0.5 border border-white/40 text-[10px] font-black uppercase whitespace-nowrap hover:bg-white hover:text-[#255d55] transition-colors"
                                >
                                    PRINT (F8)
                                </button>
                                <button
                                    onClick={() => onCancel && onCancel()}
                                    className="px-3 py-0.5 border border-white/40 text-[10px] font-black uppercase whitespace-nowrap hover:bg-white hover:text-[#255d55] transition-colors"
                                >
                                    RETURN (Esc)
                                </button>
                            </>
                        ) : (
                            ["SALE", "PURC", "SC", "PC", "COPY BILL", "PASTE", "SR", "PR", "CASH", "SAVE", "PRINT", "RETURN"].map(btn => (
                                <button
                                    key={btn}
                                    onClick={() => {
                                        if (btn === 'SAVE') handleSave();
                                        if (btn === 'PRINT' && transactionToEdit) onPrintBill(transactionToEdit);
                                        if (btn === 'RETURN' && onCancel) onCancel();
                                    }}
                                    className="px-3 py-0.5 border border-white/40 text-[10px] font-black uppercase whitespace-nowrap hover:bg-white hover:text-[#255d55] transition-colors"
                                >
                                    {btn}
                                </button>
                            ))
                        )}
                        <div className="ml-auto text-right pr-2 flex items-center gap-6">
                            {!isNonGst && (
                                <div className="flex gap-4 text-[10px] font-bold uppercase opacity-80 border-r border-white/20 pr-4">
                                    <div className="flex flex-col">
                                        <span>SGST</span>
                                        <span className="text-xs">₹{(totals.tax / 2).toFixed(2)}</span>
                                    </div>
                                    <div className="flex flex-col">
                                        <span>CGST</span>
                                        <span className="text-xs">₹{(totals.tax / 2).toFixed(2)}</span>
                                    </div>
                                    <div className="flex flex-col">
                                        <span>GST Amount</span>
                                        <span className="text-xs">₹{(totals.tax || 0).toFixed(2)}</span>
                                    </div>
                                </div>
                            )}
                            <div className="flex flex-col">
                                <div className="text-[11px] uppercase font-bold">Invoice Value</div>
                                <div className="text-2xl font-black">₹{(grandTotal || 0).toFixed(2)}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

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
                        <span className="text-[10px] font-bold uppercase opacity-70">↑/↓ Navigate | F4 Product Details | Enter Select</span>
                    </div>

                    <div className="flex flex-1 overflow-hidden relative">
                        <div className="flex-1 flex flex-col overflow-hidden">
                            <div className="p-2 bg-white dark:bg-zinc-900 border-b-2 border-primary/10">
                                <input
                                    ref={modalSearchInputRef}
                                    type="text"
                                    value={modalSearchTerm}
                                    onChange={e => {
                                        setModalSearchTerm(e.target.value);
                                        setSelectedSearchIndex(0);
                                    }}
                                    onKeyDown={handleCreateMaterialFromMatrixKeyDown}
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
                                                <th className="p-1.5 px-3 text-center border-r border-gray-200">Strip/Pack Stock</th>
                                                <th className="p-1.5 px-3 text-center border-r border-gray-200">Loose Stock</th>
                                                <th className="p-1.5 px-3 text-center border-r border-gray-200">Total Units</th>
                                                <th className="p-1.5 px-3 text-right">MRP</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {deduplicatedSearchInventory.map((res, sIdx) => {
                                                const isSelected = sIdx === selectedSearchIndex;
                                                const item = res.item;
                                                const totalStock = res.batches.reduce((sum, batch) => sum + (batch.stock || 0), 0);
                                                const unitsPerPack = resolveUnitsPerStrip(item.unitsPerPack, item.packType);
                                                const stripsStock = Math.floor(totalStock / unitsPerPack);
                                                const looseStock = totalStock % unitsPerPack;
                                                const isAnyBatchExpired = res.batches.some(b => checkIsExpired(b.expiry ? String(b.expiry) : ''));
                                                const areAllBatchesExpired = res.batches.length > 0 && res.batches.every(b => checkIsExpired(b.expiry ? String(b.expiry) : ''));

                                                return (
                                                    <tr
                                                        key={item.id}
                                                        data-index={sIdx}
                                                        onClick={() => triggerBatchSelection(res)}
                                                        onMouseEnter={() => setSelectedSearchIndex(sIdx)}
                                                        className={`cursor-pointer transition-colors border-b border-gray-100 hover:bg-primary hover:text-white group ${isSelected ? 'bg-primary text-white scale-[1.01] z-10 shadow-xl' : ''} ${areAllBatchesExpired ? 'opacity-50 grayscale' : ''}`}
                                                    >
                                                        <td className="p-1.5 px-3 border-r border-gray-200">
                                                            <div className="flex items-center gap-2">
                                                                <p className={`leading-none ${matrixRowTextStyle} ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-950'}`}>{item.name}</p>
                                                                {areAllBatchesExpired && <span className="bg-red-600 text-white text-[8px] px-1 py-0.5 font-black uppercase">Expired</span>}
                                                                {!areAllBatchesExpired && isAnyBatchExpired && <span className="bg-amber-500 text-white text-[8px] px-1 py-0.5 font-black uppercase">Some Expired</span>}
                                                            </div>
                                                        </td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center font-mono ${matrixRowTextStyle} ${isSelected ? 'text-white' : 'group-hover:text-white text-primary'}`}>
                                                            {item.code}
                                                        </td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 ${matrixRowTextStyle} ${isSelected ? 'text-white/80' : 'group-hover:text-white text-gray-500'}`}>{item.manufacturer || item.brand}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (totalStock <= 0 ? 'text-red-500 group-hover:text-white' : 'text-emerald-700 group-hover:text-white')}`}>{stripsStock}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (totalStock <= 0 ? 'text-red-500 group-hover:text-white' : 'text-emerald-700 group-hover:text-white')}`}>{looseStock}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (totalStock <= 0 ? 'text-red-500 group-hover:text-white' : 'text-emerald-700 group-hover:text-white')}`}>{totalStock}</td>
                                                        <td className={`p-1.5 px-3 text-right ${matrixRowTextStyle} ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-900'}`}>₹{(item.mrp || 0).toFixed(2)}</td>
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
                            onClose={closeInsightsPanel}
                        />

                        <div className="w-80 bg-[#f9f7d9] dark:bg-zinc-900 border-l-2 border-primary/10 flex flex-col overflow-y-auto">
                            {activeIntelItem ? (
                                <div className="flex-1 flex flex-col p-6 animate-in slide-in-from-right-4 duration-300">
                                    {isFieldVisible('intelHub') && (
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
                                    )}

                                    <div className="space-y-6">
                                        {isFieldVisible('intelIdentity') && (
                                            <div className="bg-white/50 dark:bg-zinc-800/50 p-4 border border-primary/5 shadow-sm">
                                                <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2 opacity-60">Identity & Validity</p>
                                                <p className="text-lg font-black text-gray-900 dark:text-white font-mono leading-none truncate">{activeIntelItem.batch} | {activeIntelItem.code}</p>
                                                <p className="text-[10px] font-bold text-gray-500 uppercase mt-1">Batch: {activeIntelItem.batch}</p>
                                                <p className="text-xs font-bold text-red-600 uppercase mt-2">Exp: {activeIntelItem.expiry ? String(activeIntelItem.expiry) : 'N/A'}</p>
                                            </div>
                                        )}

                                        {isFieldVisible('intelPricing') && (
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
                                        )}

                                        {isFieldVisible('intelProfit') && (
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
                                        )}
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

            <JournalEntryViewerModal
                isOpen={isJournalModalOpen}
                onClose={() => setIsJournalModalOpen(false)}
                invoiceId={transactionToEdit?.id}
                invoiceNumber={transactionToEdit?.id || currentInvoiceNo}
                documentType="SALES"
                currentUser={currentUser}
                isPosted={isPostedVoucher}
            />

            {isAddMedicineMasterModalOpen && (
                <AddMedicineModal
                    isOpen={isAddMedicineMasterModalOpen}
                    onClose={() => setIsAddMedicineMasterModalOpen(false)}
                    onAddMedicine={onAddMedicineMaster}
                    onMedicineSaved={handleMedicineSavedFromSales}
                    initialName={modalSearchTerm.trim() || undefined}
                    organizationId={currentUser?.organization_id || ''}
                />
            )}
            {isAddInventoryModalOpen && (
                <AddProductModal
                    isOpen={isAddInventoryModalOpen}
                    onClose={() => {
                        setIsAddInventoryModalOpen(false);
                        setNewlyCreatedMedicine(null);
                    }}
                    onAddProduct={handleAddInventoryForNewMedicine}
                    organizationId={currentUser?.organization_id || ''}
                    medicines={medicines}
                    initialData={{
                        name: newlyCreatedMedicine?.name || '',
                        code: newlyCreatedMedicine?.materialCode || '',
                        brand: newlyCreatedMedicine?.brand || '',
                        manufacturer: newlyCreatedMedicine?.manufacturer || newlyCreatedMedicine?.marketer || '',
                        composition: newlyCreatedMedicine?.composition || '',
                        hsnCode: newlyCreatedMedicine?.hsnCode || '',
                        gstPercent: newlyCreatedMedicine?.gstRate || 0,
                        mrp: Number(newlyCreatedMedicine?.mrp || 0),
                        rateA: Number(newlyCreatedMedicine?.rateA || 0),
                        rateB: Number(newlyCreatedMedicine?.rateB || 0),
                        rateC: Number(newlyCreatedMedicine?.rateC || 0),
                        packType: newlyCreatedMedicine?.pack || '',
                        unitsPerPack: resolveUnitsPerStrip(extractPackMultiplier(newlyCreatedMedicine?.pack) ?? 1, newlyCreatedMedicine?.pack),
                        barcode: newlyCreatedMedicine?.barcode || ''
                    }}
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
                    onSave={handleUpdateMaterialFromSales}
                />
            )}

            <CustomerSearchModal
                isOpen={isCustomerSearchModalOpen}
                onClose={() => {
                    setIsCustomerSearchModalOpen(false);
                    // Focus the next field on Esc
                    setTimeout(() => phoneInputRef.current?.focus(), 100);
                }}
                customers={customers}
                transactions={transactions}
                onSelect={handleSelectCustomer}
                initialSearch={customerSearch}
            />

            <AddCustomerModal
                isOpen={isAddCustomerModalOpen}
                onClose={() => {
                    setIsAddCustomerModalOpen(false);
                    setTimeout(() => customerSearchInputRef.current?.focus(), 100);
                }}
                onAdd={handleAddCustomerModalSave as any}
                teamMembers={teamMembers}
                organizationId={currentUser?.organization_id || ''}
                defaultControlGlId={defaultCustomerControlGlId}
                initialName={customerSearch.trim()}
                initialPhone={customerPhone.trim()}
            />

            {isPrescriptionAlertOpen && (
                <div
                    className="fixed inset-0 z-[220] flex items-center justify-center bg-[rgba(0,0,0,0.45)] px-4"
                    onClick={() => setIsPrescriptionAlertOpen(false)}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Prescription Required"
                >
                    <div
                        className="w-full max-w-[420px] rounded-xl bg-white shadow-[0_14px_40px_rgba(0,0,0,0.28)] border border-gray-200 overflow-hidden animate-[fadeIn_160ms_ease-out]"
                        style={{ animation: 'fadeIn 160ms ease-out, zoomIn 160ms ease-out' }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                            <h3 className="text-sm font-bold text-gray-900">⚠️ Prescription Required</h3>
                            <button
                                type="button"
                                className="text-gray-500 hover:text-gray-700"
                                onClick={() => setIsPrescriptionAlertOpen(false)}
                                aria-label="Close"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="p-4 space-y-3">
                            <p className="text-sm text-gray-800">
                                This item requires a valid prescription.
                                Please verify prescription details before billing.
                            </p>
                            <p className="text-xs font-medium text-gray-600">
                                Prescription items require customer details as per compliance rules.
                            </p>
                            <div className="pt-2 flex justify-end gap-2">
                                <button
                                    type="button"
                                    className="px-4 py-2 text-xs font-semibold border border-gray-300 text-gray-700 rounded-md bg-white"
                                    onClick={() => setIsPrescriptionAlertOpen(false)}
                                >
                                    Proceed Anyway
                                </button>
                                <button
                                    type="button"
                                    className="px-4 py-2 text-xs font-semibold bg-red-600 text-white rounded-md"
                                    onClick={() => {
                                        if (pendingPrescriptionItemId) {
                                            setCartItems(prev => prev.filter(item => item.id !== pendingPrescriptionItemId));
                                        }
                                        setPendingPrescriptionItemId(null);
                                        setIsPrescriptionAlertOpen(false);
                                    }}
                                >
                                    Cancel Item
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <Modal
                isOpen={isDoctorPickerOpen}
                onClose={() => setIsDoctorPickerOpen(false)}
                title="Select Doctor"
                widthClass="max-w-[680px]"
                heightClass="h-[380px]"
            >
                <div className="p-3 bg-white h-full flex flex-col">
                    <input
                        ref={doctorSearchInputRef}
                        type="text"
                        value={doctorSearchTerm}
                        onChange={(e) => {
                            setDoctorSearchTerm(e.target.value);
                            setDoctorHighlightedIndex(0);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                setDoctorHighlightedIndex(prev => Math.min(prev + 1, Math.max(filteredDoctors.length - 1, 0)));
                            } else if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                setDoctorHighlightedIndex(prev => Math.max(prev - 1, 0));
                            } else if (e.key === 'Enter') {
                                e.preventDefault();
                                const selectedDoctor = filteredDoctors[doctorHighlightedIndex];
                                if (selectedDoctor) {
                                    handleDoctorSelect(selectedDoctor);
                                } else if (filteredDoctors.length === 0) {
                                    handleUseTypedDoctorName();
                                }
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setIsDoctorPickerOpen(false);
                            }
                        }}
                        placeholder="Search doctor name / mobile..."
                        className="h-9 w-full border border-gray-300 px-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-blue-200"
                    />
                    <div className="mt-3 border border-gray-200 rounded shadow-sm overflow-hidden flex-1 min-h-0">
                        <div className="overflow-auto h-full popup-content">
                            <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-gray-50 z-10">
                                    <tr className="text-left text-[11px] font-bold text-gray-600">
                                        <th className="px-3 py-2 border-b">Doctor Name</th>
                                        <th className="px-3 py-2 border-b">Mobile</th>
                                        <th className="px-3 py-2 border-b">Specialization</th>
                                        <th className="px-3 py-2 border-b">Area</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredDoctors.length > 0 ? filteredDoctors.map((doctor, index) => (
                                        <tr
                                            key={doctor.id}
                                            className={`cursor-pointer ${doctorHighlightedIndex === index ? 'bg-blue-100' : 'bg-white hover:bg-gray-50'}`}
                                            onMouseEnter={() => setDoctorHighlightedIndex(index)}
                                            onClick={() => handleDoctorSelect(doctor)}
                                        >
                                            <td className="px-3 py-2 border-b">{doctor.name || '-'}</td>
                                            <td className="px-3 py-2 border-b">{doctor.mobile || '-'}</td>
                                            <td className="px-3 py-2 border-b">{doctor.specialization || '-'}</td>
                                            <td className="px-3 py-2 border-b">{doctor.area || '-'}</td>
                                        </tr>
                                    )) : (
                                        <tr>
                                            <td colSpan={4} className="px-3 py-4 text-gray-500">
                                                <div className="doctor-empty">
                                                    <div className="empty-text">No active doctors found</div>
                                                    {doctorSearchTerm.trim() && (
                                                        <>
                                                            <button
                                                                type="button"
                                                                className="btn-use-doctor"
                                                                onClick={handleUseTypedDoctorName}
                                                            >
                                                                👉 Use <b>{doctorSearchTerm.trim()}</b> as entered doctor
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn-add-doctor"
                                                                onClick={() => void handleAddTypedDoctorToMaster()}
                                                            >
                                                                ➕ Add "{doctorSearchTerm.trim()}" to Doctor Master
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </Modal>

            <Modal
                isOpen={isDoctorQuickAddOpen}
                onClose={() => setIsDoctorQuickAddOpen(false)}
                title="Register New Doctor"
            >
                <div className="p-4 space-y-3">
                    <p className="text-[10px] font-bold uppercase text-gray-500">Triggered via Ctrl + Enter in Referred By field.</p>
                    <div>
                        <label className="text-[10px] font-black uppercase text-gray-600 block mb-1">Doctor Name *</label>
                        <input
                            type="text"
                            className="w-full h-9 border border-gray-400 p-2 text-xs font-bold uppercase focus:bg-yellow-50 outline-none"
                            value={quickDoctorName}
                            onChange={e => setQuickDoctorName(e.target.value)}
                            autoFocus
                        />
                    </div>
                    <div className="pt-2 flex justify-end gap-2">
                        <button
                            className="px-4 py-2 text-xs font-black uppercase border border-gray-300 text-gray-600"
                            onClick={() => setIsDoctorQuickAddOpen(false)}
                            type="button"
                        >
                            Cancel
                        </button>
                        <button
                            className="px-4 py-2 text-xs font-black uppercase bg-primary text-white"
                            onClick={handleQuickDoctorSave}
                            type="button"
                        >
                            Save & Select
                        </button>
                    </div>
                </div>
            </Modal>

            {schemeItem && (
                <SchemeModal
                    isOpen={!!schemeItem}
                    onClose={() => { setSchemeItem(null); setTimeout(() => productSearchInputRef.current?.focus(), 100); }}
                    item={schemeItem}
                    schemeCalculationBasis={schemeItem.schemeCalculationBasis === 'before_discount' ? 'before_discount' : 'after_discount'}
                    onApply={handleApplyScheme}
                    onClear={handleClearScheme}
                />
            )}

            <SchemeCalculatorModal
                isOpen={isSchemeCalcOpen}
                onClose={() => setIsSchemeCalcOpen(false)}
                baseRate={cartItems.find(i => i.id === activeSchemeCalcRowId)?.rate || 0}
                onApply={(effectiveRate) => {
                    if (activeSchemeCalcRowId) {
                        handleUpdateCartItem(activeSchemeCalcRowId, 'rate', effectiveRate);
                    }
                }}
            />

            <BatchSelectionModal
                isOpen={!!pendingBatchSelection}
                onClose={() => { setPendingBatchSelection(null); setTimeout(() => productSearchInputRef.current?.focus(), 100); }}
                productName={pendingBatchSelection?.item.name || ''}
                batches={pendingBatchSelection?.batches || []}
                onSelect={addSelectedBatchToGrid}
            />

            <Modal
                isOpen={isStockIssueModalOpen}
                onClose={() => setIsStockIssueModalOpen(false)}
                title={`Stock Validation (${stockValidationIssues.length})`}
                widthClass="max-w-3xl"
            >
                <div className="p-4 overflow-auto">
                    <div className="text-[11px] font-black uppercase tracking-wider text-red-700 mb-3">
                        Insufficient stock for the following items:
                    </div>
                    <div className="space-y-2">
                        {stockValidationIssues.map((issue, index) => (
                            <button
                                key={`${issue.itemId}-${index}`}
                                type="button"
                                onClick={() => {
                                    setIsStockIssueModalOpen(false);
                                    const targetIndex = cartItems.findIndex(ci => ci.id === issue.itemId);
                                    if (targetIndex >= 0) setSelectedRowIndex(targetIndex);
                                    setTimeout(() => {
                                        const rowEl = document.getElementById(`cart-row-${issue.itemId}`);
                                        rowEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        const targetFieldId = issue.reason === 'batch_missing' ? `batch-${issue.itemId}` : `qty-p-${issue.itemId}`;
                                        const targetField = document.getElementById(targetFieldId) as HTMLElement | null;
                                        targetField?.focus();
                                    }, 0);
                                }}
                                className="w-full text-left p-2 border border-red-200 bg-red-50 hover:bg-red-100 transition-colors"
                            >
                                <div className="text-[11px] font-black text-red-800">
                                    {index + 1}. Item: {issue.itemName} | Batch: {issue.batch} | Available: {issue.available} | Required: {issue.required}
                                </div>
                                <div className="text-[10px] font-bold text-red-600 mt-1 uppercase">
                                    {issue.reason === 'batch_missing'
                                        ? 'Please select batch for this item.'
                                        : issue.reason === 'no_stock'
                                            ? 'No stock available in selected batch.'
                                            : 'Required quantity exceeds available stock.'}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            </Modal>

            <WebcamCaptureModal
                isOpen={isWebcamOpen}
                onClose={() => setIsWebcamOpen(false)}
                onCapture={handleWebcamCapture}
            />

            <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                accept="image/*,application/pdf"
                onChange={handleFileChange}
            />
        </div>

        {!isSidebarCollapsed && (
            <div className="w-64 h-full bg-white flex flex-col overflow-hidden shadow-xl shrink-0">
                <div className="bg-gray-800 text-white h-7 flex items-center px-4 shrink-0">
                    <span className="text-[10px] font-black uppercase tracking-widest">Sales Insights</span>
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
                        <div className="text-[9px] font-bold text-gray-500 uppercase">Orders Count (MTD)</div>
                        <div className="text-sm font-black text-gray-800">{stats.monthCount}</div>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 bg-gray-50/50">
                    <div className="text-[10px] font-black text-gray-400 uppercase mb-2 ml-1">Last 20 Sales</div>
                    <div className="space-y-1.5">
                        {salesHistory.map((sale) => (
                            <button
                                key={sale.id}
                                type="button"
                                onClick={() => handleOpenRecentSalePreview(sale)}
                                disabled={historyPreviewLoadingId === sale.id}
                                className="w-full text-left p-2 bg-white border border-gray-200 hover:bg-primary group transition-colors cursor-pointer text-[11px] shadow-sm disabled:opacity-60 disabled:cursor-wait"
                            >
                                <div className="flex justify-between items-start mb-0.5">
                                    <span className="font-black text-gray-800 uppercase truncate pr-2 flex-1 group-hover:text-white" title={sale.customerName}>{sale.customerName}</span>
                                    <span className="shrink-0 font-black text-primary group-hover:text-white">
                                        {historyPreviewLoadingId === sale.id ? 'Opening...' : `₹${sale.total.toFixed(2)}`}
                                    </span>
                                </div>
                                <div className="flex justify-between text-[9px] text-gray-400 font-bold uppercase group-hover:text-white/70">
                                    <span>{formatVoucherNo(sale.invoiceNumber || sale.id)}</span>
                                    <span>{(sale.date || '').split('T')[0]}</span>
                                </div>
                            </button>
                        ))}
                        {salesHistory.length === 0 && (
                            <div className="text-center py-10 text-gray-400 text-xs italic">No recent sales</div>
                        )}
                    </div>
                </div>
            </div>
        )}

        {viewingHistorySale && (
            <Modal
                isOpen={!!viewingHistorySale}
                onClose={() => setViewingHistorySale(null)}
                title={`View Sales Invoice: ${formatVoucherNo(viewingHistorySale.invoiceNumber || viewingHistorySale.id)}`}
            >
                <div className="h-[90vh] overflow-hidden flex flex-col">
                    <POS
                        inventory={inventory}
                        purchases={purchases}
                        medicines={medicines}
                        customers={customers}
                        doctors={doctors}
                        onSaveOrUpdateTransaction={() => Promise.resolve()}
                        onPrintBill={onPrintBill}
                        currentUser={currentUser}
                        config={config}
                        configurations={configurations}
                        billType={billType}
                        transactionToEdit={viewingHistorySale}
                        isReadOnly={true}
                        onCancel={() => setViewingHistorySale(null)}
                        onAddMedicineMaster={onAddMedicineMaster}
                        onQuickAddCustomer={onQuickAddCustomer}
                        onAddCustomer={onAddCustomer}
                        teamMembers={teamMembers}
                        defaultCustomerControlGlId={defaultCustomerControlGlId}
                        onRefreshConfig={onRefreshConfig}
                        openChallanExposure={openChallanExposure}
                        salesChallans={salesChallans}
                        addNotification={addNotification}
                    />
                </div>
            </Modal>
        )}
    </div>
);

});

export default POS;
