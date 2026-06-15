
import React, { useState, useMemo } from 'react';
import Card from '@core/components/ui/Card';
import POS from '@modules/pos/components/POS';
import Modal from '@core/components/ui/Modal';
import { SalesChallan, BillItem, InventoryItem, Customer, RegisteredPharmacy, AppConfigurations, SalesChallanStatus, Medicine, Purchase } from '@core/types';
// Fix: Verified storage service exports include updateSalesChallanStatus and updateChallanStatus
import { reserveVoucherNumber, updateSalesChallanStatus, updateChallanStatus } from '@core/services/storageService';
import { evaluateCustomerCredit, getCustomerOpenChallanExposure } from '@core/utils/creditControl';

interface SalesChallansProps {
    salesChallans: SalesChallan[];
    inventory: InventoryItem[];
    medicines: Medicine[]; // Added medicines prop
    // Add missing purchases prop
    purchases: Purchase[];
    customers: Customer[];
    currentUser: RegisteredPharmacy | null;
    configurations: AppConfigurations;
    onAddChallan: (challan: SalesChallan) => Promise<void>;
    onUpdateChallan: (challan: SalesChallan) => Promise<void>;
    onCancelChallan: (id: string) => Promise<void>;
    onConvertToInvoice: (items: BillItem[], customer: Customer, challanIds: string[]) => void;
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
}

