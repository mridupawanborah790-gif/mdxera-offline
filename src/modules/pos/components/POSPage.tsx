import React, { useState, useRef, useEffect, useMemo, useImperativeHandle, forwardRef, useCallback } from 'react';
import Card from '@core/components/ui/Card';
import SchemeModal from '../components/SchemeModal';
import Modal from '@core/components/ui/Modal';
import AddMedicineModal from '@modules/inventory/components/AddMedicineModal';
import BatchSelectionModal from '@modules/inventory/components/BatchSelectionModal';
import WebcamCaptureModal from '@modules/inventory/components/WebcamCaptureModal';
import CustomerSearchModal from '@modules/customers/components/CustomerSearchModal';
import JournalEntryViewerModal from '@modules/accounting/components/JournalEntryViewerModal';
import ProductInsightsPanel from '@modules/inventory/components/ProductInsightsPanel';
import { extractPrescription } from '@core/services/geminiService';
import * as storage from '@core/services/storageService';
import { supabase } from '@core/db/supabaseClient';
import { InventoryItem, Customer, Transaction, BillItem, AppConfigurations, RegisteredPharmacy, Medicine, Purchase, FileInput } from '@core/types';
import { generateNewInvoiceId } from '@core/utils/invoice';
import { handleEnterToNextField } from '@core/utils/navigation';
import { fuzzyMatch } from '@core/utils/search';
import { calculateCustomerReceivableBreakdown, getOutstandingBalance, parseNumber, checkIsExpired, formatExpiryToMMYY, formatVoucherNo } from '@core/utils/helpers';
import { getInventoryPolicy, getResolvedMedicinePolicy } from '@core/utils/materialType';
import { isLiquidOrWeightPack, resolveUnitsPerStrip } from '@core/utils/pack';
import { calculateBillingTotals, resolveBillingSettings } from '@core/utils/billing';

interface POSProps {
    inventory: InventoryItem[];
    purchases: Purchase[];
    medicines: Medicine[];
    customers: Customer[];
    transactions?: Transaction[];
    onSaveOrUpdateTransaction: (transaction: Transaction, isUpdate: boolean, nextCounter?: number) => Promise<void>;
    onPrintBill: (transaction: Transaction) => void;
    currentUser: RegisteredPharmacy | null;
    config: any;
    configurations: AppConfigurations;
    billType?: 'regular' | 'non-gst';
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    transactionToEdit?: Transaction | null;
    isReadOnly?: boolean;
    onCancel?: () => void;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
}

interface UploadedFile {
    id: string;
    data: string;
    type: 'image' | 'pdf';
    name: string;
}

const uniformTextStyle = "text-sm font-bold tracking-tight uppercase leading-tight";
const matrixRowTextStyle = "text-base font-bold tracking-tight uppercase leading-tight";

