import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import POS from '@modules/pos/components/POS';
import type { Transaction, RegisteredPharmacy, InventoryItem, SalesReturn, Customer, Medicine, Purchase, AppConfigurations } from '@core/types';
import { downloadCsv, arrayToCsvRow } from '@core/utils/csv';
import ConfirmModal from '@core/components/ui/ConfirmModal';
import JournalEntryViewerModal from '@modules/accounting/components/JournalEntryViewerModal';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';

type SortableKeys = 'invoiceNumber' | 'date' | 'customerName' | 'total' | 'status' | 'itemCount';

const SortIcon = ({ sortKey, sortConfig }: { sortKey: SortableKeys; sortConfig: { key: SortableKeys; direction: 'ascending' | 'descending' } }) => {
    if (sortConfig.key !== sortKey) return <span className="text-gray-400 opacity-30 ml-1">↕</span>;
    return <span className="text-primary ml-1">{sortConfig.direction === 'ascending' ? '▲' : '▼'}</span>;
};

interface SalesHistoryProps {
    transactions: Transaction[];
    inventory: InventoryItem[];
    customers: Customer[];
    onViewDetails: (transaction: Transaction) => void;
    onPrintBill: (transaction: Transaction) => void;
    onCancelTransaction: (transactionId: string) => void;
    initialFilters?: { startDate?: string; endDate?: string } | null;
    onFiltersChange?: () => void;
    currentUser: RegisteredPharmacy | null;
    onRefresh?: () => Promise<void>; 
    onViewSale: (transaction: Transaction) => void;
    onEditSale: (transaction: Transaction) => void;
    onCreateReturn: (transaction: Transaction) => void;
    salesReturns: SalesReturn[];
    configurations: any;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    purchases: Purchase[];
    medicines: Medicine[];
    onQuickAddCustomer: any;
    onGoToPOS?: () => void;
}

const RefreshIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
);

const POSIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
);

const ITEMS_PER_PAGE = 15;

const getInvoiceSequenceNumber = (transaction: Transaction): number => {
    const invoiceRef = String(transaction.invoiceNumber || transaction.id || '');
    
    // Legacy offline bills have UUIDs. If we parse the first chunk of digits from a UUID 
    // (e.g. '12602748-87c3...'), we get massive sequence numbers (12,602,748) which breaks 
    // sorting and pushes them above the current INV sequence.
    // Check if it looks like a UUID (36 chars, 4 hyphens) and return 0 so it falls back to date sorting.
    if (invoiceRef.length === 36 && invoiceRef.split('-').length === 5) {
        return 0;
    }

    const firstNumericChunk = invoiceRef.match(/\d+/)?.[0];
    if (!firstNumericChunk) return 0;
    const parsed = Number.parseInt(firstNumericChunk, 10);
    return Number.isFinite(parsed) ? parsed : 0;
};

