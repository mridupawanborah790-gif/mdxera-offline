import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import PurchaseForm from '../components/PurchaseForm';
import type {
    Purchase,
    Distributor,
    InventoryItem,
    RegisteredPharmacy,
    Medicine,
    DistributorProductMap,
    PurchaseReturn,
    Supplier,
    SupplierProductMap,
    AppConfigurations,
} from '@core/types';
import type { SupplierQuickResult } from '@core/services/supplierService';
import { downloadCsv, arrayToCsvRow } from '@core/utils/csv';
import ConfirmModal from '@core/components/ui/ConfirmModal';
import JournalEntryViewerModal from '@modules/accounting/components/JournalEntryViewerModal';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';
import { formatVoucherNo } from '@core/utils/helpers';

type PurchaseSortableKeys = 'purchaseSerialId' | 'invoiceNumber' | 'date' | 'supplier' | 'totalAmount' | 'status' | 'itemCount';

const SortIcon = ({ sortKey, sortConfig }: { sortKey: PurchaseSortableKeys; sortConfig: { key: PurchaseSortableKeys; direction: 'ascending' | 'descending' } }) => {
    if (sortConfig.key !== sortKey) return <span className="text-gray-400 opacity-30 ml-1">↕</span>;
    return <span className="text-primary ml-1">{sortConfig.direction === 'ascending' ? '▲' : '▼'}</span>;
};

interface PurchaseHistoryProps {
    purchases: Purchase[];
    distributors: Distributor[];
    onViewDetails: (purchase: Purchase) => void;
    onCancelPurchase: (purchaseId: string) => void;
    onEditPurchase?: (purchase: Purchase) => void;
    onCopyPurchase?: (purchase: Purchase) => void;
    onCreateReturn?: (purchase: Purchase) => void;
    inventory: InventoryItem[];
    medicines: Medicine[];
    onUpdatePurchase: (purchase: Purchase, supplierGst?: string) => Promise<void>;
    onAddInventoryItem: (item: Omit<InventoryItem, 'id'>) => Promise<InventoryItem>;
    currentUser: RegisteredPharmacy | null;
    onSaveMapping: (map: DistributorProductMap) => Promise<void>;
    purchaseReturns?: PurchaseReturn[];
    onRefresh?: () => Promise<void>;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    onPrintPurchase?: (purchase: Purchase) => void;
    configurations: AppConfigurations;
    onCreateNew?: () => void;
}

const RefreshIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
);

const ITEMS_PER_PAGE = 15;


const extractSystemIdSequence = (systemId?: string | null): number => {
    if (!systemId) return Number.NEGATIVE_INFINITY;

    const firstSegment = systemId.split('-')[0] || '';
    const segmentMatch = firstSegment.match(/(\d+)(?!.*\d)/);
    if (segmentMatch) return Number.parseInt(segmentMatch[1], 10);

    const fallbackMatch = systemId.match(/(\d+)(?!.*\d)/);
    if (fallbackMatch) return Number.parseInt(fallbackMatch[1], 10);

    return Number.NEGATIVE_INFINITY;
};

