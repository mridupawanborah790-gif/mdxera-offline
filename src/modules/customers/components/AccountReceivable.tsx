import React, { useState, useMemo, useEffect } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import PrintCustomerVoucherModal from './PrintCustomerVoucherModal';
import { Customer, RegisteredPharmacy, Transaction, TransactionLedgerItem } from '@core/types';
import { calculateCustomerReceivableBreakdown, formatVoucherNo } from '@core/utils/helpers';
import { fuzzyMatch } from '@core/utils/search';
import { handleEnterToNextField } from '@core/utils/navigation';
import { numberToWords } from '@core/utils/numberToWords';

const uniformTextStyle = 'text-2xl font-normal tracking-tight uppercase leading-tight';

interface BankOption {
    id: string;
    bankName: string;
    accountName: string;
    accountNumber: string;
    isDefault: boolean;
    accountType?: string;
}


interface ReceivableInvoiceRow {
    id: string;
    invoiceNumber?: string;
    date: string;
    invoiceAmount: number;
    received: number;
    balance: number;
    status: 'Open' | 'Partially Received' | 'Paid';
    paymentDate: string;
    paymentMode: string;
    bankName: string;
    voucherRef: string;
    latestPaymentEntry?: TransactionLedgerItem;
}

interface VoucherAllocationSummary {
    adjustedAmount: number;
    remainingAmount: number;
    status: 'Open / Unadjusted' | 'Partially Adjusted' | 'Fully Adjusted' | 'Cancelled';
}

