import type { Customer, Distributor, Transaction } from '@core/types';
import type { TransactionLedgerItem } from '@core/types';

const round2 = (value: number): number => Number((Number(value || 0)).toFixed(2));

const getLedgerAmount = (entry: TransactionLedgerItem): number => {
    const credit = Number(entry.credit || 0);
    if (credit > 0) return credit;
    return Number(entry.debit || 0);
};

const getOpeningBalanceSignedFromLedger = (ledger: TransactionLedgerItem[]): number | null => {
    const openingEntries = ledger.filter((entry) => entry && entry.type === 'openingBalance' && entry.status !== 'cancelled');
    if (openingEntries.length === 0) return null;
    return round2(openingEntries.reduce((sum, entry) => sum + Number(entry.credit || 0) - Number(entry.debit || 0), 0));
};

const getLinkedAdjustedAmount = (ledger: TransactionLedgerItem[], paymentEntry: TransactionLedgerItem): number => {
    if (!paymentEntry?.id) return 0;
    const adjusted = ledger
        .filter((row) => row && row.status !== 'cancelled')
        .reduce((sum, row) => {
            if (paymentEntry.entryCategory === 'down_payment' && row.entryCategory === 'down_payment_adjustment' && row.sourceDownPaymentId === paymentEntry.id) {
                return sum + Number(row.adjustedAmount || 0);
            }
            if (paymentEntry.entryCategory !== 'down_payment' && row.entryCategory === 'invoice_payment_adjustment' && row.sourcePaymentId === paymentEntry.id) {
                return sum + Number(row.adjustedAmount || 0);
            }
            return sum;
        }, 0);
    return round2(adjusted);
};

export interface SupplierPayableBreakdown {
    openingBalanceSigned: number;
    openingPayable: number;
    openingAdvance: number;
    purchaseInvoices: number;
    purchaseReturns: number;
    adjustedPayments: number;
    unadjustedAdvance: number;
    grossPayable: number;
    netOutstanding: number;
}

export interface CustomerReceivableBreakdown {
    openingBalanceSigned: number;
    openingReceivable: number;
    openingAdvance: number;
    salesInvoices: number;
    salesReturns: number;
    adjustedReceipts: number;
    unadjustedAdvance: number;
    grossReceivable: number;
    netOutstanding: number;
}

const getOpeningSignedForSupplier = (ledger: TransactionLedgerItem[], supplier: Distributor): number => {
    const openingFromLedger = getOpeningBalanceSignedFromLedger(ledger);
    return round2(openingFromLedger ?? Number((supplier as any).opening_balance || (supplier as any).openingBalance || 0));
};

const getOpeningSignedForCustomer = (ledger: TransactionLedgerItem[], customer: Customer): number => {
    const openingEntrySigned = ledger
        .filter((entry) => entry && entry.type === 'openingBalance' && entry.status !== 'cancelled')
        .reduce((sum, entry) => sum + Number(entry.debit || 0) - Number(entry.credit || 0), 0);
    if (ledger.some((entry) => entry && entry.type === 'openingBalance' && entry.status !== 'cancelled')) {
        return round2(openingEntrySigned);
    }
    return round2(Number((customer as any).opening_balance || (customer as any).openingBalance || 0));
};

