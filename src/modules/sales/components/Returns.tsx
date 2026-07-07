import React, { useState, useMemo, useEffect } from 'react';
import Card from '@core/components/ui/Card';
import type { 
    Transaction, 
    SalesReturn, 
    PurchaseReturn, 
    InventoryItem, 
    SalesReturnItem, 
    PurchaseReturnItem, 
    Purchase, 
    ReturnsProps
} from '@core/types';
import { handleEnterToNextField } from '@core/utils/navigation';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';
import PrintReturnModal from './PrintReturnModal';

const RETURN_REASONS = [
    'Damaged / Broken', 'Expired / Near Expiry', 'Incorrect Item Sent', 
    'Customer Return', 'Stock Adjustment', 'Manufacturer Recall', 'Other'
];

const getPurchaseReturnItemKey = (item: any): string => {
    const materialId = String(item?.inventoryItemId || item?.materialId || item?.sku || item?.id || '').trim().toLowerCase();
    const batch = String(item?.batch || '').trim().toLowerCase();
    const packType = String(item?.packType || '').trim().toLowerCase();
    const unit = String(item?.unitOfMeasurement || item?.selectedUnit || '').trim().toLowerCase();
    const name = String(item?.name || '').trim().toLowerCase();
    return [materialId, name, batch, packType, unit].join('|');
};

const getPurchaseItemBaseQuantity = (item: any): number => {
    const packQty = Number(item?.quantity || 0);
    const looseQty = Number(item?.looseQuantity || 0);
    const unitsPerPack = Number(item?.unitsPerPack || 0);

    if (unitsPerPack > 0) {
        return (packQty * unitsPerPack) + looseQty;
    }
    if (looseQty > 0) {
        return packQty + looseQty;
    }
    return packQty;
};

const buildPurchaseReturnItems = (purchase: Purchase, purchaseReturns: PurchaseReturn[]): PurchaseReturnItem[] => {
    const returnedQtyMap = new Map<string, number>();

    (purchaseReturns || [])
        .filter(ret => ret.originalPurchaseInvoiceId === purchase.purchaseSerialId)
        .flatMap(ret => ret.items || [])
        .forEach((retItem: any) => {
            const key = getPurchaseReturnItemKey(retItem);
            const current = returnedQtyMap.get(key) || 0;
            returnedQtyMap.set(key, current + Number(retItem.returnQuantity || 0));
        });

    return (purchase.items || []).map(item => {
        const key = getPurchaseReturnItemKey(item);
        const originalQuantity = getPurchaseItemBaseQuantity(item);
        const alreadyReturnedQuantity = returnedQtyMap.get(key) || 0;
        const availableReturnableQuantity = Math.max(0, originalQuantity - alreadyReturnedQuantity);

        return {
            id: item.id,
            name: item.name,
            brand: item.brand,
            purchasePrice: item.purchasePrice,
            returnQuantity: 0,
            reason: RETURN_REASONS[0],
            quantity: availableReturnableQuantity,
            originalQuantity,
            alreadyReturnedQuantity,
            batch: item.batch,
            expiry: item.expiry,
            gstPercent: item.gstPercent,
            hsnCode: item.hsnCode,
            packType: item.packType,
            unitOfMeasurement: item.unitOfMeasurement,
            selectedUnit: item.selectedUnit,
            unitsPerPack: item.unitsPerPack,
            inventoryItemId: item.inventoryItemId,
        } as PurchaseReturnItem;
    });
};