const PurchaseHistory: React.FC<PurchaseHistoryProps> = ({
    purchases,
    distributors,
    onViewDetails,
    onCancelPurchase,
    currentUser,
    onEditPurchase,
    onCopyPurchase,
    onCreateReturn,
    purchaseReturns,
    onRefresh,
    inventory,
    medicines,
    onAddMedicineMaster,
    onPrintPurchase,
    configurations,
    onSaveMapping,
    onUpdatePurchase,
    onCreateNew,
}) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [distributorFilter, setDistributorFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'cancelled' | 'hold'>('all');
    const [sortConfig, setSortConfig] = useState<{ key: PurchaseSortableKeys; direction: 'ascending' | 'descending' }>({ key: 'purchaseSerialId', direction: 'descending' });
    const [currentPage, setCurrentPage] = useState(1);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [purchaseToCancel, setPurchaseToCancel] = useState<string | null>(null);
    const [journalPurchase, setJournalPurchase] = useState<Purchase | null>(null);
    const [selectedPurchaseId, setSelectedPurchaseId] = useState<string | null>(null);
    const [actionWarning, setActionWarning] = useState('');
    const [isSyncing, setIsSyncing] = useState(false);
    const [viewingPurchase, setViewingPurchase] = useState<Purchase | null>(null);

    const requestSort = (key: PurchaseSortableKeys) => {
        let direction: 'ascending' | 'descending' = 'ascending';
        if (sortConfig.key === key && sortConfig.direction === 'ascending') {
            direction = 'descending';
        }
        setSortConfig({ key, direction });
    };

    const filteredAndSortedPurchases = useMemo(() => {
        let filtered = (purchases || []).filter(Boolean);

        if (startDate) {
            const start = new Date(startDate); start.setHours(0, 0, 0, 0);
            filtered = filtered.filter(p => new Date(p.date) >= start);
        }
        if (endDate) {
            const end = new Date(endDate); end.setHours(23, 59, 59, 999);
            filtered = filtered.filter(p => new Date(p.date) <= end);
        }
        if (distributorFilter !== 'all') filtered = filtered.filter(p => p.supplier === distributorFilter);
        if (statusFilter !== 'all') filtered = filtered.filter(p => (p.status as string) === statusFilter);

        if (searchTerm) {
            const lowercasedFilter = searchTerm.toLowerCase();
            filtered = filtered.filter(p =>
                (p.purchaseSerialId || '').toLowerCase().includes(lowercasedFilter) ||
                (p.invoiceNumber || '').toLowerCase().includes(lowercasedFilter) ||
                (p.supplier || '').toLowerCase().includes(lowercasedFilter)
            );
        }

        return filtered.sort((a, b) => {
            let comparison = 0;
            switch (sortConfig.key) {
                case 'purchaseSerialId':
                    comparison = extractSystemIdSequence(a.purchaseSerialId) - extractSystemIdSequence(b.purchaseSerialId);
                    if (comparison === 0) {
                        comparison = (a.purchaseSerialId || '').localeCompare(b.purchaseSerialId || '', undefined, { numeric: true });
                    }
                    break;
                case 'invoiceNumber':
                    comparison = (a.invoiceNumber || '').localeCompare(b.invoiceNumber || '', undefined, { numeric: true });
                    break;
                case 'date':
                    comparison = new Date(a.date).getTime() - new Date(b.date).getTime();
                    break;
                case 'supplier':
                    comparison = (a.supplier || '').localeCompare(b.supplier || '');
                    break;
                case 'totalAmount':
                    comparison = (a.totalAmount || 0) - (b.totalAmount || 0);
                    break;
                case 'status':
                    comparison = (a.status || '').localeCompare(b.status || '');
                    break;
                case 'itemCount':
                    comparison = (a.items?.length || 0) - (b.items?.length || 0);
                    break;
                default:
                    comparison = 0;
            }

            if (comparison !== 0) {
                return sortConfig.direction === 'ascending' ? comparison : -comparison;
            }

            // Fallback for stable sort: System ID descending
            const bSeq = extractSystemIdSequence(b.purchaseSerialId);
            const aSeq = extractSystemIdSequence(a.purchaseSerialId);
            if (bSeq !== aSeq) return bSeq - aSeq;
            return (b.purchaseSerialId || '').localeCompare(a.purchaseSerialId || '', undefined, { numeric: true });
        });
    }, [purchases, searchTerm, startDate, endDate, distributorFilter, statusFilter, sortConfig]);

    const totalPages = Math.ceil(filteredAndSortedPurchases.length / ITEMS_PER_PAGE);

    const paginatedPurchases = useMemo(() => {
        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        return filteredAndSortedPurchases.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    }, [filteredAndSortedPurchases, currentPage]);

    const selectedPurchase = useMemo(
        () => filteredAndSortedPurchases.find(p => p.id === selectedPurchaseId) || null,
        [filteredAndSortedPurchases, selectedPurchaseId]
    );

    useEffect(() => {
        if (selectedPurchaseId && !selectedPurchase) {
            setSelectedPurchaseId(null);
        }
    }, [selectedPurchaseId, selectedPurchase]);

    const requireSelectedPurchase = useCallback(() => {
        if (!selectedPurchase) {
            setActionWarning('Please select a Bill first.');
            return null;
        }
        setActionWarning('');
        return selectedPurchase;
    }, [selectedPurchase]);

    const handleSelectRow = (purchaseId: string) => {
        setSelectedPurchaseId(purchaseId);
        setActionWarning('');
    };

    const handleViewSelected = useCallback(() => {
        const purchase = requireSelectedPurchase();
        if (!purchase) return;
        setViewingPurchase(purchase);
    }, [requireSelectedPurchase]);

    const checkLinkedPayments = useCallback((purchase: Purchase) => {
        const distributor = distributors.find(d => 
            (d.name || '').trim().toLowerCase() === (purchase.supplier || '').trim().toLowerCase()
        );
        
        if (!distributor || !Array.isArray(distributor.ledger)) return false;

        // Check if there are any non-cancelled payment entries linked to this purchase invoice
        return distributor.ledger.some(entry => 
            entry.type === 'payment' && 
            entry.status !== 'cancelled' &&
            (entry.referenceInvoiceId === purchase.id || entry.referenceInvoiceNumber === purchase.invoiceNumber) &&
            ['invoice_payment', 'invoice_payment_adjustment', 'down_payment_adjustment'].includes(entry.entryCategory || '') &&
            ((entry.adjustedAmount || 0) > 0 || (entry.credit || 0) > 0)
        );
    }, [distributors]);

    const handleEditSelected = useCallback(() => {
        const purchase = requireSelectedPurchase();
        if (!purchase) return;

        // Allow editing for both completed and hold status
        const isEditable = purchase.status === 'completed' || purchase.status === 'hold' || purchase.status === 'draft';

        if (!isEditable || !onEditPurchase) {
            setActionWarning('Selected bill cannot be modified.');
            return;
        }

        if (checkLinkedPayments(purchase)) {
            setActionWarning('Cannot edit bill: A payment has been made against this purchase bill. Cancel the payment voucher first.');
            return;
        }

        setActionWarning('');
        const latestSelected = purchases.find((p) => p.id === purchase.id) || purchase;
        onEditPurchase(latestSelected);
    }, [requireSelectedPurchase, onEditPurchase, purchases, checkLinkedPayments]);

    const handleCopySelected = useCallback(() => {
        const purchase = requireSelectedPurchase();
        if (!purchase) return;
        if (purchase.status === 'cancelled') {
            setActionWarning('Cancelled bill can only be viewed or printed.');
            return;
        }

        if (!onCopyPurchase) {
            setActionWarning('Selected bill cannot be copied.');
            return;
        }

        setActionWarning('');
        const latestSelected = purchases.find((p) => p.id === purchase.id) || purchase;
        onCopyPurchase(latestSelected);
    }, [requireSelectedPurchase, onCopyPurchase, purchases]);

    const handleReturnSelected = useCallback(() => {
        const purchase = requireSelectedPurchase();
        if (!purchase) return;

        if (purchase.status !== 'completed' || !onCreateReturn) {
            setActionWarning('Selected bill is not eligible for purchase return.');
            return;
        }

        const totalReturnedQty = (purchaseReturns || [])
            .filter(ret => ret.originalPurchaseInvoiceId === purchase.purchaseSerialId)
            .flatMap(ret => ret.items || [])
            .reduce((sum, item) => sum + Number(item.returnQuantity || 0), 0);
        const totalPurchasedQty = (purchase.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);

        if (totalPurchasedQty > 0 && totalReturnedQty >= totalPurchasedQty) {
            setActionWarning('Purchase return already completed for this bill.');
            return;
        }

        setActionWarning('');
        onCreateReturn(purchase);
    }, [requireSelectedPurchase, currentUser, onCreateReturn, purchaseReturns]);

    const handleViewJournalSelected = useCallback(() => {
        const purchase = requireSelectedPurchase();
        if (!purchase) return;
        if (purchase.status === 'cancelled') {
            setActionWarning('Cancelled bill can only be viewed or printed.');
            return;
        }
        setJournalPurchase(purchase);
    }, [requireSelectedPurchase]);

    const handlePrintSelected = useCallback(() => {
        const purchase = requireSelectedPurchase();
        if (!purchase) return;
        onViewDetails(purchase);
    }, [onViewDetails, requireSelectedPurchase]);

    const selectedIsCancelled = selectedPurchase?.status === 'cancelled';

    const handleCancelClick = (id: string) => {
        setPurchaseToCancel(id);
        setIsConfirmOpen(true);
    };

    const handleCancelSelected = useCallback(() => {
        const purchase = requireSelectedPurchase();
        if (!purchase) return;

        if (purchase.status === 'draft') {
            setActionWarning('Selected bill cannot be cancelled.');
            return;
        }

        if (purchase.status === 'cancelled') {
            setActionWarning('Selected bill cannot be cancelled.');
            return;
        }

        if (checkLinkedPayments(purchase)) {
            setActionWarning('Cannot cancel bill: A payment has been made against this purchase bill. Cancel the payment voucher first.');
            return;
        }

        handleCancelClick(purchase.id);
    }, [requireSelectedPurchase, currentUser, checkLinkedPayments]);

    const handleExportSelected = useCallback(() => {
        const purchase = requireSelectedPurchase();
        if (!purchase) return;
        if (purchase.status === 'cancelled') {
            setActionWarning('Cancelled bill can only be viewed or printed.');
            return;
        }

        const headers = ['System ID', 'Supplier Bill ID', 'Date', 'Supplier', 'Items', 'Amount', 'Status'];
        const row = [
            purchase.purchaseSerialId,
            purchase.invoiceNumber,
            new Date(purchase.date).toLocaleDateString('en-IN'),
            purchase.supplier,
            String((purchase.items || []).length),
            (purchase.totalAmount || 0).toFixed(2),
            purchase.status,
        ];

        const csvContent = [arrayToCsvRow(headers), arrayToCsvRow(row)].join('\n');
        downloadCsv(`purchase-${purchase.purchaseSerialId}.csv`, csvContent);
    }, [requireSelectedPurchase]);

    const renderPageNumbers = () => {
        const delta = 2;
        const range = [];
        const rangeWithDots = [];
        let l;

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
                range.push(i);
            }
        }

        for (const i of range) {
            if (l) {
                if (i - l === 2) {
                    rangeWithDots.push(l + 1);
                } else if (i - l !== 1) {
                    rangeWithDots.push('...');
                }
            }
            rangeWithDots.push(i);
            l = i;
        }

        return rangeWithDots.map((p, idx) => (
            <button
                key={idx}
                disabled={p === '...'}
                onClick={() => typeof p === 'number' && setCurrentPage(p)}
                className={`min-w-[32px] h-8 px-2 border border-gray-400 text-[10px] font-black uppercase transition-all ${
                    p === currentPage 
                    ? 'bg-primary text-white border-primary shadow-inner' 
                    : p === '...' 
                    ? 'bg-white text-gray-400 cursor-default border-dashed' 
                    : 'bg-white text-gray-700 hover:bg-gray-50'
                }`}
            >
                {p}
            </button>
        ));
    };

    const handleConfirmCancel = () => {
        if (purchaseToCancel) {
            onCancelPurchase(purchaseToCancel);
            setPurchaseToCancel(null);
        }
        setIsConfirmOpen(false);
    };

    const handleRefresh = useCallback(async () => {
        if (!onRefresh) return;
        setIsSyncing(true);
        try {
            await onRefresh();
        } finally {
            setIsSyncing(false);
        }
    }, [onRefresh]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, 'purchaseHistory', { allowedKeysWhenInputFocused: ['F5'] })) return;

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (filteredAndSortedPurchases.length === 0) return;

                const currentIndex = selectedPurchase
                    ? filteredAndSortedPurchases.findIndex(p => p.id === selectedPurchase.id)
                    : -1;
                const nextIndex = e.key === 'ArrowDown'
                    ? Math.min(currentIndex + 1, filteredAndSortedPurchases.length - 1)
                    : Math.max(currentIndex - 1, 0);

                const nextPurchase = filteredAndSortedPurchases[nextIndex];
                if (nextPurchase) handleSelectRow(nextPurchase.id);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                handleViewSelected();
            } else if (e.key === 'F4') {
                e.preventDefault();
                handleEditSelected();
            } else if (e.key === 'F6') {
                e.preventDefault();
                handleReturnSelected();
            } else if (e.key === 'F7') {
                e.preventDefault();
                handleViewJournalSelected();
            } else if (e.key === 'F8') {
                e.preventDefault();
                handlePrintSelected();
            } else if (e.key === 'Delete') {
                e.preventDefault();
                handleCancelSelected();
            } else if (e.key === 'F3') {
                e.preventDefault();
                handleExportSelected();
            } else if (e.key === 'F5') {
                e.preventDefault();
                handleRefresh();
            } else if (e.key === 'F9') {
                e.preventDefault();
                handleCopySelected();
            } else if (e.key === 'F2') {
                e.preventDefault();
                onCreateNew?.();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        filteredAndSortedPurchases,
        selectedPurchase,
        handleViewSelected,
        handleEditSelected,
        handleReturnSelected,
        handleViewJournalSelected,
        handlePrintSelected,
        handleCancelSelected,
        handleExportSelected,
        handleRefresh,
        handleCopySelected,
    ]);

    const totalValue = useMemo(() => filteredAndSortedPurchases.reduce((sum, p) => sum + (p.status !== 'cancelled' ? p.totalAmount : 0), 0), [filteredAndSortedPurchases]);

    const applySearch = useCallback(() => {
        setSearchTerm(searchInput.trim());
    }, [searchInput]);

    return (
        <main className="flex-1 page-fade-in flex flex-col overflow-hidden bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Purchase Register (Inward Bills)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Purchase: ₹{totalValue.toLocaleString()}</span>
            </div>

            <div className="p-4 flex-1 flex flex-col gap-4 overflow-hidden">
                <Card className="sticky top-0 z-20 px-2 py-1.5 tally-border !rounded-none bg-white">
                    <div className="flex items-center gap-2 whitespace-nowrap overflow-x-auto">
                        <div className="flex items-center gap-1.5 min-w-[340px]">
                            <label className="text-[11px] font-semibold text-gray-600">Search:</label>
                            <input
                                type="text"
                                placeholder="Bill No / Supplier"
                                value={searchInput}
                                onChange={e => setSearchInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        applySearch();
                                    }
                                }}
                                className="h-8 w-[300px] border border-gray-400 px-2 text-[13px] font-semibold focus:bg-yellow-50 outline-none"
                            />
                        </div>

                        <div className="flex items-center gap-1.5 min-w-[180px]">
                            <label className="text-[11px] font-semibold text-gray-600">From:</label>
                            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-8 w-[150px] border border-gray-400 px-2 text-[12px] font-semibold outline-none" />
                        </div>

                        <div className="flex items-center gap-1.5 min-w-[170px]">
                            <label className="text-[11px] font-semibold text-gray-600">To:</label>
                            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="h-8 w-[150px] border border-gray-400 px-2 text-[12px] font-semibold outline-none" />
                        </div>

                        <div className="flex items-center gap-1.5 min-w-[190px]">
                            <label className="text-[11px] font-semibold text-gray-600">Supplier:</label>
                            <select value={distributorFilter} onChange={e => setDistributorFilter(e.target.value)} className="h-8 w-[150px] border border-gray-400 px-2 text-[12px] font-semibold outline-none bg-white">
                                <option value="all">All Suppliers</option>
                                {distributors.map(d => (
                                    <option key={d.id} value={d.name}>{d.name}</option>
                                ))}
                            </select>
                        </div>

                        <div className="flex items-center gap-1.5 min-w-[190px]">
                            <label className="text-[11px] font-semibold text-gray-600">Status:</label>
                            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as 'all' | 'completed' | 'cancelled' | 'hold')} className="h-8 w-[150px] border border-gray-400 px-2 text-[12px] font-semibold outline-none bg-white">
                                <option value="completed">Completed</option>
                                <option value="cancelled">Cancelled</option>
                                <option value="hold">On Hold</option>
                                <option value="all">All Bills</option>
                            </select>
                        </div>

                        <button
                            onClick={handleRefresh}
                            disabled={isSyncing}
                            className="h-8 min-w-[150px] px-3 tally-button-primary text-[11px] font-black uppercase flex items-center justify-center gap-2 disabled:opacity-60"
                        >
                            <RefreshIcon className={isSyncing ? 'animate-spin' : ''} />
                            {isSyncing ? 'Syncing...' : 'F5: Refresh'}
                        </button>
                    </div>
                </Card>

                <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white">
                    <div className="border-b border-gray-300 p-3 bg-gray-50 space-y-3">
                        <div className="text-[11px] font-bold text-gray-700">
                            Selected Bill: <span className="font-mono text-primary">{formatVoucherNo(selectedPurchase?.purchaseSerialId) || 'None'}</span>
                            {' '}| Supplier: <span className="uppercase">{selectedPurchase?.supplier || '-'}</span>
                            {' '}| Supplier Bill ID: <span className="font-mono">{formatVoucherNo(selectedPurchase?.invoiceNumber) || '-'}</span>
                            {' '}| Amount: <span className="font-black">₹{(selectedPurchase?.totalAmount || 0).toFixed(2)}</span>
                        </div>
                        {actionWarning && <div className="text-[11px] font-bold text-red-700 bg-red-100 border border-red-200 px-2 py-1">{actionWarning}</div>}
                        <div className="flex flex-wrap gap-2">
                            <button disabled={!selectedPurchase} onClick={handleViewSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">Enter: View</button>
                            <button disabled={!selectedPurchase || selectedIsCancelled} onClick={handleEditSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F4: Edit / Modify Bill</button>
                            <button disabled={!selectedPurchase || selectedIsCancelled} onClick={handleCopySelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F9: Copy Purchase Bill</button>
                            <button disabled={!selectedPurchase || selectedIsCancelled} onClick={handleReturnSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F6: Purchase Return</button>
                            <button disabled={!selectedPurchase || selectedIsCancelled} onClick={handleViewJournalSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F7: View Journal Entry</button>
                            <button disabled={!selectedPurchase} onClick={handlePrintSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F8: Print</button>
                            <button disabled={!selectedPurchase || selectedIsCancelled} onClick={handleCancelSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase text-red-700 disabled:opacity-50">Delete: Cancel</button>
                            <button disabled={!selectedPurchase || selectedIsCancelled} onClick={handleExportSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F3: Export</button>
                            <button onClick={handleRefresh} disabled={isSyncing} className="px-3 py-1.5 tally-button-primary text-[10px] font-black uppercase disabled:opacity-60">F5: Refresh</button>
                            <button onClick={onCreateNew} className="px-3 py-1.5 tally-border bg-emerald-600 text-white text-[10px] font-black uppercase hover:bg-emerald-700 shadow-md">F2: New Purchase</button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-auto">
                        <table className="min-w-full border-collapse text-sm">
                            <thead className="sticky top-0 bg-gray-100 border-b border-gray-400">
                                <tr className="text-[10px] font-black uppercase text-gray-600 select-none">
                                    <th className="p-2 border-r border-gray-400 text-left w-10">Sl.</th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('purchaseSerialId')}>
                                        <div className="flex items-center">System ID <SortIcon sortKey="purchaseSerialId" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('invoiceNumber')}>
                                        <div className="flex items-center">Supplier Bill ID <SortIcon sortKey="invoiceNumber" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('date')}>
                                        <div className="flex items-center">Date <SortIcon sortKey="date" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('supplier')}>
                                        <div className="flex items-center">Supplier <SortIcon sortKey="supplier" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-center w-24 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('itemCount')}>
                                        <div className="flex items-center justify-center">Items <SortIcon sortKey="itemCount" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-right w-32 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('totalAmount')}>
                                        <div className="flex items-center justify-end">Amount <SortIcon sortKey="totalAmount" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-center w-28 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('status')}>
                                        <div className="flex items-center justify-center">Status <SortIcon sortKey="status" sortConfig={sortConfig} /></div>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {paginatedPurchases.map((p, idx) => (
                                    <tr
                                        key={p.id}
                                        onClick={() => handleSelectRow(p.id)}
                                        className={`cursor-pointer transition-colors group ${selectedPurchaseId === p.id ? 'bg-primary text-white shadow-md' : 'hover:bg-primary hover:text-white'} ${p.status === 'cancelled' ? (selectedPurchaseId === p.id ? 'line-through text-white/50 bg-primary' : 'line-through text-red-500 bg-red-50/50') : ''}`}
                                    >
                                        <td className={`p-2 border-r border-gray-200 font-bold text-center ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white text-gray-400'}`}>{((currentPage - 1) * ITEMS_PER_PAGE) + idx + 1}</td>
                                        <td className={`p-2 border-r border-gray-200 font-mono font-bold ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white text-primary'}`}>{formatVoucherNo(p.purchaseSerialId)}</td>
                                        <td className={`p-2 border-r border-gray-200 font-bold uppercase ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white'}`}>{formatVoucherNo(p.invoiceNumber)}</td>
                                        <td className={`p-2 border-r border-gray-200 ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white'}`}>{new Date(p.date).toLocaleDateString('en-IN')}</td>
                                        <td className={`p-2 border-r border-gray-200 font-bold uppercase ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white'}`}>{p.supplier}</td>
                                        <td className={`p-2 border-r border-gray-200 text-center font-bold ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white'}`}>
                                            {(() => {
                                                const originalCount = (p.items || []).length;
                                                const returnedItemIds = new Set(
                                                    (purchaseReturns || [])
                                                        .filter(ret => ret.originalPurchaseInvoiceId === p.purchaseSerialId)
                                                        .flatMap(ret => (ret.items || []).map(item => item.inventoryItemId || item.id || item.name))
                                                );
                                                const netCount = Math.max(0, originalCount - returnedItemIds.size);
                                                
                                                if (returnedItemIds.size > 0) {
                                                    return (
                                                        <div className="flex flex-col items-center leading-none">
                                                            <span className={`text-xs ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white'}`}>{netCount}</span>
                                                            <span className={`text-[8px] font-black mt-0.5 uppercase ${selectedPurchaseId === p.id ? 'text-white/70' : 'text-red-500 group-hover:text-white/70'}`}>({returnedItemIds.size} Ret)</span>
                                                        </div>
                                                    );
                                                }
                                                return originalCount;
                                            })()}
                                        </td>
                                        <td className={`p-2 border-r border-gray-200 text-right font-black ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white'}`}>₹{(p.totalAmount || 0).toFixed(2)}</td>
                                        <td className={`p-2 border-r border-gray-200 text-center ${selectedPurchaseId === p.id ? 'text-white' : 'group-hover:text-white'}`}>
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${
                                                selectedPurchaseId === p.id 
                                                ? 'bg-white/20 text-white border-white/30' 
                                                : (p.status === 'cancelled' 
                                                    ? 'bg-red-100 text-red-700 border-red-200' 
                                                    : p.status === 'hold' || p.status === 'draft'
                                                    ? 'bg-amber-100 text-amber-700 border-amber-200'
                                                    : 'bg-emerald-100 text-emerald-700 border-emerald-200')
                                            }`}>
                                                {p.status === 'cancelled' ? 'Cancelled' : (p.status === 'hold' ? 'On Hold' : (p.status === 'draft' ? 'Draft' : 'Completed'))}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {/* Pagination Footer */}
                    {totalPages > 1 && (
                        <div className="p-2 bg-gray-100 border-t border-gray-400 flex justify-between items-center flex-shrink-0">
                            <div className="text-[10px] font-black uppercase text-gray-500 tracking-widest ml-2">
                                Showing {paginatedPurchases.length} of {filteredAndSortedPurchases.length} items
                            </div>
                            <div className="flex items-center gap-1">
                                <button 
                                    disabled={currentPage === 1}
                                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                                    className="px-4 h-8 border border-gray-400 bg-white text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-50 transition-colors shadow-sm"
                                >
                                    Prev
                                </button>
                                
                                <div className="flex items-center gap-1 mx-2">
                                    {renderPageNumbers()}
                                </div>

                                <button 
                                    disabled={currentPage === totalPages}
                                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                                    className="px-4 h-8 border border-gray-400 bg-white text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-50 transition-colors shadow-sm"
                                >
                                    Next
                                </button>
                            </div>
                            <div className="text-[9px] font-bold text-gray-400 uppercase mr-2 italic">
                                Use ← → keys to flip pages
                            </div>
                        </div>
                    )}
                </Card>
            </div>
            <ConfirmModal isOpen={isConfirmOpen} onClose={() => setIsConfirmOpen(false)} onConfirm={handleConfirmCancel} title="Cancel Purchase" message="Are you sure you want to cancel this inward entry? Stock levels will be reduced." />

            <JournalEntryViewerModal
                isOpen={!!journalPurchase}
                onClose={() => setJournalPurchase(null)}
                invoiceId={journalPurchase?.id}
                invoiceNumber={formatVoucherNo(journalPurchase?.invoiceNumber || journalPurchase?.purchaseSerialId)}
                documentType="PURCHASE"
                currentUser={currentUser}
                isPosted={(journalPurchase?.status || '') === 'completed'}
            />

            {viewingPurchase && (
                <Modal 
                    isOpen={!!viewingPurchase} 
                    onClose={() => setViewingPurchase(null)} 
                    title={`View Purchase: ${viewingPurchase.purchaseSerialId}`}
                >
                    <div className="h-[90vh] overflow-hidden flex flex-col">
                        <PurchaseForm
                            onAddPurchase={() => Promise.resolve()}
                            onUpdatePurchase={onUpdatePurchase}
                            inventory={inventory}
                            suppliers={distributors}
                            medicines={medicines}
                            mappings={[]}
                            purchases={purchases}
                            purchaseToEdit={viewingPurchase}
                            draftItems={null}
                            onClearDraft={() => {}}
                            currentUser={currentUser}
                            onAddMedicineMaster={onAddMedicineMaster}
                            onAddsupplier={async () => ({} as any)}
                            onSaveMapping={async (map) => onSaveMapping(map as SupplierProductMap)}
                            setIsDirty={() => {}}
                            addNotification={() => {}}
                            title="View Purchase"
                            configurations={configurations}
                            isReadOnly={true}
                            mobileSyncSessionId={null}
                            setMobileSyncSessionId={() => {}}
                            onCancel={() => setViewingPurchase(null)}
                            onPrint={onPrintPurchase}
                            organizationId={currentUser?.organization_id || ''}
                        />
                    </div>
                </Modal>
            )}
        </main>
    );
};

export default PurchaseHistory;