export const calculateSupplierPayableBreakdown = (
    supplier: Distributor | null | undefined,
    invoiceOutstandingTotal: number = 0
): SupplierPayableBreakdown => {
    if (!supplier) {
        return {
            openingBalanceSigned: 0,
            openingPayable: 0,
            openingAdvance: 0,
            purchaseInvoices: 0,
            purchaseReturns: 0,
            adjustedPayments: 0,
            unadjustedAdvance: 0,
            grossPayable: 0,
            netOutstanding: 0,
        };
    }

    const ledger = Array.isArray(supplier.ledger) ? supplier.ledger.filter(Boolean) : [];
    const openingBalanceSigned = getOpeningSignedForSupplier(ledger, supplier);
    const openingPayable = round2(Math.max(openingBalanceSigned, 0));
    const openingAdvance = round2(Math.max(-openingBalanceSigned, 0));

    const purchaseInvoices = round2(
        ledger
            .filter((row) => row.status !== 'cancelled' && row.type === 'purchase')
            .reduce((sum, row) => sum + Number(row.credit || 0), 0)
    );

    const purchaseReturns = round2(
        ledger
            .filter((row) => row.status !== 'cancelled' && row.type === 'return')
            .reduce((sum, row) => sum + Number(row.debit || 0), 0)
    );

    const adjustedPayments = round2(
        ledger
            .filter((row) => row.status !== 'cancelled' && (row.entryCategory === 'invoice_payment_adjustment' || row.entryCategory === 'down_payment_adjustment'))
            .reduce((sum, row) => sum + Number(row.adjustedAmount || 0), 0)
    );

    const paymentVouchers = ledger.filter(
        (row) =>
            row.status !== 'cancelled' &&
            row.type === 'payment' &&
            (row.entryCategory === 'invoice_payment' || row.entryCategory === 'down_payment')
    );

    const unadjustedVoucherPayments = round2(
        paymentVouchers.reduce((sum, row) => {
            const remaining = Math.max(round2(getLedgerAmount(row) - getLinkedAdjustedAmount(ledger, row)), 0);
            return sum + remaining;
        }, 0)
    );

    const openingAdjustments = round2(
        ledger
            .filter((row) => row.status !== 'cancelled' && (row.entryCategory === 'invoice_payment_adjustment' || row.entryCategory === 'down_payment_adjustment'))
            .filter((row) => row.referenceInvoiceId === 'opening-balance-id-fallback' || row.referenceInvoiceNumber === 'OPENING-BAL' || ledger.some(e => e.id === row.referenceInvoiceId && e.type === 'openingBalance'))
            .reduce((sum, row) => sum + Number(row.adjustedAmount || 0), 0)
    );
    const openingPayableOutstanding = round2(Math.max(openingPayable - openingAdjustments, 0));

    const invoiceOutstanding = round2(Math.max(invoiceOutstandingTotal, 0));
    const grossRaw = round2(openingPayableOutstanding + invoiceOutstanding - purchaseReturns);
    const grossPayable = round2(Math.max(grossRaw, 0));
    const returnDrivenAdvance = round2(Math.max(-grossRaw, 0));
    const unadjustedAdvance = round2(openingAdvance + unadjustedVoucherPayments + returnDrivenAdvance);
    const netOutstanding = round2(grossPayable - unadjustedAdvance);

    return {
        openingBalanceSigned,
        openingPayable,
        openingAdvance,
        purchaseInvoices,
        purchaseReturns,
        adjustedPayments,
        unadjustedAdvance,
        grossPayable,
        netOutstanding,
    };
};

