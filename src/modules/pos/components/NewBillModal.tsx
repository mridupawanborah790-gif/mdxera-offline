import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Modal from '@core/components/ui/Modal';
import AddMedicineModal from '@modules/inventory/components/AddMedicineModal';
import BatchSelectionModal from '@modules/inventory/components/BatchSelectionModal';
import { InventoryItem, Customer, Transaction, BillItem, AppConfigurations, RegisteredPharmacy, Medicine } from '@core/types';
import { fuzzyMatch } from '@core/utils/search';
import * as storage from '@core/services/storageService';
import { calculateBillingTotals } from '@core/utils/billing';

interface NewBillModalProps {
    isOpen: boolean;
    onClose: () => void;
    inventory: InventoryItem[];
    customers: Customer[];
    onSaveOrUpdateTransaction: (transaction: Transaction, isUpdate: boolean, nextCounter?: number) => Promise<void>;
    onPrintBill?: (transaction: Transaction) => void;
    currentUser: RegisteredPharmacy | null;
    configurations: AppConfigurations;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    initialItem?: BillItem[] | null; // Changed to BillItem[]
    // New props for initial values
    initialReferredBy?: string;
    initialPaymentMode?: string;
    isReadOnly?: boolean;
    initialCustomer?: Customer | null;
    initialInvoiceId?: string;
    initialDate?: string;
    initialPricingMode?: 'mrp' | 'rate';
}

interface UploadedFile {
    id: string;
    data: string;
    type: 'image' | 'pdf';
    name: string;
}

