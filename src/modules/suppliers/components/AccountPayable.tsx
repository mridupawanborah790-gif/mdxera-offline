import React, { useState, useMemo, useEffect } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import PrintSupplierVoucherModal from './PrintSupplierVoucherModal';
import { Distributor, Purchase, RegisteredPharmacy, TransactionLedgerItem } from '@core/types';
import { calculateSupplierPayableBreakdown, getOutstandingBalance, formatVoucherNo } from '@core/utils/helpers';
import { fuzzyMatch } from '@core/utils/search';
import { handleEnterToNextField } from '@core/utils/navigation';
import { numberToWords } from '@core/utils/numberToWords';
import { supabase } from '@core/db/supabaseClient';

const uniformTextStyle = 'text-2xl font-normal tracking-tight uppercase leading-tight';

interface BankOption {
    id: string;
    bankName: string;
    accountName: string;
    accountNumber: string;
    isDefault: boolean;
    accountType?: string;
}

interface PayableInvoiceRow {
    id: string;
    date: string;
    invoiceNumber: string;
    invoiceAmount: number;
    paid: number;
    balance: number;
    status: 'Open' | 'Partially Paid' | 'Fully Paid';
    paymentDate: string;
    paymentMode: string;
    bankName: string;
    voucherRef: string;
    latestPaymentEntry?: TransactionLedgerItem;
}

interface LedgerVoucherMeta {
    journalEntryId?: string;
    journalEntryNumber?: string;
    referenceInvoiceNumber?: string;
}

interface VoucherAllocationSummary {
    adjustedAmount: number;
    remainingAmount: number;
    status: 'Open / Unadjusted' | 'Partially Adjusted' | 'Fully Adjusted' | 'Cancelled';
}

interface AccountPayableProps {
    distributors: Distributor[];
    purchases: Purchase[];
    bankOptions: BankOption[];
    onRecordPayment: (args: {
        supplierId: string;
        amount: number;
        date: string;
        description: string;
        paymentMode: string;
        bankAccountId: string;
        referenceInvoiceId?: string;
        referenceInvoiceNumber?: string;
        entryCategory?: 'invoice_payment' | 'down_payment';
    }) => Promise<{ ledgerEntryId: string }>;
    onRecordDownPaymentAdjustment: (args: {
        supplierId: string;
        date: string;
        downPaymentId: string;
        referenceInvoiceId: string;
        referenceInvoiceNumber?: string;
        amount: number;
        description?: string;
    }) => Promise<void>;
    onRecordInvoicePaymentAdjustment: (args: {
        supplierId: string;
        date: string;
        sourcePaymentId: string;
        referenceInvoiceId: string;
        referenceInvoiceNumber?: string;
        amount: number;
        description?: string;
    }) => Promise<void>;
    onCancelPaymentEntry: (args: {
        ownerType: 'customer' | 'supplier';
        ownerId: string;
        paymentEntryId: string;
        cancellationDate: string;
        reason: string;
    }) => Promise<void>;
    currentUser: RegisteredPharmacy | null;
}

