import React, { useState, useEffect, useRef, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import Card from '@core/components/ui/Card';
import AddMedicineModal from '@modules/inventory/components/AddMedicineModal';
import { AddDistributorModal } from '@modules/suppliers/components/AddDistributorModal';
import { extractPurchaseDetailsFromBill } from '@core/services/geminiService';
import type { Purchase, InventoryItem, Distributor, PurchaseItem, ModuleConfig, RegisteredPharmacy, PurchaseOrder, PurchaseOrderItem, DistributorProductMap, Medicine, AppConfigurations, SupplierProductMap, Supplier, FileInput } from '@core/types';
import { handleEnterToNextField } from '@core/utils/navigation';
import WebcamCaptureModal from '@modules/inventory/components/WebcamCaptureModal';
import MobileSyncModal from '@modules/suppliers/components/MobileSyncModal';
import LinkToMasterModal from '@modules/inventory/components/LinkToMasterModal';
import { fuzzyMatch } from '@core/utils/search';
import { fetchSupplierProductMaps, generateUUID, saveData } from '@core/services/storageService';
import { parseNumber, normalizeImportDate, getOutstandingBalance, formatExpiryToMMYY } from '@core/utils/helpers';
import SupplierLedgerModal from '@modules/suppliers/components/SupplierLedgerModal';
import { generateNewInvoiceId } from '@core/utils/invoice';
import { parseNetworkAndApiError } from '@core/utils/error';
import { prepareCapturedImageForAiExtraction, prepareFilesForAiExtraction } from '@core/utils/aiImagePrep';
import JournalEntryViewerModal from '@modules/accounting/components/JournalEntryViewerModal';

const UploadIcon = (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>;
const CameraIcon = (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="4" /></svg>;
const SmartphoneIcon = (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" ry="18" x2="12.01" y2="18" /></svg>;

const Spinner = () => (
    <svg className="animate-spin h-4 w-4 text-current" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
);

const currencyFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

const formatCurrency = (value: number) => currencyFormatter.format(Number.isFinite(value) ? value : 0);

const formatSignedCurrency = (value: number, sign: '+' | '-' = '-') => {
    const normalizedValue = Number.isFinite(value) ? Math.abs(value) : 0;
    return `${sign}${formatCurrency(normalizedValue)}`;
};

const normalizeExpiryInput = (value: string) => {
    const digitsOnly = value.replace(/\D/g, '').slice(0, 4);
    if (digitsOnly.length <= 2) {
        if (digitsOnly.length === 2 && parseInt(digitsOnly) > 12) return digitsOnly[0];
        return digitsOnly;
    }
    const month = digitsOnly.slice(0, 2);
    if (parseInt(month) > 12) return month[0];
    return `${month}/${digitsOnly.slice(2)}`;
};

const isExpiryComplete = (value: string) => /^((0[1-9])|(1[0-2]))\/(\d{2})$/.test(value);

const getEffectiveQuantityForCalculation = (item: PurchaseItem, showPackQty: boolean, showLooseQty: boolean) => {
    if (showPackQty) return Number(item.quantity || 0);
    if (showLooseQty) return Number(item.looseQuantity || 0);
    return Number(item.quantity || 0);
};

const getLineTotal = (item: PurchaseItem, showPackQty: boolean, showLooseQty: boolean) => {
    const gross = (item.purchasePrice || 0) * getEffectiveQuantityForCalculation(item, showPackQty, showLooseQty);
    const tradeDisc = gross * ((item.discountPercent || 0) / 100);
    const afterTrade = gross - tradeDisc;
    const schemeDiscPercentAmount = afterTrade * ((item.schemeDiscountPercent || 0) / 100);
    const schemeDisc = item.schemeDiscountAmount > 0 ? item.schemeDiscountAmount : schemeDiscPercentAmount;
    const taxable = afterTrade - schemeDisc;
    const gst = taxable * ((item.gstPercent || 0) / 100);
    return taxable + gst;
};

// Fix: Added missing createBlankItem helper function to initialize empty purchase items
const createBlankItem = (): PurchaseItem => ({
    id: crypto.randomUUID(),
    name: '',
    brand: '',
    category: 'General',
    batch: '',
    expiry: '',
    quantity: 0,
    looseQuantity: 0,
    freeQuantity: 0,
    purchasePrice: 0,
    mrp: 0,
    gstPercent: 5,
    hsnCode: '',
    discountPercent: 0,
    schemeDiscountPercent: 0,
    schemeDiscountAmount: 0,
    matchStatus: 'pending',
    packType: '',
    unitsPerPack: 1
});

interface PurchaseFormProps {
    onAddPurchase: (purchase: any, supplierGst: string, nextCounter?: number) => Promise<void>;
    onUpdatePurchase: (purchase: Purchase, supplierGst?: string) => Promise<void>;
    inventory: InventoryItem[];
    distributors: Distributor[];
    medicines?: Medicine[];
    mappings: DistributorProductMap[];
    purchases: Purchase[];
    sourcePO?: PurchaseOrder | null;
    purchaseToEdit: Purchase | null;
    draftItems: PurchaseOrderItem[] | null;
    draftSupplier?: string;
    linkedChallans?: string[];
    onClearDraft: () => void;
    currentUser: RegisteredPharmacy | null;
    onAddInventoryItem?: (item: Omit<InventoryItem, 'id'>) => Promise<InventoryItem>;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    onAddDistributor: (data: Omit<Distributor, 'id' | 'ledger' | 'organization_id'>, balance: number, date: string) => Promise<Distributor>;
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
    organizationId: string;
}

const PurchaseForm = forwardRef<any, PurchaseFormProps>(({
    onAddPurchase, onUpdatePurchase, inventory, distributors, medicines = [], mappings = [], purchases, purchaseToEdit, draftItems, draftSupplier, onClearDraft, currentUser, onAddMedicineMaster, onAddDistributor, onSaveMapping, onCancel, title, className, configurations, addNotification, isReadOnly = false,
    isManualEntry = false, isChallan = false, disableAIInput = false, mobileSyncSessionId, setMobileSyncSessionId,
    organizationId,
}, ref) => {
    const isEditing = !!purchaseToEdit;
    const isFieldVisible = useCallback((fieldId: string) => {
        const purchaseFieldValue = configurations.modules?.['purchase']?.fields?.[fieldId];
        if (typeof purchaseFieldValue !== 'undefined') return purchaseFieldValue !== false;

        if (fieldId === 'colPQty' || fieldId === 'colLQty') {
            const legacyQty = configurations.modules?.['purchase']?.fields?.['colQty'];
            if (typeof legacyQty !== 'undefined') return legacyQty !== false;
        }

        return configurations.modules?.['automatedPurchaseEntry']?.fields?.[fieldId] !== false;
    }, [configurations.modules]);

    // Standard State
    const [supplier, setSupplier] = useState('');
    const [supplierGst, setSupplierGst] = useState('');
    const [invoiceNumber, setInvoiceNumber] = useState('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    // Fix: createBlankItem now defined
    const [items, setItems] = useState<PurchaseItem[]>([createBlankItem()]);
    const [activeRowId, setActiveRowId] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isUploading, setIsUploading] = useState(false);

    // Modal States
    const [isWebcamModalOpen, setIsWebcamModalOpen] = useState(false);
    const [isAddSupplierModalOpen, setIsAddSupplierModalOpen] = useState(false);
    const [isAddMedicineMasterModalOpen, setIsAddMedicineMasterModalOpen] = useState(false);
    const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
    const [isSupplierDropdownOpen, setIsSupplierDropdownOpen] = useState(false);
    const [selectedSupplierIndex, setSelectedSupplierIndex] = useState(0);
    const [isSupplierLedgerModalOpen, setIsSupplierLedgerModalOpen] = useState(false);
    const [supplierForLedger, setSupplierForLedger] = useState<Distributor | null>(null);
    const [supplierNameError, setSupplierNameError] = useState<string | null>(null);
    const [invoiceNumberError, setInvoiceNumberError] = useState<string | null>(null);
    const [isJournalModalOpen, setIsJournalModalOpen] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const supplierNameInputRef = useRef<HTMLInputElement>(null);
    const invoiceNumberInputRef = useRef<HTMLInputElement>(null);
    const dateInputRef = useRef<HTMLInputElement>(null);
    const lastSourceRef = useRef<string | null>(null);

    const currentDistributor = useMemo(() => {
        const lowerSupplier = (supplier || '').toLowerCase().trim();
        if (!lowerSupplier) return null;
        return distributors.find(d => (d.name || '').toLowerCase().trim() === lowerSupplier) ?? null;
    }, [distributors, supplier]);

    const canOpenJournalEntry = Boolean(purchaseToEdit?.id);
    const isPostedVoucher = (purchaseToEdit?.status || '') === 'completed';

    const attemptAutoLink = useCallback((itemList: PurchaseItem[], targetDistributor: Distributor | null) => {
        if (!medicines.length) return itemList;

        return itemList.map(item => {
            if (item.inventoryItemId) return item;

            if (targetDistributor) {
                const mapping = mappings.find(m =>
                    m.supplier_id === targetDistributor.id &&
                    m.supplier_product_name.toLowerCase().trim() === item.name.toLowerCase().trim()
                );
                if (mapping) {
                    const foundMed = medicines.find(m => m.id === mapping.master_medicine_id);
                    if (foundMed) {
                        return {
                            ...item,
                            inventoryItemId: foundMed.id,
                            matchStatus: 'matched' as const,
                            name: foundMed.name,
                            hsnCode: foundMed.hsnCode || item.hsnCode,
                            gstPercent: foundMed.gstRate || item.gstPercent,
                            brand: foundMed.brand || item.brand,
                            mrp: Number(foundMed.mrp || item.mrp)
                        };
                    }
                }
            }

            const directMatch = medicines.find(m => m.name.toLowerCase().trim() === item.name.toLowerCase().trim());
            if (directMatch) {
                return {
                    ...item,
                    inventoryItemId: directMatch.id,
                    matchStatus: 'matched' as const,
                    hsnCode: directMatch.hsnCode || item.hsnCode,
                    gstPercent: directMatch.gstRate || item.gstPercent,
                    brand: directMatch.brand || item.brand,
                    mrp: Number(directMatch.mrp || item.mrp)
                };
            }
            return item;
        });
    }, [medicines, mappings]);

    useEffect(() => {
        const sourceId = purchaseToEdit?.id || (draftItems ? 'draft' : 'new');
        if (lastSourceRef.current === sourceId && sourceId !== 'new') return;
        lastSourceRef.current = sourceId;

        if (purchaseToEdit) {
            setSupplier(purchaseToEdit.supplier || '');
            setInvoiceNumber(purchaseToEdit.invoiceNumber || '');
            setDate(purchaseToEdit.date ? purchaseToEdit.date.split('T')[0] : new Date().toISOString().split('T')[0]);

            const matchedDist = distributors.find(d => (d.name || '').toLowerCase().trim() === (purchaseToEdit.supplier || '').toLowerCase().trim());
            if (matchedDist) setSupplierGst(matchedDist.gst_number || '');
            else setSupplierGst('');

            const pItems = Array.isArray(purchaseToEdit.items) ? purchaseToEdit.items : [];
            const mappedItems = pItems.map(item => ({
                // Fix: createBlankItem now defined
                ...createBlankItem(),
                ...item,
                expiry: normalizeExpiryInput(formatExpiryToMMYY(item.expiry || '')),
                quantity: Number(item.quantity || 0),
                purchasePrice: Number(item.purchasePrice || 0),
                mrp: Number(item.mrp || 0),
                gstPercent: Number(item.gstPercent || 0),
                discountPercent: Number(item.discountPercent || 0),
                matchStatus: (item.inventoryItemId) ? 'matched' as const : 'pending' as const
            }));

            const linked = attemptAutoLink(mappedItems as PurchaseItem[], matchedDist || null);
            // Fix: createBlankItem now defined
            setItems(linked.length > 0 ? [...linked, createBlankItem()] : [createBlankItem()]);
        } else if (draftItems) {
            setSupplier(draftSupplier || '');
            const matchedDist = distributors.find(d => (d.name || '').toLowerCase().trim() === (draftSupplier || '').toLowerCase().trim());
            const newItems = Array.isArray(draftItems) ? draftItems.map(item => ({
                // Fix: createBlankItem now defined
                ...createBlankItem(), ...item,
                expiry: normalizeExpiryInput(formatExpiryToMMYY(item.expiry || '')),
                quantity: item.quantity,
                freeQuantity: item.freeQuantity || 0,
                purchasePrice: item.purchasePrice,
                matchStatus: 'pending' as const
            })) : [];
            const linked = attemptAutoLink(newItems as PurchaseItem[], matchedDist || null);
            // Fix: createBlankItem now defined
            setItems([...linked, createBlankItem()]);
        } else {
            // Fix: createBlankItem now defined
            setSupplier(''); setSupplierGst(''); setInvoiceNumber(''); setDate(new Date().toISOString().split('T')[0]); setItems([createBlankItem()]);
        }
    }, [purchaseToEdit, draftItems, distributors, draftSupplier, attemptAutoLink]);

    const showPackQty = isFieldVisible('colPQty');
    const showLooseQty = isFieldVisible('colLQty');

    const calculatedTotals = useMemo(() => {
        const billDiscount = 0;
        let subtotal = 0;
        let totalGst = 0;
        let grossAmount = 0;
        let totalItemDiscount = 0;
        let totalItemSchemeDiscount = 0;

        const validItems = items.filter(p => (p.name || '').trim() !== '');
        const itemsWithCalculations = validItems.map(p => {
            const effectiveQty = getEffectiveQuantityForCalculation(p, showPackQty, showLooseQty);
            const gross = (p.purchasePrice || 0) * effectiveQty;
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
    }, [items, showPackQty, showLooseQty]);

    const activeItemDetails = useMemo(() => {
        const activeItem = items.find(item => item.id === activeRowId) || items.find(item => (item.name || '').trim() !== '');
        return {
            item: activeItem?.name || '-',
            batch: activeItem?.batch || '-',
            expiry: activeItem?.expiry || '-',
            stock: 0,
            mrp: activeItem?.mrp || 0
        };
    }, [activeRowId, items]);

    const activeRowCalculations = useMemo(() => {
        const p = items.find(item => item.id === activeRowId) || items.find(item => (item.name || '').trim() !== '');
        if (!p || !(p.name || '').trim()) return null;

        const effectiveQty = getEffectiveQuantityForCalculation(p, showPackQty, showLooseQty);
        const gross = (p.purchasePrice || 0) * effectiveQty;
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
    }, [activeRowId, items, showPackQty, showLooseQty]);

    const vendorSnapshot = useMemo(() => {
        if (!currentDistributor) {
            return {
                area: '-',
                route: '-',
                collectionDays: '-',
                lastPurchase: '-',
                lastReceipt: '-',
                avgPayDays: '-'
            };
        }

        return {
            area: currentDistributor.area || '-',
            route: currentDistributor.city || '-',
            collectionDays: currentDistributor.payment_details?.payment_terms || '-',
            lastPurchase: '-',
            lastReceipt: '-',
            avgPayDays: '-'
        };
    }, [currentDistributor]);

    const handleSubmit = async () => {
        if (isSubmitting) return;
        if (!supplier.trim()) { setSupplierNameError("Supplier name is required."); return; }
        if (!invoiceNumber.trim()) { setInvoiceNumberError("Invoice number is required."); return; }
        
        // Check for duplicate supplier invoice
        const normalizedSupplier = supplier.toLowerCase().trim();
        const normalizedInvoice = invoiceNumber.toLowerCase().trim();
        const inactiveStatuses = new Set(['cancelled', 'void', 'deleted']);
        const isDuplicate = purchases.some(p => {
            if (purchaseToEdit?.id && p.id === purchaseToEdit.id) return false;
            if ((p.organization_id || '').trim() !== (organizationId || '').trim()) return false;
            if (inactiveStatuses.has(String((p as any).status || 'completed').trim().toLowerCase())) return false;
            return (p.supplier || '').toLowerCase().trim() === normalizedSupplier && 
                   (p.invoiceNumber || '').toLowerCase().trim() === normalizedInvoice;
        });

        if (isDuplicate) {
            const msg = "Supplier Invoice Number already exists for this supplier. Duplicate entry not allowed.";
            setInvoiceNumberError(msg);
            addNotification(msg, "error");
            return;
        }

        const activeItems = items.filter(p => (p.name || '').trim() !== '');
        if (activeItems.length === 0) { addNotification("At least one item is required.", "error"); return; }

        setIsSubmitting(true);
        try {
            let purchaseSerialId = purchaseToEdit?.purchaseSerialId;
            let nextExternalNumber;

            if (!purchaseToEdit) {
                const { id: generatedSerialId, nextExternalNumber: nextNum } = generateNewInvoiceId(configurations.purchaseConfig, 'purchase-bill');
                purchaseSerialId = generatedSerialId;
                nextExternalNumber = nextNum;
            }

            const payload = {
                purchaseSerialId: purchaseSerialId!,
                supplier,
                invoiceNumber: invoiceNumber.trim(),
                date,
                items: calculatedTotals.itemsWithCalculations,
                subtotal: calculatedTotals.subtotal,
                totalGst: calculatedTotals.totalGst,
                totalAmount: calculatedTotals.totalAmount,
                totalItemDiscount: calculatedTotals.totalItemDiscount,
                totalItemSchemeDiscount: calculatedTotals.totalItemSchemeDiscount,
                status: 'completed' as const,
                organization_id: organizationId,
                roundOff: calculatedTotals.roundOff,
                schemeDiscount: 0
            };

            if (purchaseToEdit) {
                await onUpdatePurchase({ ...purchaseToEdit, ...payload } as any, supplierGst);
            } else {
                await onAddPurchase(payload, supplierGst, nextExternalNumber);
            }
            onClearDraft(); if (onCancel) onCancel();
        } catch (e: any) {
            addNotification(`Error: ${parseNetworkAndApiError(e)}`, "error");
        } finally { setIsSubmitting(false); }
    };

    useImperativeHandle(ref, () => ({
        handleSubmit,
        items
    }));

    const handleDeleteRow = useCallback((id: string, index: number) => {
        if (isReadOnly) return;

        setItems(prev => {
            const newItems = prev.filter(item => item.id !== id);
            if (newItems.length === 0) return [createBlankItem()];

            const nextFocusIdx = index < newItems.length ? index : newItems.length - 1;
            const itemToFocus = newItems[nextFocusIdx];
            if (itemToFocus) {
                setTimeout(() => {
                    const qtyInput = document.getElementById(`qty-p-${itemToFocus.id}`) || document.getElementById(`qty-l-${itemToFocus.id}`);
                    qtyInput?.focus();
                    if (qtyInput instanceof HTMLInputElement) qtyInput.select();
                }, 10);
            }
            return newItems;
        });
    }, [isReadOnly]);

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
            if (field === 'name') { updatedItem.matchStatus = 'pending'; updatedItem.inventoryItemId = undefined; }
            if (['quantity', 'looseQuantity', 'freeQuantity', 'purchasePrice', 'mrp', 'discountPercent', 'schemeDiscountPercent', 'gstPercent'].includes(field)) { (updatedItem as any)[field] = value === '' ? 0 : (parseFloat(value) || 0); }
            if (field === 'expiry') {
                updatedItem.expiry = normalizeExpiryInput(String(value).toUpperCase());
            }
            const wasEmpty = !prev[index].name && !prev[index].inventoryItemId;
            const updated = prev.map(p => p.id === id ? updatedItem : p);
            // Fix: createBlankItem now defined
            if (field === 'name' && (value || '').trim() !== '' && index === prev.length - 1 && wasEmpty) return [...updated, createBlankItem()];
            return updated;
        });
    };

    const handleExpiryBlur = (id: string, value: string) => {
        if (!value) return;
        if (!isExpiryComplete(value)) {
            addNotification('Expiry must be in MM/YY format with month between 01 and 12.', 'error');
            handleUpdateItem(id, 'expiry', '');
        }
    };

    const processAiExtraction = useCallback(async (fileInputs: FileInput[]) => {
        if (!fileInputs || fileInputs.length === 0) return;

        setIsUploading(true);
        try {
            const bill = await extractPurchaseDetailsFromBill(fileInputs, currentUser?.pharmacy_name || '');
            if (bill.error) {
                addNotification(bill.error, 'error');
                return;
            }

            if (bill.supplier) setSupplier(bill.supplier);
            if (bill.invoiceNumber) setInvoiceNumber(bill.invoiceNumber);
            if (bill.date) setDate(normalizeImportDate(bill.date) || date);
            if (bill.items && bill.items.length > 0) {
                const newItems = bill.items.map(item => {
                    const packTypeStr = String(item.packType || (item as any).pack || '').trim();
                    return {
                        ...createBlankItem(),
                        ...item,
                        packType: packTypeStr,
                        unitsPerPack: parseNumber(item.unitsPerPack) || parseInt(packTypeStr.match(/\d+/)?.[0] || '10', 10),
                        expiry: normalizeExpiryInput(formatExpiryToMMYY(item.expiry || '')),
                        quantity: parseNumber(item.quantity),
                        purchasePrice: parseNumber(item.purchasePrice),
                        mrp: parseNumber(item.mrp),
                        gstPercent: parseNumber(item.gstPercent) || 5,
                        discountPercent: parseNumber(item.discountPercent),
                        matchStatus: 'pending' as const
                    };
                });
                const linked = attemptAutoLink(newItems as PurchaseItem[], currentDistributor);
                setItems([...linked, createBlankItem()]);
            }
            addNotification("AI Extracted bill details successfully.", "success");
        } catch (err: any) {
            addNotification(`AI Extraction failed: ${parseNetworkAndApiError(err)}`, "error");
        } finally {
            setIsUploading(false);
        }
    }, [addNotification, attemptAutoLink, currentDistributor, currentUser?.pharmacy_name, date]);

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

    const handleSupplierSelect = (d: Distributor) => {
        setSupplier(d.name);
        setSupplierGst(d.gst_number || '');
        setIsSupplierDropdownOpen(false);
        setSelectedSupplierIndex(0);
        setSupplierNameError(null);
        invoiceNumberInputRef.current?.focus();
    };

    const handleSupplierKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const filtered = distributors.filter(d => d.is_blocked !== true && fuzzyMatch(d.name, supplier)).slice(0, 10);
            setSelectedSupplierIndex(prev => (prev + 1) % Math.max(1, filtered.length));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const filtered = distributors.filter(d => d.is_blocked !== true && fuzzyMatch(d.name, supplier)).slice(0, 10);
            setSelectedSupplierIndex(prev => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
        } else if (e.key === 'Enter') {
            const filtered = distributors.filter(d => d.is_blocked !== true && fuzzyMatch(d.name, supplier)).slice(0, 10);
            if (filtered[selectedSupplierIndex]) {
                handleSupplierSelect(filtered[selectedSupplierIndex]);
            }
        } else if (e.key === 'Escape') {
            setIsSupplierDropdownOpen(false);
        }
    };

    return (
        <div className={`flex flex-col h-full bg-app-bg overflow-hidden relative ${className || ''}`} onKeyDown={handleEnterToNextField}>
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <div className="flex items-center gap-3">
                    <span className="text-[10px] font-black uppercase tracking-widest">{isChallan ? 'Delivery Challan Entry' : 'Purchase Voucher Creation'}</span>
                </div>
                <span className="text-[10px] font-black uppercase text-accent">No. {isEditing ? purchaseToEdit?.purchaseSerialId : 'New'}</span>
            </div>
            <div className="p-2 md:p-3 flex-1 flex flex-col gap-2 md:gap-3 overflow-hidden">
                <div className="p-2 bg-white dark:bg-card-bg border border-app-border rounded-none grid grid-cols-1 md:grid-cols-4 gap-2 md:gap-3 items-end flex-shrink-0">
                    <div className="md:col-span-2 relative">
                        <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Particulars (Supplier Name)</label>
                        <input
                            ref={supplierNameInputRef}
                            type="text"
                            value={supplier}
                            autoComplete="off"
                            onChange={e => { setSupplier(e.target.value); setIsSupplierDropdownOpen(true); }}
                            onKeyDown={handleSupplierKeyDown}
                            className={`w-full border p-2 text-sm font-bold uppercase outline-none ${supplierNameError ? 'border-red-500' : 'border-gray-400 focus:border-primary'}`}
                            placeholder="Type to search Ledger..."
                        />
                        {isSupplierDropdownOpen && supplier.length > 0 && (
                            <div className="absolute top-full left-0 w-full bg-white border border-primary shadow-2xl z-[200] overflow-hidden rounded-none">
                                {distributors.filter(d => d.is_blocked !== true && fuzzyMatch(d.name, supplier)).slice(0, 10).map((d, sIdx) => (
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
                    <div>
                        <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Invoice #</label>
                        <input
                            ref={invoiceNumberInputRef}
                            type="text"
                            value={invoiceNumber}
                            onChange={e => setInvoiceNumber(e.target.value)}
                            className={`w-full border p-2 text-sm font-bold outline-none ${invoiceNumberError ? 'border-red-500' : 'border-gray-400 focus:border-primary'}`}
                        />
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold text-gray-500 uppercase block mb-1">Date</label>
                        <input
                            ref={dateInputRef}
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className="w-full border border-gray-400 p-2 text-sm font-bold outline-none"
                        />
                    </div>
                </div>

                {!isEditing && !disableAIInput && !isManualEntry && (
                    <div className="flex flex-wrap gap-2 flex-shrink-0 px-1">
                        <button onClick={() => setIsWebcamModalOpen(true)} className="px-3 py-1.5 text-[10px] font-black uppercase bg-white text-primary border border-primary flex items-center gap-2 hover:bg-primary/5 transition-colors"><CameraIcon /> Webcam Scan</button>
                        <button onClick={() => setMobileSyncSessionId(generateUUID())} className="px-3 py-1.5 text-[10px] font-black uppercase bg-white text-primary border border-primary flex items-center gap-2 hover:bg-primary/5 transition-colors"><SmartphoneIcon /> Mobile Sync</button>
                        <button onClick={() => fileInputRef.current?.click()} className="px-3 py-1.5 text-[10px] font-black uppercase bg-white text-primary border border-primary flex items-center gap-2 hover:bg-primary/5 transition-colors"><UploadIcon /> {isUploading ? <Spinner /> : 'Import Document'}</button>
                        <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="image/*,application/pdf" multiple />
                    </div>
                )}

                <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white dark:bg-zinc-800">
                    <div className="flex-1 overflow-auto min-h-[200px]">
                        <table className="min-w-full border-collapse text-sm">
                            <thead className="sticky top-0 bg-gray-100 dark:bg-zinc-900 border-b border-gray-400 z-10">
                                <tr className="text-[10px] font-black uppercase text-gray-600 h-9">
                                    <th className="p-1 border-r border-gray-400 text-left w-8">Sl.</th>
                                    <th className="p-1 border-r border-gray-400 text-left min-w-[200px]">Name of Item</th>
                                    <th className="p-1 border-r border-gray-400 text-left w-20">MFR</th>
                                    <th className="p-1 border-r border-gray-400 text-center w-16">Pack</th>
                                    <th className="p-1 border-r border-gray-400 text-center w-20">Batch</th>
                                    <th className="p-1 border-r border-gray-400 text-center w-20">Expiry Date</th>
                                    <th className="p-1 border-r border-gray-400 text-right w-24">MRP</th>
                                    {showPackQty && <th className="p-1 border-r border-gray-400 text-center w-16">P.Qty</th>}
                                    {showLooseQty && <th className="p-1 border-r border-gray-400 text-center w-16">Loose qty</th>}
                                    <th className="p-1 border-r border-gray-400 text-center w-16">Free</th>
                                    <th className="p-1 border-r border-gray-400 text-right w-24">Rate</th>
                                    {isFieldVisible('colDisc') && <th className="p-1 border-r border-gray-400 text-center w-16">Disc%</th>}
                                    <th className="p-1 border-r border-gray-400 text-center w-16">Sch%</th>
                                    <th className="p-1 text-right w-32">Amount</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {items.map((p, idx) => (
                                    <tr 
                                        key={p.id} 
                                        style={activeRowId === p.id ? { backgroundColor: '#004242', color: 'white' } : {}}
                                        className={`group h-10 transition-colors ${activeRowId === p.id ? 'shadow-md' : 'hover:bg-primary hover:text-white'}`}
                                    >
                                        <td 
                                            className={`p-1 border-r border-gray-200 font-bold text-center cursor-pointer hover:bg-red-600 hover:text-white transition-colors group/del ${activeRowId === p.id ? 'text-white' : 'text-gray-400 group-hover:text-white'}`}
                                            onClick={(e) => { e.stopPropagation(); handleDeleteRow(p.id, idx); }}
                                            title="Click to delete this line item"
                                        >
                                            <span className="group-hover/del:hidden">{idx + 1}</span>
                                            <span className="hidden group-hover/del:inline">✕</span>
                                        </td>
                                        <td className={`p-1 border-r border-gray-200 font-bold uppercase relative ${activeRowId === p.id ? 'text-white' : 'group-hover:text-white text-primary'}`}>
                                            <input 
                                                type="text" 
                                                id={`name-${p.id}`} 
                                                value={p.name} 
                                                autoComplete="off" 
                                                onChange={e => handleUpdateItem(p.id, 'name', e.target.value)} 
                                                onFocus={() => setActiveRowId(p.id)} 
                                                className={`w-full bg-transparent outline-none ${activeRowId === p.id ? 'text-white placeholder:text-white/50' : 'group-hover:text-white text-primary placeholder:text-gray-400'} focus:bg-white/10`} 
                                            />
                                        </td>
                                        <td className="p-1 border-r border-gray-400"><input type="text" id={`mfr-${p.id}`} value={p.brand} onChange={e => handleUpdateItem(p.id, 'brand', e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full bg-transparent text-[10px] outline-none ${activeRowId === p.id ? 'text-white' : 'group-hover:text-white'}`} /></td>
                                        <td className="p-1 border-r border-gray-200 text-center"><input type="text" value={p.packType} onChange={e => handleUpdateItem(p.id, 'packType', e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full text-center bg-transparent text-[10px] outline-none ${activeRowId === p.id ? 'text-white' : 'group-hover:text-white'}`} /></td>
                                        <td className="p-1 border-r border-gray-200 text-center font-mono text-[10px] uppercase"><input type="text" id={`batch-${p.id}`} value={p.batch} onChange={e => handleUpdateItem(p.id, 'batch', e.target.value.toUpperCase())} onFocus={() => setActiveRowId(p.id)} className={`w-full text-center bg-transparent outline-none ${activeRowId === p.id ? 'text-white' : 'group-hover:text-white'}`} /></td>
                                        <td className="p-1 border-r border-gray-200 text-center text-[10px]"><input type="text" id={`expiry-${p.id}`} value={p.expiry} maxLength={5} inputMode="numeric" pattern="(0[1-9]|1[0-2])\/\d{2}" placeholder="MM/YY" title="Enter expiry as MM/YY" onChange={e => handleUpdateItem(p.id, 'expiry', e.target.value)} onBlur={e => handleExpiryBlur(p.id, e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full text-center bg-transparent outline-none ${activeRowId === p.id ? 'text-white placeholder:text-white/50' : 'group-hover:text-white'}`} /></td>
                                        <td className="p-1 border-r border-gray-400 text-right text-[11px] font-mono whitespace-nowrap"><input type="number" id={`mrp-${p.id}`} value={p.mrp || ''} onChange={e => handleUpdateItem(p.id, 'mrp', e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full text-right bg-transparent outline-none no-spinner ${activeRowId === p.id ? 'text-white' : 'group-hover:text-white'}`} /></td>
                                        {showPackQty && <td className="p-1 border-r border-gray-400 text-center font-black">
                                            <input 
                                                type="number" 
                                                id={`qty-p-${p.id}`} 
                                                value={p.quantity || ''} 
                                                onChange={e => handleUpdateItem(p.id, 'quantity', e.target.value)} 
                                                onFocus={() => setActiveRowId(p.id)} 
                                                onKeyDown={e => {
                                                    if (e.key === 'Delete') {
                                                        e.preventDefault();
                                                        const idx = items.findIndex(item => item.id === p.id);
                                                        handleDeleteRow(p.id, idx);
                                                    }
                                                }}
                                                className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${activeRowId === p.id ? 'text-white' : 'group-hover:text-white'}`} 
                                            />
                                        </td>}
                                        {showLooseQty && <td className="p-1 border-r border-gray-400 text-center font-black"><input type="number" id={`qty-l-${p.id}`} value={p.looseQuantity || ''} onChange={e => handleUpdateItem(p.id, 'looseQuantity', e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${activeRowId === p.id ? 'text-white' : 'group-hover:text-white'}`} /></td>}
                                        <td className="p-1 border-r border-gray-400 text-center font-bold"><input type="number" value={p.freeQuantity || ''} onChange={e => handleUpdateItem(p.id, 'freeQuantity', e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${activeRowId === p.id ? 'text-white' : 'text-emerald-600 group-hover:text-white'}`} /></td>
                                        <td className="p-1 border-r border-gray-400 text-right font-bold"><input type="number" id={`rate-${p.id}`} value={p.purchasePrice || ''} onChange={e => handleUpdateItem(p.id, 'purchasePrice', e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full text-right bg-transparent outline-none no-spinner font-mono ${activeRowId === p.id ? 'text-white' : 'text-blue-900 group-hover:text-white'}`} /></td>
                                        {isFieldVisible('colDisc') && <td className="p-1 border-r border-gray-400 text-center"><input type="number" value={p.discountPercent || ''} onChange={e => handleUpdateItem(p.id, 'discountPercent', e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${activeRowId === p.id ? 'text-white' : 'text-red-600 group-hover:text-white'}`} /></td>}
                                        <td className="p-1 border-r border-gray-400 text-center"><input type="number" value={p.schemeDiscountPercent || ''} onChange={e => handleUpdateItem(p.id, 'schemeDiscountPercent', e.target.value)} onFocus={() => setActiveRowId(p.id)} className={`w-full text-center bg-transparent no-spinner outline-none font-mono ${activeRowId === p.id ? 'text-white' : 'text-red-600 group-hover:text-white'}`} /></td>
                                        <td className={`p-1 text-right font-black font-mono whitespace-nowrap ${activeRowId === p.id ? 'text-white' : 'group-hover:text-white text-gray-950'}`}>{formatCurrency(getLineTotal(p, showPackQty, showLooseQty))}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Card>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-2 flex-shrink-0">
                    <div className="md:col-span-5 bg-[#e5f0f0] px-3 py-2 tally-border !rounded-none shadow-sm min-h-[100px] xl:min-h-[140px] flex flex-col justify-center">
                        <div className="text-[11px] xl:text-[14px] font-bold uppercase space-y-1 xl:space-y-2">
                            <div className="flex border-b border-gray-300 pb-0.5"><span className="w-16 xl:w-24 text-gray-500">Item :</span> <span className="text-primary truncate">{activeItemDetails.item}</span></div>
                            <div className="flex border-b border-gray-300 pb-0.5"><span className="w-16 xl:w-24 text-gray-500">Batch :</span> <span className="text-primary">{activeItemDetails.batch}</span></div>
                            <div className="flex border-b border-gray-300 pb-0.5"><span className="w-16 xl:w-24 text-gray-500">Expiry :</span> <span className="text-primary">{activeItemDetails.expiry}</span></div>
                            <div className="flex border-b border-gray-300 pb-0.5"><span className="w-16 xl:w-24 text-gray-500">Stock :</span> <span className="text-primary">{activeItemDetails.stock}</span></div>
                            <div className="flex"><span className="w-16 xl:w-24 text-gray-500">MRP :</span> <span className="text-primary">₹{activeItemDetails.mrp.toFixed(2)}</span></div>
                        </div>
                    </div>

                    <div className="md:col-span-4 bg-[#e5f0f0] px-3 py-2 tally-border !rounded-none shadow-sm min-h-[100px] xl:min-h-[140px]">
                        <div className="text-[10px] xl:text-[12px] font-black uppercase text-gray-500 mb-1 border-b border-gray-200 pb-1">Line Item Details</div>
                        <div className="grid grid-cols-1 xl:grid-cols-2 xl:gap-x-8 xl:gap-y-2 text-[11px] xl:text-[14px] font-bold uppercase">
                            <div className="space-y-1">
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>MRP Value</span><span>₹{calculatedTotals.grossAmount.toFixed(2)}</span></div>
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>Value of Goods</span><span>₹{calculatedTotals.subtotal.toFixed(2)}</span></div>
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>Discount</span><span className="text-red-600">- ₹{(calculatedTotals.totalItemDiscount + calculatedTotals.totalItemSchemeDiscount + calculatedTotals.billDiscount).toFixed(2)}</span></div>
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between border-b border-gray-300 pb-0.5"><span>SGST / CGST</span><span>₹{(calculatedTotals.totalGst / 2).toFixed(2)} x 2</span></div>
                                <div className="flex justify-between font-black text-blue-900 pt-1"><span>Total Payable</span><span>₹{calculatedTotals.grandTotal.toFixed(2)}</span></div>
                            </div>
                        </div>
                    </div>

                    <div className="md:col-span-3 bg-white p-2 tally-border !rounded-none shadow-sm min-h-[100px] xl:min-h-[140px]">
                        <div className="text-[10px] xl:text-[12px] font-black uppercase text-gray-500 mb-1 border-b border-gray-200 pb-1 flex justify-between"><span>Vendor Info</span> <span className="text-[8px] xl:text-[10px] text-primary bg-primary/10 px-1">ACTIVE</span></div>
                        <div className="text-[11px] xl:text-[14px] font-bold uppercase space-y-0.5 xl:space-y-1">
                            <div className="truncate">Area: <span className="text-gray-600">{vendorSnapshot.area}</span></div>
                            <div className="truncate">Route: <span className="text-gray-600">{vendorSnapshot.route}</span></div>
                            <div className="truncate">Terms: <span className="text-gray-600">{vendorSnapshot.collectionDays}</span></div>
                            <div className="text-[9px] xl:text-[11px] mt-1 text-gray-400">Avg Pay: {vendorSnapshot.avgPayDays}</div>
                        </div>
                    </div>
                </div>

                <div className="flex justify-end gap-3 pb-2">
                    <button onClick={onCancel} className="px-6 py-2 bg-white font-bold hover:bg-gray-100 text-gray-700 tally-border uppercase tracking-widest text-[10px] shadow-sm">Discard</button>
                    <button onClick={handleSubmit} disabled={isSubmitting} className="px-10 py-2 tally-button-primary shadow-lg uppercase text-[10px] font-black tracking-widest">
                        {isSubmitting ? <Spinner /> : (isEditing ? 'Update Entry' : 'Accept (Enter)')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setIsJournalModalOpen(true)}
                        disabled={!canOpenJournalEntry}
                        className="px-5 py-2 bg-white border border-primary text-primary hover:bg-primary/5 font-black uppercase tracking-widest text-[10px] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Show Accounting Entry
                    </button>
                </div>
            </div>

            {isWebcamModalOpen && <WebcamCaptureModal isOpen={isWebcamModalOpen} onClose={() => setIsWebcamModalOpen(false)} onCapture={handleWebcamCapture} />}
            {isAddSupplierModalOpen && <AddDistributorModal isOpen={isAddSupplierModalOpen} onClose={() => setIsAddSupplierModalOpen(false)} onAdd={onAddDistributor} organizationId={organizationId} />}
            {isAddMedicineMasterModalOpen && <AddMedicineModal isOpen={isAddMedicineMasterModalOpen} onClose={() => setIsAddMedicineMasterModalOpen(false)} onAddMedicine={onAddMedicineMaster} organizationId={organizationId} />}
            {isLinkModalOpen && currentDistributor && (
                <LinkToMasterModal
                    isOpen={isLinkModalOpen} onClose={() => setIsLinkModalOpen(false)} supplier={currentDistributor as any} medicines={medicines} mappings={mappings}
                    onLink={onSaveMapping} scannedItems={items} onFinalize={(reconciled) => { setItems(reconciled); setIsLinkModalOpen(false); }} onAddMedicineMaster={onAddMedicineMaster} organizationId={organizationId}
                />
            )}
            {isSupplierLedgerModalOpen && supplierForLedger && <SupplierLedgerModal isOpen={isSupplierLedgerModalOpen} onClose={() => setIsSupplierLedgerModalOpen(false)} supplier={supplierForLedger} />}
            <MobileSyncModal isOpen={!!mobileSyncSessionId} onClose={() => setMobileSyncSessionId(null)} sessionId={mobileSyncSessionId} orgId={organizationId} />
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
    );
});

export default PurchaseForm;