export const calculateCustomerReceivableBreakdown = (
    customer: Customer | null | undefined,
    invoiceOutstandingTotal: number = 0
): CustomerReceivableBreakdown => {
    if (!customer) {
        return {
            openingBalanceSigned: 0,
            openingReceivable: 0,
            openingAdvance: 0,
            salesInvoices: 0,
            salesReturns: 0,
            adjustedReceipts: 0,
            unadjustedAdvance: 0,
            grossReceivable: 0,
            netOutstanding: 0,
        };
    }

    const ledger = Array.isArray(customer.ledger) ? customer.ledger.filter(Boolean) : [];
    const openingBalanceSigned = getOpeningSignedForCustomer(ledger, customer);
    const openingReceivable = round2(Math.max(openingBalanceSigned, 0));
    const openingAdvance = round2(Math.max(-openingBalanceSigned, 0));

    const salesInvoices = round2(
        ledger
            .filter((row) => row.status !== 'cancelled' && row.type === 'sale')
            .reduce((sum, row) => sum + Number(row.debit || 0), 0)
    );

    const salesReturns = round2(
        ledger
            .filter((row) => row.status !== 'cancelled' && row.type === 'return')
            .reduce((sum, row) => sum + Number(row.credit || 0), 0)
    );

    const adjustedReceipts = round2(
        ledger
            .filter((row) => row.status !== 'cancelled' && (row.entryCategory === 'invoice_payment_adjustment' || row.entryCategory === 'down_payment_adjustment'))
            .reduce((sum, row) => sum + Number(row.adjustedAmount || 0), 0)
    );

    const receiptVouchers = ledger.filter(
        (row) =>
            row.status !== 'cancelled' &&
            row.type === 'payment' &&
            (row.entryCategory === 'invoice_payment' || row.entryCategory === 'down_payment')
    );
    const unadjustedVoucherReceipts = round2(
        receiptVouchers.reduce((sum, row) => {
            const remaining = Math.max(round2(getLedgerAmount(row) - getLinkedAdjustedAmount(ledger, row)), 0);
            return sum + remaining;
        }, 0)
    );

    const openingAdjustments = round2(
        ledger
            .filter((row) => row.status !== 'cancelled' && (row.entryCategory === 'invoice_payment_adjustment' || row.entryCategory === 'down_payment_adjustment'))
            .filter((row) => row.referenceInvoiceId === 'opening-balance-id-fallback' || row.referenceInvoiceNumber === 'OPENING-BAL' || ledger.some(e => e.id === row.referenceInvoiceId && e.type === 'openingBalance'))
            .reduce((sum, row) => sum + Number(row.adjustedAmount || 0), 0)
    );
    const openingReceivableOutstanding = round2(Math.max(openingReceivable - openingAdjustments, 0));

    const invoiceOutstanding = round2(Math.max(invoiceOutstandingTotal, 0));
    const grossRaw = round2(openingReceivableOutstanding + invoiceOutstanding - salesReturns);
    const grossReceivable = round2(Math.max(grossRaw, 0));
    const returnDrivenAdvance = round2(Math.max(-grossRaw, 0));
    const unadjustedAdvance = round2(openingAdvance + unadjustedVoucherReceipts + returnDrivenAdvance);
    const netOutstanding = round2(grossReceivable - unadjustedAdvance);

    return {
        openingBalanceSigned,
        openingReceivable,
        openingAdvance,
        salesInvoices,
        salesReturns,
        adjustedReceipts,
        unadjustedAdvance,
        grossReceivable,
        netOutstanding,
    };
};


export const getSupplierInvoiceOutstandingTotalFromPurchases = (
    supplier: Distributor | null | undefined,
    purchases: Array<any> = []
): number => {
    if (!supplier || !Array.isArray(purchases)) return 0;

    const supplierName = (supplier.name || '').trim().toLowerCase();
    const supplierId = String((supplier as any).id || '').trim();

    const supplierBills = purchases
        .filter((p) => p && p.status !== 'cancelled')
        .filter((p) => {
            const nameMatch = ((p.supplier || '').trim().toLowerCase() === supplierName);
            const idMatch = supplierId && String((p as any).supplierId || '').trim() === supplierId;
            return nameMatch || idMatch;
        })
        .map((p) => ({
            id: String(p.id || ''),
            invoiceNumber: String(p.invoiceNumber || '').trim().toLowerCase(),
            invoiceAmount: Number(p.totalAmount || 0),
            paid: 0,
            balance: Number(p.totalAmount || 0),
        }));

    if (supplierBills.length === 0) return 0;

    const byInvoiceId = new Map(supplierBills.map((row) => [row.id, row]));
    const byInvoiceNumber = new Map(supplierBills.filter((row) => row.invoiceNumber).map((row) => [row.invoiceNumber, row.id]));
    const ledger = Array.isArray(supplier.ledger) ? supplier.ledger : [];

    for (const entry of ledger) {
        if (!entry || entry.type !== 'payment' || entry.status === 'cancelled') continue;
        const entryCategory = String(entry.entryCategory || '');
        if (!['invoice_payment_adjustment', 'down_payment_adjustment', 'invoice_payment_adjustment_reversal', 'down_payment_adjustment_reversal'].includes(entryCategory)) continue;

        const invoiceId = String(entry.referenceInvoiceId || byInvoiceNumber.get(String(entry.referenceInvoiceNumber || '').trim().toLowerCase()) || '');
        const target = invoiceId ? byInvoiceId.get(invoiceId) : undefined;
        if (!target) continue;

        const adjustedAmount = Number(entry.adjustedAmount || 0);
        const multiplier = entryCategory.endsWith('_reversal') ? -1 : 1;
        target.paid += adjustedAmount * multiplier;
        target.balance = Number((target.invoiceAmount - target.paid).toFixed(2));
        if (target.balance < 0) target.balance = 0;
    }

    return round2(Array.from(byInvoiceId.values()).reduce((sum, row) => sum + Number(row.balance || 0), 0));
};