const SalesChallans = React.forwardRef<any, SalesChallansProps>(({
    salesChallans, inventory, medicines, purchases, customers, currentUser, configurations,
    onAddChallan, onUpdateChallan, onCancelChallan, onConvertToInvoice, addNotification, onAddMedicineMaster
}, ref) => {
    const [activeTab, setActiveTab] = useState<'create' | 'list'>('list');
    const [selectedChallanIds, setSelectedChallanIds] = useState<Set<string>>(new Set());
    const [filterStatus, setFilterStatus] = useState<SalesChallanStatus | 'all'>(SalesChallanStatus.OPEN);
    const [selectedChallanForView, setSelectedChallanForView] = useState<SalesChallan | null>(null);

    const posRef = React.useRef<any>(null);

    React.useImperativeHandle(ref, () => ({
        handleSubmit: () => posRef.current?.handleSave?.(),
        resetForm: () => {
            setActiveTab('create');
            posRef.current?.resetForm?.();
        },
        get isDirty() {
            return activeTab === 'create' && (posRef.current?.isDirty ?? false);
        }
    }), [activeTab]);

    const visibleChallans = useMemo(() => {
        let list = [...salesChallans];
        if (filterStatus !== 'all') {
            list = list.filter(c => c.status === filterStatus);
        }
        return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [salesChallans, filterStatus]);

    const handleSelectChallan = (challan: SalesChallan) => {
        if (challan.status !== SalesChallanStatus.OPEN) return;
        setSelectedChallanIds(prev => {
            const next = new Set(prev);
            if (next.has(challan.id)) next.delete(challan.id);
            else next.add(challan.id);
            return next;
        });
    };

    const handleMergeToPOS = () => {
        const selected = salesChallans.filter(c => selectedChallanIds.has(c.id));
        if (selected.length === 0) return;
        const customerNames = new Set(selected.map(c => c.customerName));
        if (customerNames.size > 1) {
            addNotification("Please select challans for the same customer to merge.", "error");
            return;
        }
        const items: BillItem[] = [];
        selected.forEach(c => items.push(...c.items));
        const customer = customers.find(cust => cust.name === selected[0].customerName || cust.id === selected[0].customerId);
        if (!customer) {
            addNotification("Customer record not found for these challans.", "error");
            return;
        }
        onConvertToInvoice(items, customer, Array.from(selectedChallanIds));
    };

    const handleChallanSave = async (tx: any) => {
        if (!currentUser) {
            addNotification('User context missing for voucher number generation.', 'error');
            return;
        }
        const selectedCustomer = customers.find(c => c.id === tx.customerId) || customers.find(c => (c.name || '').trim().toLowerCase() === (tx.customerName || '').trim().toLowerCase()) || null;
        const openChallanExposure = getCustomerOpenChallanExposure(salesChallans, selectedCustomer?.id);
        const creditCheck = evaluateCustomerCredit({
            customer: selectedCustomer,
            currentTransactionAmount: Number(tx.total || 0),
            openChallanExposure,
            moduleName: 'Sales Challan'
        });

        if (creditCheck && !creditCheck.canProceed) {
            const formatted = `Credit Limit ₹${creditCheck.details.creditLimit.toFixed(2)} | Outstanding ₹${creditCheck.details.currentOutstanding.toFixed(2)} | Open Challan ₹${creditCheck.details.openChallanExposure.toFixed(2)} | Challan ₹${creditCheck.details.currentTransactionAmount.toFixed(2)} | Projected ₹${creditCheck.details.projectedExposure.toFixed(2)}`;
            if (creditCheck.mode === 'warning_only') {
                const proceed = window.confirm(`${creditCheck.message}

${formatted}

Do you want to continue?`);
                if (!proceed) return;
            } else {
                addNotification(`${creditCheck.message} ${formatted}`, 'error');
                return;
            }
        }

        const serialId = tx.invoiceNumber;
        const challan: SalesChallan = {
            id: crypto.randomUUID(),
            organization_id: currentUser?.organization_id || '',
            challanSerialId: serialId,
            customerName: tx.customerName,
            customerId: tx.customerId,
            customerPhone: tx.customerPhone,
            customerAddress: tx.customerAddress,
            referredBy: tx.referredBy,
            date: tx.date,
            items: tx.items,
            totalAmount: tx.total,
            subtotal: tx.subtotal,
            totalGst: tx.totalGst,
            status: SalesChallanStatus.OPEN,
            narration: tx.narration,
            billCategory: tx.paymentMode
        };

        await onAddChallan(challan);
        addNotification(`Sales Challan ${serialId} recorded.`, "success");
        setActiveTab('list');
    };

    const getStatusBadge = (status: SalesChallanStatus) => {
        switch (status) {
            case SalesChallanStatus.OPEN:
                return <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-blue-100 text-blue-700 uppercase border border-blue-200">Pending</span>;
            case SalesChallanStatus.CONVERTED:
                return <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-700 uppercase border border-emerald-200">Billed</span>;
            case SalesChallanStatus.CANCELLED:
                return <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-red-100 text-red-700 uppercase border border-red-200">Cancelled</span>;
            default: return null;
        }
    };

    return (
        <main className="h-full overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Sales Challan (Delivery Note)</span>
                <span className="text-[10px] font-black uppercase text-accent">Entries: {visibleChallans.length}</span>
            </div>

            <div className="p-4 flex-1 flex flex-col gap-4 overflow-hidden">
                <div className="flex justify-between items-center px-2">
                    <div className="flex items-center space-x-2 bg-white p-1 border border-app-border shadow-sm">
                        <button onClick={() => { setActiveTab('list'); setSelectedChallanForView(null); }} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'list' ? 'bg-primary text-white' : 'text-gray-400 hover:bg-hover'}`}>History</button>
                        <button onClick={() => { setActiveTab('create'); setSelectedChallanForView(null); }} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'create' ? 'bg-primary text-white' : 'text-gray-400 hover:bg-hover'}`}>New Note</button>
                    </div>
                    {selectedChallanIds.size > 0 && (
                        <button onClick={handleMergeToPOS} className="px-6 py-2 bg-emerald-600 text-white font-black text-xs uppercase tracking-widest shadow-lg transform active:scale-95">Convert {selectedChallanIds.size} to Sales Bill</button>
                    )}
                </div>

                {activeTab === 'create' ? (
                    <div className="flex-1 overflow-hidden">
                        <POS 
                            ref={posRef}
                            inventory={inventory}
                            /* Fix: Pass missing purchases prop to POS component */
                            purchases={purchases}
                            medicines={medicines}
                            customers={customers}
                            onSaveOrUpdateTransaction={handleChallanSave}
                            onPrintBill={() => {}}
                            currentUser={currentUser}
                            config={configurations.modules?.['pos']}
                            configurations={configurations}
                            billType="regular"
                            addNotification={addNotification}
                            onAddMedicineMaster={onAddMedicineMaster}
                            onCancel={() => setActiveTab('list')}
                            salesChallans={salesChallans}
                            isChallan={true}
                        />
                    </div>
                ) : (
                    <Card className="flex-1 p-0 overflow-hidden tally-border shadow-md bg-white">
                        <div className="p-3 border-b border-gray-400 bg-gray-50 flex gap-4">
                            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)} className="text-[10px] font-black uppercase border border-gray-400 p-1.5 focus:bg-yellow-50 outline-none shadow-sm">
                                <option value="all">All Status</option>
                                <option value={SalesChallanStatus.OPEN}>Pending Only</option>
                                <option value={SalesChallanStatus.CONVERTED}>Invoiced Only</option>
                            </select>
                        </div>
                        <div className="overflow-auto h-full pb-20">
                            <table className="min-w-full border-collapse text-sm">
                                <thead className="bg-gray-100 sticky top-0 z-10 border-b border-gray-400">
                                    <tr className="text-[10px] font-black uppercase text-gray-600">
                                        <th className="p-2 border-r border-gray-400 w-10 text-center">Sel.</th>
                                        <th className="p-2 border-r border-gray-400 text-left">Challan ID</th>
                                        <th className="p-2 border-r border-gray-400 text-left">Date</th>
                                        <th className="p-2 border-r border-gray-400 text-left">Customer</th>
                                        <th className="p-2 border-r border-gray-400 text-right">Items</th>
                                        <th className="p-2 border-r border-gray-400 text-right">Amount</th>
                                        <th className="p-2 border-r border-gray-400 text-center">Status</th>
                                        <th className="p-2 text-right">Action</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200">
                                    {visibleChallans.map(c => {
                                        const isSelected = selectedChallanIds.has(c.id);
                                        return (
                                            <tr 
                                                key={c.id} 
                                                className={`transition-colors cursor-pointer hover:bg-primary hover:text-white group ${isSelected ? 'bg-primary text-white shadow-md' : ''}`} 
                                                onClick={() => handleSelectChallan(c)}
                                            >
                                                <td className={`p-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white'}`} onClick={e => e.stopPropagation()}>
                                                    <input type="checkbox" disabled={c.status !== SalesChallanStatus.OPEN} checked={isSelected} onChange={() => handleSelectChallan(c)} className="w-4 h-4 text-primary" />
                                                </td>
                                                <td className={`p-2 border-r border-gray-200 font-mono font-bold ${isSelected ? 'text-white' : 'text-primary group-hover:text-white'}`}>{c.challanSerialId}</td>
                                                <td className={`p-2 border-r border-gray-200 ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{new Date(c.date).toLocaleDateString('en-GB')}</td>
                                                <td className={`p-2 border-r border-gray-200 font-black uppercase ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{c.customerName}</td>
                                                <td className={`p-2 border-r border-gray-200 text-center font-bold ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{c.items.length}</td>
                                                <td className={`p-2 border-r border-gray-200 text-right font-black ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>₹{c.totalAmount.toFixed(2)}</td>
                                                <td className={`p-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{getStatusBadge(c.status)}</td>
                                                <td className="p-2 text-right">
                                                    <button onClick={() => setSelectedChallanForView(c)} className={`font-black uppercase text-[10px] hover:underline ${isSelected ? 'text-white' : 'text-primary group-hover:text-white'}`}>View</button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                )}
            </div>
            {selectedChallanForView && (
                <Modal isOpen={!!selectedChallanForView} onClose={() => setSelectedChallanForView(null)} title={`Sales Note Review: ${selectedChallanForView.challanSerialId}`} widthClass="max-w-4xl">
                    <div className="p-6">
                        <div className="mb-6 grid grid-cols-2 gap-4 text-sm font-bold uppercase">
                            <div className="bg-gray-50 p-3 border">
                                <p className="text-[10px] text-gray-400">Ledger Account</p>
                                <p>{selectedChallanForView.customerName}</p>
                            </div>
                            <div className="bg-gray-50 p-3 border">
                                <p className="text-[10px] text-gray-400">Assessment Value</p>
                                <p className="text-primary font-black text-lg">₹{selectedChallanForView.totalAmount.toFixed(2)}</p>
                            </div>
                        </div>
                        <table className="min-w-full text-xs erp-table border-collapse">
                            <thead className="bg-gray-100 border-b-2 border-black">
                                <tr className="uppercase font-black text-[9px] text-gray-500">
                                    <th className="p-2 text-left">Description</th>
                                    <th className="p-2 text-center w-24">Batch</th>
                                    <th className="p-2 text-center w-20">Qty</th>
                                    <th className="p-2 text-right w-32">Line Val</th>
                                </tr>
                            </thead>
                            <tbody>
                                {selectedChallanForView.items.map((item, idx) => (
                                    <tr key={idx} className="border-b">
                                        <td className="p-2 font-black uppercase">{item.name}</td>
                                        <td className="p-2 text-center font-mono">{item.batch}</td>
                                        <td className="p-2 text-center font-black">{item.quantity}</td>
                                        <td className="p-2 text-right font-black">₹{((item.rate || item.mrp) * item.quantity).toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <div className="mt-8 flex justify-end">
                            <button onClick={() => setSelectedChallanForView(null)} className="px-12 py-3 tally-button-primary uppercase text-[11px] font-black tracking-widest shadow-xl">Close Preview</button>
                        </div>
                    </div>
                </Modal>
            )}
        </main>
    );
});

export default SalesChallans;
