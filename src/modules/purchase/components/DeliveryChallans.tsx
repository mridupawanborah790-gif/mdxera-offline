import React, { useState, useMemo } from 'react';
import Card from '@core/components/ui/Card';
// Fix: Corrected named import for PurchaseForm to default import
import PurchaseForm from '../components/PurchaseForm';
import ChallanDetailModal from '@modules/suppliers/components/ChallanDetailModal';
import type { DeliveryChallan, PurchaseItem, InventoryItem, Distributor, Medicine, RegisteredPharmacy, AppConfigurations, SupplierProductMap, Purchase } from '@core/types';
import { DeliveryChallanStatus } from '@core/types';
// Fixed: Corrected import from services/storageService
import { reserveVoucherNumber } from '@core/services/storageService';
import type { SupplierQuickResult } from '@core/services/supplierService';

interface DeliveryChallansPageProps {
    deliveryChallans: DeliveryChallan[];
    inventory: InventoryItem[];
    distributors: Distributor[];
    medicines?: Medicine[];
    currentUser: RegisteredPharmacy | null;
    configurations: AppConfigurations;
    onAddChallan: (challan: DeliveryChallan) => Promise<void>;
    onUpdateChallan: (challan: DeliveryChallan) => Promise<void>;
    onCancelChallan: (id: string) => Promise<void>;
    onConvertToPurchase: (mergedItems: PurchaseItem[], supplier: string, challanIds: string[]) => void;
    onAddInventoryItem: (item: Omit<InventoryItem, 'id'>) => Promise<InventoryItem>;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    onAddDistributor: (data: Omit<Distributor, 'id' | 'ledger' | 'organization_id'>, balance: number, date: string) => Promise<SupplierQuickResult>;
    onSaveMapping: (map: Partial<SupplierProductMap>) => Promise<void>;
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    // Added required mappings prop
    mappings: SupplierProductMap[];
}