export const NewBillModal: React.FC<NewBillModalProps> = ({ 
    isOpen, onClose, inventory, customers, onSaveOrUpdateTransaction, onPrintBill, currentUser, configurations, onAddMedicineMaster, 
    initialItem, initialReferredBy, initialPaymentMode, isReadOnly = false, initialCustomer, initialInvoiceId, initialDate, initialPricingMode 
}) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(initialCustomer || null);
    const [customerSearch, setCustomerSearch] = useState('');
    const [selectedCustomerIndex, setSelectedCustomerIndex] = useState(0);
    const [customerPhone, setCustomerPhone] = useState('');
    const [referredBy, setReferredBy] = useState(initialReferredBy || ''); 
    const [paymentMode, setPaymentMode] = useState(initialPaymentMode || 'Cash'); 
    const [invoiceDate, setInvoiceDate] = useState(initialDate || new Date().toISOString().split('T')[0]);
    const [cartItems, setCartItems] = useState<BillItem[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
    const [lumpsumDiscount, setLumpsumDiscount] = useState<number>(0);
    const [prescriptions, setPrescriptions] = useState<UploadedFile[]>([]);
    const [localPricingMode, setLocalPricingMode] = useState<'mrp' | 'rate'>(initialPricingMode || configurations?.displayOptions?.pricingMode || 'mrp');

    useEffect(() => {
        if (currentUser?.organization_type === 'Distributor') {
            setLocalPricingMode('rate');
        } else if (initialPricingMode) {
            setLocalPricingMode(initialPricingMode);
        } else if (configurations?.displayOptions?.pricingMode) {
            setLocalPricingMode(configurations.displayOptions.pricingMode);
        }
    }, [currentUser?.organization_type, configurations?.displayOptions?.pricingMode, initialPricingMode]);

    const [isAddMedicineMasterModalOpen, setIsAddMedicineMasterModalOpen] = useState(false);
    const [newProductInitialName, setNewProductInitialName] = useState('');
    const [pendingAddProductResolver, setPendingAddProductResolver] = useState<((medicine: Medicine) => void) | null>(null);

    const [pendingBatchSelection, setPendingBatchSelection] = useState<{ item: InventoryItem; batches: InventoryItem[] } | null>(null);

    const highlightedItemRef = useRef<HTMLLIElement>(null);
    const customerHighlightedRef = useRef<HTMLLIElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null); 

    useEffect(() => {
        if (isOpen) {
            setSearchTerm('');
            setCustomerSearch('');
            setSelectedCustomer(initialCustomer || null);
            setSelectedCustomerIndex(0);
            setCartItems([]);
            setPrescriptions([]); 
            setSelectedSearchIndex(0);
            setLumpsumDiscount(0);
            setPendingBatchSelection(null);
            setReferredBy(initialReferredBy || ''); 
            setPaymentMode(initialPaymentMode || 'Cash'); 
            setInvoiceDate(initialDate || new Date().toISOString().split('T')[0]);
            setLocalPricingMode(initialPricingMode || configurations?.displayOptions?.pricingMode || 'mrp');
            
            if (!isReadOnly) {
                setTimeout(() => searchInputRef.current?.focus(), 150);
            }

            if (initialItem && initialItem.length > 0) {
                setCartItems(initialItem.filter(Boolean)); 
            } else if (!isReadOnly) {
                const savedState = localStorage.getItem('pos_draft_regular'); 
                if (savedState) {
                    try {
                        const parsed = JSON.parse(savedState);
                        if (parsed.cartItems && parsed.cartItems.length > 0) setCartItems(parsed.cartItems.filter(Boolean)); 
                        if (parsed.selectedCustomer) setSelectedCustomer(parsed.selectedCustomer);
                        if (parsed.customerSearch) setCustomerSearch(parsed.customerSearch);
                        if (parsed.customerPhone) setCustomerPhone(parsed.customerPhone);
                        if (parsed.referredBy) setReferredBy(parsed.referredBy);
                        if (parsed.invoiceDate) setInvoiceDate(parsed.invoiceDate);
                        if (parsed.paymentMode) setPaymentMode(parsed.paymentMode);
                        if (parsed.prescriptions) setPrescriptions(parsed.prescriptions);
                        if (parsed.lumpsumDiscount) setLumpsumDiscount(parsed.lumpsumDiscount);
                    } catch (e) {
                        console.error("Failed to restore POS state:", e);
                        setCartItems([]);
                    }
                }
            }
        }
    }, [isOpen, initialItem, initialReferredBy, initialPaymentMode, initialCustomer, initialDate, initialPricingMode, isReadOnly, configurations?.displayOptions?.pricingMode]);

    const cartUnitsByBatchId = useMemo(() => {
        const mapping: Record<string, number> = {};
        cartItems.forEach(item => {
            const uPP = item.unitsPerPack || 1;
            const totalUnits = ((item.quantity + (item.freeQuantity || 0)) * uPP) + (item.looseQuantity || 0);
            mapping[item.inventoryItemId] = (mapping[item.inventoryItemId] || 0) + totalUnits;
        });
        return mapping;
    }, [cartItems]);

    useEffect(() => {
        if (searchTerm && highlightedItemRef.current) {
            highlightedItemRef.current.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
            });
        }
    }, [selectedSearchIndex, searchTerm]);

    useEffect(() => {
        if (customerHighlightedRef.current) {
            customerHighlightedRef.current.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
            });
        }
    }, [selectedCustomerIndex]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { files } = e.target;
        if (!files) return;
        Array.from(files).forEach((file: File) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result as string;
                setPrescriptions(prev => [...prev, {
                    id: crypto.randomUUID(),
                    data: base64,
                    type: file.type.includes('pdf') ? 'pdf' : 'image',
                    name: file.name
                }]);
            };
            reader.readAsDataURL(file);
        });
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const filteredCustomers = useMemo(() => {
        if (!customerSearch) return [];
        const lowerTerm = customerSearch.toLowerCase();
        return customers.filter(c => c.name.toLowerCase().includes(lowerTerm) || (c.phone && c.phone.includes(lowerTerm))).slice(0, 5);
    }, [customerSearch, customers]);

    const deduplicatedSearchInventory = useMemo(() => {
        if (!searchTerm) return [];
        
        const grouped = new Map<string, { item: InventoryItem; batches: InventoryItem[] }>();
        inventory.forEach(i => {
            if (fuzzyMatch(i.name, searchTerm) || fuzzyMatch(i.brand, searchTerm) || fuzzyMatch(i.barcode, searchTerm) || fuzzyMatch(i.batch, searchTerm)) {
                const key = `${i.name.toLowerCase()}|${i.brand?.toLowerCase() || ''}`;
                if (!grouped.has(key)) {
                    grouped.set(key, { item: i, batches: [i] });
                } else {
                    grouped.get(key)!.batches.push(i);
                }
            }
        });

        return Array.from(grouped.values())
            .sort((a, b) => {
                const aStarts = a.item.name.toLowerCase().startsWith(searchTerm.toLowerCase());
                const bStarts = b.item.name.toLowerCase().startsWith(searchTerm.toLowerCase());
                if (aStarts && !bStarts) return -1;
                if (!aStarts && bStarts) return 1;
                return a.item.name.localeCompare(b.item.name);
            })
            .slice(0, 30);
    }, [searchTerm, inventory]);

    useEffect(() => { setSelectedSearchIndex(0); }, [searchTerm]);

    const triggerBatchSelection = (productWrapper: { item: InventoryItem, batches: InventoryItem[] }) => {
        if (!productWrapper.batches || productWrapper.batches.length === 0) {
            return;
        }
        setPendingBatchSelection(productWrapper);
    };

    const addSelectedBatchToGrid = (batch: InventoryItem) => {
        let rateValue = batch.mrp;
        const globalDefaultRateTier = configurations?.displayOptions?.defaultRateTier || 'mrp';
        let rateTierToUse = selectedCustomer?.defaultRateTier !== 'none' ? selectedCustomer?.defaultRateTier : globalDefaultRateTier;
        
        if (rateTierToUse === 'rateA' && batch.rateA) rateValue = batch.rateA;
        else if (rateTierToUse === 'rateB' && batch.rateB) rateValue = batch.rateB;
        else if (rateTierToUse === 'rateC' && batch.rateC) rateValue = batch.rateC;
        else if (rateTierToUse === 'ptr' && batch.ptr) rateValue = batch.ptr;

        const newItem: BillItem = {
            id: crypto.randomUUID(),
            inventoryItemId: batch.id,
            name: batch.name,
            brand: batch.brand,
            mrp: batch.mrp,
            quantity: 1,
            looseQuantity: 0,
            freeQuantity: 0,
            unit: 'pack',
            gstPercent: batch.gstPercent,
            discountPercent: selectedCustomer?.defaultDiscount || 0,
            itemFlatDiscount: 0,
            batch: batch.batch,
            expiry: batch.expiry,
            rate: rateValue,
            unitsPerPack: batch.unitsPerPack || 1
        };

        setCartItems(prev => [...prev, newItem]);
        setSearchTerm('');
        setPendingBatchSelection(null);
        
        setTimeout(() => {
            const rows = document.querySelectorAll('tr[data-bill-item-id]');
            const lastRow = rows[rows.length - 1];
            const qtyInput = lastRow?.querySelector('input[data-field="quantity"]') as HTMLInputElement;
            qtyInput?.focus();
            qtyInput?.select();
        }, 50);
    };

    const handleUpdateCartItem = (id: string, field: keyof BillItem, value: any) => {
        setCartItems(prev => prev.map(item => {
            if (item.id === id) {
                const updated = { ...item, [field]: value };
                if (['quantity', 'looseQuantity', 'freeQuantity', 'discountPercent', 'rate', 'itemFlatDiscount', 'mrp', 'gstPercent'].includes(field as string)) {
                    (updated as any)[field] = parseFloat(value) || 0;
                }
                return updated;
            }
            return item;
        }));
    };

    const handleAddMedicineMasterSuccess = useCallback(async (medData: Omit<Medicine, 'id'>) => {
        const savedMed = await onAddMedicineMaster(medData);
        setIsAddMedicineMasterModalOpen(false);
        if (pendingAddProductResolver) {
            pendingAddProductResolver(savedMed);
            setPendingAddProductResolver(null);
        }
    }, [onAddMedicineMaster, pendingAddProductResolver]);

    const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (deduplicatedSearchInventory.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedSearchIndex(prev => (prev + 1) % deduplicatedSearchInventory.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedSearchIndex(prev => (prev - 1 + deduplicatedSearchInventory.length) % deduplicatedSearchInventory.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            const selection = deduplicatedSearchInventory[selectedSearchIndex];
            if (selection) triggerBatchSelection(selection);
        }
    };

    const handleCustomerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (filteredCustomers.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedCustomerIndex(prev => (prev + 1) % filteredCustomers.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedCustomerIndex(prev => (prev - 1 + filteredCustomers.length) % filteredCustomers.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const selection = filteredCustomers[selectedCustomerIndex];
            if (selection) {
                setSelectedCustomer(selection);
                setCustomerSearch('');
            }
        }
    };

    const handleRemoveItem = (id: string) => { setCartItems(prev => prev.filter(item => item.id !== id)); };

    const totals = useMemo(() => {
        const billingTotals = calculateBillingTotals({
            items: cartItems,
            billDiscount: lumpsumDiscount,
            isNonGst: false,
            configurations,
            organizationType: currentUser?.organization_type,
            pricingMode: localPricingMode
        });

        let totalCost = 0;
        cartItems.forEach(item => {
            const unitsPerPack = item.unitsPerPack || 1;
            const totalUnits = ((item.quantity || 0) * unitsPerPack) + (item.looseQuantity || 0);
            const invItem = inventory.find(i => i.id === item.inventoryItemId);
            if (invItem) {
                const unitCost = invItem.cost || (invItem.unitsPerPack > 0 ? (invItem.purchasePrice / invItem.unitsPerPack) : invItem.purchasePrice);
                totalCost += unitCost * totalUnits;
            }
        });

        const netAfterLumpsum = billingTotals.baseTotal;
        const roundedNet = Math.round(netAfterLumpsum);
        const roundOff = parseFloat((roundedNet - netAfterLumpsum).toFixed(2));
        const grossMargin = netAfterLumpsum - totalCost;
        const grossMarginPercent = netAfterLumpsum > 0 ? (grossMargin / netAfterLumpsum) * 100 : 0;

        return { 
            gross: billingTotals.gross, 
            tradeDiscount: billingTotals.tradeDiscount + billingTotals.lineFlatDiscount, 
            schemeDiscount: billingTotals.schemeTotal, 
            itemFlatDiscountTotal: billingTotals.lineFlatDiscount, 
            tax: billingTotals.tax, 
            net: netAfterLumpsum, 
            roundOff, 
            roundedNet, 
            totalCost, 
            grossMargin, 
            grossMarginPercent 
        };
    }, [cartItems, inventory, lumpsumDiscount, configurations, currentUser?.organization_type, localPricingMode]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Create New Sales Bill">
            <div className="flex flex-col h-[90vh]">
                <div className="p-4 bg-gray-50 border-b space-y-4">
                    <div className="flex justify-between items-center">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
                            <div className="relative">
                                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Customer / Ledger</label>
                                {selectedCustomer ? (
                                    <div className="flex items-center justify-between p-2 border border-blue-200 bg-blue-50 rounded">
                                        <span className="font-bold text-blue-900">{selectedCustomer.name}</span>
                                        <button onClick={() => setSelectedCustomer(null)} className="text-blue-500 hover:text-blue-700">✕</button>
                                    </div>
                                ) : (
                                    <input
                                        type="text"
                                        placeholder="Search customer by name/phone..."
                                        value={customerSearch}
                                        onChange={e => setCustomerSearch(e.target.value)}
                                        onKeyDown={handleCustomerKeyDown}
                                        className="w-full p-2 border border-gray-300 rounded focus:ring-1 focus:ring-primary outline-none"
                                    />
                                )}
                                {customerSearch && filteredCustomers.length > 0 && !selectedCustomer && (
                                    <ul className="absolute top-full left-0 w-full bg-white border border-gray-300 shadow-xl z-50 rounded mt-1 overflow-hidden">
                                        {filteredCustomers.map((c, idx) => (
                                            <li
                                                key={c.id}
                                                onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); }}
                                                className={`p-2 cursor-pointer border-b last:border-b-0 ${idx === selectedCustomerIndex ? 'bg-primary text-white' : 'hover:bg-gray-50'}`}
                                            >
                                                <div className="font-bold">{c.name}</div>
                                                <div className="text-xs opacity-70">{c.phone || 'No Phone'}</div>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            <div className="relative">
                                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Product Search</label>
                                <input
                                    ref={searchInputRef}
                                    type="text"
                                    placeholder="Search by item name..."
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    onKeyDown={handleSearchKeyDown}
                                    className="w-full p-2 border border-gray-300 rounded focus:ring-1 focus:ring-primary outline-none"
                                />
                                {searchTerm && deduplicatedSearchInventory.length > 0 && (
                                    <ul className="absolute top-full left-0 w-full bg-white border border-gray-300 shadow-xl z-50 rounded mt-1 overflow-hidden">
                                        {deduplicatedSearchInventory.map((wrapper, idx) => (
                                            <li
                                                key={wrapper.item.id}
                                                onClick={() => triggerBatchSelection(wrapper)}
                                                className={`p-2 cursor-pointer border-b last:border-b-0 ${idx === selectedSearchIndex ? 'bg-primary text-white' : 'hover:bg-gray-50'}`}
                                            >
                                                <span className="font-normal">{wrapper.item.name}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                        {currentUser?.organization_type === 'Retail' && (
                            <div className="ml-4 flex flex-col items-end">
                                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1">Pricing Mode</label>
                                <button
                                    type="button"
                                    onClick={() => setLocalPricingMode(prev => prev === 'mrp' ? 'rate' : 'mrp')}
                                    className={`px-3 py-2 border rounded font-black text-xs uppercase transition-colors ${localPricingMode === 'mrp' ? 'bg-primary text-white border-primary' : 'bg-white text-primary border-primary'}`}
                                >
                                    {localPricingMode === 'mrp' ? 'MRP (Incl)' : 'Rate (Ext)'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex-1 overflow-auto p-4">
                    <table className="min-w-full border-collapse">
                        <thead className="bg-gray-100 sticky top-0">
                            <tr className="text-[10px] font-black uppercase text-gray-600 border-b">
                                <th className="p-2 text-left">Item Name</th>
                                <th className="p-2 text-center">Batch</th>
                                <th className="p-2 text-center">Qty</th>
                                <th className="p-2 text-right">MRP</th>
                                <th className="p-2 text-right">Disc%</th>
                                <th className="p-2 text-right">GST%</th>
                                <th className="p-2 text-right">Total</th>
                                <th className="p-2 w-10"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {cartItems.map((item) => {
                                const unitsPerPack = item.unitsPerPack || 1;
                                const billedQty = (item.quantity || 0) + ((item.looseQuantity || 0) / unitsPerPack);
                                const effectivePricingMode = (currentUser?.organization_type === 'Distributor') ? 'rate' : localPricingMode;
                                const displayRate = (effectivePricingMode === 'mrp') ? item.mrp : (item.rate || item.mrp);
                                const itemGross = billedQty * displayRate;
                                const lineAfterDisc = itemGross * (1 - (item.discountPercent || 0) / 100) - (item.itemFlatDiscount || 0);

                                return (
                                    <tr key={item.id} className="border-b hover:bg-gray-50">
                                        <td className="p-2 font-bold uppercase truncate max-w-[200px]">{item.name}</td>
                                        <td className="p-2 text-center font-mono text-xs">{item.batch}</td>
                                        <td className="p-2 text-center">
                                            <input 
                                                type="number" 
                                                value={item.quantity} 
                                                onChange={e => handleUpdateCartItem(item.id, 'quantity', e.target.value)} 
                                                onKeyDown={e => {
                                                    if (e.key === 'Delete') {
                                                        e.preventDefault();
                                                        handleRemoveItem(item.id);
                                                    }
                                                }}
                                                className="w-12 text-center border p-1 rounded font-bold disabled:bg-gray-100" 
                                                disabled={isReadOnly}
                                            />
                                        </td>
                                        <td className="p-2 text-right">₹{displayRate.toFixed(2)}</td>
                                        <td className="p-2 text-right">
                                            <input 
                                                type="number" 
                                                value={item.discountPercent} 
                                                onChange={e => handleUpdateCartItem(item.id, 'discountPercent', e.target.value)} 
                                                onKeyDown={e => {
                                                    if (e.key === 'Delete') {
                                                        e.preventDefault();
                                                        handleRemoveItem(item.id);
                                                    }
                                                }}
                                                className="w-12 text-right border p-1 rounded disabled:bg-gray-100" 
                                                disabled={isReadOnly}
                                            />
                                        </td>
                                        <td className="p-2 text-right">{item.gstPercent}%</td>
                                        <td className="p-2 text-right font-bold">₹{lineAfterDisc.toFixed(2)}</td>
                                        <td className="p-2">
                                            {!isReadOnly && <button onClick={() => handleRemoveItem(item.id)} className="text-red-400 hover:text-red-600">✕</button>}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                <div className="p-4 bg-gray-50 border-t flex justify-between items-end">
                    <div className="space-y-1">
                        <p className="text-xs text-gray-500 font-bold uppercase">Net Value in Words</p>
                        <p className="text-sm font-black italic">{numberToWords(totals.roundedNet)}</p>
                    </div>
                    <div className="w-64 space-y-2">
                        <div className="flex justify-between text-xs font-bold text-gray-500">
                            <span>Subtotal</span>
                            <span>₹{totals.gross.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-xs font-bold text-red-500">
                            <span>Trade Discount (-)</span>
                            <span>₹{totals.tradeDiscount.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-xs font-bold text-blue-500">
                            <span>GST Tax (+)</span>
                            <span>₹{totals.tax.toFixed(2)}</span>
                        </div>
                        <div className="border-t pt-2 flex justify-between text-xl font-black text-primary">
                            <span>Total</span>
                            <span>₹{totals.roundedNet.toFixed(2)}</span>
                        </div>
                        {isReadOnly ? (
                            <button
                                onClick={() => {
                                    if (onPrintBill && initialInvoiceId) {
                                        // Create a transaction-like object for printing
                                        const tx: Transaction = {
                                            id: initialInvoiceId,
                                            organization_id: currentUser?.organization_id || '',
                                            date: invoiceDate,
                                            customerName: selectedCustomer?.name || 'Walking Customer',
                                            customerId: selectedCustomer?.id || null,
                                            items: cartItems,
                                            total: totals.roundedNet,
                                            subtotal: totals.gross,
                                            totalItemDiscount: totals.tradeDiscount,
                                            totalGst: totals.tax,
                                            schemeDiscount: 0,
                                            roundOff: totals.roundOff,
                                            status: 'completed',
                                            itemCount: cartItems.length,
                                            paymentMode: paymentMode,
                                            pricingMode: localPricingMode
                                        };
                                        onPrintBill(tx);
                                    }
                                }}
                                className="w-full py-3 bg-primary text-white font-black uppercase rounded shadow-lg hover:bg-primary-dark transition-all flex items-center justify-center gap-2"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
                                Print Invoice (F8)
                            </button>
                        ) : (
                            <button
                                onClick={async () => {
                                    if (!currentUser) throw new Error('User context missing for voucher generation.');
                                    const reservation = await storage.reserveVoucherNumber('sales-gst', currentUser);
                                    const generatedId = reservation.documentNumber;
                                    const tx: Transaction = {
                                        id: generatedId,
                                        organization_id: currentUser?.organization_id || '',
                                        date: new Date(invoiceDate).toISOString(),
                                        customerName: selectedCustomer?.name || 'Walking Customer',
                                        customerId: selectedCustomer?.id || null,
                                        items: cartItems,
                                        total: totals.roundedNet,
                                        subtotal: totals.gross,
                                        totalItemDiscount: totals.tradeDiscount,
                                        totalGst: totals.tax,
                                        schemeDiscount: 0,
                                        roundOff: totals.roundOff,
                                        status: 'completed',
                                        itemCount: cartItems.length,
                                        paymentMode: paymentMode,
                                        pricingMode: localPricingMode
                                    };
                                    await onSaveOrUpdateTransaction(tx, false);
                                    onClose();
                                }}
                                disabled={isSaving || cartItems.length === 0}
                                className="w-full py-3 bg-primary text-white font-black uppercase rounded shadow-lg hover:bg-primary-dark transition-all"
                            >
                                Accept Bill (F2)
                            </button>
                        )}
                    </div>
                </div>
            </div>
            
            {pendingBatchSelection && (
                <BatchSelectionModal
                    isOpen={!!pendingBatchSelection}
                    onClose={() => setPendingBatchSelection(null)}
                    productName={pendingBatchSelection.item.name}
                    batches={pendingBatchSelection.batches}
                    onSelect={addSelectedBatchToGrid}
                />
            )}
        </Modal>
    );
};
function numberToWords(num: number): string {
    return `Rupees ${num.toFixed(2)} Only`;
}