const escapeHtml = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const formatDisplayDate = (value?: string): string => {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const getPaymentAmount = (entry: TransactionLedgerItem): number => {
    const creditAmount = Number(entry.credit || 0);
    if (creditAmount > 0) return creditAmount;
    return Number(entry.debit || 0);
};

const getEntryTypeWeight = (entry: TransactionLedgerItem): number => {
    if (entry.type === 'openingBalance') return 0;
    if (entry.type === 'purchase' || entry.type === 'sale') return 1;
    if (entry.type === 'payment' && (entry.entryCategory === 'invoice_payment' || entry.entryCategory === 'down_payment')) return 2;
    if (String(entry.entryCategory || '').includes('adjustment')) return 3;
    return 4;
};

const AccountPayable: React.FC<AccountPayableProps> = ({ distributors, purchases, bankOptions, onRecordPayment, onRecordDownPaymentAdjustment, onRecordInvoicePaymentAdjustment, onCancelPaymentEntry, currentUser }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedDistributor, setSelectedDistributor] = useState<Distributor | null>(null);
    const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
    const [amount, setAmount] = useState<number | ''>('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [description, setDescription] = useState('Supplier Payment');
    const [paymentMode, setPaymentMode] = useState('Bank');
    const [bankAccountId, setBankAccountId] = useState('');
    const [showPaymentForm, setShowPaymentForm] = useState(false);
    const [showDownPaymentForm, setShowDownPaymentForm] = useState(false);
    const [adjustAgainstInvoice, setAdjustAgainstInvoice] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [ledgerVoucherMap, setLedgerVoucherMap] = useState<Record<string, LedgerVoucherMeta>>({});
    const [invoiceAdjustments, setInvoiceAdjustments] = useState<Record<string, number>>({});
    const [paymentType, setPaymentType] = useState<'against_invoice' | 'on_account'>('against_invoice');
    const [isAmountManuallyEdited, setIsAmountManuallyEdited] = useState(false);
    const [adjustmentVoucher, setAdjustmentVoucher] = useState<TransactionLedgerItem | null>(null);
    const [adjustmentDate, setAdjustmentDate] = useState(new Date().toISOString().split('T')[0]);
    const [voucherInvoiceAdjustments, setVoucherInvoiceAdjustments] = useState<Record<string, number>>({});
    const [printingVoucher, setPrintingVoucher] = useState<TransactionLedgerItem | null>(null);

    const normalizedPaymentMode = paymentMode.trim().toLowerCase();
    const isCashMode = normalizedPaymentMode === 'cash';

    const bankOnlyOptions = useMemo(
        () =>
            bankOptions.filter((option) => {
                const accountType = String(option.accountType || '').toLowerCase();
                const compositeLabel = `${option.bankName} ${option.accountName} ${option.accountNumber}`.toLowerCase();
                return accountType.includes('bank') || (!accountType.includes('cash') && !compositeLabel.includes('cash'));
            }),
        [bankOptions]
    );

    const defaultBankOption = useMemo(
        () => bankOnlyOptions.find((option) => option.isDefault) || bankOnlyOptions[0] || null,
        [bankOnlyOptions]
    );

    const filteredDistributors = useMemo(() => {
        if (!Array.isArray(distributors)) return [];
        return distributors
            .filter(d => d && d.is_blocked !== true)
            .filter(d => fuzzyMatch(d.name || '', searchTerm) || fuzzyMatch(d.gst_number || '', searchTerm))
            .sort((a, b) => getOutstandingBalance(b) - getOutstandingBalance(a));
    }, [distributors, searchTerm]);

    useEffect(() => {
        if (!selectedDistributor?.id) return;
        const latestDistributor = distributors.find((distributor) => distributor.id === selectedDistributor.id) || null;
        if (!latestDistributor) {
            setSelectedDistributor(null);
            setShowPaymentForm(false);
            setShowDownPaymentForm(false);
            return;
        }
        if (latestDistributor !== selectedDistributor) {
            setSelectedDistributor(latestDistributor);
        }
    }, [distributors, selectedDistributor?.id]);

    useEffect(() => {
        let isMounted = true;

        const hydrateLedgerVoucherDetails = async () => {
            if (!selectedDistributor || !currentUser || !navigator.onLine) {
                if (isMounted) setLedgerVoucherMap({});
                return;
            }

            const ledger = Array.isArray(selectedDistributor.ledger) ? selectedDistributor.ledger : [];
            const paymentEntries = ledger.filter((entry) => entry && entry.type === 'payment' && getPaymentAmount(entry) > 0);
            
            if (paymentEntries.length === 0) {
                if (isMounted) setLedgerVoucherMap({});
                return;
            }

            const referenceIds = Array.from(new Set([
                selectedDistributor.id,
                ...paymentEntries.map((entry) => entry.referenceInvoiceId || '').filter(Boolean),
            ])).filter(Boolean);

            if (referenceIds.length === 0) return;

            try {
                const { data, error } = await supabase
                    .from('journal_entry_header')
                    .select('id, journal_entry_number, reference_id, reference_document_id, document_reference, posting_date, total_debit, total_credit')
                    .eq('organization_id', currentUser.organization_id)
                    .eq('reference_type', 'SUPPLIER_PAYMENT')
                    .in('reference_id', referenceIds)
                    .order('posting_date', { ascending: false });

                if (error || !isMounted) return;

                const rows = data || [];
                const byId = new Map(rows.map((row: any) => [String(row.id), row]));
                const byReferenceDocumentId = new Map<string, any[]>();
                for (const row of rows) {
                    const key = String(row.reference_document_id || row.reference_id || '');
                    if (!key) continue;
                    const existing = byReferenceDocumentId.get(key) || [];
                    existing.push(row);
                    byReferenceDocumentId.set(key, existing);
                }

                const resolved: Record<string, LedgerVoucherMeta> = {};
                for (const entry of paymentEntries) {
                    const amount = getPaymentAmount(entry);
                    const entryDate = String(entry.date || '').split('T')[0];
                    const byJournalId = entry.journalEntryId ? byId.get(String(entry.journalEntryId)) : undefined;
                    const candidatePool = (byJournalId
                        ? [byJournalId]
                        : (byReferenceDocumentId.get(String(entry.referenceInvoiceId || selectedDistributor.id)) || []).concat(byReferenceDocumentId.get(selectedDistributor.id) || []))
                        .filter(Boolean);

                    const exactMatch = candidatePool.find((row: any) => {
                        const postingDate = String(row.posting_date || '').split('T')[0];
                        const rowAmount = Number(row.total_credit || row.total_debit || 0);
                        return postingDate === entryDate && Math.abs(rowAmount - amount) < 0.01;
                    }) || candidatePool[0];

                    if (!exactMatch) continue;
                    resolved[entry.id] = {
                        journalEntryId: String(exactMatch.id),
                        journalEntryNumber: String(exactMatch.journal_entry_number || ''),
                        referenceInvoiceNumber: String(exactMatch.document_reference || entry.referenceInvoiceNumber || ''),
                    };
                }

                if (isMounted) setLedgerVoucherMap(resolved);
            } catch (err) {
                console.error('AccountPayable: Hydration error', err);
            }
        };

        hydrateLedgerVoucherDetails();
        return () => {
            isMounted = false;
        };
    }, [selectedDistributor, currentUser]);

    const invoiceRows = useMemo(() => {
        if (!selectedDistributor || !Array.isArray(purchases)) return [] as PayableInvoiceRow[];

        const supplierName = (selectedDistributor.name || '').trim().toLowerCase();
        if (!supplierName) return [] as PayableInvoiceRow[];

        const supplierPurchases: PayableInvoiceRow[] = purchases
            .filter(p => p && p.status !== 'cancelled' && (p.supplier || '').trim().toLowerCase() === supplierName)
            .map(p => ({
                id: p.id,
                date: p.date,
                invoiceNumber: formatVoucherNo(p.invoiceNumber || p.id),
                invoiceAmount: Number(p.totalAmount || 0),
                paid: 0,
                balance: Number(p.totalAmount || 0),
                status: 'Open',
                paymentDate: '-',
                paymentMode: 'Credit',
                bankName: '-',
                voucherRef: '-',
                latestPaymentEntry: undefined,
            }));

        const mapByInvoice = new Map(supplierPurchases.map(item => [item.id, { ...item }]));
        const ledger = Array.isArray(selectedDistributor.ledger) ? selectedDistributor.ledger : [];

        // Expose Opening Balance as a clearable "pseudo-invoice" item if a positive balance exists
        const openingEntries = ledger.filter(e => e && e.type === 'openingBalance' && e.status !== 'cancelled');
        openingEntries.forEach(entry => {
            const obVal = Number(entry.credit || 0) - Number(entry.debit || 0);
            if (obVal > 0) {
                mapByInvoice.set(entry.id, {
                    id: entry.id,
                    date: entry.date,
                    invoiceNumber: 'OPENING-BAL',
                    invoiceAmount: obVal,
                    paid: 0,
                    balance: obVal,
                    status: 'Open',
                    paymentDate: '-',
                    paymentMode: 'Opening Balance',
                    bankName: '-',
                    voucherRef: '-',
                    latestPaymentEntry: undefined,
                });
            }
        });
        
        const hasOpeningEntry = ledger.some(e => e && e.type === 'openingBalance' && e.status !== 'cancelled');
        if (!hasOpeningEntry && Number(selectedDistributor.opening_balance || 0) > 0) {
            const obVal = Number(selectedDistributor.opening_balance || 0);
            mapByInvoice.set('opening-balance-id-fallback', {
                id: 'opening-balance-id-fallback',
                date: selectedDistributor.created_at || new Date().toISOString(),
                invoiceNumber: 'OPENING-BAL',
                invoiceAmount: obVal,
                paid: 0,
                balance: obVal,
                status: 'Open',
                paymentDate: '-',
                paymentMode: 'Opening Balance',
                bankName: '-',
                voucherRef: '-',
                latestPaymentEntry: undefined,
            });
        }

        for (const entry of ledger) {
            if (!entry || entry.type !== 'payment' || entry.status === 'cancelled') continue;
            if (!['invoice_payment_adjustment', 'down_payment_adjustment', 'invoice_payment_adjustment_reversal', 'down_payment_adjustment_reversal'].includes(String(entry.entryCategory || ''))) {
                continue;
            }
            const invoiceId = entry.referenceInvoiceId || '';
            const target = invoiceId && mapByInvoice.get(invoiceId);
            if (!target) continue;

            const resolvedMeta = ledgerVoucherMap[entry.id];
            const normalizedEntry = {
                ...entry,
                journalEntryId: entry.journalEntryId || resolvedMeta?.journalEntryId,
                journalEntryNumber: entry.journalEntryNumber || resolvedMeta?.journalEntryNumber,
                referenceInvoiceNumber: entry.referenceInvoiceNumber || resolvedMeta?.referenceInvoiceNumber,
            };

            const adjustedAmount = Number(normalizedEntry.adjustedAmount || 0);
            target.paid += adjustedAmount;
            target.balance = Number((target.invoiceAmount - target.paid).toFixed(2));
            if (target.balance <= 0) {
                target.balance = 0;
                target.status = 'Fully Paid';
            } else if (target.paid > 0) {
                target.status = 'Partially Paid';
            } else {
                target.status = 'Open';
            }
            target.paymentDate = normalizedEntry.date || target.paymentDate;
            target.paymentMode = normalizedEntry.paymentMode || target.paymentMode;
            target.bankName = normalizedEntry.bankName || target.bankName;
            target.voucherRef = normalizedEntry.journalEntryNumber || normalizedEntry.journalEntryId || target.voucherRef;
            target.latestPaymentEntry = normalizedEntry;
        }

        return Array.from(mapByInvoice.values()).sort((a, b) => {
            const dateA = new Date(a.date).getTime();
            const dateB = new Date(b.date).getTime();
            return (Number.isNaN(dateB) ? 0 : dateB) - (Number.isNaN(dateA) ? 0 : dateA);
        });
    }, [selectedDistributor, purchases, ledgerVoucherMap]);

    const openPayableInvoiceRows = useMemo(
        () => invoiceRows.filter((row) => row.balance > 0 && (row.status === 'Open' || row.status === 'Partially Paid')),
        [invoiceRows]
    );

    const totalAllocatedAmount = useMemo(
        () =>
            Object.values(invoiceAdjustments)
                .reduce((sum, value) => sum + Number(value || 0), 0),
        [invoiceAdjustments]
    );

    useEffect(() => {
        if (!showPaymentForm || paymentType !== 'against_invoice' || isAmountManuallyEdited) return;
        setAmount(totalAllocatedAmount > 0 ? Number(totalAllocatedAmount.toFixed(2)) : '');
    }, [showPaymentForm, paymentType, totalAllocatedAmount, isAmountManuallyEdited]);

    const ledgerRows = useMemo(() => {
        if (!selectedDistributor) return [];
        const ledger = Array.isArray(selectedDistributor.ledger) ? selectedDistributor.ledger : [];
        const resolved = [...ledger]
            .filter(Boolean)
            .map((entry) => {
                const resolvedMeta = ledgerVoucherMap[entry.id];
                return {
                    ...entry,
                    journalEntryId: entry.journalEntryId || resolvedMeta?.journalEntryId,
                    journalEntryNumber: entry.journalEntryNumber || resolvedMeta?.journalEntryNumber,
                    referenceInvoiceNumber: entry.referenceInvoiceNumber || resolvedMeta?.referenceInvoiceNumber,
                };
            });

        // Sort chronologically ascending to calculate running balance correctly.
        const sortedAsc = [...resolved].sort((a, b) => {
            const dateA = new Date(a.date).getTime();
            const dateB = new Date(b.date).getTime();
            if (dateA !== dateB) {
                return (Number.isNaN(dateA) ? 0 : dateA) - (Number.isNaN(dateB) ? 0 : dateB);
            }
            const weightA = getEntryTypeWeight(a);
            const weightB = getEntryTypeWeight(b);
            if (weightA !== weightB) return weightA - weightB;
            return (a.id || '').localeCompare(b.id || '');
        });

        // Supplier is a Creditor. Credit increases balance, Debit decreases balance.
        // If there is an active openingBalance entry, start running balance at 0 to avoid doubling.
        const hasOpeningBalanceEntry = sortedAsc.some(entry => entry.type === 'openingBalance' && entry.status !== 'cancelled');
        let runningBalance = hasOpeningBalanceEntry ? 0 : Number(selectedDistributor.opening_balance || 0);

        const calculated = sortedAsc.map(entry => {
            if (entry.status !== 'cancelled') {
                runningBalance += Number(entry.credit || 0) - Number(entry.debit || 0);
            }
            return {
                ...entry,
                balance: runningBalance
            };
        });

        // Now sort descending by date (newest first) for UI display.
        // On equal dates, sort by descending weight (newest adjustment first, then payment, then invoice, then opening balance)
        return calculated.sort((a, b) => {
            const dateA = new Date(a.date).getTime();
            const dateB = new Date(b.date).getTime();
            if (dateA !== dateB) {
                return (Number.isNaN(dateB) ? 0 : dateB) - (Number.isNaN(dateA) ? 0 : dateA);
            }
            const weightA = getEntryTypeWeight(a);
            const weightB = getEntryTypeWeight(b);
            if (weightA !== weightB) return weightB - weightA;
            return (b.id || '').localeCompare(a.id || '');
        });
    }, [selectedDistributor, ledgerVoucherMap]);

    const payableHistoryRows = useMemo(
        () => ledgerRows.filter(item => item.type === 'payment' && (getPaymentAmount(item) > 0 || Number(item.adjustedAmount || 0) > 0)),
        [ledgerRows]
    );
    const downPaymentRows = useMemo(
        () => ledgerRows.filter(item => item.type === 'payment' && item.entryCategory === 'down_payment' && item.status !== 'cancelled' && getPaymentAmount(item) > 0),
        [ledgerRows]
    );
    const availableAdvanceBalance = useMemo(() => {
        const totalAdvance = downPaymentRows.reduce((sum, row) => sum + getPaymentAmount(row), 0);
        const totalAdjusted = ledgerRows
            .filter(item => item.entryCategory === 'down_payment_adjustment' || item.entryCategory === 'down_payment_adjustment_reversal')
            .reduce((sum, row) => sum + Number(row.adjustedAmount || 0), 0);
        return Number((totalAdvance - totalAdjusted).toFixed(2));
    }, [downPaymentRows, ledgerRows]);

    const getVoucherAllocationSummary = (voucher: TransactionLedgerItem): VoucherAllocationSummary => {
        const originalAmount = getPaymentAmount(voucher);
        const adjustedAmount = ledgerRows
            .filter((row) => row.status !== 'cancelled')
            .reduce((sum, row) => {
                if (voucher.entryCategory === 'down_payment' && row.entryCategory === 'down_payment_adjustment' && row.sourceDownPaymentId === voucher.id) {
                    return sum + Number(row.adjustedAmount || 0);
                }
                if (voucher.entryCategory !== 'down_payment' && row.entryCategory === 'invoice_payment_adjustment' && row.sourcePaymentId === voucher.id) {
                    return sum + Number(row.adjustedAmount || 0);
                }
                return sum;
            }, 0);
        const remainingAmount = Number((originalAmount - adjustedAmount).toFixed(2));
        if (voucher.status === 'cancelled') return { adjustedAmount, remainingAmount: 0, status: 'Cancelled' };
        if (remainingAmount <= 0.001) return { adjustedAmount, remainingAmount: 0, status: 'Fully Adjusted' };
        if (adjustedAmount > 0) return { adjustedAmount, remainingAmount, status: 'Partially Adjusted' };
        return { adjustedAmount, remainingAmount, status: 'Open / Unadjusted' };
    };

    const totalInvoiceOutstanding = useMemo(
        () => invoiceRows
            .filter(row => row.invoiceNumber !== 'OPENING-BAL')
            .reduce((sum, row) => sum + Number(row.balance || 0), 0),
        [invoiceRows]
    );

    const payableBreakdown = useMemo(
        () => calculateSupplierPayableBreakdown(selectedDistributor, totalInvoiceOutstanding),
        [selectedDistributor, totalInvoiceOutstanding]
    );
    const grossOutstanding = payableBreakdown.grossPayable;
    const totalAdjustedPayment = payableBreakdown.adjustedPayments;
    const totalUnadjustedPayment = payableBreakdown.unadjustedAdvance;
    const netPayable = payableBreakdown.netOutstanding;

    const printVoucher = (entry: TransactionLedgerItem) => {
        setPrintingVoucher(entry);
    };

    const openPaymentPanel = () => {
        setShowPaymentForm(true);
        setShowDownPaymentForm(false);
        setAmount('');
        setDescription('Supplier Payment');
        setSelectedInvoiceId('');
        setPaymentType('against_invoice');
        setInvoiceAdjustments({});
        setIsAmountManuallyEdited(false);
        setPaymentMode('Bank');
        setBankAccountId(defaultBankOption?.id || '');
        setSubmitError('');
    };

    const openDownPaymentPanel = () => {
        setShowDownPaymentForm(true);
        setShowPaymentForm(false);
        setAmount('');
        setDescription('Advance Paid');
        setPaymentMode('Bank');
        setSelectedInvoiceId('');
        setAdjustAgainstInvoice(false);
        setInvoiceAdjustments({});
        setIsAmountManuallyEdited(false);
        setBankAccountId(defaultBankOption?.id || '');
        setSubmitError('');
    };

    useEffect(() => {
        if (isCashMode) {
            setBankAccountId('');
            return;
        }
        if (!bankAccountId) {
            setBankAccountId(defaultBankOption?.id || '');
        } else if (!bankOnlyOptions.some((option) => option.id === bankAccountId)) {
            setBankAccountId(defaultBankOption?.id || '');
        }
    }, [isCashMode, bankAccountId, bankOnlyOptions, defaultBankOption]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedDistributor || !amount || amount <= 0) return;
        if (!isCashMode && !bankAccountId) return;
        const paymentAmount = Number(amount);
        const allocations = Object.entries(invoiceAdjustments)
            .map(([invoiceId, allocated]) => ({ invoiceId, allocated: Number(allocated || 0) }))
            .filter(({ allocated }) => allocated > 0);
        const totalAllocated = allocations.reduce((sum, item) => sum + item.allocated, 0);
        if (paymentType === 'against_invoice') {
            if (allocations.length === 0) throw new Error('Select invoice allocations for against-invoice payment.');
            if (Math.abs(totalAllocated - paymentAmount) > 0.001) throw new Error('Payment Amount does not match total invoice allocation. Please adjust invoice-wise amounts or payment amount before posting.');
            for (const allocation of allocations) {
                const invoice = openPayableInvoiceRows.find((row) => row.id === allocation.invoiceId);
                if (!invoice) throw new Error('One or more selected invoices are already fully settled or unavailable.');
                if (allocation.allocated > invoice.balance + 0.001) throw new Error(`Allocated amount exceeds pending balance for invoice ${invoice.invoiceNumber}.`);
            }
        }

        setIsSubmitting(true);
        setSubmitError('');
        try {
            const paymentResult = await onRecordPayment({
                supplierId: selectedDistributor.id,
                amount: paymentAmount,
                date,
                description,
                paymentMode,
                bankAccountId: isCashMode ? '' : bankAccountId,
                referenceInvoiceId: paymentType === 'against_invoice' && allocations.length === 1 ? allocations[0].invoiceId : undefined,
                referenceInvoiceNumber: paymentType === 'against_invoice' && allocations.length === 1 ? invoiceRows.find(i => i.id === allocations[0].invoiceId)?.invoiceNumber : undefined,
                entryCategory: 'invoice_payment',
            });
            if (paymentType === 'against_invoice') {
                for (const allocation of allocations) {
                    const invoice = invoiceRows.find(i => i.id === allocation.invoiceId);
                    if (!invoice) continue;
                    await onRecordInvoicePaymentAdjustment({
                        supplierId: selectedDistributor.id,
                        date,
                        sourcePaymentId: paymentResult.ledgerEntryId,
                        referenceInvoiceId: invoice.id,
                        referenceInvoiceNumber: invoice.invoiceNumber,
                        amount: allocation.allocated,
                        description: 'Payment adjusted against invoice',
                    });
                }
            }
            setShowPaymentForm(false);
            setAmount('');
            setDescription('Supplier Payment');
            setIsAmountManuallyEdited(false);
            setSubmitError('');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to post supplier payment. Please try again.';
            setSubmitError(message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDownPaymentSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedDistributor || !amount || amount <= 0) return;
        if (!isCashMode && !bankAccountId) return;

        const enteredAmount = Number(amount);
        const allocations = Object.entries(invoiceAdjustments)
            .map(([invoiceId, allocated]) => ({ invoiceId, allocated: Number(allocated || 0) }))
            .filter(({ allocated }) => allocated > 0);
        const totalAllocated = allocations.reduce((sum, item) => sum + item.allocated, 0);
        if (adjustAgainstInvoice && totalAllocated > enteredAmount) return;

        setIsSubmitting(true);
        setSubmitError('');
        try {
            const downPaymentResult = await onRecordPayment({
                supplierId: selectedDistributor.id,
                amount: enteredAmount,
                date,
                description: description || 'Advance Paid',
                paymentMode,
                bankAccountId: isCashMode ? '' : bankAccountId,
                entryCategory: 'down_payment',
            });
            for (const allocation of allocations) {
                const invoice = invoiceRows.find(row => row.id === allocation.invoiceId);
                if (!invoice) continue;
                await onRecordDownPaymentAdjustment({
                    supplierId: selectedDistributor.id,
                    date,
                    downPaymentId: downPaymentResult.ledgerEntryId,
                    referenceInvoiceId: invoice.id,
                    referenceInvoiceNumber: invoice.invoiceNumber,
                    amount: allocation.allocated,
                    description: 'Advance adjusted against invoice',
                });
            }
            setShowDownPaymentForm(false);
            setAmount('');
            setDescription('Advance Paid');
            setAdjustAgainstInvoice(false);
            setInvoiceAdjustments({});
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to post supplier down payment. Please try again.';
            setSubmitError(message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const openVoucherAdjustmentModal = (voucher: TransactionLedgerItem) => {
        const summary = getVoucherAllocationSummary(voucher);
        if (voucher.status === 'cancelled' || summary.remainingAmount <= 0) return;
        setAdjustmentVoucher(voucher);
        setVoucherInvoiceAdjustments({});
        setAdjustmentDate(new Date().toISOString().split('T')[0]);
        setSubmitError('');
    };

    const handleVoucherAdjustmentSubmit = async () => {
        if (!selectedDistributor || !adjustmentVoucher) return;
        const summary = getVoucherAllocationSummary(adjustmentVoucher);
        if (summary.remainingAmount <= 0) throw new Error('Selected voucher is already fully adjusted.');
        const allocations = Object.entries(voucherInvoiceAdjustments)
            .map(([invoiceId, allocated]) => ({ invoiceId, allocated: Number(allocated || 0) }))
            .filter(({ allocated }) => allocated > 0);
        if (allocations.length === 0) throw new Error('Enter at least one invoice allocation.');
        const totalAllocation = allocations.reduce((sum, row) => sum + row.allocated, 0);
        if (totalAllocation > summary.remainingAmount + 0.001) throw new Error('Cannot allocate more than voucher unadjusted balance.');

        setIsSubmitting(true);
        setSubmitError('');
        try {
            for (const allocation of allocations) {
                const invoice = openPayableInvoiceRows.find((row) => row.id === allocation.invoiceId);
                if (!invoice) throw new Error('One or more invoices are unavailable for adjustment.');
                if (allocation.allocated > invoice.balance + 0.001) throw new Error(`Allocated amount exceeds pending balance for invoice ${invoice.invoiceNumber}.`);
                if (adjustmentVoucher.entryCategory === 'down_payment') {
                    await onRecordDownPaymentAdjustment({
                        supplierId: selectedDistributor.id,
                        date: adjustmentDate,
                        downPaymentId: adjustmentVoucher.id,
                        referenceInvoiceId: invoice.id,
                        referenceInvoiceNumber: invoice.invoiceNumber,
                        amount: allocation.allocated,
                        description: 'Advance adjusted against old / pending invoice',
                    });
                } else {
                    await onRecordInvoicePaymentAdjustment({
                        supplierId: selectedDistributor.id,
                        date: adjustmentDate,
                        sourcePaymentId: adjustmentVoucher.id,
                        referenceInvoiceId: invoice.id,
                        referenceInvoiceNumber: invoice.invoiceNumber,
                        amount: allocation.allocated,
                        description: 'Payment adjusted against old / pending invoice',
                    });
                }
            }
            setAdjustmentVoucher(null);
            setVoucherInvoiceAdjustments({});
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to adjust voucher against invoice.';
            setSubmitError(message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCancelEntry = async (entry: TransactionLedgerItem) => {
        if (!selectedDistributor || entry.status === 'cancelled') return;
        const reason = window.prompt('Enter cancellation reason', 'User requested cancellation');
        if (!reason) return;
        await onCancelPaymentEntry({
            ownerType: 'supplier',
            ownerId: selectedDistributor.id,
            paymentEntryId: entry.id,
            cancellationDate: new Date().toISOString().split('T')[0],
            reason,
        });
    };

    return (
        <main className="flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg" onKeyDown={handleEnterToNextField}>
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Sundry Creditors (Payable)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Creditors: {distributors.length}</span>
            </div>

            <div className="p-4 flex-1 flex gap-4 min-h-0 overflow-hidden">
                <Card className="w-1/3 flex flex-col p-0 tally-border overflow-hidden bg-white">
                    <div className="p-3 border-b border-gray-400 bg-gray-50 flex-shrink-0">
                        <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Search Ledger</label>
                        <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Name or GSTIN..." className="w-full border border-gray-400 p-2 text-sm font-bold focus:bg-yellow-50 outline-none" />
                    </div>
                    <div className="flex-1 overflow-y-auto divide-y divide-gray-200">
                        {filteredDistributors.map(d => {
                            const isSelected = selectedDistributor?.id === d.id;
                            return (
                                <button 
                                    key={d.id} 
                                    onClick={() => { setSelectedDistributor(d); setShowPaymentForm(false); }} 
                                    className={`w-full text-left px-3 py-2 transition-all group ${isSelected ? 'bg-primary text-white shadow-lg' : 'hover:bg-primary hover:text-white'}`}
                                >
                                    <div className="min-w-0">
                                        <p className={`${uniformTextStyle} !text-lg truncate ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{d.name}</p>
                                        <p className={`${uniformTextStyle} !text-xs mt-0.5 ${isSelected ? 'text-white/70' : 'text-gray-500 group-hover:text-white/70'}`}>{d.gst_number || 'NO GSTIN'}</p>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </Card>

                <Card className="flex-1 p-6 tally-border bg-white overflow-y-auto">
                    {selectedDistributor ? (
                        <div className="space-y-6">
                            <div className="pb-4 border-b border-gray-300 flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1">Active Ledger Selection</p>
                                    <h2 className={`${uniformTextStyle} !text-4xl text-primary`}>{selectedDistributor.name}</h2>
                                    <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-black uppercase">
                                        <div className="text-gray-500">Gross Payable: <span className="text-red-600">₹{grossOutstanding.toFixed(2)}</span></div>
                                        <div className="text-gray-500">Adjusted Payment: <span className="text-primary">₹{totalAdjustedPayment.toFixed(2)}</span></div>
                                        <div className="text-emerald-700">Available Advance / Unadjusted Payment: ₹{totalUnadjustedPayment.toFixed(2)}</div>
                                        <div className="text-gray-500">Net Outstanding Payable: <span className="text-red-700 text-lg">₹{netPayable.toFixed(2)}</span></div>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button type="button" onClick={openPaymentPanel} className="px-4 py-2 tally-button-primary text-xs uppercase font-black tracking-wider">Add Payment</button>
                                    <button type="button" onClick={openDownPaymentPanel} className="px-4 py-2 tally-button-primary text-xs uppercase font-black tracking-wider">Down Payment</button>
                                </div>
                            </div>

                            {showPaymentForm && (
                                <form onSubmit={handleSubmit} className="border border-gray-300 p-4 bg-gray-50 space-y-4">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-gray-500">Record Supplier Payment</p>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Payment Type</label>
                                            <select value={paymentType} onChange={e => setPaymentType(e.target.value as 'against_invoice' | 'on_account')} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50">
                                                <option value="against_invoice">Against Invoice</option>
                                                <option value="on_account">On Account</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Payment Amount (₹)</label>
                                            <input type="number" required value={amount} onChange={e => { setAmount(parseFloat(e.target.value) || ''); setIsAmountManuallyEdited(true); }} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50" placeholder="0.00" />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Payment Date</label>
                                            <input type="date" required value={date} onChange={e => setDate(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50" />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Payment Mode</label>
                                            <select value={paymentMode} onChange={e => setPaymentMode(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50">
                                                <option value="Bank">Bank</option>
                                                <option value="Cash">Cash</option>
                                                <option value="UPI">UPI</option>
                                                <option value="Cheque">Cheque</option>
                                                <option value="NEFT/RTGS">NEFT/RTGS</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Bank / Cash Account</label>
                                            {isCashMode ? (
                                                <input
                                                    type="text"
                                                    value="Cash Account"
                                                    disabled
                                                    className="w-full border border-gray-300 bg-gray-100 p-2 text-sm font-bold text-gray-600 cursor-not-allowed"
                                                />
                                            ) : (
                                                <select required value={bankAccountId} onChange={e => setBankAccountId(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50">
                                                    <option value="">Select Bank Account</option>
                                                    {bankOnlyOptions.map(option => (
                                                        <option key={option.id} value={option.id}>{option.bankName} • {option.accountNumber || option.accountName}</option>
                                                    ))}
                                                </select>
                                            )}
                                            {!isCashMode && !defaultBankOption && <p className="text-[10px] mt-1 text-amber-700">No default bank configured. Select from Bank Master.</p>}
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Narration / Remark</label>
                                            <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold uppercase outline-none focus:bg-yellow-50" placeholder="SUPPLIER PAYMENT" />
                                        </div>
                                    </div>
                                    {paymentType === 'against_invoice' && (
                                        <div className="space-y-2">
                                            {openPayableInvoiceRows.map(row => (
                                                <div key={row.id} className="grid grid-cols-1 md:grid-cols-6 gap-2">
                                                    <div className="border border-gray-200 p-2 text-xs font-bold">{formatVoucherNo(row.invoiceNumber)}</div>
                                                    <div className="border border-gray-200 p-2 text-xs">{formatDisplayDate(row.date)}</div>
                                                    <div className="border border-gray-200 p-2 text-xs">Original ₹{row.invoiceAmount.toFixed(2)}</div>
                                                    <div className="border border-gray-200 p-2 text-xs">Paid ₹{row.paid.toFixed(2)}</div>
                                                    <div className="border border-gray-200 p-2 text-xs">Balance ₹{row.balance.toFixed(2)}</div>
                                                    <input type="number" min={0} max={row.balance} value={invoiceAdjustments[row.id] ?? ''} onChange={e => setInvoiceAdjustments(prev => ({ ...prev, [row.id]: Math.min(parseFloat(e.target.value) || 0, row.balance) }))} className="border border-gray-300 p-2 text-xs font-bold" placeholder="Allocate amount" />
                                                </div>
                                            ))}
                                            {Math.abs(Number(amount || 0) - totalAllocatedAmount) > 0.001 && (
                                                <p className="text-xs font-bold text-amber-700">Payment Amount does not match total invoice allocation. Please adjust invoice-wise amounts or payment amount before posting.</p>
                                            )}
                                        </div>
                                    )}
                                    <div className="flex justify-end gap-2">
                                        <button type="button" onClick={() => setShowPaymentForm(false)} className="px-3 py-2 border border-gray-300 font-bold uppercase text-[10px] hover:bg-white">Discard</button>
                                        <button type="submit" disabled={isSubmitting || !amount || Number(amount) <= 0 || (!isCashMode && !bankAccountId)} className="px-4 py-2 tally-button-primary font-black uppercase text-xs">
                                            {isSubmitting ? 'Posting...' : 'Post Supplier Payment'}
                                        </button>
                                    </div>
                                    {submitError && (
                                        <p className="text-xs font-bold text-red-700">{submitError}</p>
                                    )}
                                </form>
                            )}

                            {showDownPaymentForm && (
                                <form onSubmit={handleDownPaymentSubmit} className="border border-gray-300 p-4 bg-gray-50 space-y-4">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-gray-500">Record Supplier Down Payment</p>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <input type="text" disabled value={selectedDistributor.name} className="w-full border border-gray-300 bg-gray-100 p-2 text-sm font-bold text-gray-600" />
                                        <input type="number" required value={amount} onChange={e => setAmount(parseFloat(e.target.value) || '')} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50" placeholder="Down payment amount" />
                                        <input type="date" required value={date} onChange={e => setDate(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50" />
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <select value={paymentMode} onChange={e => setPaymentMode(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50">
                                            <option value="Bank">Bank</option><option value="Cash">Cash</option><option value="UPI">UPI</option>
                                        </select>
                                        {isCashMode ? (
                                            <input type="text" value="Cash Account" disabled className="w-full border border-gray-300 bg-gray-100 p-2 text-sm font-bold text-gray-600" />
                                        ) : (
                                            <select required value={bankAccountId} onChange={e => setBankAccountId(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none focus:bg-yellow-50">
                                                <option value="">Select Bank Account</option>
                                                {bankOnlyOptions.map(option => (
                                                    <option key={option.id} value={option.id}>{option.bankName} • {option.accountNumber || option.accountName}</option>
                                                ))}
                                            </select>
                                        )}
                                        <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold uppercase outline-none focus:bg-yellow-50" placeholder="Reference / Note" />
                                    </div>
                                    <label className="inline-flex items-center gap-2 text-xs font-black uppercase">
                                        <input type="checkbox" checked={adjustAgainstInvoice} onChange={e => setAdjustAgainstInvoice(e.target.checked)} />
                                        Adjust Against Invoice
                                    </label>
                                    {adjustAgainstInvoice && invoiceRows.filter(row => row.balance > 0).map(row => (
                                        <div key={row.id} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            <div className="border border-gray-200 p-2 text-xs font-bold">{formatVoucherNo(row.invoiceNumber)} • Pending ₹{row.balance.toFixed(2)}</div>
                                            <input type="number" min={0} max={row.balance} value={invoiceAdjustments[row.id] ?? ''} onChange={e => setInvoiceAdjustments(prev => ({ ...prev, [row.id]: parseFloat(e.target.value) || 0 }))} className="border border-gray-300 p-2 text-xs font-bold" placeholder="Adjust amount" />
                                        </div>
                                    ))}
                                    <div className="flex justify-end gap-2">
                                        <button type="button" onClick={() => setShowDownPaymentForm(false)} className="px-3 py-2 border border-gray-300 font-bold uppercase text-[10px] hover:bg-white">Discard</button>
                                        <button type="submit" disabled={isSubmitting || !amount || Number(amount) <= 0 || (!isCashMode && !bankAccountId)} className="px-4 py-2 tally-button-primary font-black uppercase text-xs">
                                            {isSubmitting ? 'Posting...' : 'Post Down Payment'}
                                        </button>
                                    </div>
                                    {submitError && <p className="text-xs font-bold text-red-700">{submitError}</p>}
                                </form>
                            )}

                            <div>
                                <p className="text-[10px] font-black uppercase tracking-wider mb-2">Invoice-wise supplier payable tracking</p>
                                <div className="overflow-auto border border-gray-200">
                                    <table className="min-w-full text-xs">
                                        <thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Date</th><th className="p-2 text-left">Invoice</th><th className="p-2 text-left">Invoice Amount</th><th className="p-2 text-left">Amount Paid</th><th className="p-2 text-left">Outstanding</th><th className="p-2 text-left">Last Payment Date</th><th className="p-2 text-left">Payment Mode</th><th className="p-2 text-left">Bank</th><th className="p-2 text-left">Voucher</th><th className="p-2 text-left">Print</th></tr></thead>
                                        <tbody>
                                            {invoiceRows.length === 0 ? (
                                                <tr><td className="p-3 text-center text-gray-500" colSpan={10}>No purchase invoices found for this supplier.</td></tr>
                                            ) : invoiceRows.map(row => (
                                                <tr key={row.id} className="border-t">
                                                    <td className="p-2">{formatDisplayDate(row.date)}</td>
                                                    <td className="p-2">{formatVoucherNo(row.invoiceNumber)}</td>
                                                    <td className="p-2">₹{row.invoiceAmount.toFixed(2)}</td>
                                                    <td className="p-2">₹{row.paid.toFixed(2)}</td>
                                                    <td className="p-2 font-bold">₹{row.balance.toFixed(2)}</td>
                                                    <td className="p-2">{formatDisplayDate(row.paymentDate)}</td>
                                                    <td className="p-2">{row.paymentMode}</td>
                                                    <td className="p-2">{row.bankName}</td>
                                                    <td className="p-2">{formatVoucherNo(row.voucherRef)}</td>
                                                    <td className="p-2">
                                                        {row.latestPaymentEntry ? (
                                                            <button type="button" onClick={() => printVoucher(row.latestPaymentEntry!)} className="px-2 py-1 border border-gray-300 font-bold uppercase text-[10px] hover:bg-gray-100">Print</button>
                                                        ) : (
                                                            '-'
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div>
                                <p className="text-[10px] font-black uppercase tracking-wider mb-2">Supplier payment history / voucher history</p>
                                <div className="overflow-auto border border-gray-200">
                                    <table className="min-w-full text-xs">
                                        <thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Date</th><th className="p-2 text-left">Type</th><th className="p-2 text-left">Payment Against</th><th className="p-2 text-left">Payment Mode</th><th className="p-2 text-left">Bank/Cash Account</th><th className="p-2 text-left">Narration</th><th className="p-2 text-left">Voucher Amount</th><th className="p-2 text-left">Adjusted</th><th className="p-2 text-left">Unadjusted</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Voucher No.</th><th className="p-2 text-left">Actions</th></tr></thead>
                                        <tbody>
                                            {payableHistoryRows.length === 0 ? (
                                                <tr><td className="p-3 text-center text-gray-500" colSpan={12}>No supplier payments posted yet.</td></tr>
                                            ) : payableHistoryRows.map(item => (
                                                <tr key={item.id} className="border-t">
                                                    {(() => {
                                                        const summary = getVoucherAllocationSummary(item);
                                                        const isAdjustableVoucher = (item.entryCategory === 'invoice_payment' || item.entryCategory === 'down_payment') && item.status !== 'cancelled' && summary.remainingAmount > 0;
                                                        return (
                                                            <>
                                                    <td className="p-2">{formatDisplayDate(item.date)}</td>
                                                    <td className="p-2">{item.entryCategory === 'down_payment' ? 'DOWN PAYMENT' : item.entryCategory === 'down_payment_adjustment' ? 'DP ADJUSTMENT' : item.entryCategory === 'invoice_payment_adjustment' ? 'INVOICE ADJUSTMENT' : item.entryCategory === 'payment_cancellation' || item.entryCategory === 'down_payment_cancellation' ? 'CANCELLATION' : 'PAYMENT'}</td>
                                                    <td className="p-2">{formatVoucherNo(item.referenceInvoiceNumber) || item.referenceInvoiceId || '-'}</td>
                                                    <td className="p-2">{item.paymentMode || '-'}</td>
                                                    <td className="p-2">{item.bankName || '-'}</td>
                                                    <td className="p-2">{item.entryCategory === 'down_payment' ? 'Advance Paid' : item.description}</td>
                                                    <td className="p-2 font-bold">₹{getPaymentAmount(item).toFixed(2)}</td>
                                                    <td className="p-2">₹{summary.adjustedAmount.toFixed(2)}</td>
                                                    <td className="p-2">₹{summary.remainingAmount.toFixed(2)}</td>
                                                    <td className="p-2">{summary.status}</td>
                                                    <td className="p-2">{formatVoucherNo(item.journalEntryNumber) || item.journalEntryId || '-'}</td>
                                                    <td className="p-2 flex gap-2">
                                                        <button type="button" onClick={() => printVoucher(item)} className="px-2 py-1 border border-gray-300 font-bold uppercase text-[10px] hover:bg-gray-100">Print</button>
                                                        {(item.entryCategory === 'invoice_payment' || item.entryCategory === 'down_payment') && item.status !== 'cancelled' && (
                                                            <button type="button" onClick={() => handleCancelEntry(item)} className="px-2 py-1 border border-red-300 text-red-700 font-bold uppercase text-[10px] hover:bg-red-50">Cancel</button>
                                                        )}
                                                        {isAdjustableVoucher && (
                                                            <button type="button" onClick={() => openVoucherAdjustmentModal(item)} className="px-2 py-1 border border-primary text-primary font-bold uppercase text-[10px] hover:bg-blue-50">Adjust Payment</button>
                                                        )}
                                                    </td>
                                                            </>
                                                        );
                                                    })()}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div>
                                <p className="text-[10px] font-black uppercase tracking-wider mb-2">Complete ledger transactions (including accounting-linked payment entries)</p>
                                <div className="overflow-auto border border-gray-200">
                                    <table className="min-w-full text-xs">
                                        <thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Date</th><th className="p-2 text-left">Type</th><th className="p-2 text-left">Description</th><th className="p-2 text-left">Debit</th><th className="p-2 text-left">Credit</th><th className="p-2 text-left">Balance</th><th className="p-2 text-left">Voucher</th></tr></thead>
                                        <tbody>
                                            {ledgerRows.map(item => (
                                                <tr key={item.id} className="border-t">
                                                    <td className="p-2">{formatDisplayDate(item.date)}</td>
                                                    <td className="p-2 uppercase">{item.type}</td>
                                                    <td className="p-2">{item.description}</td>
                                                    <td className="p-2">₹{Number(item.debit || 0).toFixed(2)}</td>
                                                    <td className="p-2">₹{Number(item.credit || 0).toFixed(2)}</td>
                                                    <td className="p-2 font-bold">₹{Number(item.balance || 0).toFixed(2)}</td>
                                                    <td className="p-2">{formatVoucherNo(item.journalEntryNumber) || item.journalEntryId || '-'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            <Modal isOpen={Boolean(adjustmentVoucher)} onClose={() => setAdjustmentVoucher(null)} title="Adjust Payment / Clear Against Invoice" widthClass="max-w-5xl">
                                {adjustmentVoucher && (
                                    <div className="space-y-4">
                                        {(() => {
                                            const summary = getVoucherAllocationSummary(adjustmentVoucher);
                                            const voucherNumber = adjustmentVoucher.journalEntryNumber || adjustmentVoucher.journalEntryId || adjustmentVoucher.id;
                                            return (
                                                <>
                                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                                                        <div><span className="font-black uppercase text-gray-500">Voucher No.</span><div>{formatVoucherNo(voucherNumber)}</div></div>
                                                        <div><span className="font-black uppercase text-gray-500">Voucher Date</span><div>{formatDisplayDate(adjustmentVoucher.date)}</div></div>
                                                        <div><span className="font-black uppercase text-gray-500">Party Name</span><div>{selectedDistributor.name}</div></div>
                                                        <div><span className="font-black uppercase text-gray-500">Original Voucher Amount</span><div>₹{getPaymentAmount(adjustmentVoucher).toFixed(2)}</div></div>
                                                        <div><span className="font-black uppercase text-gray-500">Already Adjusted</span><div>₹{summary.adjustedAmount.toFixed(2)}</div></div>
                                                        <div><span className="font-black uppercase text-gray-500">Remaining Unadjusted</span><div>₹{summary.remainingAmount.toFixed(2)}</div></div>
                                                    </div>
                                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
                                                        <label className="text-xs font-black uppercase text-gray-500">Adjustment Date
                                                            <input type="date" value={adjustmentDate} onChange={(e) => setAdjustmentDate(e.target.value)} className="mt-1 w-full border border-gray-300 p-2" />
                                                        </label>
                                                    </div>
                                                    <div className="overflow-auto border border-gray-200">
                                                        <table className="min-w-full text-xs">
                                                            <thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Invoice No.</th><th className="p-2 text-left">Invoice Date</th><th className="p-2 text-left">Invoice Amount</th><th className="p-2 text-left">Already Paid</th><th className="p-2 text-left">Outstanding</th><th className="p-2 text-left">Allocate Amount</th></tr></thead>
                                                            <tbody>
                                                                {openPayableInvoiceRows.length === 0 ? (
                                                                    <tr><td colSpan={6} className="p-3 text-center text-gray-500">No open invoices available.</td></tr>
                                                                ) : openPayableInvoiceRows.map((row) => (
                                                                    <tr key={row.id} className="border-t">
                                                                        <td className="p-2">{formatVoucherNo(row.invoiceNumber)}</td>
                                                                        <td className="p-2">{formatDisplayDate(row.date)}</td>
                                                                        <td className="p-2">₹{row.invoiceAmount.toFixed(2)}</td>
                                                                        <td className="p-2">₹{row.paid.toFixed(2)}</td>
                                                                        <td className="p-2">₹{row.balance.toFixed(2)}</td>
                                                                        <td className="p-2"><input type="number" min={0} max={Math.min(row.balance, summary.remainingAmount)} value={voucherInvoiceAdjustments[row.id] ?? ''} onChange={e => setVoucherInvoiceAdjustments(prev => ({ ...prev, [row.id]: Math.min(parseFloat(e.target.value) || 0, row.balance) }))} className="w-full border border-gray-300 p-2" placeholder="Allocate" /></td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                    <div className="flex justify-end gap-2">
                                                        <button type="button" onClick={() => setAdjustmentVoucher(null)} className="px-3 py-2 border border-gray-300 text-xs font-black uppercase">Close</button>
                                                        <button type="button" disabled={isSubmitting} onClick={handleVoucherAdjustmentSubmit} className="px-4 py-2 tally-button-primary text-xs font-black uppercase">{isSubmitting ? 'Adjusting...' : 'Adjust Payment'}</button>
                                                    </div>
                                                </>
                                            );
                                        })()}
                                        {submitError && <p className="text-xs font-bold text-red-700">{submitError}</p>}
                                    </div>
                                )}
                            </Modal>
                        </div>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-center opacity-30">
                            <p className="text-2xl font-black uppercase tracking-[0.2em]">Select Ledger to review payables</p>
                        </div>
                    )}
                </Card>
            </div>
            <PrintSupplierVoucherModal
                isOpen={Boolean(printingVoucher)}
                onClose={() => setPrintingVoucher(null)}
                voucher={printingVoucher}
                distributor={selectedDistributor}
                pharmacy={currentUser}
                bankOptions={bankOptions}
                summary={printingVoucher ? getVoucherAllocationSummary(printingVoucher) : null}
            />
        </main>
    );
};

export default AccountPayable;