const DeliveryChallansPage = React.forwardRef<any, DeliveryChallansPageProps>(({
    deliveryChallans,
    inventory,
    distributors,
    medicines,
    currentUser,
    configurations,
    onAddChallan,
    onUpdateChallan,
    onCancelChallan,
    onConvertToPurchase,
    onAddInventoryItem,
    onAddMedicineMaster,
    onAddDistributor,
    onSaveMapping,
    addNotification,
    mappings,
}, ref) => {
    const [activeTab, setActiveTab] = useState<'create' | 'list'>('list');
    const [selectedChallanIds, setSelectedChallanIds] = useState<Set<string>>(new Set());
    const [filterStatus, setFilterStatus] = useState<'active_only' | 'all' | DeliveryChallanStatus>('active_only');
    const [filterSupplier, setFilterSupplier] = useState<string>('all');
    const [startDate, setStartDate] = useState<string>('');
    const [endDate, setEndDate] = useState<string>('');

    const [challanToEdit, setChallanToEdit] = useState<DeliveryChallan | null>(null);
    const [selectedChallanForView, setSelectedChallanForView] = useState<DeliveryChallan | null>(null);

    const purchaseFormRef = React.useRef<any>(null);

    React.useImperativeHandle(ref, () => ({
        handleSubmit: () => purchaseFormRef.current?.handleSubmit?.(),
        resetForm: () => {
            setActiveTab('create');
            purchaseFormRef.current?.resetForm?.();
        },
        get isDirty() {
            return activeTab === 'create' && (purchaseFormRef.current?.isDirty ?? false);
        }
    }), [activeTab]);

    const visibleChallans = useMemo(() => {
        let list = [...deliveryChallans];
        if (filterStatus === 'active_only') {
            list = list.filter(c => c.status === DeliveryChallanStatus.OPEN);
        } else if (filterStatus !== 'all') {
            list = list.filter(c => c.status === filterStatus);
        }
        if (filterSupplier !== 'all') {
            list = list.filter(c => c.supplier === filterSupplier);
        }
        if (startDate) {
            const start = new Date(startDate); start.setHours(0, 0, 0, 0);
            list = list.filter(c => new Date(c.date) >= start);
        }
        if (endDate) {
            const end = new Date(endDate); end.setHours(23, 59, 59, 999);
            list = list.filter(c => new Date(c.date) <= end);
        }
        return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [deliveryChallans, filterStatus, filterSupplier, startDate, endDate]);

    const uniqueSuppliers = useMemo(() => {
        const suppliers = new Set(deliveryChallans.map(c => c.supplier));
        return Array.from(suppliers).sort();
    }, [deliveryChallans]);

    const handleSelectChallan = (challan: DeliveryChallan) => {
        if (challan.status !== DeliveryChallanStatus.OPEN) return;
        setSelectedChallanIds(prev => {
            const next = new Set(prev);
            if (next.has(challan.id)) next.delete(challan.id);
            else next.add(challan.id);
            return next;
        });
    };

    const handleMergeSelected = () => {
        const selected = deliveryChallans.filter(c => selectedChallanIds.has(c.id));
        if (selected.length === 0) return;
        const suppliers = new Set(selected.map(c => c.supplier));
        if (suppliers.size > 1) {
            addNotification("Please select challans from the same supplier to merge.", "error");
            return;
        }
        const itemMap = new Map<string, PurchaseItem>();
        selected.forEach(challan => {
            (challan.items || []).forEach(item => {
                const key = `${item.name.toLowerCase()}|${(item.batch || '').toLowerCase()}`;
                if (itemMap.has(key)) {
                    const existing = itemMap.get(key)!;
                    existing.quantity += item.quantity;
                    existing.looseQuantity += (item.looseQuantity || 0);
                    existing.freeQuantity += (item.freeQuantity || 0);
                } else {
                    itemMap.set(key, { ...item, id: crypto.randomUUID() });
                }
            });
        });
        onConvertToPurchase(Array.from(itemMap.values()), selected[0].supplier, Array.from(selectedChallanIds));
    };

    const handleChallanSave = async (purchaseData: any) => {
        if (challanToEdit) {
            const updatedChallan: DeliveryChallan = {
                ...challanToEdit,
                supplier: purchaseData.supplier,
                challanNumber: purchaseData.invoiceNumber,
                date: purchaseData.date,
                items: purchaseData.items,
                subtotal: purchaseData.subtotal,
                totalGst: purchaseData.totalGst,
                totalAmount: purchaseData.totalAmount,
            };
            await onUpdateChallan(updatedChallan);
            setChallanToEdit(null);
            setActiveTab('list');
            addNotification(`Challan ${updatedChallan.challanSerialId} updated.`, "success");
            return;
        }

        if (!currentUser) {
            addNotification('User context missing for voucher number generation.', 'error');
            return;
        }
        const serialId = purchaseData.purchaseSerialId;
        const challan: DeliveryChallan = {
            id: crypto.randomUUID(),
            organization_id: currentUser?.organization_id || '',
            challanSerialId: serialId,
            supplier: purchaseData.supplier,
            challanNumber: purchaseData.invoiceNumber,
            date: purchaseData.date,
            items: purchaseData.items,
            subtotal: purchaseData.subtotal,
            totalGst: purchaseData.totalGst,
            totalAmount: purchaseData.totalAmount,
            status: DeliveryChallanStatus.OPEN
        };

        await onAddChallan(challan);
        addNotification(`Delivery Challan ${serialId} recorded.`, "success");
        setActiveTab('list');
    };

    const handleEditClick = (challan: DeliveryChallan) => {
        setChallanToEdit(challan);
        setActiveTab('create');
    };

    const getStatusBadge = (status: DeliveryChallanStatus) => {
        switch (status) {
            case DeliveryChallanStatus.OPEN:
                return <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-blue-100 text-blue-700 uppercase border border-blue-200">Pending</span>;
            case DeliveryChallanStatus.CONVERTED:
                return <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-700 uppercase border border-emerald-200">Completed</span>;
            case DeliveryChallanStatus.CANCELLED:
                return <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-red-100 text-red-700 uppercase border border-red-200">Cancelled</span>;
            default: return null;
        }
    };

    const challanAsPurchase = useMemo(() => {
        if (!challanToEdit) return null;
        return {
            id: challanToEdit.id,
            purchaseSerialId: challanToEdit.challanSerialId,
            supplier: challanToEdit.supplier,
            invoiceNumber: challanToEdit.challanNumber,
            date: challanToEdit.date,
            items: challanToEdit.items || [],
            totalAmount: challanToEdit.totalAmount,
            subtotal: challanToEdit.subtotal,
            totalGst: challanToEdit.totalGst,
            status: 'completed' as const,
        } as Purchase;
    }, [challanToEdit]);

    return (
        <main className="h-full overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Delivery Challan Register (Inward)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Items: {visibleChallans.length}</span>
            </div>

            <div className="p-4 flex-1 flex flex-col gap-4 overflow-hidden">
                <div className="flex justify-between items-center px-2">
                    <div className="flex items-center space-x-2 bg-white p-1 border border-app-border shadow-sm">
                        <button onClick={() => { setActiveTab('list'); setChallanToEdit(null); }} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'list' ? 'bg-primary text-white' : 'text-gray-400 hover:bg-hover'}`}>List View</button>
                        <button onClick={() => { setActiveTab('create'); setChallanToEdit(null); }} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'create' ? 'bg-primary text-white' : 'text-gray-400 hover:bg-hover'}`}>New Challan</button>
                    </div>
                    {selectedChallanIds.size > 0 && (
                        <button onClick={handleMergeSelected} className="px-6 py-2 bg-emerald-600 text-white font-black text-xs uppercase tracking-widest shadow-lg transform active:scale-95">Push to Purchase Bill</button>
                    )}
                </div>

                {activeTab === 'create' ? (
                    <div className="flex-1 min-h-0">
                        <PurchaseForm
                            ref={purchaseFormRef}
                            onAddPurchase={handleChallanSave}
                            onUpdatePurchase={handleChallanSave}
                            onAddInventoryItem={onAddInventoryItem}
                            onAddMedicineMaster={onAddMedicineMaster}
                            onAddsupplier={onAddDistributor}
                            onSaveMapping={onSaveMapping}
                            addNotification={addNotification}
                            inventory={inventory}
                            suppliers={distributors}
                            medicines={medicines}
                            // Pass the required mappings prop
                            mappings={mappings}
                            purchases={[]}
                            sourcePO={null}
                            purchaseToEdit={challanAsPurchase}
                            draftItems={null}
                            onClearDraft={() => { }}
                            currentUser={currentUser}
                            configurations={configurations}
                            config={configurations.modules?.['purchase']}
                            setIsDirty={() => { }}
                            title={challanToEdit ? "Alter Delivery Challan" : "Create Delivery Challan"}
                            isChallan={true}
                            disableAIInput={true}
                            className="h-full !p-0 border-0 bg-transparent"
                            onCancel={() => { setActiveTab('list'); setChallanToEdit(null); }}
                            mobileSyncSessionId={null} setMobileSyncSessionId={() => { }}
                            /* Fix: Pass missing organizationId prop to PurchaseForm */
                            organizationId={currentUser?.organization_id || ''}
                        />
                    </div>
                ) : (
                    <div className="flex-1 flex flex-col min-h-0">
                        <Card className="flex-1 p-0 overflow-hidden tally-border shadow-md bg-white">
                            <div className="overflow-auto h-full">
                                <table className="min-w-full border-collapse text-sm">
                                    <thead className="bg-gray-100 sticky top-0 z-10 border-b border-gray-400">
                                        <tr className="text-[10px] font-black uppercase text-gray-600">
                                            <th className="p-2 border-r border-gray-400 w-10 text-center">Sel.</th>
                                            <th className="p-2 border-r border-gray-400 text-left">Challan ID</th>
                                            <th className="p-2 border-r border-gray-400 text-left">Date</th>
                                            <th className="p-2 border-r border-gray-400 text-left">Supplier</th>
                                            <th className="p-2 border-r border-gray-400 text-left">Ref No.</th>
                                            <th className="p-2 border-r border-gray-400 text-right">Amount</th>
                                            <th className="p-2 border-r border-gray-400 text-center">Status</th>
                                            <th className="p-2 text-right">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-200">
                                        {visibleChallans.map(c => {
                                            const isSelectable = c.status === DeliveryChallanStatus.OPEN;
                                            const isSelected = selectedChallanIds.has(c.id);
                                            return (
                                                <tr 
                                                    key={c.id} 
                                                    className={`transition-colors cursor-pointer hover:bg-primary hover:text-white group ${!isSelectable && !isSelected ? 'bg-gray-50/50' : ''} ${isSelected ? 'bg-primary text-white shadow-md' : ''}`} 
                                                    onClick={() => handleSelectChallan(c)}
                                                >
                                                    <td className={`p-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white'}`} onClick={e => e.stopPropagation()}>
                                                        <input type="checkbox" disabled={!isSelectable} checked={isSelected} onChange={() => handleSelectChallan(c)} className="w-4 h-4 text-primary" />
                                                    </td>
                                                    <td className={`p-2 border-r border-gray-200 font-mono font-bold ${isSelected ? 'text-white' : 'text-primary group-hover:text-white'}`}>{c.challanSerialId}</td>
                                                    <td className={`p-2 border-r border-gray-200 ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{new Date(c.date).toLocaleDateString('en-IN')}</td>
                                                    <td className={`p-2 border-r border-gray-200 font-black uppercase ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{c.supplier}</td>
                                                    <td className={`p-2 border-r border-gray-200 font-mono text-[10px] ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{c.challanNumber}</td>
                                                    <td className={`p-2 border-r border-gray-200 text-right font-black ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>₹{c.totalAmount.toFixed(2)}</td>
                                                    <td className={`p-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{getStatusBadge(c.status)}</td>
                                                    <td className="p-2 text-right">
                                                        <div className="flex justify-end gap-2" onClick={e => e.stopPropagation()}>
                                                            <button onClick={() => setSelectedChallanForView(c)} className={`font-black uppercase text-[10px] hover:underline ${isSelected ? 'text-white' : 'text-primary group-hover:text-white'}`}>View</button>
                                                            {isSelectable && <button onClick={() => handleEditClick(c)} className={`font-black uppercase text-[10px] hover:underline ${isSelected ? 'text-white' : 'text-blue-700 group-hover:text-white'}`}>Alter</button>}
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                    </div>
                )}
            </div>
            {selectedChallanForView && <ChallanDetailModal isOpen={!!selectedChallanForView} onClose={() => setSelectedChallanForView(null)} challan={selectedChallanForView} />}
        </main>
    );
});

export default DeliveryChallansPage;