const SalesHistory: React.FC<SalesHistoryProps> = ({ 
    transactions, inventory, customers, onViewDetails, onPrintBill, onCancelTransaction, initialFilters, 
    onFiltersChange, currentUser, onRefresh, onViewSale, onEditSale, onCreateReturn, salesReturns, 
    configurations, onAddMedicineMaster, purchases, medicines, onQuickAddCustomer, onGoToPOS
}) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [rmpFilter, setRmpFilter] = useState('all');
    const [paymentModeFilter, setPaymentModeFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'cancelled'>('all');
    const [sortConfig, setSortConfig] = useState<{ key: SortableKeys; direction: 'ascending' | 'descending' }>({ key: 'invoiceNumber', direction: 'descending' });
    const [currentPage, setCurrentPage] = useState(1);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [transactionToCancel, setTransactionToCancel] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [journalTransaction, setJournalTransaction] = useState<Transaction | null>(null);
    const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
    const [actionWarning, setActionWarning] = useState<string>('');
    const [viewingTransaction, setViewingTransaction] = useState<Transaction | null>(null);

    const requestSort = (key: SortableKeys) => {
        let direction: 'ascending' | 'descending' = 'ascending';
        if (sortConfig.key === key && sortConfig.direction === 'ascending') {
            direction = 'descending';
        }
        setSortConfig({ key, direction });
    };

    const filteredAndSortedTransactions = useMemo(() => {
        let filtered = (transactions || []).filter(Boolean);

        if (startDate) {
            const start = new Date(startDate); start.setHours(0, 0, 0, 0);
            filtered = filtered.filter(t => new Date(t.date) >= start);
        }
        if (endDate) {
            const end = new Date(endDate); end.setHours(23, 59, 59, 999);
            filtered = filtered.filter(t => new Date(t.date) <= end);
        }
        if (rmpFilter !== 'all') filtered = filtered.filter(t => t.referredBy === rmpFilter);
        if (paymentModeFilter !== 'all') filtered = filtered.filter(t => (t.paymentMode || 'Cash') === paymentModeFilter);
        if (statusFilter !== 'all') filtered = filtered.filter(t => (statusFilter === 'cancelled' ? t.status === 'cancelled' : t.status !== 'cancelled'));
        
        if (searchTerm) {
            const lowercasedFilter = searchTerm.toLowerCase();
            filtered = filtered.filter(t =>
                (t.invoiceNumber || t.id || '').toLowerCase().includes(lowercasedFilter) ||
                (t.customerName || '').toLowerCase().includes(lowercasedFilter) ||
                (t.customerPhone || '').toLowerCase().includes(lowercasedFilter)
            );
        }

        return filtered.sort((a, b) => {
            let comparison = 0;
            switch (sortConfig.key) {
                case 'invoiceNumber':
                    comparison = getInvoiceSequenceNumber(a) - getInvoiceSequenceNumber(b);
                    if (comparison === 0) {
                        comparison = String(a.invoiceNumber || a.id || '').localeCompare(String(b.invoiceNumber || b.id || ''));
                    }
                    break;
                case 'date':
                    comparison = new Date(a.date).getTime() - new Date(b.date).getTime();
                    break;
                case 'customerName':
                    comparison = (a.customerName || '').localeCompare(b.customerName || '');
                    break;
                case 'total':
                    comparison = (a.total || 0) - (b.total || 0);
                    break;
                case 'status':
                    comparison = (a.status || 'completed').localeCompare(b.status || 'completed');
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

            // Fallback for stable sort: Invoice number descending, then Date descending
            const fallbackSeq = getInvoiceSequenceNumber(b) - getInvoiceSequenceNumber(a);
            if (fallbackSeq !== 0) return fallbackSeq;
            
            return new Date(b.date).getTime() - new Date(a.date).getTime();
        });
    }, [transactions, searchTerm, startDate, endDate, rmpFilter, paymentModeFilter, statusFilter, sortConfig]);

    const totalPages = Math.ceil(filteredAndSortedTransactions.length / ITEMS_PER_PAGE);

    const paginatedTransactions = useMemo(() => {
        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        return filteredAndSortedTransactions.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    }, [filteredAndSortedTransactions, currentPage]);

    const selectedTransaction = useMemo(
        () => filteredAndSortedTransactions.find(tx => tx.id === selectedTransactionId) || null,
        [filteredAndSortedTransactions, selectedTransactionId]
    );

    // Reset to page 1 when filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [searchTerm, startDate, endDate, rmpFilter, paymentModeFilter, statusFilter]);

    useEffect(() => {
        if (selectedTransactionId && !selectedTransaction) {
            setSelectedTransactionId(null);
        }
    }, [selectedTransactionId, selectedTransaction]);

    const requireSelectedTransaction = useCallback(() => {
        if (!selectedTransaction) {
            setActionWarning('Please select an Invoice first.');
            return null;
        }
        setActionWarning('');
        return selectedTransaction;
    }, [selectedTransaction]);

    const handleSelectRow = (transactionId: string) => {
        setSelectedTransactionId(transactionId);
        setActionWarning('');
    };

    const handleViewSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;
        setViewingTransaction(tx);
    }, [requireSelectedTransaction]);

    const checkLinkedPayments = useCallback((tx: Transaction) => {
        const customer = customers.find(c => 
            c.id === tx.customerId || 
            (c.name || '').trim().toLowerCase() === (tx.customerName || '').trim().toLowerCase()
        );
        
        if (!customer || !Array.isArray(customer.ledger)) return false;

        // Check if there are any non-cancelled payment entries linked to this invoice
        return customer.ledger.some(entry => 
            entry.type === 'payment' && 
            entry.status !== 'cancelled' &&
            (entry.referenceInvoiceId === tx.id || (entry.referenceInvoiceNumber === tx.invoiceNumber && tx.invoiceNumber)) &&
            ['invoice_payment', 'invoice_payment_adjustment', 'down_payment_adjustment'].includes(entry.entryCategory || '') &&
            ((entry.adjustedAmount || 0) > 0 || (entry.credit || 0) > 0)
        );
    }, [customers]);

    const handleEditSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;

        const canEdit = tx.status === 'completed' || tx.status === 'hold' || tx.status === 'draft';
        if (!canEdit) {
            setActionWarning('Selected invoice cannot be modified.');
            return;
        }

        if (checkLinkedPayments(tx)) {
            setActionWarning('Cannot edit bill: A payment has been received against this invoice. Cancel the payment voucher first.');
            return;
        }

        setActionWarning('');
        onEditSale(tx);
    }, [requireSelectedTransaction, onEditSale, checkLinkedPayments]);

    const handleReturnOrderSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;

        if (tx.status !== 'completed') {
            setActionWarning('Selected invoice is not eligible for return.');
            return;
        }

        const totalReturnedQty = (salesReturns || [])
            .filter(ret => ret.originalInvoiceId === tx.id)
            .flatMap(ret => ret.items || [])
            .reduce((sum, item) => sum + Number(item.returnQuantity || 0), 0);

        const totalSoldQty = (tx.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        if (totalSoldQty > 0 && totalReturnedQty >= totalSoldQty) {
            setActionWarning('Return already completed for this invoice.');
            return;
        }

        setActionWarning('');
        onCreateReturn(tx);
    }, [requireSelectedTransaction, onCreateReturn, salesReturns]);

    const handleViewJournalSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;
        setJournalTransaction(tx);
    }, [requireSelectedTransaction]);

    const handlePrintSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;
        onPrintBill(tx);
    }, [onPrintBill, requireSelectedTransaction]);

    const handleCancelSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;

        if (tx.status === 'cancelled') {
            setActionWarning('Selected invoice is already cancelled.');
            return;
        }

        if (checkLinkedPayments(tx)) {
            setActionWarning('Cannot cancel bill: A payment has been received against this invoice. Cancel the payment voucher first.');
            return;
        }

        handleCancelClick(tx.id);
    }, [requireSelectedTransaction, checkLinkedPayments]);

    const handleExportSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;

        const headers = ['Invoice ID', 'Date', 'Customer Name', 'Items', 'Amount', 'Status'];
        const row = [
            tx.id,
            new Date(tx.date).toLocaleDateString('en-IN'),
            tx.customerName,
            String((tx.items || []).length),
            (tx.total || 0).toFixed(2),
            tx.status || 'completed',
        ];

        const csvContent = [arrayToCsvRow(headers), arrayToCsvRow(row)].join('\n');
        downloadCsv(`invoice-${tx.id}.csv`, csvContent);
    }, [requireSelectedTransaction]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, 'salesHistory', { allowedKeysWhenInputFocused: ['F5'] })) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (paginatedTransactions.length === 0) return;

                const currentIndex = selectedTransaction
                    ? paginatedTransactions.findIndex(tx => tx.id === selectedTransaction.id)
                    : -1;
                const nextIndex = e.key === 'ArrowDown'
                    ? Math.min(currentIndex + 1, paginatedTransactions.length - 1)
                    : Math.max(currentIndex - 1, 0);
                const nextTransaction = paginatedTransactions[nextIndex];
                if (nextTransaction) {
                    handleSelectRow(nextTransaction.id);
                }
            } else if (e.key === 'ArrowRight' && currentPage < totalPages) {
                e.preventDefault();
                setCurrentPage(p => p + 1);
            } else if (e.key === 'ArrowLeft' && currentPage > 1) {
                e.preventDefault();
                setCurrentPage(p => p - 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                handleViewSelected();
            } else if (e.key === 'F1') {
                e.preventDefault();
                if (onGoToPOS) onGoToPOS();
            } else if (e.key === 'F4') {
                e.preventDefault();
                handleEditSelected();
            } else if (e.key === 'F6') {
                e.preventDefault();
                handleReturnOrderSelected();
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
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [paginatedTransactions, selectedTransaction, handleViewSelected, handleEditSelected, handleReturnOrderSelected, handleViewJournalSelected, handlePrintSelected, handleCancelSelected, handleExportSelected, currentPage, totalPages]);

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

    const handleCancelClick = (id: string) => {
        setTransactionToCancel(id);
        setIsConfirmOpen(true);
    };

    const handleConfirmCancel = () => {
        if (transactionToCancel) {
            onCancelTransaction(transactionToCancel);
            setTransactionToCancel(null);
        }
        setIsConfirmOpen(false);
    };

    const handleRefresh = async () => {
        if (onRefresh) {
            setIsSyncing(true);
            try {
                await onRefresh();
            } finally {
                setIsSyncing(false);
            }
        }
    };

    const totalRevenue = useMemo(() => filteredAndSortedTransactions.reduce((sum, t) => sum + (t.status !== 'cancelled' ? t.total : 0), 0), [filteredAndSortedTransactions]);

    const applySearch = useCallback(() => {
        setSearchTerm(searchInput.trim());
    }, [searchInput]);

    return (
        <main className="flex-1 page-fade-in flex flex-col overflow-hidden bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Sales Register (Accounting)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Revenue: ₹{totalRevenue.toLocaleString()}</span>
            </div>

            <div className="p-4 flex-1 flex flex-col gap-4 overflow-hidden">
                <Card className="sticky top-0 z-20 px-2 py-1.5 tally-border !rounded-none bg-white">
                    <div className="flex items-center gap-2 whitespace-nowrap overflow-x-auto">
                        <div className="flex items-center gap-1.5 min-w-[340px]">
                            <label className="text-[11px] font-semibold text-gray-600">Search:</label>
                            <input
                                type="text"
                                placeholder="Bill ID / Customer"
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

                        <div className="flex items-center gap-1.5 min-w-[205px]">
                            <label className="text-[11px] font-semibold text-gray-600">Status:</label>
                            <select
                                value={statusFilter}
                                onChange={e => setStatusFilter(e.target.value as any)}
                                className="h-8 w-[165px] border border-gray-400 px-2 text-[12px] font-semibold outline-none bg-white"
                            >
                                <option value="all">All Orders</option>
                                <option value="completed">Completed Orders</option>
                                <option value="cancelled">Cancelled Orders</option>
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
                            Selected Invoice: <span className="font-mono text-primary">{selectedTransaction?.invoiceNumber || selectedTransaction?.id || 'None'}</span>
                            {' '}| Customer: <span className="uppercase">{selectedTransaction?.customerName || '-'}</span>
                            {' '}| Voucher ID: <span className="font-mono">{selectedTransaction?.invoiceNumber || selectedTransaction?.id || '-'}</span>
                            {' '}| Amount: <span className="font-black">₹{(selectedTransaction?.total || 0).toFixed(2)}</span>
                            {selectedTransaction?.narration && (
                                <> | Narration: <span className="text-indigo-600 italic font-medium">{selectedTransaction.narration}</span></>
                            )}
                        </div>
                        {actionWarning && <div className="text-[11px] font-bold text-red-700 bg-red-100 border border-red-200 px-2 py-1">{actionWarning}</div>}
                        <div className="flex flex-wrap gap-2">
                            <button onClick={() => onGoToPOS?.()} className="px-3 py-1.5 tally-border bg-primary text-white text-[10px] font-black uppercase flex items-center gap-2 hover:bg-primary-dark transition-colors shadow-md">
                                <POSIcon className="w-3 h-3" />
                                F1: POS Sales
                            </button>
                            <button disabled={!selectedTransaction} onClick={handleViewSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">Enter: View</button>
                            <button disabled={!selectedTransaction} onClick={handleEditSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F4: Edit / Modify Bill</button>
                            <button disabled={!selectedTransaction} onClick={handleReturnOrderSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F6: Return Order</button>
                            <button disabled={!selectedTransaction} onClick={handleViewJournalSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F7: View Journal Entry</button>
                            <button disabled={!selectedTransaction} onClick={handlePrintSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F8: Print</button>
                            <button disabled={!selectedTransaction} onClick={handleCancelSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase text-red-700 disabled:opacity-50">Delete: Cancel</button>
                            <button disabled={!selectedTransaction} onClick={handleExportSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F3: Export</button>
                            <button onClick={handleRefresh} disabled={isSyncing} className="px-3 py-1.5 tally-button-primary text-[10px] font-black uppercase disabled:opacity-60">F5: Refresh</button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-auto">
                        <table className="min-w-full border-collapse text-sm">
                            <thead className="sticky top-0 bg-gray-100 border-b border-gray-400">
                                <tr className="text-[10px] font-black uppercase text-gray-600 select-none">
                                    <th className="p-2 border-r border-gray-400 text-left w-10">Sl.</th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('invoiceNumber')}>
                                        <div className="flex items-center">Invoice ID <SortIcon sortKey="invoiceNumber" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('date')}>
                                        <div className="flex items-center">Date <SortIcon sortKey="date" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('customerName')}>
                                        <div className="flex items-center">Customer Name <SortIcon sortKey="customerName" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-center w-24 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('itemCount')}>
                                        <div className="flex items-center justify-center">Items <SortIcon sortKey="itemCount" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-right w-32 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('total')}>
                                        <div className="flex items-center justify-end">Amount <SortIcon sortKey="total" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-center w-28 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('status')}>
                                        <div className="flex items-center justify-center">Status <SortIcon sortKey="status" sortConfig={sortConfig} /></div>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {paginatedTransactions.map((tx, idx) => {
                                    const status = tx.status || 'completed';
                                    return (
                                    <tr
                                        key={tx.id}
                                        onClick={() => handleSelectRow(tx.id)}
                                        className={`cursor-pointer transition-colors group ${selectedTransactionId === tx.id ? 'bg-primary text-white shadow-md' : 'hover:bg-primary hover:text-white'} ${status === 'cancelled' ? (selectedTransactionId === tx.id ? 'line-through text-white/50 bg-primary' : 'line-through text-red-500 bg-red-50/50') : ''}`}
                                    >
                                        <td className={`p-2 border-r border-gray-200 font-bold text-center ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white text-gray-400'}`}>{((currentPage - 1) * ITEMS_PER_PAGE) + idx + 1}</td>
                                        <td className={`p-2 border-r border-gray-200 font-mono font-bold ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white text-primary'}`}>{tx.invoiceNumber || tx.id}</td>
                                        <td className={`p-2 border-r border-gray-200 ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>{new Date(tx.date).toLocaleDateString('en-IN')}</td>
                                        <td className={`p-2 border-r border-gray-200 font-bold uppercase ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>{tx.customerName}</td>
                                        <td className={`p-2 border-r border-gray-200 text-center font-bold ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>
                                            {(() => {
                                                const originalCount = (tx.items || []).length;
                                                const returnedItemIds = new Set(
                                                    (salesReturns || [])
                                                        .filter(ret => ret.originalInvoiceId === tx.id)
                                                        .flatMap(ret => (ret.items || []).map(item => item.inventoryItemId || item.id || item.name))
                                                );
                                                const netCount = Math.max(0, originalCount - returnedItemIds.size);
                                                
                                                if (returnedItemIds.size > 0) {
                                                    return (
                                                        <div className="flex flex-col items-center leading-none">
                                                            <span className={`text-xs ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>{netCount}</span>
                                                            <span className={`text-[8px] font-black mt-0.5 uppercase ${selectedTransactionId === tx.id ? 'text-white/70' : 'text-red-500 group-hover:text-white/70'}`}>({returnedItemIds.size} Ret)</span>
                                                        </div>
                                                    );
                                                }
                                                return originalCount;
                                            })()}
                                        </td>
                                        <td className={`p-2 border-r border-gray-400 text-right font-black ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>₹{(tx.total || 0).toFixed(2)}</td>
                                        <td className={`p-2 border-r border-gray-200 text-center ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>
                                            <div className="flex flex-col gap-1 items-center">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${
                                                    selectedTransactionId === tx.id 
                                                    ? 'bg-white/20 text-white border-white/30' 
                                                    : (status === 'cancelled' 
                                                        ? 'bg-red-100 text-red-700 border-red-200' 
                                                        : 'bg-emerald-100 text-emerald-700 border-emerald-200')
                                                }`}>
                                                    {status === 'cancelled' ? 'Cancelled' : 'Completed'}
                                                </span>
                                                {tx.sync_status === 'pending' && (
                                                    <span className={`text-[8px] font-black px-1 border uppercase animate-pulse ${selectedTransactionId === tx.id ? 'text-white border-white/40 bg-white/10' : 'text-amber-600 bg-amber-50 border-amber-200'}`}>
                                                        Sync Pending
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )})}
                            </tbody>
                        </table>
                    </div>
                    {/* Pagination Footer */}
                    {totalPages > 1 && (
                        <div className="p-2 bg-gray-100 border-t border-gray-400 flex justify-between items-center flex-shrink-0">
                            <div className="text-[10px] font-black uppercase text-gray-500 tracking-widest ml-2">
                                Showing {paginatedTransactions.length} of {filteredAndSortedTransactions.length} items
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
            <ConfirmModal isOpen={isConfirmOpen} onClose={() => setIsConfirmOpen(false)} onConfirm={handleConfirmCancel} title="Cancel Invoice" message="Are you sure you want to cancel this invoice? Inventory will be reversed." />
            
            <JournalEntryViewerModal
                isOpen={!!journalTransaction}
                onClose={() => setJournalTransaction(null)}
                invoiceId={journalTransaction?.id}
                invoiceNumber={journalTransaction?.invoiceNumber || journalTransaction?.id}
                documentType="SALES"
                currentUser={currentUser}
                isPosted={(journalTransaction?.status || '') === 'completed'}
            />

            {viewingTransaction && (
                <Modal 
                    isOpen={!!viewingTransaction} 
                    onClose={() => setViewingTransaction(null)} 
                    title={`View Sales Invoice: ${viewingTransaction.invoiceNumber || viewingTransaction.id}`}
                >
                    <div className="h-[90vh] overflow-hidden flex flex-col">
                        <POS
                            inventory={inventory}
                            purchases={purchases}
                            medicines={medicines}
                            customers={customers}
                            transactions={transactions}
                            onSaveOrUpdateTransaction={() => Promise.resolve()}
                            onPrintBill={onPrintBill}
                            currentUser={currentUser}
                            config={{}}
                            configurations={configurations}
                            transactionToEdit={viewingTransaction}
                            isReadOnly={true}
                            onCancel={() => setViewingTransaction(null)}
                            onAddMedicineMaster={onAddMedicineMaster}
                            onQuickAddCustomer={onQuickAddCustomer}
                            addNotification={() => {}}
                        />
                    </div>
                </Modal>
            )}
        </main>
    );
};

export default SalesHistory;