const buildSalesReturnItems = (transaction: Transaction, salesReturns: SalesReturn[]): SalesReturnItem[] => {
    const returnedQtyMap = new Map<string, number>();

    (salesReturns || [])
        .filter(ret => ret.originalInvoiceId === transaction.id)
        .flatMap(ret => ret.items || [])
        .forEach((retItem: any) => {
            const key = retItem.inventoryItemId || retItem.id;
            const current = returnedQtyMap.get(key) || 0;
            returnedQtyMap.set(key, current + Number(retItem.returnQuantity || 0));
        });

    return (transaction.items || []).map(item => {
        const key = item.inventoryItemId || item.id;
        const originalQuantity = Number(item.quantity || 0); // Sales quantity is in packs/main units
        const alreadyReturnedQuantity = returnedQtyMap.get(key) || 0;
        const availableReturnableQuantity = Math.max(0, originalQuantity - alreadyReturnedQuantity);

        return {
            ...item,
            returnQuantity: 0,
            reason: RETURN_REASONS[0],
            quantity: availableReturnableQuantity, // Store available quantity in the item's quantity field for UI
            originalQuantity, // Keep track of original for reference
            alreadyReturnedQuantity,
        } as any; // Cast to any because SalesReturnItem might not have these extra fields but we need them for UI
    });
};