const parseExpiryForSort = (expiry?: string | null): number => {
    const formatted = formatExpiryToMMYY(expiry || '');
    const [monthText, yearText] = formatted.split('/');
    const month = Number(monthText);
    const year = Number(yearText);
    if (!month || !year) return Number.MAX_SAFE_INTEGER;
    return (year * 100) + month;
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

const resolveProductDiscountPercent = (item?: Partial<InventoryItem> | null) => {
    if (!item) return 0;
    const candidateKeys: Array<keyof InventoryItem | 'discountPercent' | 'defaultDiscount' | 'saleDiscountPercent'> = ['discountPercent', 'defaultDiscount', 'saleDiscountPercent'];
    for (const key of candidateKeys) {
        const value = Number((item as any)?.[key]);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
};



const getBilledQuantity = (item: BillItem) => {
    const unitsPerPack = item.unitsPerPack || 1;
    return Math.max(0, (item.quantity || 0) + ((item.looseQuantity || 0) / unitsPerPack));
};

const recalculateSchemeFields = (item: BillItem): BillItem => {
    if (!item.schemeMode) return item;

    const billedQty = getBilledQuantity(item);
    const baseRate = Number(item.rate || item.mrp || 0);
    const tradeDiscountPercent = Number(item.discountPercent || 0);
    const netRate = baseRate * (1 - tradeDiscountPercent / 100);
    const schemeBaseRate = item.schemeCalculationBasis === 'before_discount' ? baseRate : netRate;
    const appliedQty = Math.max(0, Number(item.schemeQty || 0));
    const schemeValue = Math.max(0, Number(item.schemeValue || 0));
    const schemeTotalQty = Math.max(0, Number(item.schemeTotalQty || 0));

    let calculatedTotalDiscount = 0;
    if (item.schemeMode === 'free_qty') {
        calculatedTotalDiscount = Math.min(appliedQty, billedQty) * schemeBaseRate;
    } else if (item.schemeMode === 'qty_ratio' && schemeTotalQty > 0) {
        calculatedTotalDiscount = (billedQty * schemeBaseRate) * (appliedQty / schemeTotalQty);
    } else if (item.schemeMode === 'flat') {
        calculatedTotalDiscount = Math.min(appliedQty, billedQty) * schemeValue;
    } else if (item.schemeMode === 'percent') {
        calculatedTotalDiscount = Math.min(appliedQty || billedQty, billedQty) * (schemeBaseRate * (schemeValue / 100));
    } else if (item.schemeMode === 'price_override') {
        calculatedTotalDiscount = Math.min(appliedQty, billedQty) * Math.max(0, schemeBaseRate - schemeValue);
    }

    const discountedSubtotal = billedQty * netRate;
    const schemeDiscountAmount = Math.max(0, Math.min(calculatedTotalDiscount, discountedSubtotal));
    const schemeDiscountPercent = discountedSubtotal > 0 ? (schemeDiscountAmount / discountedSubtotal) * 100 : 0;

    return {
        ...item,
        schemeDiscountAmount,
        schemeDiscountPercent,
    };
};

const inventoryMapCache = new WeakMap<InventoryItem[], {
    byId: Map<string, InventoryItem>;
    byNameAndBrand: Map<string, InventoryItem>;
}>();

const getInventoryByIdOrNameBrand = (inventory: InventoryItem[], id?: string, name?: string, brand?: string): InventoryItem | undefined => {
    let cached = inventoryMapCache.get(inventory);
    if (!cached) {
        const byId = new Map<string, InventoryItem>();
        const byNameAndBrand = new Map<string, InventoryItem>();
        (inventory || []).forEach(i => {
            if (i.id) byId.set(i.id, i);
            const key = `${(i.name || '').trim().toLowerCase()}|${(i.brand || '').trim().toLowerCase()}`;
            if (!byNameAndBrand.has(key)) {
                byNameAndBrand.set(key, i);
            }
        });
        cached = { byId, byNameAndBrand };
        inventoryMapCache.set(inventory, cached);
    }
    if (id) {
        const item = cached.byId.get(id);
        if (item) return item;
    }
    if (name) {
        const key = `${name.trim().toLowerCase()}|${(brand || '').trim().toLowerCase()}`;
        return cached.byNameAndBrand.get(key);
    }
    return undefined;
};

const POS = forwardRef<any, POSProps>(({
    inventory,
    purchases,
    medicines,
    customers,
    transactions = [],
    onSaveOrUpdateTransaction,
    onPrintBill,
    currentUser,
    config,
    configurations,
    billType = 'regular',
    addNotification,
    transactionToEdit,
    isReadOnly,
    onCancel,
    onAddMedicineMaster
}, ref) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
    const [customerSearch, setCustomerSearch] = useState('');
    const [customerAddress, setCustomerAddress] = useState('');
    const [customerPhone, setCustomerPhone] = useState('');
    const billCategorySelectRef = useRef<HTMLSelectElement>(null);
    const customerSearchInputRef = useRef<HTMLInputElement>(null);
    const productSearchInputRef = useRef<HTMLInputElement>(null);
    const modalSearchInputRef = useRef<HTMLInputElement>(null);
    const searchResultsRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dateInputRef = useRef<HTMLInputElement>(null);
    const phoneInputRef = useRef<HTMLInputElement>(null);

    const [billCategory, setBillCategory] = useState<'Cash Bill' | 'Credit Bill'>('Cash Bill');
    const [billMode, setBillMode] = useState<'GST' | 'EST'>(billType === 'non-gst' ? 'EST' : 'GST');
    const [referredBy, setReferredBy] = useState('');
    const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
    const [cartItems, setCartItems] = useState<BillItem[]>([]);
    const [prescriptions, setPrescriptions] = useState<UploadedFile[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [isProcessingRx, setIsProcessingRx] = useState(false);
    const [isWebcamOpen, setIsWebcamOpen] = useState(false);
    const [lumpsumDiscount, setLumpsumDiscount] = useState<number>(0);
    const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
    const [isInsightsOpen, setIsInsightsOpen] = useState(false);
    const [isKeywordFocused, setIsKeywordFocused] = useState(false);
    const [salesHistory, setSalesHistory] = useState<Transaction[]>([]);
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

            const monthQuery = supabase
                .from('sales_bill')
                .select('total, date')
                .eq('organization_id', currentUser.organization_id)
                .in('status', ['completed', 'Completed'])
                .gte('date', startOfMonthStr);

            const todayQuery = supabase
                .from('sales_bill')
                .select('total')
                .eq('organization_id', currentUser.organization_id)
                .in('status', ['completed', 'Completed'])
                .gte('date', todayStartIso)
                .lt('date', tomorrowStartIso);

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

            const { data: recent } = await supabase
                .from('sales_bill')
                .select('*')
                .eq('organization_id', currentUser.organization_id)
                .in('status', ['completed', 'Completed'])
                .order('created_at', { ascending: false })
                .limit(20);
            if (recent) setSalesHistory(recent.map(r => storage.toCamel(r)));
        } catch (e) {
            console.error('Error fetching stats:', e);
        }
    }, [currentUser]);

    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    const [isInsightsLoading, setIsInsightsLoading] = useState(false);
    const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
    const [modalSearchTerm, setModalSearchTerm] = useState('');
    const [isCustomerSearchModalOpen, setIsCustomerSearchModalOpen] = useState(false);
    const [pendingBatchSelection, setPendingBatchSelection] = useState<{ item: InventoryItem; batches: InventoryItem[] } | null>(null);
    const [schemeItem, setSchemeItem] = useState<BillItem | null>(null);
    const [isJournalModalOpen, setIsJournalModalOpen] = useState(false);
    const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
    const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);

    const activeRowIdRef = useRef<string | null>(null);

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
    const inventoryWithPolicy = useMemo(() => inventory.map(item => ({ item, policy: getInventoryPolicy(item, medicines) })), [inventory, medicines]);
    const applicableLineDiscountPercent = useMemo(() => {
        const rules = configurations?.discountRules || [];
        const firstApplicablePercentRule = rules.find(rule => rule.enabled && rule.level === 'line' && (rule.type === 'percentage' || rule.type === 'trade'));
        return Math.max(0, Number(firstApplicablePercentRule?.value || 0));
    }, [configurations]);

    const isFieldVisible = useCallback((fieldId: string) => {
        if (config?.fields) return config.fields[fieldId] !== false;
        return configurations.modules?.['pos']?.fields?.[fieldId] !== false;
    }, [config, configurations.modules]);

    useEffect(() => {
        const handleGlobalKeyDown = () => {
            setHoveredRowId(null);
        };
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, []);

    const totals = useMemo(() => calculateBillingTotals({
        items: cartItems,
        billDiscount: lumpsumDiscount,
        isNonGst,
        configurations,
    }), [cartItems, lumpsumDiscount, isNonGst, configurations]);

    const activeLineTotals = useMemo(() => {
        const targetId = hoveredRowId || selectedRowId;
        if (!targetId) return null;
        const item = cartItems.find(i => i.id === targetId);
        if (!item) return null;

        return calculateBillingTotals({
            items: [item],
            billDiscount: 0,
            isNonGst,
            configurations,
        });
    }, [cartItems, hoveredRowId, selectedRowId, isNonGst, configurations]);

    const activeSummary = useMemo(() => {
        const targetId = hoveredRowId || selectedRowId;
        if (!targetId) return null;
        const item = cartItems.find(i => i.id === targetId);
        if (!item || !activeLineTotals) return null;

        const effectiveSchemeRule = item.schemeCalculationBasis
            || (resolveBillingSettings(configurations).schemeBase === 'subtotal' ? 'before_discount' : 'after_discount');
        const value = activeLineTotals.gross || 0;
        const discount = (activeLineTotals.tradeDiscount || 0) + (activeLineTotals.lineFlatDiscount || 0);
        const amountAfterDiscount = activeLineTotals.subtotal || 0;
        const schemeAmount = activeLineTotals.schemeTotal || 0;
        const taxableValueAfterScheme = activeLineTotals.taxableValue || 0;
        const lineTax = activeLineTotals.tax || 0;
        const lineTotal = activeLineTotals.baseTotal || 0;

        return {
            rule: effectiveSchemeRule,
            value,
            discount,
            amountAfterDiscount,
            schemeAmount,
            taxableValueAfterScheme,
            lineTax,
            lineTotal,
        };
    }, [cartItems, hoveredRowId, selectedRowId, configurations, activeLineTotals]);

    useEffect(() => {
        setBillMode(billType === 'non-gst' ? 'EST' : 'GST');
    }, [billType]);

    useEffect(() => {
        if (transactionToEdit) {
            setSelectedCustomer(customers.find(c => c.id === transactionToEdit.customerId) || null);
            setCustomerSearch(transactionToEdit.customerName || '');
            setCustomerAddress(transactionToEdit.customerAddress || '');
            setCustomerPhone(transactionToEdit.customerPhone || '');
            setReferredBy(transactionToEdit.referredBy || '');
            setInvoiceDate(transactionToEdit.date.split('T')[0]);
            setCartItems(transactionToEdit.items || []);
            setLumpsumDiscount(transactionToEdit.schemeDiscount || 0);
        } else {
            setTimeout(() => dateInputRef.current?.focus(), 150);
        }
    }, [transactionToEdit, customers]);

    const currentInvoiceNo = useMemo(() => {
        if (transactionToEdit) return transactionToEdit.id;
        const configKey = isNonGst ? 'nonGstInvoiceConfig' : 'invoiceConfig';
        const typeKey = isNonGst ? 'non-gst' : 'regular';
        const { id } = generateNewInvoiceId(configurations[configKey], typeKey);
        return id;
    }, [transactionToEdit, isNonGst, configurations, billMode]);

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
            if (['cash', 'card', 'upi', 'bank'].includes(sale.paymentMode)) sale.balance = 0;
        }

        return Number(sales.reduce((sum, row) => sum + Number(row.balance || 0), 0).toFixed(2));
    }, [currentUser]);

    const handleSave = useCallback(async () => {
        if (isSaving || cartItems.length === 0) return;

        if (shouldPreventNegativeStock) {
            for (const item of cartItems) {
                const invItem = item.inventoryItemId ? getInventoryByIdOrNameBrand(inventory, item.inventoryItemId) : undefined;
                if (invItem) {
                    const policy = getInventoryPolicy(invItem, medicines);
                    if (!policy.inventorised) continue;
                    const unitsPerPack = invItem.unitsPerPack || 1;
                    const requiredUnits = (item.quantity * unitsPerPack) + (item.looseQuantity || 0);
                    if (invItem.stock <= 0 || invItem.stock < requiredUnits) {
                        addNotification(`Insufficient stock for ${item.name}. Available: ${invItem.stock}`, "error");
                        return;
                    }
                }
            }
        }

        setIsSaving(true);

        const generatedId = transactionToEdit
            ? transactionToEdit.id
            : (await storage.reserveVoucherNumber(isNonGst ? 'sales-non-gst' : 'sales-gst', currentUser!)).documentNumber;

        const finalPaymentMode = billCategory === 'Credit Bill' ? 'Credit' : 'Cash';

        const previousBalanceBeforeBill = selectedCustomer?.id
            ? calculateCustomerReceivableBreakdown(
                selectedCustomer,
                await getCustomerInvoiceOutstandingTotal(selectedCustomer)
            ).netOutstanding
            : 0;
        const balanceAfterBill = finalPaymentMode === 'Credit'
            ? Number((previousBalanceBeforeBill + Math.round(totals.baseTotal)).toFixed(2))
            : Number(previousBalanceBeforeBill.toFixed(2));

        const transaction: Transaction = {
            id: generatedId,
            invoiceNumber: generatedId, // Fallback, will be overridden by real reservation in handleSave if using that
            organization_id: currentUser?.organization_id || '',
            date: new Date(invoiceDate).toISOString(),
            customerName: selectedCustomer?.name || customerSearch || 'Walking Customer',
            customerId: selectedCustomer?.id,
            customerPhone: customerPhone || selectedCustomer?.phone,
            customerAddress: customerAddress || selectedCustomer?.address || '',
            referredBy: referredBy || '',
            items: cartItems,
            total: Math.round(totals.baseTotal),
            subtotal: totals.taxableValue,
            totalItemDiscount: totals.tradeDiscount,
            totalGst: totals.tax,
            schemeDiscount: lumpsumDiscount,
            roundOff: totals.autoRoundOff,
            status: 'completed',
            paymentMode: finalPaymentMode,
            billType: isNonGst ? 'non-gst' : 'regular',
            itemCount: cartItems.length,
            // p.data is raw base64 (prefix stripped for Gemini). Wrap as a full
            // data URI so Sales History / TransactionDetailModal can render it.
            prescriptionImages: prescriptions.map(p => {
                if (typeof p.data !== 'string') return p.data;
                if (p.data.startsWith('data:')) return p.data;
                const mime = p.type === 'pdf' ? 'application/pdf' : 'image/png';
                return `data:${mime};base64,${p.data}`;
            }),
            previousBalanceBeforeBill: Number(previousBalanceBeforeBill.toFixed(2)),
            balanceAfterBill,
        };

        try {
            await onSaveOrUpdateTransaction(transaction, !!transactionToEdit);
            if (onPrintBill) onPrintBill(transaction);
            setCartItems([]);
            setPrescriptions([]);
            setSelectedCustomer(null);
            setCustomerSearch('');
            setCustomerAddress('');
            setLumpsumDiscount(0);
            setReferredBy('');
            addNotification(`Bill saved successfully. Bill No: ${transaction.invoiceNumber || transaction.id}`, "success");
            fetchStats();
        } catch (e: any) {
            const errorMessage = e?.message || String(e) || "Unknown error";
            addNotification(`Failed to save bill: ${errorMessage}`, "error");
        } finally {
            setIsSaving(false);
        }
    }, [cartItems, totals, selectedCustomer, invoiceDate, configurations, isNonGst, isSaving, onSaveOrUpdateTransaction, transactionToEdit, currentUser, customerSearch, customerAddress, customerPhone, onPrintBill, addNotification, lumpsumDiscount, billCategory, referredBy, prescriptions, shouldPreventNegativeStock, inventory, medicines, getCustomerInvoiceOutstandingTotal]);

    const focusFirstEditableFieldInRow = useCallback((rowId: string) => {
        const firstEditableField = [
            `name-${rowId}`,
            `batch-${rowId}`,
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

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                handleSave();
                return;
            }

            const activeTag = document.activeElement?.tagName.toLowerCase();
            const isInputFocused = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || (activeTag === 'button' && (document.activeElement?.id?.includes('-') || (document.activeElement as HTMLElement)?.innerText?.includes('Apply')));

            if (!isInputFocused && cartItems.length > 0) {
                const itemIdx = cartItems.findIndex(i => i.id === selectedRowId);
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const targetIdx = Math.max(0, itemIdx - 1);
                    const item = cartItems[targetIdx];
                    if (item) setSelectedRowId(item.id);
                    return;
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const targetIdx = Math.min(cartItems.length - 1, itemIdx + 1);
                    const item = cartItems[targetIdx];
                    if (item) setSelectedRowId(item.id);
                    return;
                } else if (e.key === 'Delete') {
                    if (selectedRowId) {
                        e.preventDefault();
                        const idx = cartItems.findIndex(i => i.id === selectedRowId);
                        handleDeleteRow(selectedRowId, idx);
                    }
                    return;
                } else if (e.key === 'Enter') {
                    if (selectedRowId) {
                        e.preventDefault();
                        focusFirstEditableFieldInRow(selectedRowId);
                    }
                    return;
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleSave, cartItems, selectedRowId, focusFirstEditableFieldInRow]);

    useImperativeHandle(ref, () => ({
        handleSave,
        setCartItems,
        cartItems
    }));

    useEffect(() => {
        if (cartItems.length === 0) {
            setSelectedRowId(null);
            return;
        }

        if (selectedRowId && cartItems.some(item => item.id === selectedRowId)) {
            return;
        }

        setSelectedRowId(cartItems[cartItems.length - 1]?.id || cartItems[0]?.id || null);
    }, [cartItems, selectedRowId]);

    useEffect(() => {
        if (!selectedRowId) return;
        const selectedRow = document.getElementById(`row-${selectedRowId}`);
        selectedRow?.scrollIntoView({ block: 'nearest' });
    }, [selectedRowId]);

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
                for (const aiItem of result.items) {
                    const match = inventory.find(inv => fuzzyMatch(inv.name, aiItem.name));
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
                            discountPercent: resolveProductDiscountPercent(match) || applicableLineDiscountPercent || selectedCustomer?.defaultDiscount || 0,
                            itemFlatDiscount: 0,
                            batch: match.batch,
                            expiry: match.expiry,
                            rate: match.mrp,
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
                setCartItems(prev => [...prev.filter(i => i.name !== ''), ...newBillItems]);
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

        // 1. First check the inventory
        inventoryWithPolicy.forEach(({ item: i, policy }) => {
            if (!policy.salesEnabled) return;
            const name = i.name.toLowerCase();
            const code = (i.code || '').toLowerCase();
            const barcode = (i.barcode || '').toLowerCase();

            if (!term || name.includes(term) || code.includes(term) || barcode.includes(term)) {
                // Use code as primary key if available, otherwise name|brand
                const key = i.code ? `CODE:${i.code.toLowerCase()}` : `NAME:${i.name.toLowerCase()}|${i.brand?.toLowerCase() || ''}`;
                
                if (!grouped.has(key)) {
                    grouped.set(key, { item: i, batches: [i] });
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
                        unitsPerPack: parseInt(m.pack?.match(/\d+/)?.[0] || '10', 10),
                        packType: m.pack || '',
                        minStockLimit: 0,
                        batch: medPolicy.inventorised ? 'NEW-STOCK' : '',
                        expiry: medPolicy.inventorised ? 'N/A' : '',
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
    }, [modalSearchTerm, inventoryWithPolicy, medicines, getResolvedMedicinePolicy]);

    const activeIntelItem = useMemo(() => {
        if (isSearchModalOpen && deduplicatedSearchInventory.length > 0) {
            return deduplicatedSearchInventory[selectedSearchIndex]?.item;
        }

        const targetId = hoveredRowId || selectedRowId;
        if (targetId) {
            const cartItem = cartItems.find(i => i.id === targetId);
            if (cartItem) {
                const found = getInventoryByIdOrNameBrand(inventory, cartItem.inventoryItemId, cartItem.name, cartItem.brand);
                return found || null;
            }
        }

        return null;
    }, [isSearchModalOpen, deduplicatedSearchInventory, selectedSearchIndex, hoveredRowId, selectedRowId, cartItems, inventory]);

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
        storage.fetchTransactions(currentUser)
            .then((rows) => {
                if (!isMounted) return;
                setSalesHistory((rows || []).filter((row: Transaction) => row.organization_id === currentUser.organization_id && row.status === 'completed'));
            })
            .finally(() => {
                if (isMounted) setIsInsightsLoading(false);
            });
        return () => { isMounted = false; };
    }, [isInsightsOpen, currentUser, salesHistory.length]);

    const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            customerSearchInputRef.current?.focus();
        }
    };

    const handleCustomerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            setIsCustomerSearchModalOpen(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (phoneInputRef.current && !phoneInputRef.current.disabled) {
                phoneInputRef.current.focus();
            } else {
                productSearchInputRef.current?.focus();
            }
        }
    };

    const handleSelectCustomer = (c: Customer) => {
        setSelectedCustomer(c);
        setCustomerSearch(c.name);
        setCustomerPhone(c.phone || '');
        setCustomerAddress(c.address || '');
        setIsCustomerSearchModalOpen(false);
        setTimeout(() => {
            if (phoneInputRef.current && !phoneInputRef.current.disabled) {
                phoneInputRef.current.focus();
                phoneInputRef.current.select();
            } else {
                productSearchInputRef.current?.focus();
                productSearchInputRef.current?.select();
            }
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
        const isValidBatch = (batchNo?: string) => {
            const normalized = (batchNo || '').trim().toUpperCase();
            return normalized !== '' && !['NEW-STOCK', 'NEW-BATCH', 'N/A', 'NA'].includes(normalized);
        };

        const candidateBatches = productWrapper.batches.filter(b => isValidBatch(b.batch));

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
            if (!isValidBatch(inv.batch)) return false;

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
        if (checkIsExpired(batch.expiry ? String(batch.expiry) : '')) {
            addNotification(`Item ${batch.name} (Batch: ${batch.batch}) is expired and cannot be sold.`, 'error');
            return;
        }

        const policy = getInventoryPolicy(batch, medicines);
        if (shouldPreventNegativeStock && policy.inventorised && Number(batch.stock || 0) <= 0) {
            addNotification(`Insufficient stock for ${batch.name}. Available: ${Number(batch.stock || 0)}`, 'error');
            return;
        }

        let rateValue = batch.mrp;
        const globalDefaultRateTier = configurations?.displayOptions?.defaultRateTier || 'mrp';
        let rateTierToUse = selectedCustomer?.defaultRateTier !== 'none' ? selectedCustomer?.defaultRateTier : globalDefaultRateTier;

        if (rateTierToUse === 'rateA' && batch.rateA) rateValue = batch.rateA;
        else if (rateTierToUse === 'rateB' && batch.rateB) rateValue = batch.rateB;
        else if (rateTierToUse === 'rateC' && batch.rateC) rateValue = batch.rateC;
        else if (rateTierToUse === 'ptr' && batch.ptr) rateValue = batch.ptr;

        const newItemId = crypto.randomUUID();
        const newItem: BillItem = {
            id: newItemId,
            inventoryItemId: batch.id,
            name: batch.name,
            brand: batch.brand,
            mrp: batch.mrp,
            quantity: 1,
            looseQuantity: 0,
            freeQuantity: 0,
            unit: 'pack',
            gstPercent: batch.gstPercent,
            discountPercent: resolveProductDiscountPercent(batch) || applicableLineDiscountPercent || selectedCustomer?.defaultDiscount || 0,
            itemFlatDiscount: 0,
            batch: policy.inventorised && ['NEW-STOCK', 'NEW-BATCH'].includes((batch.batch || '').trim().toUpperCase()) ? '' : (policy.inventorised ? (batch.batch || '') : ''),
            expiry: policy.inventorised ? (batch.expiry ? String(batch.expiry) : 'N/A') : '',
            rate: rateValue,
            unitsPerPack: batch.unitsPerPack || 1,
            packType: batch.packType
        };

        setCartItems(prev => {
            const index = prev.findIndex(p => p.id === activeRowIdRef.current);
            if (activeRowIdRef.current && index > -1) {
                const next = [...prev];
                next[index] = newItem;
                return next;
            }
            return [...prev, newItem];
        });
        setSelectedRowId(newItemId);

        setSearchTerm('');
        setIsSearchModalOpen(false);
        setPendingBatchSelection(null);
        activeRowIdRef.current = null;

        setTimeout(() => {
            const qtyInput = document.getElementById(`qty-p-${newItemId}`);
            if (qtyInput) {
                (qtyInput as HTMLInputElement).focus();
                (qtyInput as HTMLInputElement).select();
            }
        }, 50);
    };

    const handleUpdateCartItem = (id: string, field: keyof BillItem, value: any) => {
        setCartItems(prev => prev.map(item => {
            if (item.id === id) {
                const updated = { ...item, [field]: value } as BillItem;
                if (['quantity', 'looseQuantity', 'freeQuantity', 'discountPercent', 'rate', 'itemFlatDiscount', 'mrp', 'gstPercent'].includes(field as string)) {
                    (updated as any)[field] = value === '' ? 0 : (parseFloat(value) || 0);
                }

                if (field === 'looseQuantity') {
                    const enteredLooseQty = Math.max(0, Math.floor(Number(updated.looseQuantity) || 0));
                    const currentPacks = Math.max(0, Math.floor(Number(updated.quantity) || 0));
                    const unitsPerPack = resolveUnitsPerStrip(item.unitsPerPack, item.packType);
                    const isPackBasedItem = unitsPerPack > 1 && !isLiquidOrWeightPack(item.packType);

                    if (isPackBasedItem) {
                        const totalUnits = (currentPacks * unitsPerPack) + enteredLooseQty;
                        updated.quantity = Math.floor(totalUnits / unitsPerPack);
                        updated.looseQuantity = totalUnits % unitsPerPack;
                    } else {
                        updated.looseQuantity = enteredLooseQty;
                    }
                }

                if (['quantity', 'looseQuantity', 'rate', 'discountPercent', 'schemeQty', 'schemeTotalQty', 'schemeValue', 'schemeMode'].includes(field as string)) {
                    return recalculateSchemeFields(updated);
                }

                return updated;
            }
            return item;
        }));
    };

    const handleApplyScheme = useCallback((itemId: string, schemeQty: number, mode: any, value: number, discountAmount: number, discountPercent: number, freeQuantity: number, schemeCalculationBasis: 'before_discount' | 'after_discount', schemeTotalQty?: number) => {
        setCartItems(prev => prev.map(item => {
            if (item.id === itemId) {
                return {
                    ...item,
                    schemeQty,
                    schemeMode: mode,
                    schemeValue: value,
                    schemeDiscountAmount: discountAmount,
                    schemeDiscountPercent: discountPercent,
                    freeQuantity,
                    schemeCalculationBasis,
                    schemeTotalQty
                };
            }
            return item;
        }));
        setSchemeItem(null);
        setTimeout(() => productSearchInputRef.current?.focus(), 100);
    }, []);

    const handleClearScheme = useCallback((itemId: string) => {
        setCartItems(prev => prev.map(item => {
            if (item.id === itemId) {
                const { schemeQty, schemeMode, schemeValue, schemeDiscountAmount, schemeDiscountPercent, schemeTotalQty, schemeCalculationBasis, ...rest } = item;
                return { ...rest, freeQuantity: 0 };
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

    const handleDeleteRow = useCallback((id: string, index: number) => {
        if (isReadOnly) return;

        setCartItems(prev => {
            const newItems = prev.filter(item => item.id !== id);
            if (newItems.length === 0) {
                setSelectedRowId(null);
                // If no items left, focus the search input
                setTimeout(() => productSearchInputRef.current?.focus(), 10);
                return [];
            }
            
            const nextFocusIdx = index < newItems.length ? index : newItems.length - 1;
            const itemToFocus = newItems[nextFocusIdx];
            if (itemToFocus) {
                setSelectedRowId(itemToFocus.id);
                setTimeout(() => {
                    const qtyInput = document.getElementById(`qty-p-${itemToFocus.id}`);
                    qtyInput?.focus();
                    if (qtyInput instanceof HTMLInputElement) qtyInput.select();
                }, 10);
            }
            return newItems;
        });
    }, [isReadOnly]);

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

            setSelectedRowId(nextId);
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
                        setSelectedRowId(nextId);
                        const nextNameEl = document.getElementById(`name-${nextId}`);
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
                        setSelectedRowId(prevId);
                        const prevLastField = `scheme-${prevId}`;
                        const prevLastEl = document.getElementById(prevLastField);
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

    const handleReferredByKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (cartItems.length > 0) {
                const firstId = cartItems[0].id;
                document.getElementById(`name-${firstId}`)?.focus();
            } else {
                productSearchInputRef.current?.focus();
            }
        }
    };

    return (
        <div className="flex flex-row h-full bg-app-bg overflow-hidden">
            <div className="flex-1 flex flex-col h-full overflow-hidden border-r border-gray-300" onKeyDown={handleEnterToNextField}>
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest">
                        {isNonGst ? 'Estimate Billing (Non-GST)' : 'Accounting Voucher Creation (Sales)'}
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
                </div>
                <span className="text-[10px] font-black uppercase text-accent">No. {currentInvoiceNo}</span>
            </div>

            <div className="p-2 flex-1 flex flex-col gap-2 overflow-hidden">
                <Card className="p-1.5 bg-white dark:bg-card-bg border border-app-border rounded-none grid grid-cols-1 md:grid-cols-5 gap-2 items-end flex-shrink-0">
                    {isFieldVisible('colDate') && (
                        <div>
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
                        <div className="md:col-span-2 relative">
                            <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Particulars (Customer Name)</label>
                            <input
                                ref={customerSearchInputRef}
                                type="text"
                                className="w-full h-8 border border-gray-400 p-1 text-xs font-bold uppercase focus:bg-yellow-50 outline-none"
                                value={customerSearch}
                                onChange={e => {
                                    setCustomerSearch(e.target.value);
                                    setSelectedCustomer(null);
                                    setCustomerAddress('');
                                }}
                                onKeyDown={handleCustomerKeyDown}
                                autoComplete="off"
                                placeholder="Enter for selection, Esc to skip..."
                                disabled={isReadOnly}
                            />
                        </div>
                    )}
                    {isFieldVisible('colAddress') && (
                        <div>
                            <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Address</label>
                            <input
                                type="text"
                                value={customerAddress}
                                onChange={e => setCustomerAddress(e.target.value)}
                                className="w-full h-8 border border-gray-400 p-1 text-xs font-bold uppercase focus:bg-yellow-50 outline-none"
                                placeholder="Customer Address"
                                disabled={isReadOnly}
                            />
                        </div>
                    )}
                    {isFieldVisible('colPhone') && (
                        <div>
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
                        <div>
                            <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Referred By</label>
                            <input
                                type="text"
                                value={referredBy}
                                onChange={e => setReferredBy(e.target.value)}
                                onKeyDown={handleReferredByKeyDown}
                                className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none uppercase focus:bg-yellow-50"
                                placeholder="Doctor Name"
                                disabled={isReadOnly}
                            />
                        </div>
                    )}
                </Card>

                <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white dark:bg-zinc-800">
                    <div className="flex-1 overflow-auto">
                        <table className="min-w-full border-collapse text-sm">
                            <thead className="sticky top-0 bg-gray-100 dark:bg-zinc-900 border-b border-gray-400 z-10">
                                <tr className="text-[10px] font-black uppercase text-gray-600 h-9">
                                    <th className="p-2 border-r border-gray-400 text-left w-10">Sl.</th>
                                    {isFieldVisible('colName') && <th className="p-2 border-r border-gray-400 text-left w-72">Name of Item</th>}
                                    {isFieldVisible('colBatch') && <th className="p-2 border-r border-gray-400 text-center w-24">Batch</th>}
                                    {isFieldVisible('colPack') && <th className="p-2 border-r border-gray-400 text-center w-16">Pack</th>}
                                    {isFieldVisible('colPQty') && <th className="p-2 border-r border-gray-400 text-center w-16">P.Qty</th>}
                                    {isFieldVisible('colLQty') && <th className="p-2 border-r border-gray-400 text-center w-16">L.Qty</th>}
                                    {isFieldVisible('colFree') && <th className="p-2 border-r border-gray-400 text-center w-16">Free</th>}
                                    <th className="p-2 border-r border-gray-400 text-right w-24">Rate</th>
                                    {isFieldVisible('colDisc') && <th className="p-2 border-r border-gray-400 text-center w-16">Disc%</th>}
                                    {isFieldVisible('colGst') && <th className="p-2 border-r border-gray-400 text-center w-16">GST%</th>}
                                    <th className="p-2 border-r border-gray-400 text-center w-20">Sch%</th>
                                    {isFieldVisible('colAmount') && <th className="p-2 text-right w-32">Amount</th>}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {cartItems.map((item, idx) => {
                                    const lineAmount = calculateBillingTotals({
                                        items: [item],
                                        billDiscount: 0,
                                        isNonGst,
                                        configurations,
                                    }).baseTotal;

                                    return (
                                        <tr
                                            id={`row-${item.id}`}
                                            key={item.id}
                                            onMouseEnter={() => setHoveredRowId(item.id)}
                                            onMouseLeave={() => setHoveredRowId(null)}
                                            onClick={(e) => {
                                                if (selectedRowId !== item.id) {
                                                    setSelectedRowId(item.id);
                                                }
                                                // Removed focusFirstEditableFieldInRow to allow direct cell click
                                            }}
                                            onFocusCapture={() => {
                                                if (selectedRowId !== item.id) {
                                                    setSelectedRowId(item.id);
                                                }
                                            }}
                                            className={`group h-10 cursor-pointer transition-colors ${selectedRowId === item.id ? 'bg-sky-100/90 outline outline-1 outline-sky-300' : 'hover:bg-gray-50'}`}
                                        >
                                            <td 
                                                className={`p-2 border-r border-gray-200 text-center cursor-pointer hover:bg-red-600 hover:text-white transition-colors group/del ${selectedRowId === item.id ? 'text-white' : 'text-gray-400 group-hover:text-white'} ${uniformTextStyle}`}
                                                onClick={(e) => { e.stopPropagation(); handleDeleteRow(item.id, idx); }}
                                                title="Click to delete this line item"
                                            >
                                                <span className="group-hover/del:hidden">{idx + 1}</span>
                                                <span className="hidden group-hover/del:inline">✕</span>
                                            </td>
                                            {isFieldVisible('colName') && (
                                                <td className={`p-2 border-r border-gray-200 text-primary uppercase w-72 truncate ${uniformTextStyle}`} title={item.name}>
                                                    <input
                                                        id={`name-${item.id}`}
                                                        type="text"
                                                        value={item.name}
                                                        onChange={e => handleUpdateCartItem(item.id, 'name', e.target.value)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className={`w-full bg-transparent border-none outline-none ${uniformTextStyle}`}
                                                        disabled={isReadOnly}
                                                    />
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
                                                        className="w-full text-center hover:bg-sky-200 hover:text-primary transition-colors outline-none focus:bg-sky-200 focus:text-primary rounded px-1"
                                                        disabled={isReadOnly}
                                                    >
                                                        {item.batch || 'N/A'}
                                                    </button>
                                                </td>
                                            )}
                                            {isFieldVisible('colPack') && <td className={`p-2 border-r border-gray-200 text-center font-mono ${uniformTextStyle}`}>{item.packType?.trim() || item.unitsPerPack || 1}</td>}
                                            {isFieldVisible('colPQty') && (
                                                <td className={`p-2 border-r border-gray-200 text-center ${uniformTextStyle}`}>
                                                    <input
                                                        id={`qty-p-${item.id}`}
                                                        type="number"
                                                        value={item.quantity === 0 ? '' : item.quantity}
                                                        onChange={e => handleUpdateCartItem(item.id, 'quantity', e.target.value)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className="w-full text-center bg-transparent font-normal no-spinner outline-none"
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
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className="w-full text-center bg-transparent font-normal no-spinner outline-none text-gray-500"
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
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className="w-12 text-center bg-transparent font-normal no-spinner outline-none text-emerald-700"
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colRate') && (
                                                <td className={`p-2 border-r border-gray-200 text-right font-normal ${uniformTextStyle}`}>
                                                    <div className="flex items-center justify-end">
                                                        <span className="mr-0.5 text-[10px] opacity-40">₹</span>
                                                        <input
                                                            id={`rate-${item.id}`}
                                                            type="number"
                                                            value={item.rate === 0 ? '' : item.rate}
                                                            onChange={e => handleUpdateCartItem(item.id, 'rate', e.target.value)}
                                                            onKeyDown={e => {
                                                                handleItemKeyDown(e, item.id, idx);
                                                                handleRowKeyNavigation(e, item.id);
                                                            }}
                                                            className="w-16 text-right bg-transparent font-black no-spinner outline-none border-b border-dashed border-gray-300 focus:border-primary"
                                                            disabled={isReadOnly}
                                                        />
                                                    </div>
                                                </td>
                                            )}
                                            {isFieldVisible('colDisc') && (
                                                <td className={`p-2 border-r border-gray-200 text-center text-red-700 ${uniformTextStyle}`}>
                                                    <input
                                                        id={`disc-${item.id}`}
                                                        type="number"
                                                        value={item.discountPercent === 0 ? '' : item.discountPercent}
                                                        onChange={e => handleUpdateCartItem(item.id, 'discountPercent', e.target.value)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className="w-12 text-center bg-transparent font-normal no-spinner outline-none"
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colGst') && (
                                                <td className={`p-2 border-r border-gray-200 text-center text-gray-600 ${uniformTextStyle}`}>
                                                    <input
                                                        id={`gst-${item.id}`}
                                                        type="number"
                                                        value={item.gstPercent === 0 ? '' : item.gstPercent}
                                                        onChange={e => handleUpdateCartItem(item.id, 'gstPercent', e.target.value)}
                                                        onKeyDown={e => {
                                                            handleItemKeyDown(e, item.id, idx);
                                                            handleRowKeyNavigation(e, item.id);
                                                        }}
                                                        className="w-12 text-center bg-transparent font-normal no-spinner outline-none"
                                                        disabled={isReadOnly}
                                                    />
                                                </td>
                                            )}
                                            {isFieldVisible('colSch') && (
                                                <td className={`p-2 border-r border-gray-400 text-center ${uniformTextStyle}`}>
                                                    <button
                                                        id={`scheme-${item.id}`}
                                                        onClick={() => !isReadOnly && setSchemeItem(item)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                setSchemeItem(item);
                                                            } else {
                                                                handleItemKeyDown(e, item.id, idx);
                                                                handleRowKeyNavigation(e, item.id);
                                                            }
                                                        }}
                                                        className={`px-2 py-0.5 text-[10px] font-normal uppercase rounded border border-dashed transition-all ${item.schemeMode ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-gray-50 text-gray-400 border-gray-300 hover:text-primary hover:border-primary'}`}
                                                        disabled={isReadOnly}
                                                    >
                                                        {item.schemeDiscountPercent ? `${item.schemeDiscountPercent.toFixed(1)}%` : 'Apply'}
                                                    </button>
                                                </td>
                                            )}
                                            {isFieldVisible('colAmount') && <td className={`p-2 text-right text-gray-900 ${uniformTextStyle}`}>₹{(lineAmount || 0).toFixed(2)}</td>}
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

                <div className="grid grid-cols-12 gap-2 flex-shrink-0 min-h-[210px] xl:min-h-[260px]">
                    <div className="col-span-5 bg-[#e5f0f0] px-3 py-2 tally-border !rounded-none shadow-sm flex flex-col justify-center">
                        <div className="text-[11px] xl:text-[14px] font-bold uppercase space-y-1 xl:space-y-2">
                            <h3 className="text-[9px] xl:text-[11px] font-black text-gray-500 mb-1 border-b border-gray-200 pb-1">Inventory Insight</h3>
                            <div>Item : <span className="text-primary">{activeIntelItem?.name || '-'}</span></div>
                            <div>Batch : <span className="text-primary">{activeIntelItem?.batch || '-'}</span></div>
                            <div>Expiry : <span className="text-primary">{activeIntelItem?.expiry || '-'}</span></div>
                            <div>Stock : <span className="text-primary">{activeIntelItem?.stock ?? 0}</span></div>
                            <div>MRP : <span className="text-primary">₹{(activeIntelItem?.mrp || 0).toFixed(2)}</span></div>
                        </div>
                    </div>

                    <div className="col-span-4 bg-[#e5f0f0] px-3 py-2 tally-border !rounded-none shadow-sm">
                        <h4 className="text-[8px] xl:text-[11px] font-black text-gray-500 uppercase tracking-[0.2em] mb-1 xl:mb-2 border-b border-gray-200 pb-1">{activeLineTotals ? 'Item Summary' : 'Bill Summary'}</h4>
                        <div className="grid grid-cols-1 xl:grid-cols-2 xl:gap-x-6 gap-y-0.5 text-[9px] xl:text-[13px] font-bold uppercase tracking-tight">
                            <div className="space-y-0.5 xl:space-y-1">
                                {activeLineTotals && (
                                    <>
                                        <div className="flex items-center justify-between text-blue-800"><span>Unit Rate</span> <span className="font-mono">₹{(cartItems.find(i => i.id === (hoveredRowId || selectedRowId))?.rate || 0).toFixed(2)}</span></div>
                                        <div className="flex items-center justify-between text-emerald-700"><span>Scheme Rule</span> <span className="font-mono">{activeSummary?.rule === 'before_discount' ? 'At Same Level / Before Discount' : 'After Disc%'}</span></div>
                                    </>
                                )}
                                {activeLineTotals ? (
                                    <>
                                        <div className="flex justify-between text-gray-600"><span>Value</span> <span className="font-mono">₹{(activeSummary?.value || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between text-gray-600"><span>Discount</span> <span className="font-mono">₹{(activeSummary?.discount || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between text-gray-600"><span>Amount After Discount</span> <span className="font-mono">₹{(activeSummary?.amountAfterDiscount || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between text-emerald-700"><span>Scheme Discount</span> <span className="font-mono">₹{(activeSummary?.schemeAmount || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between text-gray-700"><span>Taxable Value After Scheme</span> <span className="font-mono">₹{(activeSummary?.taxableValueAfterScheme || 0).toFixed(2)}</span></div>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex justify-between text-gray-600"><span>MRP Value</span> <span className="font-mono">₹{(totals?.gross || 0).toFixed(2)}</span></div>
                                        <div className="flex justify-between text-gray-600"><span>Value of Goods</span> <span className="font-mono">₹{(totals?.taxableValue || 0).toFixed(2)}</span></div>
                                    </>
                                )}
                            </div>
                            <div className="space-y-0.5 xl:space-y-1">
                                {!isNonGst && (
                                    <>
                                        <div className="flex justify-between text-blue-700"><span>SGST</span> <span className="font-mono">₹{((activeLineTotals?.tax ?? (totals?.tax || 0)) / 2).toFixed(2)}</span></div>
                                        <div className="flex justify-between text-blue-700"><span>CGST</span> <span className="font-mono">₹{((activeLineTotals?.tax ?? (totals?.tax || 0)) / 2).toFixed(2)}</span></div>
                                        {activeLineTotals && <div className="flex justify-between text-blue-700"><span>GST</span> <span className="font-mono">₹{(activeSummary?.lineTax || 0).toFixed(2)}</span></div>}
                                    </>
                                )}
                                <div className="flex justify-between text-red-600">
                                    <span>Discount</span> 
                                    <span className="font-mono">
                                        ₹{activeLineTotals 
                                            ? ((activeLineTotals.tradeDiscount || 0) + (activeLineTotals.schemeTotal || 0)).toFixed(2)
                                            : ((totals?.tradeDiscount || 0) + (totals?.schemeTotal || 0) + (lumpsumDiscount || 0)).toFixed(2)
                                        }
                                    </span>
                                </div>
                            </div>
                            {!activeLineTotals && (
                                <div className="flex items-center justify-between text-indigo-700 gap-1 py-0.5 xl:col-span-2 border-t border-gray-300 mt-1">
                                    <span className="xl:text-[14px]">Bill Discount</span>
                                    <input
                                        type="number"
                                        value={lumpsumDiscount === 0 ? '' : lumpsumDiscount}
                                        onChange={e => setLumpsumDiscount(parseFloat(e.target.value) || 0)}
                                        className="w-16 text-right bg-white border border-gray-300 font-normal text-[9px] xl:text-[12px] no-spinner outline-none px-1 h-4 xl:h-6"
                                        disabled={isReadOnly}
                                    />
                                </div>
                            )}
                            <div className="flex justify-between text-gray-600 xl:col-span-1">
                                <span>GST%</span>
                                <span className="font-mono">
                                    {(() => {
                                        const sub = activeLineTotals?.taxableValue ?? totals.taxableValue;
                                        const tx = activeLineTotals?.tax ?? (totals?.tax || 0);
                                        return sub > 0 ? ((tx / sub) * 100).toFixed(2) : '0.00';
                                    })()}%
                                </span>
                            </div>
                            {activeLineTotals ? null : <div className="flex justify-between text-gray-600 xl:col-span-1"><span>Round Off</span> <span className="font-mono">₹{(totals?.autoRoundOff || 0).toFixed(2)}</span></div>}
                            <div className="xl:col-span-2 border-t border-gray-400 pt-0.5 mt-0.5 flex justify-between text-[11px] xl:text-[15px] font-black text-primary leading-none">
                                <span>{activeLineTotals ? 'Line Total' : 'Grand Total'}</span>
                                <span className="font-mono">₹{(activeLineTotals ? (activeSummary?.lineTotal || 0) : Math.round(totals.baseTotal || 0)).toFixed(2)}</span>
                            </div>
                        </div>
                    </div>

                    <div className="col-span-3 bg-white p-2 tally-border !rounded-none shadow-sm">
                        <div className="text-[10px] font-black uppercase text-gray-500 mb-1">Customer Info</div>
                        <div className="text-[11px] font-bold uppercase space-y-1">
                            <div>Area: {selectedCustomer?.area || '-'}</div>
                            <div>Route: {selectedCustomer?.assignedStaffName || '-'}</div>
                            <div>Last Sale: -</div>
                            <div>Last Receipt: -</div>
                            <div>Avg Pay Days: -</div>
                        </div>
                    </div>

                    <div className="col-span-12 bg-[#255d55] px-2 py-1.5 text-white flex items-center gap-1 overflow-x-auto">
                        {["SALE", "PURC", "SC", "PC", "COPY BILL", "PASTE", "SR", "PR", "CASH", "HOLD", "SAVE", "PRINT", "RETURN"].map(btn => (
                            <button
                                key={btn}
                                onClick={() => {
                                    if (btn === 'SAVE') handleSave();
                                    if (btn === 'PRINT' && transactionToEdit) onPrintBill(transactionToEdit);
                                }}
                                className="px-3 py-0.5 border border-white/40 text-[10px] font-black uppercase whitespace-nowrap"
                            >
                                {btn}
                            </button>
                        ))}
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
                                <div className="text-2xl font-black">₹{Math.round(totals.baseTotal).toFixed(2)}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <JournalEntryViewerModal
                isOpen={isJournalModalOpen}
                onClose={() => setIsJournalModalOpen(false)}
                invoiceId={transactionToEdit?.id}
                invoiceNumber={transactionToEdit?.id || currentInvoiceNo}
                documentType="SALES"
                currentUser={currentUser}
                isPosted={isPostedVoucher}
            />

            <Modal
                isOpen={isSearchModalOpen}
                onClose={() => setIsSearchModalOpen(false)}
                title="Product selection Matrix"
            >
                <div className="flex flex-col h-full bg-[#fffde7] dark:bg-zinc-950 font-normal outline-none" onKeyDown={handleSearchKeyDown}>
                    <div className="py-1.5 px-4 bg-primary text-white flex-shrink-0 flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                            <span className="text-xs font-black uppercase tracking-[0.2em]">Material Discovery Engine</span>
                        </div>
                        <span className="text-[10px] font-bold uppercase opacity-70">↑/↓ Navigate | Enter Select</span>
                    </div>

                    <div className="flex flex-1 overflow-hidden">
                        <div className="flex-1 flex flex-col overflow-hidden">
                            <div className="p-2 bg-white dark:bg-zinc-900 border-b-2 border-primary/10">
                                <input
                                    ref={modalSearchInputRef}
                                    type="text"
                                    value={modalSearchTerm}
                                    onChange={e => setModalSearchTerm(e.target.value)}
                                    placeholder="Type medicine name or code..."
                                    className={`w-full p-2 border-2 border-primary/20 bg-white text-base font-black focus:border-primary outline-none shadow-inner uppercase tracking-tighter`}
                                />
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
                                                const itemPolicy = getInventoryPolicy(item, medicines);
                                                const isServiceLike = !itemPolicy.inventorised;
                                                const totalStock = res.batches.reduce((sum, batch) => sum + (batch.stock || 0), 0);
                                                const unitsPerPack = item.unitsPerPack || 1;
                                                const stripsStock = Math.floor(totalStock / unitsPerPack);
                                                const looseStock = totalStock % unitsPerPack;
                                                const isAnyBatchExpired = !isServiceLike && res.batches.some(b => checkIsExpired(b.expiry ? String(b.expiry) : ''));
                                                const areAllBatchesExpired = !isServiceLike && res.batches.length > 0 && res.batches.every(b => checkIsExpired(b.expiry ? String(b.expiry) : ''));

                                                return (
                                                    <tr
                                                        key={item.id}
                                                        data-index={sIdx}
                                                        onClick={() => triggerBatchSelection(res)}
                                                        onMouseEnter={() => setSelectedSearchIndex(sIdx)}
                                                        className={`cursor-pointer transition-all border-b border-gray-100 ${isSelected ? 'bg-primary text-white scale-[1.01] z-10 shadow-xl' : 'hover:bg-yellow-50'} ${areAllBatchesExpired ? 'opacity-50 grayscale' : ''}`}
                                                    >
                                                        <td className="p-1.5 px-3 border-r border-gray-200">
                                                            <div className="flex items-center gap-2">
                                                                <p className={`leading-none ${matrixRowTextStyle} ${isSelected ? 'text-white' : 'text-gray-950'}`}>{item.name}</p>
                                                                {areAllBatchesExpired && <span className="bg-red-600 text-white text-[8px] px-1 py-0.5 font-black uppercase">Expired</span>}
                                                                {!areAllBatchesExpired && isAnyBatchExpired && <span className="bg-amber-500 text-white text-[8px] px-1 py-0.5 font-black uppercase">Some Expired</span>}
                                                            </div>
                                                        </td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center font-mono ${matrixRowTextStyle} ${isSelected ? 'text-white' : 'text-primary'}`}>
                                                            {item.code}
                                                        </td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 ${matrixRowTextStyle} ${isSelected ? 'text-white/80' : 'text-gray-500'}`}>{item.manufacturer || item.brand}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (isServiceLike ? 'text-gray-400' : (totalStock <= 0 ? 'text-red-500' : 'text-emerald-700'))}`}>{isServiceLike ? '—' : stripsStock}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (isServiceLike ? 'text-gray-400' : (totalStock <= 0 ? 'text-red-500' : 'text-emerald-700'))}`}>{isServiceLike ? '—' : looseStock}</td>
                                                        <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${matrixRowTextStyle} ${isSelected ? 'text-white' : (isServiceLike ? 'text-gray-400' : (totalStock <= 0 ? 'text-red-500' : 'text-emerald-700'))}`}>{isServiceLike ? '—' : totalStock}</td>
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
                                            <div className="flex justify-between items-start mb-2">
                                                <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest opacity-60">Identity & Validity</p>
                                                {checkIsExpired(activeIntelItem.expiry ? String(activeIntelItem.expiry) : '') && (
                                                    <span className="bg-red-600 text-white text-[8px] px-1.5 py-0.5 font-black uppercase animate-pulse">EXPIRED</span>
                                                )}
                                            </div>
                                            <p className="text-lg font-black text-gray-900 dark:text-white font-mono leading-none truncate">{activeIntelItem.batch} | {activeIntelItem.code}</p>
                                            <p className="text-[10px] font-bold text-gray-500 uppercase mt-1">Batch: {activeIntelItem.batch}</p>
                                            <p className={`text-xs font-bold uppercase mt-2 ${checkIsExpired(activeIntelItem.expiry ? String(activeIntelItem.expiry) : '') ? 'text-red-600' : 'text-primary'}`}>Exp: {activeIntelItem.expiry ? String(activeIntelItem.expiry) : 'N/A'}</p>
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

            <CustomerSearchModal
                isOpen={isCustomerSearchModalOpen}
                onClose={() => {
                    setIsCustomerSearchModalOpen(false);
                    setTimeout(() => {
                        if (phoneInputRef.current && !phoneInputRef.current.disabled) {
                            phoneInputRef.current.focus();
                        } else {
                            productSearchInputRef.current?.focus();
                        }
                    }, 100);
                }}
                customers={customers}
                transactions={transactions}
                onSelect={handleSelectCustomer}
                initialSearch={customerSearch}
            />

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

            <BatchSelectionModal
                isOpen={!!pendingBatchSelection}
                onClose={() => { setPendingBatchSelection(null); setTimeout(() => productSearchInputRef.current?.focus(), 100); }}
                productName={pendingBatchSelection?.item.name || ''}
                batches={pendingBatchSelection?.batches || []}
                onSelect={addSelectedBatchToGrid}
            />

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

        <div className="w-80 h-full bg-white flex flex-col overflow-hidden shadow-xl shrink-0">
            <div className="bg-gray-800 text-white h-7 flex items-center px-4 shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Sales Insights & History</span>
            </div>
            
            <div className="p-3 border-b border-gray-200 bg-gray-50 grid grid-cols-2 gap-2">
                <div className="bg-white p-2 border border-gray-300 shadow-sm">
                    <div className="text-[9px] font-bold text-gray-500 uppercase">This Month</div>
                    <div className="text-sm font-black text-primary">₹{stats.monthTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                </div>
                <div className="bg-white p-2 border border-gray-300 shadow-sm">
                    <div className="text-[9px] font-bold text-gray-500 uppercase">Today</div>
                    <div className="text-sm font-black text-emerald-600">₹{stats.todayTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                </div>
                <div className="bg-white p-2 border border-gray-300 shadow-sm col-span-2">
                    <div className="text-[9px] font-bold text-gray-500 uppercase">Orders Count (MTD)</div>
                    <div className="text-sm font-black text-gray-800">{stats.monthCount}</div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 bg-gray-50/50">
                <div className="text-[10px] font-black text-gray-400 uppercase mb-2 ml-1">Last 20 Sales</div>
                <div className="space-y-1.5">
                    {salesHistory.map((sale) => (
                        <div key={sale.id} className="p-2 bg-white border border-gray-200 hover:border-primary/50 hover:bg-sky-50 transition-colors cursor-pointer text-[11px] shadow-sm">
                            <div className="flex justify-between items-start mb-1">
                                <span className="font-black text-gray-800 uppercase truncate pr-2" title={sale.customerName}>{sale.customerName}</span>
                                <span className="shrink-0 font-black text-primary">₹{sale.total.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between text-[10px] text-gray-500 font-bold uppercase">
                                <span>{formatVoucherNo(sale.invoiceNumber || sale.id)}</span>
                                <span>{sale.date}</span>
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                                <span className={`px-1.5 py-0.5 rounded-sm text-[8px] font-black ${sale.paymentMode === 'Credit' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                    {sale.paymentMode}
                                </span>
                                <span className="text-[9px] text-gray-400">{sale.createdAt ? new Date(sale.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                            </div>
                        </div>
                    ))}
                    {salesHistory.length === 0 && (
                        <div className="text-center py-10 text-gray-400 text-xs italic">No recent sales found</div>
                    )}
                </div>
            </div>
        </div>
    </div>
);
});

export default POS;