interface AccountReceivableProps {
    customers: Customer[];
    transactions: Transaction[];
    bankOptions: BankOption[];
    onRecordPayment: (args: {
        customerId: string;
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
        customerId: string;
        date: string;
        downPaymentId: string;
        referenceInvoiceId: string;
        referenceInvoiceNumber?: string;
        amount: number;
        description?: string;
    }) => Promise<void>;
    onRecordInvoicePaymentAdjustment: (args: {
        customerId: string;
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

const getEntryTypeWeight = (entry: TransactionLedgerItem): number => {
    if (entry.type === 'openingBalance') return 0;
    if (entry.type === 'purchase' || entry.type === 'sale') return 1;
    if (entry.type === 'payment' && (entry.entryCategory === 'invoice_payment' || entry.entryCategory === 'down_payment')) return 2;
    if (String(entry.entryCategory || '').includes('adjustment')) return 3;
    return 4;
};

const getReceivableInvoiceRowsForCustomer = (
    customer: Customer | null,
    transactions: Transaction[]
): ReceivableInvoiceRow[] => {
    if (!customer || !Array.isArray(transactions)) return [];

    const sales: ReceivableInvoiceRow[] = transactions
        .filter(t => t && t.status !== 'cancelled' && (t.customerId === customer.id || (t.customerName || '').trim().toLowerCase() === (customer.name || '').trim().toLowerCase()))
        .map(t => ({
            id: t.id,
            invoiceNumber: t.invoiceNumber,
            date: t.date,
            invoiceAmount: Number(t.total || 0),
            received: 0,
            balance: Number(t.total || 0),
            status: 'Open',
            paymentDate: '-',
            paymentMode: String(t.paymentMode || 'Credit'),
            bankName: '-',
            voucherRef: '-',
            latestPaymentEntry: undefined,
        }));

    const mapByInvoice = new Map(sales.map(s => [s.id, { ...s }]));
    const mapByInvoiceNumber = new Map(
        sales
            .filter((s) => String(s.invoiceNumber || '').trim() !== '')
            .map((s) => [String(s.invoiceNumber).trim().toLowerCase(), s.id])
    );
    const ledger = Array.isArray(customer.ledger) ? customer.ledger : [];

    // Expose Opening Balance as a clearable "pseudo-invoice" item if a positive balance exists
    const openingEntries = ledger.filter(e => e && e.type === 'openingBalance' && e.status !== 'cancelled');
    openingEntries.forEach(entry => {
        const obVal = Number(entry.debit || 0) - Number(entry.credit || 0);
        if (obVal > 0) {
            mapByInvoice.set(entry.id, {
                id: entry.id,
                invoiceNumber: 'OPENING-BAL',
                date: entry.date,
                invoiceAmount: obVal,
                received: 0,
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
    if (!hasOpeningEntry && Number(customer.opening_balance || 0) > 0) {
        const obVal = Number(customer.opening_balance || 0);
        mapByInvoice.set('opening-balance-id-fallback', {
            id: 'opening-balance-id-fallback',
            invoiceNumber: 'OPENING-BAL',
            date: new Date().toISOString(),
            invoiceAmount: obVal,
            received: 0,
            balance: obVal,
            status: 'Open',
            paymentDate: '-',
            paymentMode: 'Opening Balance',
            bankName: '-',
            voucherRef: '-',
            latestPaymentEntry: undefined,
        });
    }
    const touchedInvoiceIds = new Set<string>();

    for (const entry of ledger) {
        if (!entry || entry.type !== 'payment' || entry.status === 'cancelled') continue;
        const entryCategory = String(entry.entryCategory || '');
        if (!['invoice_payment_adjustment', 'down_payment_adjustment', 'invoice_payment_adjustment_reversal', 'down_payment_adjustment_reversal'].includes(entryCategory)) {
            continue;
        }
        const invoiceId = entry.referenceInvoiceId
            || mapByInvoiceNumber.get(String(entry.referenceInvoiceNumber || '').trim().toLowerCase())
            || '';
        const target = invoiceId && mapByInvoice.get(invoiceId);
        if (target) {
            const adjustedAmount = Number(entry.adjustedAmount || 0);
            const multiplier = entryCategory.endsWith('_reversal') ? -1 : 1;
            target.received += (adjustedAmount * multiplier);
            target.balance = Number((target.invoiceAmount - target.received).toFixed(2));
            if (target.balance <= 0) {
                target.balance = 0;
                target.status = 'Paid';
            } else if (target.received > 0) {
                target.status = 'Partially Received';
            } else {
                target.status = 'Open';
            }
            target.paymentDate = entry.date || target.paymentDate;
            target.paymentMode = entry.paymentMode || target.paymentMode;
            target.bankName = entry.bankName || target.bankName;
            target.voucherRef = entry.journalEntryNumber || entry.journalEntryId || target.voucherRef;
            target.latestPaymentEntry = entry;
            touchedInvoiceIds.add(target.id);
        }
    }

    for (const sale of sales) {
        const normalizedMode = String(sale.paymentMode || '').trim().toLowerCase();
        const isImmediatePayment = ['cash', 'card', 'upi', 'bank'].includes(normalizedMode);
        if (!isImmediatePayment || touchedInvoiceIds.has(sale.id)) continue;

        const target = mapByInvoice.get(sale.id);
        if (!target) continue;
        target.received = Number(target.invoiceAmount || 0);
        target.balance = 0;
        target.status = 'Paid';
        target.paymentDate = target.paymentDate === '-' ? target.date : target.paymentDate;
        target.voucherRef = target.voucherRef === '-' ? 'AUTO RECEIPT' : target.voucherRef;
    }

    return Array.from(mapByInvoice.values()).sort((a, b) => {
        const timeA = new Date(a.date).getTime();
        const timeB = new Date(b.date).getTime();
        return (Number.isNaN(timeB) ? 0 : timeB) - (Number.isNaN(timeA) ? 0 : timeA);
    });
};

const AccountReceivable: React.FC<AccountReceivableProps> = ({ customers, transactions, bankOptions, onRecordPayment, onRecordDownPaymentAdjustment, onRecordInvoicePaymentAdjustment, onCancelPaymentEntry, currentUser }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
    const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
    const [amount, setAmount] = useState<number | ''>('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [description, setDescription] = useState('Payment Received');
    const [paymentMode, setPaymentMode] = useState('Bank');
    const [bankAccountId, setBankAccountId] = useState('');
    const [showPaymentForm, setShowPaymentForm] = useState(false);
    const [showDownPaymentForm, setShowDownPaymentForm] = useState(false);
    const [adjustAgainstInvoice, setAdjustAgainstInvoice] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
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

    const cashOnlyOptions = useMemo(
        () =>
            bankOptions.filter((option) => {
                const accountType = String(option.accountType || '').toLowerCase();
                const compositeLabel = `${option.bankName} ${option.accountName} ${option.accountNumber}`.toLowerCase();
                return accountType.includes('cash') || compositeLabel.includes('cash');
            }),
        [bankOptions]
    );

    const defaultBank = useMemo(() => bankOnlyOptions.find(b => b.isDefault) || bankOnlyOptions[0] || null, [bankOnlyOptions]);
    const defaultCash = useMemo(() => cashOnlyOptions.find(b => b.isDefault) || cashOnlyOptions[0] || null, [cashOnlyOptions]);

    const customerInvoiceOutstandingMap = useMemo(() => {
        if (!Array.isArray(customers) || !Array.isArray(transactions)) return {} as Record<string, number>;
        return customers.reduce<Record<string, number>>((acc, customer) => {
            const rows = getReceivableInvoiceRowsForCustomer(customer, transactions);
            acc[customer.id] = Number(rows.filter(row => row.invoiceNumber !== 'OPENING-BAL').reduce((sum, row) => sum + Number(row.balance || 0), 0).toFixed(2));
            return acc;
        }, {});
    }, [customers, transactions]);

    const filteredCustomers = useMemo(() => {
        if (!Array.isArray(customers)) return [];
        return customers
            .filter(c => c && c.is_blocked !== true)
            .filter(c => fuzzyMatch(c.name || '', searchTerm) || fuzzyMatch(c.phone || '', searchTerm))
            .sort((a, b) => {
                const left = calculateCustomerReceivableBreakdown(a, customerInvoiceOutstandingMap[a.id] || 0).netOutstanding;
                const right = calculateCustomerReceivableBreakdown(b, customerInvoiceOutstandingMap[b.id] || 0).netOutstanding;
                return right - left;
            });
    }, [customers, searchTerm, customerInvoiceOutstandingMap]);

    useEffect(() => {
        if (!selectedCustomer) return;
        const latestCustomerSnapshot = customers.find((customer) => customer.id === selectedCustomer.id);
        if (!latestCustomerSnapshot) {
            setSelectedCustomer(null);
            setShowPaymentForm(false);
            setShowDownPaymentForm(false);
            setAdjustmentVoucher(null);
            return;
        }
        if (latestCustomerSnapshot !== selectedCustomer) {
            setSelectedCustomer(latestCustomerSnapshot);
        }
    }, [customers, selectedCustomer]);

    const invoiceRows = useMemo(() => {
        return getReceivableInvoiceRowsForCustomer(selectedCustomer, transactions);
    }, [selectedCustomer, transactions]);

    const openReceivableInvoiceRows = useMemo(
        () => invoiceRows.filter((row) => row.balance > 0 && (row.status === 'Open' || row.status === 'Partially Received')),
        [invoiceRows]
    );

    const totalAllocatedAmount = useMemo(
        () => Object.values(invoiceAdjustments).reduce((sum, value) => sum + Number(value || 0), 0),
        [invoiceAdjustments]
    );

    useEffect(() => {
        if (!showPaymentForm || paymentType !== 'against_invoice' || isAmountManuallyEdited) return;
        setAmount(totalAllocatedAmount > 0 ? Number(totalAllocatedAmount.toFixed(2)) : '');
    }, [showPaymentForm, paymentType, totalAllocatedAmount, isAmountManuallyEdited]);

    const ledgerRows = useMemo(() => {
        if (!selectedCustomer) return [];
        const ledger = Array.isArray(selectedCustomer.ledger) ? selectedCustomer.ledger : [];
        const resolved = [...ledger].filter(Boolean);

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

        // Customer is a Debtor. Debit increases balance, Credit decreases balance.
        // If there is an active openingBalance entry, start running balance at 0 to avoid doubling.
        const hasOpeningBalanceEntry = sortedAsc.some(entry => entry.type === 'openingBalance' && entry.status !== 'cancelled');
        let runningBalance = hasOpeningBalanceEntry ? 0 : Number(selectedCustomer.opening_balance || 0);

        const calculated = sortedAsc.map(entry => {
            if (entry.status !== 'cancelled') {
                runningBalance += Number(entry.debit || 0) - Number(entry.credit || 0);
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
    }, [selectedCustomer]);

    const receiptHistoryRows = useMemo(
        () => ledgerRows.filter(item => item.type === 'payment' && (Number(item.credit || 0) > 0 || Number(item.adjustedAmount || 0) !== 0)),
        [ledgerRows]
    );
    const downPaymentRows = useMemo(() => ledgerRows.filter(item => item.type === 'payment' && item.entryCategory === 'down_payment' && item.status !== 'cancelled' && Number(item.credit || 0) > 0), [ledgerRows]);
    const availableAdvanceBalance = useMemo(() => {
        const totalAdvance = downPaymentRows.reduce((sum, row) => sum + Number(row.credit || 0), 0);
        const totalAdjusted = ledgerRows
            .filter(item => item.entryCategory === 'down_payment_adjustment' || item.entryCategory === 'down_payment_adjustment_reversal')
            .reduce((sum, item) => sum + Number(item.adjustedAmount || 0), 0);
        return Number((totalAdvance - totalAdjusted).toFixed(2));
    }, [downPaymentRows, ledgerRows]);

    const getVoucherAllocationSummary = (voucher: TransactionLedgerItem): VoucherAllocationSummary => {
        const originalAmount = Number(voucher.credit || voucher.debit || 0);
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

    const invoiceOutstandingTotal = useMemo(
        () => Number(invoiceRows.filter(row => row.invoiceNumber !== 'OPENING-BAL').reduce((sum, row) => sum + Number(row.balance || 0), 0).toFixed(2)),
        [invoiceRows]
    );
    const receivableBreakdown = useMemo(
        () => calculateCustomerReceivableBreakdown(selectedCustomer, invoiceOutstandingTotal),
        [selectedCustomer, invoiceOutstandingTotal]
    );
    const grossOutstanding = receivableBreakdown.grossReceivable;
    const totalAdjustedReceipt = receivableBreakdown.adjustedReceipts;
    const totalUnadjustedReceipt = receivableBreakdown.unadjustedAdvance;
    const netReceivable = receivableBreakdown.netOutstanding;

    const printVoucher = (entry: TransactionLedgerItem) => {
        setPrintingVoucher(entry);
    };

    const openPaymentPanel = () => {
        setShowPaymentForm(true);
        setShowDownPaymentForm(false);
        setAmount('');
        setDescription('Payment Received');
        setSelectedInvoiceId('');
        setPaymentType('against_invoice');
        setInvoiceAdjustments({});
        setIsAmountManuallyEdited(false);
        setPaymentMode('Bank');
        setBankAccountId(defaultBank?.id || '');
        setSubmitError('');
    };

    const openDownPaymentPanel = () => {
        setShowDownPaymentForm(true);
        setShowPaymentForm(false);
        setAmount('');
        setDescription('Advance Received');
        setPaymentMode('Bank');
        setSelectedInvoiceId('');
        setAdjustAgainstInvoice(false);
        setInvoiceAdjustments({});
        setIsAmountManuallyEdited(false);
        setBankAccountId(defaultBank?.id || '');
        setSubmitError('');
    };

    useEffect(() => {
        if (isCashMode) {
            if (!bankAccountId) {
                setBankAccountId(defaultCash?.id || '');
            } else if (!cashOnlyOptions.some((option) => option.id === bankAccountId)) {
                setBankAccountId(defaultCash?.id || '');
            }
            return;
        }
        if (!bankAccountId) {
            setBankAccountId(defaultBank?.id || '');
        } else if (!bankOnlyOptions.some((option) => option.id === bankAccountId)) {
            setBankAccountId(defaultBank?.id || '');
        }
    }, [isCashMode, bankAccountId, defaultBank, defaultCash, bankOnlyOptions, cashOnlyOptions]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedCustomer || !amount || amount <= 0) return;
        if (!bankAccountId && !isCashMode) return;
        const enteredPaymentAmount = Number(amount);
        const allocations = Object.entries(invoiceAdjustments)
            .map(([invoiceId, allocated]) => ({ invoiceId, allocated: Number(allocated || 0) }))
            .filter(({ allocated }) => allocated > 0);
        const totalAllocated = Number(allocations.reduce((sum, item) => sum + item.allocated, 0).toFixed(2));
        const paymentAmount = paymentType === 'against_invoice' && allocations.length > 0 ? totalAllocated : enteredPaymentAmount;

        if (paymentType === 'against_invoice') {
            if (allocations.length === 0) {
                throw new Error('Please select at least one invoice allocation.');
            }
            setAmount(paymentAmount);
            if (isAmountManuallyEdited && Math.abs(totalAllocated - enteredPaymentAmount) > 0.001) {
                throw new Error('Payment Amount does not match total invoice allocation. Please adjust invoice-wise amounts or payment amount before posting.');
            }
            for (const allocation of allocations) {
                const invoice = openReceivableInvoiceRows.find((row) => row.id === allocation.invoiceId);
                if (!invoice) throw new Error('One or more selected invoices are already fully settled or unavailable.');
                if (allocation.allocated > invoice.balance + 0.001) throw new Error(`Allocated amount exceeds pending balance for invoice ${invoice.id}.`);
            }
        }

        setIsSubmitting(true);
        setSubmitError('');
        try {
            const paymentResult = await onRecordPayment({
                customerId: selectedCustomer.id,
                amount: paymentAmount,
                date,
                description,
                paymentMode,
                bankAccountId,
                referenceInvoiceId: paymentType === 'against_invoice' && allocations.length === 1 ? allocations[0].invoiceId : undefined,
                referenceInvoiceNumber: paymentType === 'against_invoice' && allocations.length === 1 ? allocations[0].invoiceId : undefined,
                entryCategory: 'invoice_payment',
            });
            if (paymentType === 'against_invoice') {
                for (const allocation of allocations) {
                    const invoice = invoiceRows.find(i => i.id === allocation.invoiceId);
                    if (!invoice) continue;
                    await onRecordInvoicePaymentAdjustment({
                        customerId: selectedCustomer.id,
                        date,
                        sourcePaymentId: paymentResult.ledgerEntryId,
                        referenceInvoiceId: invoice.id,
                        referenceInvoiceNumber: invoice.id,
                        amount: allocation.allocated,
                        description: 'Payment adjusted against invoice',
                    });
                }
            }
            setShowPaymentForm(false);
            setAmount('');
            setDescription('Payment Received');
            setIsAmountManuallyEdited(false);
            setSubmitError('');
        } catch (error) {
            const message = error instanceof Error ? error.message : ((error as any)?.message || JSON.stringify(error) || 'Unable to post customer receipt. Please try again.');
            setSubmitError(message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDownPaymentSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedCustomer || !amount || amount <= 0) return;
        if (!bankAccountId && !isCashMode) return;

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
                customerId: selectedCustomer.id,
                amount: enteredAmount,
                date,
                description: description || 'Advance Received',
                paymentMode,
                bankAccountId,
                entryCategory: 'down_payment',
            });
            for (const allocation of allocations) {
                const invoice = invoiceRows.find(row => row.id === allocation.invoiceId);
                if (!invoice) continue;
                await onRecordDownPaymentAdjustment({
                    customerId: selectedCustomer.id,
                    date,
                    downPaymentId: downPaymentResult.ledgerEntryId,
                    referenceInvoiceId: invoice.id,
                    referenceInvoiceNumber: invoice.id,
                    amount: allocation.allocated,
                    description: 'Advance adjusted against invoice',
                });
            }
            setShowDownPaymentForm(false);
            setAmount('');
            setDescription('Advance Received');
            setAdjustAgainstInvoice(false);
            setInvoiceAdjustments({});
            setSubmitError('');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to post customer down payment. Please try again.';
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
        if (!selectedCustomer || !adjustmentVoucher) return;
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
                const invoice = openReceivableInvoiceRows.find((row) => row.id === allocation.invoiceId);
                if (!invoice) throw new Error('One or more invoices are unavailable for adjustment.');
                if (allocation.allocated > invoice.balance + 0.001) throw new Error(`Allocated amount exceeds pending balance for invoice ${invoice.invoiceNumber || invoice.id}.`);
                if (adjustmentVoucher.entryCategory === 'down_payment') {
                    await onRecordDownPaymentAdjustment({
                        customerId: selectedCustomer.id,
                        date: adjustmentDate,
                        downPaymentId: adjustmentVoucher.id,
                        referenceInvoiceId: invoice.id,
                        referenceInvoiceNumber: invoice.invoiceNumber || invoice.id,
                        amount: allocation.allocated,
                        description: 'Receipt advance adjusted against old / pending invoice',
                    });
                } else {
                    await onRecordInvoicePaymentAdjustment({
                        customerId: selectedCustomer.id,
                        date: adjustmentDate,
                        sourcePaymentId: adjustmentVoucher.id,
                        referenceInvoiceId: invoice.id,
                        referenceInvoiceNumber: invoice.invoiceNumber || invoice.id,
                        amount: allocation.allocated,
                        description: 'Receipt adjusted against old / pending invoice',
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
        if (!selectedCustomer || entry.status === 'cancelled') return;
        const reason = window.prompt('Enter cancellation reason', 'User requested cancellation');
        if (!reason) return;
        await onCancelPaymentEntry({
            ownerType: 'customer',
            ownerId: selectedCustomer.id,
            paymentEntryId: entry.id,
            cancellationDate: new Date().toISOString().split('T')[0],
            reason,
        });
    };

    return (
        <main className="flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg" onKeyDown={handleEnterToNextField}>
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Sundry Debtors (Receivable)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Debtors: {customers.length}</span>
            </div>

            <div className="p-4 flex-1 flex gap-4 min-h-0 overflow-hidden">
                <Card className="w-1/3 flex flex-col p-0 tally-border overflow-hidden bg-white">
                    <div className="p-3 border-b border-gray-400 bg-gray-50 flex-shrink-0">
                        <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Search Ledger</label>
                        <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Name or Phone..." className="w-full border border-gray-400 p-2 text-sm font-bold focus:bg-yellow-50 outline-none" />
                    </div>
                    <div className="flex-1 overflow-y-auto divide-y divide-gray-200">
                        {filteredCustomers.map(c => {
                            const balance = calculateCustomerReceivableBreakdown(c, customerInvoiceOutstandingMap[c.id] || 0).netOutstanding;
                            const isSelected = selectedCustomer?.id === c.id;
                            return (
                                <button 
                                    key={c.id} 
                                    onClick={() => { setSelectedCustomer(c); setShowPaymentForm(false); }} 
                                    className={`w-full text-left p-4 transition-all group ${isSelected ? 'bg-primary text-white shadow-lg' : 'hover:bg-primary hover:text-white'}`}
                                >
                                    <div className="flex justify-between items-start">
                                        <div className="min-w-0 flex-1">
                                            <p className={`${uniformTextStyle} truncate ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{c.name}</p>
                                            <p className={`${uniformTextStyle} !text-base mt-1 ${isSelected ? 'text-white/70' : 'text-gray-500 group-hover:text-white/70'}`}>{c.phone || 'No Phone'}</p>
                                        </div>
                                        <div className="text-right ml-2">
                                            <p className={`${uniformTextStyle} ${isSelected ? 'text-white' : (balance > 0 ? 'text-red-700 font-black group-hover:text-white' : 'text-emerald-700 font-black group-hover:text-white')}`}>₹{balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </Card>

                <Card className="flex-1 p-6 tally-border bg-white overflow-y-auto">
                    {selectedCustomer ? (
                        <div className="space-y-4">
                            <div className="flex items-start justify-between">
                                <div>
                                    <h2 className={`${uniformTextStyle} !text-3xl text-primary`}>{selectedCustomer.name}</h2>
                                    <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-black uppercase">
                                        <div className="text-gray-500">Gross Receivable: <span className="text-red-600">₹{grossOutstanding.toFixed(2)}</span></div>
                                        <div className="text-gray-500">Adjusted Receipt: <span className="text-primary">₹{totalAdjustedReceipt.toFixed(2)}</span></div>
                                        <div className="text-emerald-700">Available Advance / Unadjusted Receipt: ₹{totalUnadjustedReceipt.toFixed(2)}</div>
                                        <div className="text-gray-500">Net Outstanding Receivable: <span className="text-red-700 text-lg">₹{netReceivable.toFixed(2)}</span></div>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button className="px-6 py-2 tally-button-primary text-xs font-black uppercase" onClick={openPaymentPanel}>Payment</button>
                                    <button className="px-6 py-2 tally-button-primary text-xs font-black uppercase" onClick={openDownPaymentPanel}>Down Payment</button>
                                </div>
                            </div>

                            {showPaymentForm && (
                                <form onSubmit={handleSubmit} className="border border-gray-300 p-4 grid grid-cols-3 gap-3">
                                    <select
                                        value={paymentType}
                                        onChange={e => {
                                            const nextPaymentType = e.target.value as 'against_invoice' | 'on_account';
                                            setPaymentType(nextPaymentType);
                                            if (nextPaymentType === 'against_invoice') {
                                                setIsAmountManuallyEdited(false);
                                            }
                                        }}
                                        className="border border-gray-300 p-2 text-xs font-bold"
                                    >
                                        <option value="against_invoice">Against Invoice</option>
                                        <option value="on_account">On Account</option>
                                    </select>
                                    <input type="number" required value={amount} onChange={e => { setAmount(parseFloat(e.target.value) || ''); setIsAmountManuallyEdited(true); }} className="border border-gray-300 p-2 text-xs font-bold" placeholder="Amount received" />
                                    <input type="date" required value={date} onChange={e => setDate(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold" />
                                    <select value={paymentMode} onChange={e => setPaymentMode(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold">
                                        <option>Bank</option><option>Cash</option><option>UPI</option><option>Card</option>
                                    </select>
                                    {isCashMode ? (
                                        <select value={bankAccountId} onChange={e => setBankAccountId(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold">
                                            <option value="">{cashOnlyOptions.length ? 'Select Cash Account' : 'Use Default Cash Ledger'}</option>
                                            {cashOnlyOptions.map(b => <option key={b.id} value={b.id}>{b.bankName} - {b.accountNumber || b.accountName}</option>)}
                                        </select>
                                    ) : (
                                        <select required value={bankAccountId} onChange={e => setBankAccountId(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold">
                                            <option value="">Select Bank / Cash Account</option>
                                            {bankOnlyOptions.map(b => <option key={b.id} value={b.id}>{b.bankName} - {b.accountNumber || b.accountName}</option>)}
                                        </select>
                                    )}
                                    <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold" placeholder="Narration" />
                                    {paymentType === 'against_invoice' && openReceivableInvoiceRows.map(inv => (
                                        <div key={inv.id} className="col-span-3 grid grid-cols-5 gap-2">
                                            <div className="border border-gray-200 p-2 text-xs font-bold">{formatVoucherNo(inv.invoiceNumber || inv.id)}</div>
                                            <div className="border border-gray-200 p-2 text-xs">Date {formatDisplayDate(inv.date)}</div>
                                            <div className="border border-gray-200 p-2 text-xs">Original ₹{inv.invoiceAmount.toFixed(2)}</div>
                                            <div className="border border-gray-200 p-2 text-xs">Balance ₹{inv.balance.toFixed(2)}</div>
                                            <input
                                                type="number"
                                                min={0}
                                                max={inv.balance}
                                                value={invoiceAdjustments[inv.id] ?? ''}
                                                onChange={e => {
                                                    const parsedValue = parseFloat(e.target.value);
                                                    setIsAmountManuallyEdited(false);
                                                    setInvoiceAdjustments(prev => {
                                                        if (Number.isNaN(parsedValue) || parsedValue <= 0) {
                                                            const { [inv.id]: _removed, ...rest } = prev;
                                                            return rest;
                                                        }
                                                        return { ...prev, [inv.id]: Math.min(parsedValue, inv.balance) };
                                                    });
                                                }}
                                                className="border border-gray-300 p-2 text-xs font-bold"
                                                placeholder="Allocate"
                                            />
                                        </div>
                                    ))}
                                    {paymentType === 'against_invoice' && isAmountManuallyEdited && Math.abs(Number(amount || 0) - totalAllocatedAmount) > 0.001 && (
                                        <p className="col-span-3 text-xs font-bold text-amber-700">Payment Amount does not match total invoice allocation. Please adjust invoice-wise amounts or payment amount before posting.</p>
                                    )}
                                    <div className="col-span-3 flex justify-end gap-2">
                                        <button type="button" onClick={() => setShowPaymentForm(false)} className="px-4 py-2 border border-gray-400 text-xs font-black uppercase">Cancel</button>
                                        <button type="submit" disabled={isSubmitting || !amount || Number(amount) <= 0 || (!isCashMode && !bankAccountId)} className="px-4 py-2 tally-button-primary text-xs font-black uppercase">{isSubmitting ? 'Posting...' : 'Post Payment'}</button>
                                    </div>
                                    {submitError && <p className="col-span-3 text-xs font-bold text-red-700">{submitError}</p>}
                                </form>
                            )}

                            {showDownPaymentForm && (
                                <form onSubmit={handleDownPaymentSubmit} className="border border-gray-300 p-4 grid grid-cols-3 gap-3">
                                    <input type="text" disabled value={selectedCustomer.name} className="border border-gray-300 p-2 text-xs font-bold bg-gray-100" />
                                    <input type="number" required value={amount} onChange={e => setAmount(parseFloat(e.target.value) || '')} className="border border-gray-300 p-2 text-xs font-bold" placeholder="Down payment amount" />
                                    <input type="date" required value={date} onChange={e => setDate(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold" />
                                    <select value={paymentMode} onChange={e => setPaymentMode(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold">
                                        <option>Bank</option><option>Cash</option><option>UPI</option>
                                    </select>
                                    {isCashMode ? (
                                        <select value={bankAccountId} onChange={e => setBankAccountId(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold">
                                            <option value="">{cashOnlyOptions.length ? 'Select Cash Account' : 'Use Default Cash Ledger'}</option>
                                            {cashOnlyOptions.map(b => <option key={b.id} value={b.id}>{b.bankName} - {b.accountNumber || b.accountName}</option>)}
                                        </select>
                                    ) : (
                                        <select required value={bankAccountId} onChange={e => setBankAccountId(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold">
                                            <option value="">Select Bank / Cash Account</option>
                                            {bankOnlyOptions.map(b => <option key={b.id} value={b.id}>{b.bankName} - {b.accountNumber || b.accountName}</option>)}
                                        </select>
                                    )}
                                    <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="border border-gray-300 p-2 text-xs font-bold" placeholder="Reference / note" />
                                    <label className="col-span-3 inline-flex items-center gap-2 text-xs font-black uppercase">
                                        <input type="checkbox" checked={adjustAgainstInvoice} onChange={e => setAdjustAgainstInvoice(e.target.checked)} />
                                        Adjust Against Invoice
                                    </label>
                                    {adjustAgainstInvoice && invoiceRows.filter(inv => inv.balance > 0).map(inv => (
                                        <div key={inv.id} className="col-span-3 grid grid-cols-3 gap-3">
                                            <div className="border border-gray-200 p-2 text-xs font-bold">{formatVoucherNo(inv.invoiceNumber || inv.id)} | Pending ₹{inv.balance.toFixed(2)}</div>
                                            <input
                                                type="number"
                                                min={0}
                                                max={inv.balance}
                                                value={invoiceAdjustments[inv.id] ?? ''}
                                                onChange={e => setInvoiceAdjustments(prev => ({ ...prev, [inv.id]: parseFloat(e.target.value) || 0 }))}
                                                className="border border-gray-300 p-2 text-xs font-bold"
                                                placeholder="Adjust amount"
                                            />
                                        </div>
                                    ))}
                                    <div className="col-span-3 flex justify-end gap-2">
                                        <button type="button" onClick={() => setShowDownPaymentForm(false)} className="px-4 py-2 border border-gray-400 text-xs font-black uppercase">Cancel</button>
                                        <button type="submit" disabled={isSubmitting || !amount || Number(amount) <= 0 || (!isCashMode && !bankAccountId)} className="px-4 py-2 tally-button-primary text-xs font-black uppercase">{isSubmitting ? 'Posting...' : 'Post Down Payment'}</button>
                                    </div>
                                    {submitError && <p className="col-span-3 text-xs font-bold text-red-700">{submitError}</p>}
                                </form>
                            )}

                            <div>
                                <p className="text-[10px] font-black uppercase tracking-wider mb-2">Invoice wise receivable</p>
                                <div className="overflow-auto border border-gray-200">
                                    <table className="min-w-full text-xs">
                                        <thead className="bg-gray-100 uppercase">
                                            <tr>
                                                <th className="p-2 text-left">Invoice</th><th className="p-2 text-left">Invoice Amount</th><th className="p-2 text-left">Amount Received</th><th className="p-2 text-left">Balance</th><th className="p-2 text-left">Payment Date</th><th className="p-2 text-left">Payment Mode</th><th className="p-2 text-left">Bank</th><th className="p-2 text-left">Journal/Voucher</th><th className="p-2 text-left">Print Voucher</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {invoiceRows.map(row => (
                                                <tr key={row.id} className="border-t">
                                                    <td className="p-2 font-bold">{formatVoucherNo(row.invoiceNumber || row.id)}</td>
                                                    <td className="p-2">₹{row.invoiceAmount.toFixed(2)}</td>
                                                    <td className="p-2 text-emerald-700">₹{row.received.toFixed(2)}</td>
                                                    <td className="p-2 text-red-700">₹{row.balance.toFixed(2)}</td>
                                                    <td className="p-2">{row.paymentDate}</td>
                                                    <td className="p-2">{row.paymentMode}</td>
                                                    <td className="p-2">{row.bankName}</td>
                                                    <td className="p-2">{row.voucherRef}</td>
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
                                <p className="text-[10px] font-black uppercase tracking-wider mb-2">Receipt / Payment history</p>
                                <div className="overflow-auto border border-gray-200">
                                    <table className="min-w-full text-xs">
                                        <thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Date</th><th className="p-2 text-left">Type</th><th className="p-2 text-left">Receipt Against</th><th className="p-2 text-left">Payment Mode</th><th className="p-2 text-left">Bank/Cash Account</th><th className="p-2 text-left">Narration</th><th className="p-2 text-left">Voucher Amount</th><th className="p-2 text-left">Adjusted</th><th className="p-2 text-left">Unadjusted</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Voucher No.</th><th className="p-2 text-left">Actions</th></tr></thead>
                                        <tbody>
                                            {receiptHistoryRows.length === 0 ? (
                                                <tr><td className="p-3 text-center text-gray-500" colSpan={12}>No payment receipts posted yet.</td></tr>
                                            ) : receiptHistoryRows.map(item => (
                                                <tr key={item.id} className="border-t">
                                                    {(() => {
                                                        const summary = getVoucherAllocationSummary(item);
                                                        const isAdjustableVoucher = (item.entryCategory === 'invoice_payment' || item.entryCategory === 'down_payment') && item.status !== 'cancelled' && summary.remainingAmount > 0;
                                                        return (
                                                            <>
                                                    <td className="p-2">{formatDisplayDate(item.date)}</td>
                                                    <td className="p-2">{item.entryCategory === 'down_payment' ? 'DOWN PAYMENT' : item.entryCategory === 'down_payment_adjustment' ? 'DP ADJUSTMENT' : item.entryCategory === 'invoice_payment_adjustment' ? 'INVOICE ADJUSTMENT' : item.entryCategory === 'payment_cancellation' || item.entryCategory === 'down_payment_cancellation' ? 'CANCELLATION' : 'PAYMENT'}</td>
                                                    <td className="p-2">{formatVoucherNo(item.referenceInvoiceNumber || item.referenceInvoiceId) || '-'}</td>
                                                    <td className="p-2">{item.paymentMode || '-'}</td>
                                                    <td className="p-2">{item.bankName || '-'}</td>
                                                    <td className="p-2">{item.entryCategory === 'down_payment' ? 'Advance Received' : item.description}</td>
                                                    <td className="p-2 font-bold">₹{Number(item.credit || item.debit || 0).toFixed(2)}</td>
                                                    <td className="p-2">₹{summary.adjustedAmount.toFixed(2)}</td>
                                                    <td className="p-2">₹{summary.remainingAmount.toFixed(2)}</td>
                                                    <td className="p-2">{summary.status}</td>
                                                    <td className="p-2">{formatVoucherNo(item.journalEntryNumber || item.journalEntryId) || '-'}</td>
                                                    <td className="p-2 flex gap-2">
                                                        <button type="button" onClick={() => printVoucher(item)} className="px-2 py-1 border border-gray-300 font-bold uppercase text-[10px] hover:bg-gray-100">Print</button>
                                                        {(item.entryCategory === 'invoice_payment' || item.entryCategory === 'down_payment') && item.status !== 'cancelled' && (
                                                            <button type="button" onClick={() => handleCancelEntry(item)} className="px-2 py-1 border border-red-300 text-red-700 font-bold uppercase text-[10px] hover:bg-red-50">Cancel</button>
                                                        )}
                                                        {isAdjustableVoucher && (
                                                            <button type="button" onClick={() => openVoucherAdjustmentModal(item)} className="px-2 py-1 border border-primary text-primary font-bold uppercase text-[10px] hover:bg-blue-50">Adjust Receipt / Clear Against Invoice</button>
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
                                                    <td className="p-2">{item.date}</td>
                                                    <td className="p-2 uppercase">{item.type}</td>
                                                    <td className="p-2">{item.description}</td>
                                                    <td className="p-2">₹{Number(item.debit || 0).toFixed(2)}</td>
                                                    <td className="p-2">₹{Number(item.credit || 0).toFixed(2)}</td>
                                                    <td className="p-2 font-bold">₹{Number(item.balance || 0).toFixed(2)}</td>
                                                    <td className="p-2">{formatVoucherNo(item.journalEntryNumber || item.journalEntryId) || '-'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            <Modal isOpen={Boolean(adjustmentVoucher)} onClose={() => setAdjustmentVoucher(null)} title="Adjust Receipt / Clear Against Invoice" widthClass="max-w-5xl">
                                {adjustmentVoucher && (
                                    <div className="space-y-4">
                                        {(() => {
                                            const summary = getVoucherAllocationSummary(adjustmentVoucher);
                                            const voucherNumber = adjustmentVoucher.journalEntryNumber || adjustmentVoucher.journalEntryId || adjustmentVoucher.id;
                                            return (
                                                <>
                                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                                                        <div><span className="font-black uppercase text-gray-500">Voucher No.</span><div>{voucherNumber}</div></div>
                                                        <div><span className="font-black uppercase text-gray-500">Voucher Date</span><div>{formatDisplayDate(adjustmentVoucher.date)}</div></div>
                                                        <div><span className="font-black uppercase text-gray-500">Party Name</span><div>{selectedCustomer.name}</div></div>
                                                        <div><span className="font-black uppercase text-gray-500">Original Voucher Amount</span><div>₹{Number(adjustmentVoucher.credit || adjustmentVoucher.debit || 0).toFixed(2)}</div></div>
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
                                                            <thead className="bg-gray-100 uppercase"><tr><th className="p-2 text-left">Invoice No.</th><th className="p-2 text-left">Invoice Date</th><th className="p-2 text-left">Invoice Amount</th><th className="p-2 text-left">Already Received</th><th className="p-2 text-left">Outstanding</th><th className="p-2 text-left">Allocate Amount</th></tr></thead>
                                                            <tbody>
                                                                {openReceivableInvoiceRows.length === 0 ? (
                                                                    <tr><td colSpan={6} className="p-3 text-center text-gray-500">No open invoices available.</td></tr>
                                                                ) : openReceivableInvoiceRows.map((row) => (
                                                                    <tr key={row.id} className="border-t">
                                                                        <td className="p-2">{formatVoucherNo(row.invoiceNumber || row.id)}</td>
                                                                        <td className="p-2">{formatDisplayDate(row.date)}</td>
                                                                        <td className="p-2">₹{row.invoiceAmount.toFixed(2)}</td>
                                                                        <td className="p-2">₹{row.received.toFixed(2)}</td>
                                                                        <td className="p-2">₹{row.balance.toFixed(2)}</td>
                                                                        <td className="p-2"><input type="number" min={0} max={Math.min(row.balance, summary.remainingAmount)} value={voucherInvoiceAdjustments[row.id] ?? ''} onChange={e => setVoucherInvoiceAdjustments(prev => ({ ...prev, [row.id]: Math.min(parseFloat(e.target.value) || 0, row.balance) }))} className="w-full border border-gray-300 p-2" placeholder="Allocate" /></td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                    <div className="flex justify-end gap-2">
                                                        <button type="button" onClick={() => setAdjustmentVoucher(null)} className="px-3 py-2 border border-gray-300 text-xs font-black uppercase">Close</button>
                                                        <button type="button" disabled={isSubmitting} onClick={handleVoucherAdjustmentSubmit} className="px-4 py-2 tally-button-primary text-xs font-black uppercase">{isSubmitting ? 'Adjusting...' : 'Adjust Receipt / Clear Against Invoice'}</button>
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
                            <p className="text-2xl font-black uppercase tracking-[0.2em]">Select Ledger to review receivables</p>
                        </div>
                    )}
                </Card>
            </div>
            <PrintCustomerVoucherModal
                isOpen={Boolean(printingVoucher)}
                onClose={() => setPrintingVoucher(null)}
                voucher={printingVoucher}
                customer={selectedCustomer}
                pharmacy={currentUser}
                bankOptions={bankOptions}
                summary={printingVoucher ? getVoucherAllocationSummary(printingVoucher) : null}
            />
        </main>
    );
};

export default AccountReceivable;