const Returns = React.forwardRef<any, ReturnsProps>(({ 
    currentUser, 
    transactions, 
    inventory, 
    salesReturns, 
    purchaseReturns, 
    purchases,
    onAddSalesReturn,
    onAddPurchaseReturn,
    addNotification,
    defaultTab = 'sales',
    isFixedMode,
    prefillSalesInvoiceId,
    prefillPurchaseInvoiceId,
    onPrefillSalesInvoiceHandled,
    onPrefillPurchaseInvoiceHandled
}, ref) => {
    const [view, setView] = useState<'list' | 'create'>('list');
    const [printVoucher, setPrintVoucher] = useState<any | null>(null);
    const [activeTab, setActiveTab] = useState<'sales' | 'purchase'>(defaultTab);
    const [searchInvoiceId, setSearchInvoiceId] = useState('');
    const [selectedInvoice, setSelectedInvoice] = useState<Transaction | Purchase | null>(null);
    const [returnItems, setReturnItems] = useState<(SalesReturnItem | PurchaseReturnItem)[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [returnReason, setReturnReason] = useState('');
    const [returnDate, setReturnDate] = useState(new Date().toISOString().split('T')[0]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, ['salesReturns', 'purchaseReturns'])) return;
            if (e.key === 'F2') {
                e.preventDefault();
                setView('create');
            } else if (e.key === 'Escape' && view === 'create') {
                e.preventDefault();
                setView('list');
                handleClearSelection();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [view]);

    const historyData = useMemo(() => {
        return activeTab === 'sales' ? salesReturns : purchaseReturns;
    }, [activeTab, salesReturns, purchaseReturns]);

    useEffect(() => {
        if (!prefillSalesInvoiceId) return;

        setActiveTab('sales');
        setView('create');
        setSearchInvoiceId(prefillSalesInvoiceId);

        const foundTx = transactions.find(tx => tx.id === prefillSalesInvoiceId || tx.invoiceNumber === prefillSalesInvoiceId);
        if (foundTx) {
            const mappedItems = buildSalesReturnItems(foundTx, salesReturns || []);
            const totalReturnedQty = mappedItems.reduce((sum, item: any) => sum + Number(item.alreadyReturnedQuantity || 0), 0);
            const totalSoldQty = mappedItems.reduce((sum, item: any) => sum + Number(item.originalQuantity || 0), 0);
            const totalAvailableQty = mappedItems.reduce((sum, item: any) => sum + Number(item.quantity || 0), 0);

            if (foundTx.status !== 'completed') {
                addNotification('Selected invoice is not eligible for return.', 'warning');
            } else if (totalSoldQty > 0 && totalReturnedQty >= totalSoldQty || totalAvailableQty <= 0) {
                addNotification('Return already completed for this invoice.', 'warning');
            } else {
                setReturnItems(mappedItems);
                setSelectedInvoice(foundTx);
                addNotification('Source Invoice Identified.', 'success');
            }
        }

        onPrefillSalesInvoiceHandled?.();
    }, [prefillSalesInvoiceId, transactions, salesReturns, addNotification, onPrefillSalesInvoiceHandled]);


    useEffect(() => {
        if (!prefillPurchaseInvoiceId) return;

        setActiveTab('purchase');
        setView('create');
        setSearchInvoiceId(prefillPurchaseInvoiceId);

        const foundPur = purchases.find(p => p.id === prefillPurchaseInvoiceId || p.invoiceNumber === prefillPurchaseInvoiceId || p.purchaseSerialId === prefillPurchaseInvoiceId);
        if (foundPur) {
            const mappedItems = buildPurchaseReturnItems(foundPur, purchaseReturns || []);
            const totalReturnedQty = mappedItems.reduce((sum, item: any) => sum + Number(item.alreadyReturnedQuantity || 0), 0);
            const totalPurchasedQty = mappedItems.reduce((sum, item: any) => sum + Number(item.originalQuantity || 0), 0);
            const totalAvailableQty = mappedItems.reduce((sum, item: any) => sum + Number(item.quantity || 0), 0);

            if (foundPur.status !== 'completed') {
                addNotification('Selected bill is not eligible for purchase return.', 'warning');
            } else if (totalPurchasedQty > 0 && totalReturnedQty >= totalPurchasedQty || totalAvailableQty <= 0) {
                addNotification('Purchase return already completed for this bill.', 'warning');
            } else {
                setReturnItems(mappedItems);
                setSelectedInvoice(foundPur);
                addNotification('Source Bill Identified.', 'success');
            }
        }

        onPrefillPurchaseInvoiceHandled?.();
    }, [prefillPurchaseInvoiceId, purchases, purchaseReturns, addNotification, onPrefillPurchaseInvoiceHandled]);

    const handleSearchInvoice = () => {
        if (!searchInvoiceId.trim()) {
            addNotification("Enter Bill/Invoice number to continue.", "warning");
            return;
        }

        const lowerSearchId = searchInvoiceId.toLowerCase().trim();
        
        if (activeTab === 'sales') {
            const foundTx = transactions.find(t => t.id.toLowerCase() === lowerSearchId || (t.invoiceNumber && t.invoiceNumber.toLowerCase() === lowerSearchId));
            if (foundTx) {
                const mappedItems = buildSalesReturnItems(foundTx, salesReturns || []);
                const totalReturnedQty = mappedItems.reduce((sum, item: any) => sum + Number(item.alreadyReturnedQuantity || 0), 0);
                const totalSoldQty = mappedItems.reduce((sum, item: any) => sum + Number(item.originalQuantity || 0), 0);
                const totalAvailableQty = mappedItems.reduce((sum, item: any) => sum + Number(item.quantity || 0), 0);

                if (foundTx.status !== 'completed') {
                    addNotification('Selected invoice is not eligible for return.', 'warning');
                    return;
                }
                if (totalSoldQty > 0 && totalReturnedQty >= totalSoldQty || totalAvailableQty <= 0) {
                    addNotification('Return already completed for this invoice.', 'warning');
                    return;
                }

                setReturnItems(mappedItems);
                setSelectedInvoice(foundTx as Transaction);
                addNotification("Source Invoice Identified.", "success");
            } else {
                addNotification("Invoice not found in Sales Register.", "error");
            }
        } else {
            const foundPur = purchases.find(p => p.id.toLowerCase() === lowerSearchId || p.invoiceNumber.toLowerCase() === lowerSearchId || p.purchaseSerialId.toLowerCase() === lowerSearchId);
            if (foundPur) {
                const mappedItems = buildPurchaseReturnItems(foundPur, purchaseReturns || []);
                const totalAvailableQty = mappedItems.reduce((sum, item: any) => sum + Number(item.quantity || 0), 0);

                if (foundPur.status !== 'completed') {
                    addNotification('Selected bill is not eligible for purchase return.', 'warning');
                    return;
                }

                if (totalAvailableQty <= 0) {
                    addNotification('Purchase return already completed for this bill.', 'warning');
                    return;
                }

                setReturnItems(mappedItems);
                setSelectedInvoice(foundPur as Purchase);
                addNotification("Source Bill Identified.", "success");
            } else {
                addNotification("Bill not found in Purchase Register.", "error");
            }
        }
    };

    const handleUpdateReturnItem = (itemId: string, field: 'returnQuantity' | 'reason', value: any) => {
        setReturnItems(prev => prev.map(item => {
            if (item.id === itemId) {
                let updatedValue = value;
                if (field === 'returnQuantity') {
                    const originalQty = Number((item as any).quantity || 0);
                    updatedValue = Math.min(originalQty, Math.max(0, parseInt(value, 10) || 0));
                }
                return { ...item, [field]: updatedValue };
            }
            return item;
        }));
    };

    const totalReturnRefundValue = useMemo(() => {
        return returnItems.reduce((sum, item) => {
            const quantity = item.returnQuantity || 0;
            if (quantity <= 0) return sum;

            let perItemValue = 0;
            if (activeTab === 'sales') {
                const sItem = item as SalesReturnItem;
                const rate = sItem.rate || sItem.mrp || 0;
                const disc = sItem.discountPercent || 0;
                const tax = sItem.gstPercent || 0;
                
                // Net value after discount and adding tax
                const afterDisc = rate * (1 - disc / 100);
                perItemValue = afterDisc * (1 + tax / 100);
            } else {
                perItemValue = (item as PurchaseReturnItem).purchasePrice || 0;
            }
            return sum + (quantity * perItemValue);
        }, 0);
    }, [returnItems, activeTab]);

    const handleProcessReturn = async () => {
        if (!selectedInvoice || !returnReason.trim()) {
            addNotification("Mandatory: Narration and Selection required.", "error");
            return;
        }
        const itemsToReturn = returnItems.filter(item => (item.returnQuantity || 0) > 0);
        if (itemsToReturn.length === 0) {
            addNotification("No items selected for return.", "warning");
            return;
        }

        setIsProcessing(true);
        try {
            if (activeTab === 'sales') {
                const salesInv = selectedInvoice as Transaction;
                await onAddSalesReturn({
                    id: `SR-${Date.now().toString().slice(-6)}`,
                    organization_id: currentUser?.organization_id || '',
                    date: returnDate,
                    originalInvoiceId: salesInv.id,
                    originalInvoiceNumber: salesInv.invoiceNumber || salesInv.id,
                    customerName: salesInv.customerName,
                    customerId: salesInv.customerId,
                    items: itemsToReturn as SalesReturnItem[],
                    totalRefund: totalReturnRefundValue,
                    remarks: returnReason,
                });
            } else {
                const purchaseInv = selectedInvoice as Purchase;
                await onAddPurchaseReturn({
                    id: `PR-${Date.now().toString().slice(-6)}`,
                    organization_id: currentUser?.organization_id || '',
                    date: returnDate,
                    supplier: purchaseInv.supplier,
                    originalPurchaseInvoiceId: purchaseInv.purchaseSerialId,
                    items: itemsToReturn as PurchaseReturnItem[],
                    totalValue: totalReturnRefundValue,
                    remarks: returnReason,
                });
            }
            handleClearSelection();
            setView('list');
        } catch (error: any) {
            console.error("Return processing error:", error);
            addNotification("Voucher processing failed: " + (error?.message || "Unknown error"), "error");
        } finally {
            setIsProcessing(false);
        }
    };

    const handleClearSelection = () => {
        setSelectedInvoice(null);
        setReturnItems([]);
        setSearchInvoiceId('');
        setReturnReason('');
    };

    React.useImperativeHandle(ref, () => ({
        handleSubmit: handleProcessReturn,
        resetForm: () => {
            setView('create');
            handleClearSelection();
        },
        isDirty: view === 'create' && (selectedInvoice !== null || searchInvoiceId !== '' || returnReason !== '' || returnItems.some(i => (i.returnQuantity || 0) > 0))
    }), [handleProcessReturn, view, selectedInvoice, searchInvoiceId, returnReason, returnItems]);

    return (
        <main className="flex-1 overflow-hidden flex flex-col bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">
                    {activeTab === 'sales' ? 'Credit Note (Sales Return) Journal' : 'Debit Note (Purchase Return) Journal'}
                </span>
                <span className="text-[10px] font-black uppercase text-accent">Total Records: {historyData.length}</span>
            </div>

            <div className="p-4 flex-1 flex flex-col gap-4 overflow-hidden">
                <div className="flex justify-between items-center px-2">
                    <div className="flex items-center space-x-2 bg-white p-1 tally-border shadow-sm">
                        <button onClick={() => setView('list')} className={`px-4 py-1.5 text-[10px] font-black uppercase transition-all ${view === 'list' ? 'bg-primary text-white' : 'text-gray-400 hover:bg-gray-50'}`}>History (Esc)</button>
                        <button onClick={() => setView('create')} className={`px-4 py-1.5 text-[10px] font-black uppercase transition-all ${view === 'create' ? 'bg-primary text-white' : 'text-gray-400 hover:bg-gray-50'}`}>New Voucher (F2)</button>
                    </div>

                    {!isFixedMode && (
                        <div className="flex bg-white p-1 tally-border shadow-sm">
                            <button onClick={() => { setActiveTab('sales'); handleClearSelection(); }} className={`px-6 py-1.5 text-[10px] font-black uppercase transition-all ${activeTab === 'sales' ? 'bg-primary text-white' : 'text-gray-400 hover:bg-gray-50'}`}>Sales Returns</button>
                            <button onClick={() => { setActiveTab('purchase'); handleClearSelection(); }} className={`px-6 py-1.5 text-[10px] font-black uppercase transition-all ${activeTab === 'purchase' ? 'bg-primary text-white' : 'text-gray-400 hover:bg-gray-50'}`}>Purchase Returns</button>
                        </div>
                    )}
                </div>

                {view === 'list' ? (
                    <Card className="flex-1 p-0 overflow-hidden tally-border shadow-md bg-white">
                        <div className="overflow-auto h-full">
                            <table className="min-w-full border-collapse text-sm">
                                <thead className="bg-gray-100 sticky top-0 z-10 border-b border-gray-400">
                                    <tr className="text-[10px] font-black uppercase text-gray-600">
                                        <th className="p-2 border-r border-gray-400 text-left w-12 text-center">#</th>
                                        <th className="p-2 border-r border-gray-400 text-left w-32">Voucher ID</th>
                                        <th className="p-2 border-r border-gray-400 text-left w-24">Date</th>
                                        <th className="p-2 border-r border-gray-400 text-left">Particulars (Account Name)</th>
                                        <th className="p-2 border-r border-gray-400 text-left w-32">Source Ref</th>
                                        <th className="p-2 border-r border-gray-400 text-right w-32">Net Value</th>
                                        <th className="p-2 text-right w-24">Action</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200">
                                    {historyData.map((ret: any, idx: number) => (
                                        <tr key={ret.id} className="hover:bg-primary hover:text-white transition-colors cursor-pointer group">
                                            <td className="p-2 border-r border-gray-200 text-center font-bold text-gray-400 group-hover:text-white/70">{idx + 1}</td>
                                            <td className="p-2 border-r border-gray-200 font-mono font-black text-primary group-hover:text-white">{ret.id}</td>
                                            <td className="p-2 border-r border-gray-200 font-bold group-hover:text-white">{new Date(ret.date).toLocaleDateString('en-IN')}</td>
                                            <td className="p-2 border-r border-gray-200 font-black uppercase group-hover:text-white">{ret.customerName || ret.supplier}</td>
                                            <td className="p-2 border-r border-gray-200 font-mono text-[10px] text-gray-500 group-hover:text-white/70">{ret.originalInvoiceNumber || ret.originalInvoiceId || ret.originalPurchaseInvoiceId}</td>
                                            <td className="p-2 border-r border-gray-400 text-right font-black text-red-600 group-hover:text-white">₹{(ret.totalRefund || ret.totalValue || 0).toFixed(2)}</td>
                                            <td className="p-2 text-right">
                                                <button onClick={(e) => { e.stopPropagation(); setPrintVoucher(ret); }} className="text-[10px] font-black uppercase text-primary group-hover:text-white hover:underline">Print</button>
                                            </td>
                                        </tr>
                                    ))}
                                    {historyData.length === 0 && <tr><td colSpan={7} className="p-20 text-center text-gray-300 font-black uppercase tracking-[0.4em] italic text-sm">No return vouchers recorded</td></tr>}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                ) : (
                    <div className="flex-1 overflow-y-auto" onKeyDown={handleEnterToNextField}>
                        <div className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6 pb-20">
                            <div className="lg:col-span-2 space-y-6">
                                <Card className="p-6 tally-border bg-white !rounded-none shadow-md">
                                    <h2 className="text-[11px] font-black text-gray-500 uppercase tracking-widest mb-4">Identification: Select Source Document</h2>
                                    <div className="flex gap-2">
                                        <input autoFocus type="text" value={searchInvoiceId} onChange={e => setSearchInvoiceId(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearchInvoice()} placeholder={activeTab === 'sales' ? "INVOICE NUMBER..." : "PURCHASE BILL NO..."} className="flex-1 p-3 border-2 border-gray-400 bg-input-bg text-sm font-black focus:bg-yellow-50 outline-none uppercase" />
                                        <button onClick={handleSearchInvoice} className="px-8 py-3 tally-button-primary uppercase text-[10px]">Identify</button>
                                    </div>
                                    
                                    {selectedInvoice && (
                                        <div className="mt-8 animate-in fade-in slide-in-from-top-4 duration-300">
                                            <div className="bg-gray-50 p-4 border-2 border-gray-300 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs font-black uppercase mb-6 shadow-sm">
                                                <div><span className="block text-[9px] text-gray-400 mb-0.5 tracking-widest">Orig. Invoice</span><span className="text-primary font-mono text-sm">{(selectedInvoice as any).id || (selectedInvoice as any).invoiceNumber}</span></div>
                                                <div><span className="block text-[9px] text-gray-400 mb-0.5 tracking-widest">Billing Date</span><span>{new Date((selectedInvoice as any).date).toLocaleDateString('en-IN')}</span></div>
                                                <div className="md:col-span-2"><span className="block text-[9px] text-gray-400 mb-0.5 tracking-widest">Party Name</span><span className="truncate block">{(selectedInvoice as any).customerName || (selectedInvoice as any).supplier}</span></div>
                                            </div>

                                            <div className="overflow-x-auto border-2 border-gray-300 rounded-none shadow-inner">
                                                <table className="min-w-full text-xs border-collapse bg-white">
                                                    <thead className="bg-gray-100 border-b-2 border-black font-black uppercase text-gray-600 text-[9px]">
                                                        <tr>
                                                            <th className="p-2 text-left">Item Description</th>
                                                            <th className="p-2 text-center w-28">Available Qty</th>
                                                            <th className="p-2 text-center w-32">Return Qty</th>
                                                            <th className="p-2 text-right w-24">Net Rate</th>
                                                            <th className="p-2 text-right w-32">Refund Value</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-gray-100 font-bold">
                                                        {returnItems.map(item => {
                                                            const availableQuantity = (item as any).quantity || 0;
                                                            const originalQuantity = (item as any).originalQuantity || (item as any).quantity || 0;
                                                            
                                                            let netRate = 0;
                                                            if (activeTab === 'sales') {
                                                                const sItem = item as SalesReturnItem;
                                                                const rate = sItem.rate || sItem.mrp || 0;
                                                                const disc = sItem.discountPercent || 0;
                                                                const tax = sItem.gstPercent || 0;
                                                                const afterDisc = rate * (1 - disc / 100);
                                                                netRate = afterDisc * (1 + tax / 100);
                                                            } else {
                                                                netRate = (item as PurchaseReturnItem).purchasePrice || 0;
                                                            }

                                                            return (
                                                                <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                                                                    <td className="p-2 uppercase text-gray-800">
                                                                        <p className="font-black leading-tight">{item.name}</p>
                                                                        <div className="flex items-center gap-2 mt-0.5">
                                                                            <span className="text-[9px] text-gray-400 font-mono">{('batch' in item && item.batch) ? `B: ${item.batch}` : ''}</span>
                                                                            {originalQuantity > availableQuantity && (
                                                                                <span className="text-[8px] bg-amber-100 text-amber-700 px-1 border border-amber-200">Partially Returned ({originalQuantity - availableQuantity} Prev)</span>
                                                                            )}
                                                                        </div>
                                                                    </td>
                                                                    <td className="p-2 text-center text-gray-400 font-black">
                                                                        <div className="flex flex-col leading-none">
                                                                            <span className="text-sm text-primary">{availableQuantity}</span>
                                                                            <span className="text-[8px] uppercase mt-0.5 tracking-tighter">Of {originalQuantity} Total</span>
                                                                        </div>
                                                                    </td>
                                                                    <td className="p-2 text-center">
                                                                        <div className="flex items-center justify-center gap-2">
                                                                            <input type="number" min="0" max={availableQuantity} value={item.returnQuantity || ''} onChange={e => handleUpdateReturnItem(item.id, 'returnQuantity', e.target.value)} className={`w-20 p-1.5 border-2 text-center text-sm font-black no-spinner focus:bg-yellow-50 outline-none ${availableQuantity <= 0 ? 'bg-gray-100 border-gray-200 cursor-not-allowed' : 'border-gray-400'}`} placeholder="0" disabled={availableQuantity <= 0} />
                                                                        </div>
                                                                    </td>
                                                                    <td className="p-2 text-right font-black text-gray-500">₹{netRate.toFixed(2)}</td>
                                                                    <td className="p-2 text-right font-black text-red-600 bg-gray-50/50">₹{((item.returnQuantity || 0) * netRate).toFixed(2)}</td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}
                                </Card>
                            </div>

                            <div className="lg:col-span-1 space-y-6">
                                <Card className="p-6 bg-primary text-white tally-border !rounded-none shadow-xl">
                                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] mb-4 opacity-70">Accounting Summary</h3>
                                    <div className="space-y-4 font-bold text-xs">
                                        <div className="flex justify-between border-b border-white/10 pb-2">
                                            <span>Impacted Items</span>
                                            <span>{returnItems.filter(item => (item.returnQuantity || 0) > 0).length}</span>
                                        </div>
                                        <div className="pt-2">
                                            <span className="text-[9px] uppercase tracking-widest opacity-70 block mb-1">Refund / Adjustment Total</span>
                                            <span className="text-4xl font-black tracking-tighter text-accent">₹{totalReturnRefundValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                                        </div>
                                    </div>
                                </Card>

                                {selectedInvoice && (
                                    <Card className="p-6 tally-border bg-white !rounded-none shadow-md space-y-4">
                                        <div>
                                            <label className="text-[10px] font-black text-gray-500 uppercase block mb-1 tracking-widest ml-1">Voucher Narration</label>
                                            <input type="text" value={returnReason} onChange={e => setReturnReason(e.target.value)} placeholder="e.g. Broken strips returned..." className="w-full p-2 border-2 border-gray-400 text-sm font-bold uppercase focus:bg-yellow-50 outline-none shadow-inner" />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-black text-gray-500 uppercase block mb-1 tracking-widest ml-1">Voucher Date</label>
                                            <input type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} className="w-full p-2 border border-gray-400 p-2 text-sm font-bold focus:bg-yellow-50 outline-none" />
                                        </div>
                                        <button onClick={handleProcessReturn} disabled={isProcessing || totalReturnRefundValue <= 0 || !returnReason.trim()} className="w-full py-4 tally-button-primary uppercase text-[11px] font-black tracking-[0.2em] shadow-lg flex items-center justify-center gap-2">
                                            {isProcessing && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>}
                                            Accept Voucher (Ent)
                                        </button>
                                        <p className="text-[9px] text-center text-gray-400 uppercase font-bold">Stock will be auto-incremented</p>
                                    </Card>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <PrintReturnModal
                isOpen={!!printVoucher}
                onClose={() => setPrintVoucher(null)}
                returnVoucher={printVoucher}
                type={activeTab}
                pharmacy={currentUser}
            />
        </main>
    );
});

export default Returns;