export const getCustomerInvoiceOutstandingTotalFromTransactions = (
    customer: Customer | null | undefined,
    transactions: Transaction[] = []
): number => {
    if (!customer || !Array.isArray(transactions)) return 0;

    const customerName = (customer.name || '').trim().toLowerCase();
    const sales = transactions
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
        if (!entry || entry.type !== 'payment' || entry.status === 'cancelled') continue;
        const entryCategory = String(entry.entryCategory || '');
        if (!['invoice_payment_adjustment', 'down_payment_adjustment', 'invoice_payment_adjustment_reversal', 'down_payment_adjustment_reversal'].includes(entryCategory)) continue;

        const invoiceId = entry.referenceInvoiceId || byInvoiceNumber.get(String(entry.referenceInvoiceNumber || '').trim().toLowerCase()) || '';
        const target = invoiceId ? byInvoiceId.get(invoiceId) : undefined;
        if (!target) continue;

        const adjustedAmount = Number(entry.adjustedAmount || 0);
        const multiplier = entryCategory.endsWith('_reversal') ? -1 : 1;
        target.received += (adjustedAmount * multiplier);
        target.balance = Number((target.invoiceAmount - target.received).toFixed(2));
        if (target.balance < 0) target.balance = 0;
        touchedInvoiceIds.add(target.id);
    }

    for (const sale of sales) {
        if (touchedInvoiceIds.has(sale.id)) continue;
        if (['cash', 'card', 'upi', 'bank'].includes(sale.paymentMode)) sale.balance = 0;
    }

    return Number(sales.reduce((sum, row) => sum + Number(row.balance || 0), 0).toFixed(2));
};

export const buildCustomerInvoiceOutstandingMap = (
    customers: Customer[] = [],
    transactions: Transaction[] = []
): Record<string, number> => {
    if (!Array.isArray(customers) || customers.length === 0) return {};
    return customers.reduce<Record<string, number>>((acc, customer) => {
        acc[customer.id] = getCustomerInvoiceOutstandingTotalFromTransactions(customer, transactions);
        return acc;
    }, {});
};

/**
 * Calculates the outstanding balance for a given customer or distributor.
 * Falls back to opening_balance if no ledger entries exist.
 */
export const getOutstandingBalance = (entity: Customer | Distributor | null | undefined): number => {
    if (!entity) return 0;

    const looksLikeSupplier = 'supplier_group' in (entity as any) || 'control_gl_id' in (entity as any);
    if (looksLikeSupplier) {
        return calculateSupplierPayableBreakdown(entity as Distributor).netOutstanding;
    }

    return calculateCustomerReceivableBreakdown(entity as Customer).netOutstanding;
};

/**
 * Formats a YYYY-MM-DD date string to MM/YY display format.
 */
export const formatExpiryToMMYY = (dateStr: string | undefined | null): string => {
    if (!dateStr) return '';
    const clean = dateStr.split('T')[0]; // Remove time if present
    const parts = clean.split('-');
    if (parts.length < 2) return dateStr; // Return as is if not standard format
    
    const year = parts[0].slice(-2);
    const month = parts[1].padStart(2, '0');
    return `${month}/${year}`;
};

/**
 * Normalizes various date string formats to YYYY-MM-DD for Postgres compatibility.
 * Handles: DD-MM-YYYY, MM/YYYY, MM/YY, and Excel serials.
 * For MM/YY or MM/YYYY, it defaults to the last day of that month.
 * Returns null if the input is empty or invalid.
 */
export const normalizeImportDate = (dateStr: string | undefined | null): string | null => {
    if (!dateStr || typeof dateStr !== 'string' || dateStr.trim() === '') return null;
    let cleanStr = dateStr.trim();
    
    // 1. Handle YYYY-MM-DD (Already correct)
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleanStr)) return cleanStr;

    // 2. Handle DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = cleanStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmyMatch) {
        const day = parseInt(dmyMatch[1], 10);
        const month = parseInt(dmyMatch[2], 10);
        const year = parseInt(dmyMatch[3], 10);
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // 3. Handle MM/YY or MM-YY (e.g., "07/26")
    const myShortMatch = cleanStr.match(/^(\d{1,2})[-/](\d{2})$/);
    if (myShortMatch) {
        let month = parseInt(myShortMatch[1], 10);
        let year = 2000 + parseInt(myShortMatch[2], 10);
        
        // Basic validation: if month > 12, it might be DD/MM or DD/YY
        // If it's DD/MM, we can't be sure of the year, so we assume current year or similar.
        // But the most common case for 2-digit/2-digit in this app is MM/YY for expiry.
        if (month > 12) {
            // Swap if it looks like DD/MM
            const day = month;
            month = parseInt(myShortMatch[2], 10);
            year = new Date().getFullYear();
            if (month > 12) return null; // Still invalid
            const lastDay = new Date(year, month, 0).getDate();
            return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
        }

        const lastDay = new Date(year, month, 0).getDate();
        return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }

    // 4. Handle MM/YYYY or MM-YYYY
    const myMatch = cleanStr.match(/^(\d{1,2})[-/](\d{4})$/);
    if (myMatch) {
        const month = parseInt(myMatch[1], 10);
        const year = parseInt(myMatch[2], 10);
        if (month < 1 || month > 12) return null;
        const lastDay = new Date(year, month, 0).getDate();
        return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }

    // 5. Handle Excel Serial Date
    if (/^\d{5}$/.test(cleanStr)) {
        const serial = parseInt(cleanStr, 10);
        const date = new Date((serial - 25569) * 86400 * 1000);
        if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
    }

    // 6. Standard ISO fallback
    const d = new Date(cleanStr);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    
    return null;
};

/**
 * Checks if a given expiry date (in MM/YY or YYYY-MM-DD format) is expired.
 */
export const checkIsExpired = (expiryStr: string | undefined | null): boolean => {
    if (!expiryStr || expiryStr === 'N/A') return false;
    
    let expiryDate: Date;
    
    // Handle MM/YY format
    const myMatch = expiryStr.match(/^(\d{1,2})\/(\d{2})$/);
    if (myMatch) {
        const month = parseInt(myMatch[1], 10);
        const year = 2000 + parseInt(myMatch[2], 10);
        // Expiry at the end of the month
        expiryDate = new Date(year, month, 0);
    } else {
        // Handle YYYY-MM-DD or other formats
        const normalized = normalizeImportDate(expiryStr);
        if (!normalized) return false;
        expiryDate = new Date(normalized);
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return expiryDate < today;
};

export const parseNumber = (value: string | number | undefined | null): number => {
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    if (typeof value !== 'string') return 0;
    const clean = value.trim().replace(/[^0-9.-]/g, '');
    return parseFloat(clean) || 0;
};

export const formatVoucherNo = (val: string | undefined | null): string => {
    if (!val) return '';
    const str = String(val).trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
    if (isUuid) {
        return str.slice(0, 8).toUpperCase();
    }
    return str;
};

