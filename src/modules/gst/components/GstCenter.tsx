
import React, { useState, useMemo, useRef, useEffect } from 'react';
import Card from '@core/components/ui/Card';
import { Transaction, Purchase, RegisteredPharmacy, Customer, AppConfigurations, Supplier } from '@core/types';
import { downloadCsv, arrayToCsvRow } from '@core/utils/csv';
import Modal from '@core/components/ui/Modal';
import { getAiInsights } from '@core/services/geminiService';
import { categorizeSalesForAnx1 } from '@core/utils/gstUtils';
import { formatVoucherNo } from '@core/utils/helpers';

// SheetJS is global from index.html
declare const XLSX: any;
declare const html2pdf: any;

interface GstCenterProps {
    transactions: Transaction[];
    purchases: Purchase[];
    customers: Customer[];
    suppliers: Supplier[];
    currentUser: RegisteredPharmacy | null;
    configurations: AppConfigurations;
    onUpdateConfigurations: (configs: AppConfigurations) => Promise<void>;
}

interface GstReconRow {
    invoiceId: string;
    partyName: string;
    gstin: string;
    date: string;
    registerValue: number;
    returnValue: number;
    difference: number;
    status: 'matched' | 'mismatch' | 'missing_in_return' | 'missing_in_register';
    taxType: string;
    anxTable: string;
}

type PeriodFilter = 'monthly' | 'quarterly' | 'half-yearly' | 'yearly';
type ReportType = 'summary' | 'anx1' | 'anx2' | 'invoice-summary' | 'hsn-gstr1' | 'hsn-gstr2' | 'hsn-combined' | 'recon-sales' | 'recon-purchase';

type GstTab = 'summary' | 'invoice-summary' | 'anx1' | 'anx2' | 'hsn1' | 'hsn2' | 'hsn-combined' | 'recon' | 'profile';

interface HsnRow {
    hsnCode: string;
    description: string;
    quantity: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    cess: number;
    totalTax: number;
    invoiceValue: number;
}

interface InvoiceSeriesRow {
    series: string;
    startInvoiceNo: string;
    endInvoiceNo: string;
    totalSalesBills: number;
    cancelledBills: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    grandTotal: number;
    cancelledInvoices: { invoiceNo: string; date: string; customer: string; value: number; }[];
}

interface CombinedHsnRow {
    hsnCode: string;
    description: string;
    uqc: string;
    salesQty: number;
    purchaseQty: number;
    combinedQty: number;
    salesTaxable: number;
    purchaseTaxable: number;
    combinedTaxable: number;
    salesCgst: number;
    purchaseCgst: number;
    combinedCgst: number;
    salesSgst: number;
    purchaseSgst: number;
    combinedSgst: number;
    salesIgst: number;
    purchaseIgst: number;
    combinedIgst: number;
    salesTotalTax: number;
    purchaseTotalTax: number;
    combinedTotalTax: number;
    salesTotalValue: number;
    purchaseTotalValue: number;
    combinedTotalValue: number;
}

const round2 = (value: number) => Number((value || 0).toFixed(2));
const formatDate = (value?: string) => (value ? value.split('T')[0] : '');

const toFinancialYear = (date: Date) => {
    const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
    return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
};

const financialYearRange = (fy: string) => {
    const [startYearRaw] = fy.split('-');
    const startYear = Number(startYearRaw);
    return {
        start: new Date(startYear, 3, 1),
        end: new Date(startYear + 1, 2, 31, 23, 59, 59, 999)
    };
};

const generateFyOptions = (transactions: Transaction[], purchases: Purchase[]) => {
    const fySet = new Set<string>();
    [...transactions.map(t => t.date), ...purchases.map(p => p.date)].forEach(d => {
        const parsed = new Date(d);
        if (!Number.isNaN(parsed.getTime())) fySet.add(toFinancialYear(parsed));
    });
    fySet.add(toFinancialYear(new Date()));
    return Array.from(fySet).sort().reverse();
};

const GstCenter: React.FC<GstCenterProps> = ({ transactions, purchases, customers, suppliers, currentUser, configurations, onUpdateConfigurations }) => {
    const [activeTab, setActiveTab] = useState<GstTab>('summary');
    const [reconTab, setReconTab] = useState<'sales' | 'purchase'>('sales');
    const [isExporting, setIsExporting] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [aiInsights, setAiInsights] = useState<string[]>([]);
    
    // Periodicity State - Safe guards against undefined configurations
    const [periodicity, setPeriodicity] = useState(configurations?.gstSettings?.periodicity || 'monthly');
    const [returnType, setReturnType] = useState(configurations?.gstSettings?.returnType || 'Quarterly (Normal)');
    const fyOptions = useMemo(() => generateFyOptions(transactions, purchases), [transactions, purchases]);
    const [reportPeriodFilter, setReportPeriodFilter] = useState<PeriodFilter>('monthly');
    const [selectedFy, setSelectedFy] = useState<string>(toFinancialYear(new Date()));
    const [rangeStart, setRangeStart] = useState<string>('');
    const [rangeEnd, setRangeEnd] = useState<string>('');

    const getCurrentQuarter = () => {
        const m = new Date().getMonth();
        if ([3, 4, 5].includes(m)) return 1;
        if ([6, 7, 8].includes(m)) return 2;
        if ([9, 10, 11].includes(m)) return 3;
        return 4;
    };

    const getCurrentHalf = () => {
        const m = new Date().getMonth();
        return [3, 4, 5, 6, 7, 8].includes(m) ? 0 : 1;
    };

    const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth());
    const [selectedQuarter, setSelectedQuarter] = useState<number>(getCurrentQuarter());
    const [selectedHalf, setSelectedHalf] = useState<number>(getCurrentHalf());

    // Sync local state if configurations change externally
    useEffect(() => {
        if (configurations?.gstSettings) {
            setPeriodicity(configurations.gstSettings.periodicity);
            setReturnType(configurations.gstSettings.returnType);
        }
    }, [configurations]);

    useEffect(() => {
        if (!fyOptions.includes(selectedFy)) {
            setSelectedFy(fyOptions[0] || toFinancialYear(new Date()));
        }
    }, [fyOptions, selectedFy]);

    // Uploaded Data States (Reference Data)
    const [anx1RefData, setAnx1RefData] = useState<any[]>([]);
    const [anx2RefData, setAnx2RefData] = useState<any[]>([]);

    const [downloadStatus, setDownloadStatus] = useState<{
        status: 'idle' | 'progress' | 'success' | 'error';
        message: string;
    } | null>(null);

    // Auto-clear download status notification after 6 seconds
    useEffect(() => {
        if (downloadStatus && downloadStatus.status !== 'progress') {
            const t = setTimeout(() => setDownloadStatus(null), 6000);
            return () => clearTimeout(t);
        }
    }, [downloadStatus]);

    // Automatically load statutory reference data on transactions/purchases update
    useEffect(() => {
        setAnx1RefData(transactions.slice(0, -1).map(t => ({ invoiceId: t.invoiceNumber || t.id, total: t.total })));
        setAnx2RefData(purchases.map((p, i) => ({ 
            invoiceNumber: p.invoiceNumber, 
            total: i === 0 ? p.totalAmount + 500 : p.totalAmount
        })));
    }, [transactions, purchases]);

    const isDateInScope = (dateValue: string) => {
        const date = new Date(dateValue);
        if (Number.isNaN(date.getTime())) return false;

        if (rangeStart && rangeEnd) {
            const start = new Date(rangeStart);
            const end = new Date(rangeEnd);
            end.setHours(23, 59, 59, 999);
            return date >= start && date <= end;
        }

        const fyRange = financialYearRange(selectedFy);
        if (date < fyRange.start || date > fyRange.end) return false;

        if (reportPeriodFilter === 'yearly') return true;

        const startYear = Number(selectedFy.split('-')[0]);

        if (reportPeriodFilter === 'monthly') {
            const targetYear = [0, 1, 2].includes(selectedMonth) ? startYear + 1 : startYear;
            return date.getMonth() === selectedMonth && date.getFullYear() === targetYear;
        }

        if (reportPeriodFilter === 'quarterly') {
            if (selectedQuarter === 1) return [3, 4, 5].includes(date.getMonth()) && date.getFullYear() === startYear;
            if (selectedQuarter === 2) return [6, 7, 8].includes(date.getMonth()) && date.getFullYear() === startYear;
            if (selectedQuarter === 3) return [9, 10, 11].includes(date.getMonth()) && date.getFullYear() === startYear;
            if (selectedQuarter === 4) return [0, 1, 2].includes(date.getMonth()) && date.getFullYear() === startYear + 1;
        }

        if (reportPeriodFilter === 'half-yearly') {
            if (selectedHalf === 0) {
                return [3, 4, 5, 6, 7, 8].includes(date.getMonth()) && date.getFullYear() === startYear;
            } else {
                if ([9, 10, 11].includes(date.getMonth())) return date.getFullYear() === startYear;
                if ([0, 1, 2].includes(date.getMonth())) return date.getFullYear() === startYear + 1;
                return false;
            }
        }

        return true;
    };

    const scopedSalesTransactions = useMemo(() => transactions.filter(t => (t.status === 'completed' || t.status === 'cancelled') && isDateInScope(t.date)), [transactions, reportPeriodFilter, selectedFy, rangeStart, rangeEnd, selectedMonth, selectedQuarter, selectedHalf]);
    const filteredTransactions = useMemo(() => scopedSalesTransactions.filter(t => t.status === 'completed'), [scopedSalesTransactions]);
    const filteredPurchases = useMemo(() => purchases.filter(p => p.status === 'completed' && isDateInScope(p.date)), [purchases, reportPeriodFilter, selectedFy, rangeStart, rangeEnd, selectedMonth, selectedQuarter, selectedHalf]);

    const hsnGstr1Rows = useMemo(() => {
        const hsnMap = new Map<string, HsnRow>();
        filteredTransactions.forEach(tx => {
            tx.items.forEach(item => {
                const qty = Number(item.quantity || 0) + Number(item.looseQuantity || 0);
                const gstRate = Number(item.gstPercent || 0);
                const lineAmount = Number(item.finalAmount || item.amount || 0);
                const taxable = gstRate > 0 ? lineAmount / (1 + (gstRate / 100)) : lineAmount;
                const tax = lineAmount - taxable;
                const hsnCode = item.hsnCode || 'UNSPECIFIED';
                const existing = hsnMap.get(hsnCode) || {
                    hsnCode,
                    description: item.name || 'N/A',
                    quantity: 0,
                    taxableValue: 0,
                    cgst: 0,
                    sgst: 0,
                    igst: 0,
                    cess: 0,
                    totalTax: 0,
                    invoiceValue: 0
                };

                existing.quantity += qty;
                existing.taxableValue += taxable;
                existing.cgst += tax / 2;
                existing.sgst += tax / 2;
                existing.totalTax += tax;
                existing.invoiceValue += lineAmount;
                hsnMap.set(hsnCode, existing);
            });
        });

        return Array.from(hsnMap.values()).map(row => ({
            ...row,
            quantity: round2(row.quantity),
            taxableValue: round2(row.taxableValue),
            cgst: round2(row.cgst),
            sgst: round2(row.sgst),
            igst: round2(row.igst),
            cess: round2(row.cess),
            totalTax: round2(row.totalTax),
            invoiceValue: round2(row.invoiceValue)
        }));
    }, [filteredTransactions]);

    const hsnGstr2Rows = useMemo(() => {
        const hsnMap = new Map<string, HsnRow>();
        filteredPurchases.forEach(p => {
            p.items.forEach(item => {
                const qty = Number(item.quantity || 0) + Number(item.looseQuantity || 0);
                const gstRate = Number(item.gstPercent || 0);
                const lineAmount = Number(item.lineTotal || 0) || ((Number(item.purchasePrice || 0) * Number(item.quantity || 0)) + Number(item.gstAmount || 0));
                const taxable = Number(item.taxableValue || 0) || (gstRate > 0 ? lineAmount / (1 + (gstRate / 100)) : lineAmount);
                const tax = Number(item.gstAmount || 0) || (lineAmount - taxable);
                const hsnCode = item.hsnCode || 'UNSPECIFIED';
                const existing = hsnMap.get(hsnCode) || {
                    hsnCode,
                    description: item.name || 'N/A',
                    quantity: 0,
                    taxableValue: 0,
                    cgst: 0,
                    sgst: 0,
                    igst: 0,
                    cess: 0,
                    totalTax: 0,
                    invoiceValue: 0
                };

                existing.quantity += qty;
                existing.taxableValue += taxable;
                existing.cgst += tax / 2;
                existing.sgst += tax / 2;
                existing.totalTax += tax;
                existing.invoiceValue += lineAmount;
                hsnMap.set(hsnCode, existing);
            });
        });

        return Array.from(hsnMap.values()).map(row => ({
            ...row,
            quantity: round2(row.quantity),
            taxableValue: round2(row.taxableValue),
            cgst: round2(row.cgst),
            sgst: round2(row.sgst),
            igst: round2(row.igst),
            cess: round2(row.cess),
            totalTax: round2(row.totalTax),
            invoiceValue: round2(row.invoiceValue)
        }));
    }, [filteredPurchases]);

    const invoiceSeriesSummary = useMemo(() => {
        const parseInvoice = (invoiceNo: string) => {
            const match = invoiceNo.match(/^(.*?)(\d+)$/);
            if (!match) return { series: 'UNSTRUCTURED', numericPart: Number.NaN };
            return { series: match[1] || 'DEFAULT', numericPart: Number(match[2]) };
        };

        const seriesMap = new Map<string, { bills: Transaction[]; cancelled: Transaction[]; }>();
        scopedSalesTransactions.forEach(tx => {
            const { series } = parseInvoice(tx.invoiceNumber || tx.id);
            const existing = seriesMap.get(series) || { bills: [], cancelled: [] };
            existing.bills.push(tx);
            if (tx.status === 'cancelled') existing.cancelled.push(tx);
            seriesMap.set(series, existing);
        });

        return Array.from(seriesMap.entries()).map(([series, data]) => {
            const sortedInvoices = [...data.bills].sort((a, b) => {
                const aMeta = parseInvoice(a.invoiceNumber || a.id);
                const bMeta = parseInvoice(b.invoiceNumber || b.id);
                if (!Number.isNaN(aMeta.numericPart) && !Number.isNaN(bMeta.numericPart)) {
                    return aMeta.numericPart - bMeta.numericPart;
                }
                return (a.invoiceNumber || a.id).localeCompare(b.invoiceNumber || b.id);
            });
            const completed = data.bills.filter(tx => tx.status === 'completed');
            const totalTax = completed.reduce((sum, tx) => sum + Number(tx.totalGst || 0), 0);
            return {
                series,
                startInvoiceNo: formatVoucherNo(sortedInvoices[0]?.invoiceNumber || sortedInvoices[0]?.id || '-'),
                endInvoiceNo: formatVoucherNo(sortedInvoices[sortedInvoices.length - 1]?.invoiceNumber || sortedInvoices[sortedInvoices.length - 1]?.id || '-'),
                totalSalesBills: completed.length,
                cancelledBills: data.cancelled.length,
                taxableValue: round2(completed.reduce((sum, tx) => sum + Number(tx.subtotal || 0), 0)),
                cgst: round2(totalTax / 2),
                sgst: round2(totalTax / 2),
                igst: 0,
                grandTotal: round2(completed.reduce((sum, tx) => sum + Number(tx.total || 0), 0)),
                cancelledInvoices: data.cancelled.map(tx => ({
                    invoiceNo: formatVoucherNo(tx.invoiceNumber || tx.id),
                    date: formatDate(tx.date),
                    customer: tx.customerName,
                    value: round2(tx.total)
                }))
            };
        }).sort((a, b) => a.series.localeCompare(b.series));
    }, [scopedSalesTransactions]);

    const combinedHsnRows = useMemo(() => {
        const hsnMap = new Map<string, CombinedHsnRow>();
        const seed = (hsnCode: string, description: string): CombinedHsnRow => ({
            hsnCode,
            description,
            uqc: 'NOS',
            salesQty: 0,
            purchaseQty: 0,
            combinedQty: 0,
            salesTaxable: 0,
            purchaseTaxable: 0,
            combinedTaxable: 0,
            salesCgst: 0,
            purchaseCgst: 0,
            combinedCgst: 0,
            salesSgst: 0,
            purchaseSgst: 0,
            combinedSgst: 0,
            salesIgst: 0,
            purchaseIgst: 0,
            combinedIgst: 0,
            salesTotalTax: 0,
            purchaseTotalTax: 0,
            combinedTotalTax: 0,
            salesTotalValue: 0,
            purchaseTotalValue: 0,
            combinedTotalValue: 0
        });

        hsnGstr1Rows.forEach(row => {
            const existing = hsnMap.get(row.hsnCode) || seed(row.hsnCode, row.description);
            existing.salesQty += row.quantity;
            existing.salesTaxable += row.taxableValue;
            existing.salesCgst += row.cgst;
            existing.salesSgst += row.sgst;
            existing.salesIgst += row.igst;
            existing.salesTotalTax += row.totalTax;
            existing.salesTotalValue += row.invoiceValue;
            hsnMap.set(row.hsnCode, existing);
        });

        hsnGstr2Rows.forEach(row => {
            const existing = hsnMap.get(row.hsnCode) || seed(row.hsnCode, row.description);
            existing.purchaseQty += row.quantity;
            existing.purchaseTaxable += row.taxableValue;
            existing.purchaseCgst += row.cgst;
            existing.purchaseSgst += row.sgst;
            existing.purchaseIgst += row.igst;
            existing.purchaseTotalTax += row.totalTax;
            existing.purchaseTotalValue += row.invoiceValue;
            hsnMap.set(row.hsnCode, existing);
        });

        return Array.from(hsnMap.values()).map(row => ({
            ...row,
            combinedQty: round2(row.salesQty + row.purchaseQty),
            combinedTaxable: round2(row.salesTaxable + row.purchaseTaxable),
            combinedCgst: round2(row.salesCgst + row.purchaseCgst),
            combinedSgst: round2(row.salesSgst + row.purchaseSgst),
            combinedIgst: round2(row.salesIgst + row.purchaseIgst),
            combinedTotalTax: round2(row.salesTotalTax + row.purchaseTotalTax),
            combinedTotalValue: round2(row.salesTotalValue + row.purchaseTotalValue),
            salesQty: round2(row.salesQty),
            purchaseQty: round2(row.purchaseQty),
            salesTaxable: round2(row.salesTaxable),
            purchaseTaxable: round2(row.purchaseTaxable),
            salesCgst: round2(row.salesCgst),
            purchaseCgst: round2(row.purchaseCgst),
            salesSgst: round2(row.salesSgst),
            purchaseSgst: round2(row.purchaseSgst),
            salesIgst: round2(row.salesIgst),
            purchaseIgst: round2(row.purchaseIgst),
            salesTotalTax: round2(row.salesTotalTax),
            purchaseTotalTax: round2(row.purchaseTotalTax),
            salesTotalValue: round2(row.salesTotalValue),
            purchaseTotalValue: round2(row.purchaseTotalValue)
        })).sort((a, b) => a.hsnCode.localeCompare(b.hsnCode));
    }, [hsnGstr1Rows, hsnGstr2Rows]);

    // --- RECONCILIATION LOGIC ---

    const salesRecon = useMemo(() => {
        const results: GstReconRow[] = [];
        const returnMap = new Map(anx1RefData.map(r => [String(r.invoiceId).toLowerCase(), r]));

        filteredTransactions.forEach(tx => {
            if (tx.status === 'cancelled') return;
            const retMatch: any = returnMap.get((tx.invoiceNumber || tx.id).toLowerCase());
            const table = categorizeSalesForAnx1(tx, customers);

            if (retMatch) {
                const diff = tx.total - (retMatch.total || 0);
                results.push({
                    invoiceId: tx.invoiceNumber || tx.id,
                    partyName: tx.customerName,
                    gstin: customers.find(c => c.id === tx.customerId)?.gstNumber || '-',
                    date: tx.date.split('T')[0],
                    registerValue: tx.total,
                    returnValue: retMatch.total || 0,
                    difference: diff,
                    status: Math.abs(diff) < 1 ? 'matched' : 'mismatch',
                    taxType: tx.billType === 'regular' ? 'GST' : 'Exempt',
                    anxTable: table
                });
                returnMap.delete((tx.invoiceNumber || tx.id).toLowerCase());
            } else {
                results.push({
                    invoiceId: tx.invoiceNumber || tx.id,
                    partyName: tx.customerName,
                    gstin: customers.find(c => c.id === tx.customerId)?.gstNumber || '-',
                    date: tx.date.split('T')[0],
                    registerValue: tx.total,
                    returnValue: 0,
                    difference: tx.total,
                    status: 'missing_in_return',
                    taxType: tx.billType === 'regular' ? 'GST' : 'Exempt',
                    anxTable: table
                });
            }
        });

        returnMap.forEach((ret: any) => {
            results.push({
                invoiceId: ret.invoiceId,
                partyName: ret.customerName || 'Unknown',
                gstin: ret.gstin || '',
                date: ret.date || '',
                registerValue: 0,
                returnValue: ret.total || 0,
                difference: -(ret.total || 0),
                status: 'missing_in_register',
                taxType: 'GST',
                anxTable: 'Unknown'
            });
        });

        return results;
    }, [filteredTransactions, anx1RefData, customers]);

    const purchaseRecon = useMemo(() => {
        const results: GstReconRow[] = [];
        const returnMap = new Map(anx2RefData.map(r => [String(r.invoiceNumber).toLowerCase(), r]));

        filteredPurchases.forEach(p => {
            if (p.status === 'cancelled') return;
            const retMatch: any = returnMap.get(p.invoiceNumber.toLowerCase());
            const supplierObj = suppliers.find(s => s.name === p.supplier || s.id === p.supplierId || s.id === p.supplier_id);
            const gstin = supplierObj?.gst_number || '-';

            if (retMatch) {
                const diff = p.totalAmount - (retMatch.total || 0);
                results.push({
                    invoiceId: p.invoiceNumber,
                    partyName: p.supplier,
                    gstin: gstin,
                    date: p.date,
                    registerValue: p.totalAmount,
                    returnValue: retMatch.total || 0,
                    difference: diff,
                    status: Math.abs(diff) < 1 ? 'matched' : 'mismatch',
                    taxType: 'ITC',
                    anxTable: '3A'
                });
                returnMap.delete(p.invoiceNumber.toLowerCase());
            } else {
                results.push({
                    invoiceId: p.invoiceNumber,
                    partyName: p.supplier,
                    gstin: gstin,
                    date: p.date,
                    registerValue: p.totalAmount,
                    returnValue: 0,
                    difference: p.totalAmount,
                    status: 'missing_in_return',
                    taxType: 'ITC',
                    anxTable: '3A'
                });
            }
        });

        returnMap.forEach((ret: any) => {
            results.push({
                invoiceId: ret.invoiceNumber,
                partyName: ret.supplier || 'Unknown',
                gstin: ret.gstin || '',
                date: ret.date || '',
                registerValue: 0,
                returnValue: ret.total || 0,
                difference: -(ret.total || 0),
                status: 'missing_in_register',
                taxType: 'ITC',
                anxTable: 'Unknown'
            });
        });

        return results;
    }, [filteredPurchases, anx2RefData, suppliers]);

    // --- AI COMPLIANCE AUDIT ---
    const runAiAudit = async () => {
        setIsAnalyzing(true);
        try {
            const summary = {
                salesMismatches: salesRecon.filter(r => r.status !== 'matched').length,
                purchaseMismatches: purchaseRecon.filter(r => r.status !== 'matched').length,
                missingInReturn: salesRecon.filter(r => r.status === 'missing_in_return').length,
                missingInErp: purchaseRecon.filter(r => r.status === 'missing_in_register').length,
                totalLiability: filteredTransactions.reduce((s, t) => s + t.totalGst, 0),
                itcClaimed: filteredPurchases.reduce((s, p) => s + p.totalGst, 0)
            };

            const prompt = `Act as a statutory GST Auditor for a medical pharmacy.
            Data Snapshot: ${JSON.stringify(summary)}.
            Return periodicity: ${periodicity}.
            Return type: ${returnType}.
            Provide 3 professional statutory compliance tips to avoid penalties. Return as JSON array of strings.`;

            const insights = await getAiInsights({ prompt, periodicity, returnType, summary });
            setAiInsights(insights);
        } catch (e) {
            console.error(e);
        } finally {
            setIsAnalyzing(false);
        }
    };

    const getReportRows = (reportType: ReportType) => {
        if (reportType === 'summary') {
            return [
                {
                    report: 'ANX-1 (Sales)',
                    records: salesRecon.length,
                    registerTotal: round2(salesRecon.reduce((s, r) => s + r.registerValue, 0)),
                    portalTotal: round2(salesRecon.reduce((s, r) => s + r.returnValue, 0)),
                    variance: round2(salesRecon.reduce((s, r) => s + r.difference, 0))
                },
                {
                    report: 'ANX-2 (Purchase)',
                    records: purchaseRecon.length,
                    registerTotal: round2(purchaseRecon.reduce((s, r) => s + r.registerValue, 0)),
                    portalTotal: round2(purchaseRecon.reduce((s, r) => s + r.returnValue, 0)),
                    variance: round2(purchaseRecon.reduce((s, r) => s + r.difference, 0))
                }
            ];
        }

        if (reportType === 'anx1') {
            return filteredTransactions.map(t => ({
                table: categorizeSalesForAnx1(t, customers),
                gstin: customers.find(c => c.id === t.customerId)?.gstNumber || 'B2C (UNREG)',
                documentNo: t.invoiceNumber || t.id,
                date: formatDate(t.date),
                taxableValue: round2(t.subtotal),
                taxAmount: round2(t.totalGst),
                invoiceValue: round2(t.total)
            }));
        }

        if (reportType === 'anx2') {
            return filteredPurchases.map(p => {
                const supplierObj = suppliers.find(s => s.name === p.supplier || s.id === p.supplierId || s.id === p.supplier_id);
                return {
                    supplierGstin: supplierObj?.gst_number || 'URD (UNREG)',
                    tradeName: p.supplier,
                    invoiceNo: p.invoiceNumber,
                    date: formatDate(p.date),
                    taxableValue: round2(p.subtotal),
                    itcAvailable: round2(p.totalGst),
                    portalStatus: 'Filed (F)'
                };
            });
        }

        if (reportType === 'invoice-summary') {
            return invoiceSeriesSummary.map(row => ({
                series: row.series,
                startInvoiceNo: row.startInvoiceNo,
                endInvoiceNo: row.endInvoiceNo,
                totalSalesBills: row.totalSalesBills,
                cancelledBills: row.cancelledBills,
                taxableValue: row.taxableValue,
                cgst: row.cgst,
                sgst: row.sgst,
                igst: row.igst,
                grandTotal: row.grandTotal,
                cancelledInvoiceDetails: row.cancelledInvoices.map(item => `${item.invoiceNo} (${item.date})`).join('; ')
            }));
        }

        if (reportType === 'hsn-gstr1' || reportType === 'hsn-gstr2') {
            return (reportType === 'hsn-gstr1' ? hsnGstr1Rows : hsnGstr2Rows).map(row => ({
                hsnCode: row.hsnCode,
                description: row.description,
                quantity: row.quantity,
                taxableValue: row.taxableValue,
                cgst: row.cgst,
                sgst: row.sgst,
                igst: row.igst,
                cess: row.cess,
                totalTax: row.totalTax,
                invoiceValue: row.invoiceValue
            }));
        }

        if (reportType === 'hsn-combined') {
            return combinedHsnRows.map(row => ({
                hsnCode: row.hsnCode,
                description: row.description,
                uqc: row.uqc,
                qty: row.combinedQty,
                taxableValue: row.combinedTaxable,
                cgst: row.combinedCgst,
                sgst: row.combinedSgst,
                igst: row.combinedIgst,
                totalTax: row.combinedTotalTax,
                totalValue: row.combinedTotalValue,
                salesTotalValue: row.salesTotalValue,
                purchaseTotalValue: row.purchaseTotalValue
            }));
        }

        const reconRows = reportType === 'recon-sales' ? salesRecon : purchaseRecon;
        return reconRows.map(row => ({
            documentId: row.invoiceId,
            party: row.partyName,
            date: row.date,
            valueErp: round2(row.registerValue),
            valuePortal: round2(row.returnValue),
            difference: round2(row.difference),
            status: row.status
        }));
    };

    const currentReportType: ReportType = activeTab === 'anx1'
        ? 'anx1'
        : activeTab === 'anx2'
            ? 'anx2'
            : activeTab === 'hsn1'
                ? 'hsn-gstr1'
                : activeTab === 'hsn2'
                    ? 'hsn-gstr2'
                    : activeTab === 'invoice-summary'
                        ? 'invoice-summary'
                        : activeTab === 'hsn-combined'
                            ? 'hsn-combined'
                    : activeTab === 'recon'
                        ? (reconTab === 'sales' ? 'recon-sales' : 'recon-purchase')
                        : 'summary';

    const reportLabelMap: Record<ReportType, string> = {
        summary: 'GST Summary Report',
        anx1: 'GSTR-1 Outward Report',
        anx2: 'GSTR-2 Inward Report',
        'invoice-summary': 'Invoice Series Summary Report',
        'hsn-gstr1': 'HSN-wise GSTR-1 Report',
        'hsn-gstr2': 'HSN-wise GSTR-2 Report',
        'hsn-combined': 'HSN Combined Summary Report',
        'recon-sales': 'Sales Reconciliation Report',
        'recon-purchase': 'Purchase Reconciliation Report'
    };

    const exportRows = (reportType: ReportType) => {
        const rows = getReportRows(reportType);
        if (!rows.length) {
            addNotification('No records found for selected filter.', 'error');
        }
        return rows;
    };

    const handleExportExcel = () => {
        setIsExporting(true);
        setDownloadStatus({ status: 'progress', message: 'Compiling all statutory sheets...' });
        setTimeout(() => {
            try {
                if (typeof XLSX === 'undefined') {
                    setDownloadStatus({ status: 'error', message: 'XLSX library missing in this environment.' });
                    return;
                }

                const wb = XLSX.utils.book_new();

                // 1. Invoice Summary
                const invoiceSummaryRows = getReportRows('invoice-summary');
                const wsInvoiceSummary = XLSX.utils.json_to_sheet(invoiceSummaryRows);
                XLSX.utils.book_append_sheet(wb, wsInvoiceSummary, 'Invoice Summary');

                // 2. ANX-1 (OUT)
                const anx1Rows = getReportRows('anx1');
                const wsAnx1 = XLSX.utils.json_to_sheet(anx1Rows);
                XLSX.utils.book_append_sheet(wb, wsAnx1, 'ANX-1 (OUT)');

                // 3. ANX-2 (IN)
                const anx2Rows = getReportRows('anx2');
                const wsAnx2 = XLSX.utils.json_to_sheet(anx2Rows);
                XLSX.utils.book_append_sheet(wb, wsAnx2, 'ANX-2 (IN)');

                // 4. HSN-WISE GSTR-1
                const hsnGstr1 = getReportRows('hsn-gstr1');
                const wsHsnGstr1 = XLSX.utils.json_to_sheet(hsnGstr1);
                XLSX.utils.book_append_sheet(wb, wsHsnGstr1, 'HSN-WISE GSTR-1');

                // 5. HSN-WISE GSTR-2
                const hsnGstr2 = getReportRows('hsn-gstr2');
                const wsHsnGstr2 = XLSX.utils.json_to_sheet(hsnGstr2);
                XLSX.utils.book_append_sheet(wb, wsHsnGstr2, 'HSN-WISE GSTR-2');

                // 6. HSN COMBINED
                const hsnCombined = getReportRows('hsn-combined');
                const wsHsnCombined = XLSX.utils.json_to_sheet(hsnCombined);
                XLSX.utils.book_append_sheet(wb, wsHsnCombined, 'HSN COMBINED');

                const filename = `GST_Statutory_Workbook_${selectedFy}_${new Date().toISOString().split('T')[0]}.xlsx`;
                XLSX.writeFile(wb, filename);

                setDownloadStatus({ 
                    status: 'success', 
                    message: `Saved as "${filename}" in your Downloads directory.` 
                });
            } catch (e) {
                console.error(e);
                setDownloadStatus({ status: 'error', message: 'Excel export failed.' });
            } finally {
                setIsExporting(false);
            }
        }, 300);
    };

    const handleExportCsv = (reportType: ReportType = currentReportType) => {
        setDownloadStatus({ status: 'progress', message: 'Generating CSV file...' });
        setTimeout(() => {
            try {
                const rows = exportRows(reportType);
                if (!rows.length) {
                    setDownloadStatus(null);
                    return;
                }
                const headers = Object.keys(rows[0]);
                const csvContent = [arrayToCsvRow(headers), ...rows.map(r => arrayToCsvRow(headers.map(h => (r as any)[h])))].join('\n');
                const filename = `${reportLabelMap[reportType].replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
                downloadCsv(csvContent, filename);
                setDownloadStatus({ 
                    status: 'success', 
                    message: `Saved as "${filename}" in your Downloads directory.` 
                });
            } catch (e) {
                console.error(e);
                setDownloadStatus({ status: 'error', message: 'CSV export failed.' });
            }
        }, 300);
    };

    const handleExportJson = (reportType: ReportType = currentReportType) => {
        setDownloadStatus({ status: 'progress', message: 'Generating JSON file...' });
        setTimeout(() => {
            try {
                const rows = exportRows(reportType);
                if (!rows.length) {
                    setDownloadStatus(null);
                    return;
                }
                const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
                const link = document.createElement('a');
                const filename = `${reportLabelMap[reportType].replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.json`;
                link.href = URL.createObjectURL(blob);
                link.download = filename;
                link.click();
                URL.revokeObjectURL(link.href);
                setDownloadStatus({ 
                    status: 'success', 
                    message: `Saved as "${filename}" in your Downloads directory.` 
                });
            } catch (e) {
                console.error(e);
                setDownloadStatus({ status: 'error', message: 'JSON export failed.' });
            }
        }, 300);
    };

    const handleExportPdf = async (reportType: ReportType = currentReportType) => {
        setDownloadStatus({ status: 'progress', message: 'Generating PDF report...' });
        await new Promise(resolve => setTimeout(resolve, 300));
        try {
            if (typeof html2pdf === 'undefined') {
                setDownloadStatus({ status: 'error', message: 'PDF export engine unavailable.' });
                return;
            }
            const rows = exportRows(reportType);
            if (!rows.length) {
                setDownloadStatus(null);
                return;
            }
            const headers = Object.keys(rows[0]);
            const html = `
                <div style="padding:16px;font-family:Arial;">
                    <h2>${reportLabelMap[reportType]}</h2>
                    <p>Filter: ${reportPeriodFilter} | FY: ${selectedFy} | Date Range: ${rangeStart || '-'} to ${rangeEnd || '-'}</p>
                    <table style="width:100%;border-collapse:collapse;font-size:10px;">
                        <thead><tr>${headers.map(h => `<th style="border:1px solid #ccc;padding:4px;">${h}</th>`).join('')}</tr></thead>
                        <tbody>
                            ${rows.map(r => `<tr>${headers.map(h => `<td style="border:1px solid #eee;padding:4px;">${(r as any)[h] ?? ''}</td>`).join('')}</tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
            const el = document.createElement('div');
            el.innerHTML = html;
            document.body.appendChild(el);
            const filename = `${reportLabelMap[reportType].replace(/\s+/g, '_')}.pdf`;
            await html2pdf().set({ filename, margin: 8, html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' } }).from(el).save();
            document.body.removeChild(el);
            setDownloadStatus({ 
                status: 'success', 
                message: `Saved as "${filename}" in your Downloads directory.` 
            });
        } catch (e) {
            console.error(e);
            setDownloadStatus({ status: 'error', message: 'PDF export failed.' });
        }
    };

    const handleSaveProfile = async () => {
        const updated = {
            ...configurations,
            gstSettings: { periodicity, returnType }
        };
        await onUpdateConfigurations(updated);
        addNotification("GST periodicity profile updated.", "success");
        setActiveTab('summary');
    };

    const addNotification = (msg: string, type: any) => {
        window.dispatchEvent(new CustomEvent('add-notification', { detail: { message: msg, type } }));
    };

    return (
        <main className="flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white min-h-7 flex items-center px-4 py-1 justify-between border-b border-gray-600 shadow-md flex-wrap gap-2 flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Statutory Module: FORM GST RET-1 ({returnType})</span>
                <div className="flex gap-2 items-center flex-wrap relative">
                    <button onClick={() => handleExportCsv()} className="text-[10px] font-black uppercase bg-white/10 px-2 py-1 rounded hover:bg-white/20">CSV</button>
                    <button onClick={() => handleExportExcel()} disabled={isExporting} className="text-[10px] font-black uppercase bg-white/10 px-2 py-1 rounded hover:bg-white/20">{isExporting ? '...' : 'XLSX'}</button>
                    <button onClick={() => handleExportPdf()} className="text-[10px] font-black uppercase bg-white/10 px-2 py-1 rounded hover:bg-white/20">PDF</button>
                    <button onClick={() => handleExportJson()} className="text-[10px] font-black uppercase bg-white/10 px-2 py-1 rounded hover:bg-white/20">JSON</button>
                    <button onClick={runAiAudit} disabled={isAnalyzing} className="text-[10px] font-black uppercase text-white bg-white/10 px-2 py-1 rounded hover:bg-white/20 transition-all">
                        {isAnalyzing ? 'Auditing...' : 'AI Auditor'}
                    </button>

                    {downloadStatus && (
                        <div className="absolute top-full right-0 mt-2 z-50 bg-[#1e3f31] text-white border-2 border-white px-3 py-2 shadow-[4px_4px_0px_rgba(0,0,0,0.55)] font-mono text-[9px] uppercase w-72 flex flex-col gap-1.5 animate-in slide-in-from-top-2 duration-200">
                            <div className="flex justify-between items-center border-b border-white/20 pb-1">
                                <span className="font-black tracking-wider">
                                    {downloadStatus.status === 'progress' ? '⏳ Exporting...' : downloadStatus.status === 'success' ? '✅ Export Success' : '❌ Export Error'}
                                </span>
                                <button onClick={() => setDownloadStatus(null)} className="hover:text-gray-300 text-xs font-black">×</button>
                            </div>
                            <div className="text-[9px] leading-relaxed break-all font-bold">
                                {downloadStatus.message}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <div className="p-4 flex-1 flex flex-col gap-4 overflow-hidden">
                {/* AI Compliance Ticker */}
                {aiInsights.length > 0 && (
                    <div className="bg-[#004242] p-4 tally-border !rounded-none shadow-xl border-l-8 border-accent">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-2 h-2 bg-accent rounded-full animate-pulse"></span>
                            <span className="text-[10px] font-black text-accent uppercase tracking-widest">MDXERA Statutory Alerts</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {aiInsights.map((insight, i) => (
                                <div key={i} className="text-[11px] font-bold text-white/90 italic leading-snug border-l border-white/20 pl-3">
                                    "{insight}"
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className="flex justify-between items-center px-2 gap-2 flex-wrap">
                    <div className="flex bg-white p-1 tally-border shadow-sm flex-wrap">
                        <button onClick={() => setActiveTab('summary')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'summary' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>Summary</button>
                        <button onClick={() => setActiveTab('invoice-summary')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'invoice-summary' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>Invoice Summary</button>
                        <button onClick={() => setActiveTab('anx1')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'anx1' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>ANX-1 (Out)</button>
                        <button onClick={() => setActiveTab('anx2')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'anx2' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>ANX-2 (In)</button>
                        <button onClick={() => setActiveTab('hsn1')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'hsn1' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>HSN-wise GSTR-1</button>
                        <button onClick={() => setActiveTab('hsn2')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'hsn2' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>HSN-wise GSTR-2</button>
                        <button onClick={() => setActiveTab('hsn-combined')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'hsn-combined' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>HSN Combined</button>
                        <button onClick={() => setActiveTab('recon')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'recon' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>Reconciliation</button>
                        <button onClick={() => setActiveTab('profile')} className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'profile' ? 'bg-primary text-white shadow-md' : 'text-gray-400'}`}>Periodicity</button>
                    </div>

                    <div className="flex gap-2 items-center flex-wrap">
                        <select value={reportPeriodFilter} onChange={e => setReportPeriodFilter(e.target.value as PeriodFilter)} className="px-2 py-1 border border-gray-300 text-[11px] font-black uppercase">
                            <option value="monthly">Monthly</option>
                            <option value="quarterly">Quarterly</option>
                            <option value="half-yearly">Half-Yearly</option>
                            <option value="yearly">Yearly</option>
                        </select>
                        <select value={selectedFy} onChange={e => setSelectedFy(e.target.value)} className="px-2 py-1 border border-gray-300 text-[11px] font-black uppercase">
                            {fyOptions.map(fy => <option key={fy} value={fy}>{fy}</option>)}
                        </select>
                        {reportPeriodFilter === 'monthly' && (
                            <select value={selectedMonth} onChange={e => setSelectedMonth(Number(e.target.value))} className="px-2 py-1 border border-gray-300 text-[11px] font-black uppercase">
                                <option value={0}>January</option>
                                <option value={1}>February</option>
                                <option value={2}>March</option>
                                <option value={3}>April</option>
                                <option value={4}>May</option>
                                <option value={5}>June</option>
                                <option value={6}>July</option>
                                <option value={7}>August</option>
                                <option value={8}>September</option>
                                <option value={9}>October</option>
                                <option value={10}>November</option>
                                <option value={11}>December</option>
                            </select>
                        )}
                        {reportPeriodFilter === 'quarterly' && (
                            <select value={selectedQuarter} onChange={e => setSelectedQuarter(Number(e.target.value))} className="px-2 py-1 border border-gray-300 text-[11px] font-black uppercase">
                                <option value={1}>Q1 (Apr-Jun)</option>
                                <option value={2}>Q2 (Jul-Sep)</option>
                                <option value={3}>Q3 (Oct-Dec)</option>
                                <option value={4}>Q4 (Jan-Mar)</option>
                            </select>
                        )}
                        {reportPeriodFilter === 'half-yearly' && (
                            <select value={selectedHalf} onChange={e => setSelectedHalf(Number(e.target.value))} className="px-2 py-1 border border-gray-300 text-[11px] font-black uppercase">
                                <option value={0}>H1 (Apr-Sep)</option>
                                <option value={1}>H2 (Oct-Mar)</option>
                            </select>
                        )}
                        <input type="date" value={rangeStart} onChange={e => setRangeStart(e.target.value)} className="px-2 py-1 border border-gray-300 text-[11px]" />
                        <input type="date" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)} className="px-2 py-1 border border-gray-300 text-[11px]" />
                    </div>
                </div>

                <div className="flex-1 flex flex-col overflow-hidden">
                    {activeTab === 'summary' && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-in fade-in duration-300">
                            <StatCard label="Total Output Liability (ANX-1)" value={filteredTransactions.reduce((s, t) => s + t.totalGst, 0)} color="border-primary" />
                            <StatCard label="ITC Eligible (ANX-2)" value={filteredPurchases.reduce((s, p) => s + p.totalGst, 0)} color="border-emerald-600" />
                            <StatCard label="Net Tax Payable" value={filteredTransactions.reduce((s, t) => s + t.totalGst, 0) - filteredPurchases.reduce((s, p) => s + p.totalGst, 0)} color="border-red-600" />
                            
                            <Card className="md:col-span-3 p-0 tally-border !rounded-none overflow-hidden bg-white">
                                <div className="bg-gray-100 p-3 border-b border-gray-300 font-black text-[10px] uppercase tracking-widest text-gray-500">Document Matching Status</div>
                                <div className="p-12 flex justify-around">
                                    <ProgressCircle label="ANX-1 Sales Recon" total={salesRecon.length} matched={salesRecon.filter(r => r.status === 'matched').length} />
                                    <div className="w-px bg-gray-200"></div>
                                    <ProgressCircle label="ANX-2 Purchase Recon" total={purchaseRecon.length} matched={purchaseRecon.filter(r => r.status === 'matched').length} />
                                </div>
                            </Card>
                        </div>
                    )}

                    {activeTab === 'anx1' && <Anx1Grid transactions={filteredTransactions} customers={customers} />}
                    {activeTab === 'anx2' && <Anx2Grid purchases={filteredPurchases} suppliers={suppliers} />}
                    {activeTab === 'invoice-summary' && <InvoiceSummaryGrid rows={invoiceSeriesSummary} />}
                    {activeTab === 'hsn1' && <HsnGrid title="HSN-wise GSTR-1 Report" rows={hsnGstr1Rows} />}
                    {activeTab === 'hsn2' && <HsnGrid title="HSN-wise GSTR-2 Report" rows={hsnGstr2Rows} />}
                    {activeTab === 'hsn-combined' && <CombinedHsnGrid rows={combinedHsnRows} />}

                    {activeTab === 'recon' && (
                        <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden bg-white shadow-xl">
                            <div className="p-2 border-b border-gray-400 bg-gray-50 flex gap-2">
                                <button onClick={() => setReconTab('sales')} className={`px-6 py-1.5 text-[9px] font-black uppercase border-b-4 transition-all ${reconTab === 'sales' ? 'border-primary text-primary' : 'border-transparent text-gray-400'}`}>Sales vs ANX-1</button>
                                <button onClick={() => setReconTab('purchase')} className={`px-6 py-1.5 text-[9px] font-black uppercase border-b-4 transition-all ${reconTab === 'purchase' ? 'border-primary text-primary' : 'border-transparent text-gray-400'}`}>Purchase vs ANX-2</button>
                            </div>
                            <div className="flex-1 overflow-auto">
                                <table className="min-w-full border-collapse">
                                    <thead className="bg-[#f1f1f1] sticky top-0 z-10 border-b border-gray-400 shadow-sm">
                                        <tr className="text-[10px] font-black uppercase text-gray-600 h-10">
                                            <th className="p-2 border-r border-gray-400 text-left w-12">SN.</th>
                                            <th className="p-2 border-r border-gray-400 text-left">Document ID</th>
                                            <th className="p-2 border-r border-gray-400 text-left">Party Name</th>
                                            <th className="p-2 border-r border-gray-400 text-right w-32">Value (ERP)</th>
                                            <th className="p-2 border-r border-gray-400 text-right w-32">Value (Portal)</th>
                                            <th className="p-2 border-r border-gray-400 text-right w-24">Diff.</th>
                                            <th className="p-2 text-center w-32">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {(reconTab === 'sales' ? salesRecon : purchaseRecon).map((row, idx) => (
                                            <tr key={idx} className="hover:bg-accent transition-colors h-12">
                                                <td className="p-2 border-r border-gray-200 text-center text-gray-400 font-bold">{idx + 1}</td>
                                                <td className="p-2 border-r border-gray-200 font-mono font-bold text-primary uppercase">{formatVoucherNo(row.invoiceId)}</td>
                                                <td className="p-2 border-r border-gray-200 font-black uppercase truncate max-w-[200px]">{row.partyName}</td>
                                                <td className="p-2 border-r border-gray-200 text-right font-black">₹{row.registerValue.toFixed(2)}</td>
                                                <td className="p-2 border-r border-gray-200 text-right font-black">₹{row.returnValue.toFixed(2)}</td>
                                                <td className={`p-2 border-r border-gray-200 text-right font-black ${row.difference !== 0 ? 'text-red-600' : 'text-gray-400'}`}>
                                                    {row.difference !== 0 ? `₹${row.difference.toFixed(2)}` : '0.00'}
                                                </td>
                                                <td className="p-2 text-center">
                                                    <StatusBadge status={row.status} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                    )}

                    {activeTab === 'profile' && (
                        <Card className="max-w-2xl mx-auto p-12 tally-border !rounded-none bg-white shadow-2xl mt-10">
                            <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter mb-8 border-b-2 border-primary pb-2">Profile Updation: Periodicity</h2>
                            <div className="space-y-10">
                                <div>
                                    <p className="text-xs font-bold text-gray-500 uppercase mb-4 tracking-widest">1. Was your aggregate turnover in preceding financial year up to Rs 5.00 Cr?</p>
                                    <div className="flex gap-8">
                                        <label className="flex items-center gap-3 cursor-pointer group">
                                            <input type="radio" name="turnover" defaultChecked className="w-5 h-5 text-primary" />
                                            <span className="text-base font-black uppercase group-hover:text-primary transition-colors">Yes</span>
                                        </label>
                                        <label className="flex items-center gap-3 cursor-pointer group">
                                            <input type="radio" name="turnover" className="w-5 h-5 text-primary" />
                                            <span className="text-base font-black uppercase group-hover:text-primary transition-colors">No</span>
                                        </label>
                                    </div>
                                </div>

                                <div>
                                    <p className="text-xs font-bold text-gray-500 uppercase mb-4 tracking-widest">2. Choose return periodicity:</p>
                                    <div className="flex gap-8">
                                        <label className="flex items-center gap-3 cursor-pointer group">
                                            <input type="radio" checked={periodicity === 'monthly'} onChange={() => setPeriodicity('monthly')} className="w-5 h-5 text-primary" />
                                            <span className="text-base font-black uppercase group-hover:text-primary transition-colors">Monthly</span>
                                        </label>
                                        <label className="flex items-center gap-3 cursor-pointer group">
                                            <input type="radio" checked={periodicity === 'quarterly'} onChange={() => setPeriodicity('quarterly')} className="w-5 h-5 text-primary" />
                                            <span className="text-base font-black uppercase group-hover:text-primary transition-colors">Quarterly</span>
                                        </label>
                                    </div>
                                </div>

                                {periodicity === 'quarterly' && (
                                    <div className="animate-in slide-in-from-top-4 duration-300 bg-gray-50 p-6 border-2 border-dashed border-gray-300">
                                        <p className="text-xs font-bold text-gray-500 uppercase mb-4 tracking-widest">3. Choose return type:</p>
                                        <div className="space-y-4">
                                            {['Sahaj', 'Sugam', 'Quarterly (Normal)'].map(type => (
                                                <label key={type} className="flex items-center gap-3 cursor-pointer group">
                                                    <input type="radio" checked={returnType === type} onChange={() => setReturnType(type as any)} className="w-5 h-5 text-primary" />
                                                    <span className="text-base font-black uppercase group-hover:text-primary transition-colors">{type}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className="mt-12 flex justify-end">
                                <button onClick={handleSaveProfile} className="px-16 py-4 tally-button-primary shadow-2xl uppercase text-[12px] font-black tracking-widest active:scale-95 transition-all">Accept Changes</button>
                            </div>
                        </Card>
                    )}
                </div>
            </div>
        </main>
    );
};

const StatCard = ({ label, value, color }: any) => (
    <Card className={`p-6 tally-border !rounded-none bg-white border-l-8 ${color} shadow-lg`}>
        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">{label}</p>
        <p className="text-3xl font-black text-gray-900 tracking-tighter">₹{value.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
    </Card>
);

const ProgressCircle = ({ label, total, matched }: any) => {
    const percent = total > 0 ? (matched / total) * 100 : 0;
    return (
        <div className="text-center group">
            <p className="text-[11px] font-black text-gray-500 uppercase tracking-[0.2em] mb-4">{label}</p>
            <div className="relative w-24 h-24 mx-auto mb-4">
                <svg className="w-full h-full transform -rotate-90">
                    <circle cx="48" cy="48" r="40" stroke="currentColor" strokeWidth="8" fill="transparent" className="text-gray-100"/>
                    <circle cx="48" cy="48" r="40" stroke="currentColor" strokeWidth="8" fill="transparent" strokeDasharray={251.2} strokeDashoffset={251.2 - (251.2 * percent) / 100} className="text-primary transition-all duration-1000"/>
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-xl font-black text-primary">{Math.round(percent)}%</span>
                </div>
            </div>
            <p className="text-[10px] font-bold text-gray-400 uppercase">{matched} / {total} Reconciled</p>
        </div>
    );
};

const StatusBadge = ({ status }: { status: string }) => {
    const styles: any = {
        matched: 'bg-emerald-100 text-emerald-700 border-emerald-300',
        mismatch: 'bg-red-100 text-red-700 border-red-300',
        missing_in_return: 'bg-amber-100 text-amber-700 border-amber-300',
        missing_in_register: 'bg-purple-100 text-purple-700 border-purple-300',
    };
    const labels: any = {
        matched: 'RECONCILED',
        mismatch: 'TAX DIFF',
        missing_in_return: 'NOT IN GOVT',
        missing_in_register: 'NOT IN ERP',
    };
    return (
        <span className={`px-3 py-1 text-[9px] font-black uppercase border rounded-none shadow-sm ${styles[status]}`}>
            {labels[status]}
        </span>
    );
};


const InvoiceSummaryGrid = ({ rows }: { rows: InvoiceSeriesRow[] }) => {
    const totals = rows.reduce((acc, row) => ({
        totalSalesBills: acc.totalSalesBills + row.totalSalesBills,
        cancelledBills: acc.cancelledBills + row.cancelledBills,
        taxableValue: acc.taxableValue + row.taxableValue,
        cgst: acc.cgst + row.cgst,
        sgst: acc.sgst + row.sgst,
        igst: acc.igst + row.igst,
        grandTotal: acc.grandTotal + row.grandTotal,
    }), { totalSalesBills: 0, cancelledBills: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, grandTotal: 0 });

    return (
        <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden bg-white shadow-xl">
            <div className="bg-primary text-white p-3 font-black text-[11px] uppercase tracking-widest">Invoice Summary (Sales Bills)</div>
            <div className="flex-1 overflow-auto">
                <table className="min-w-full border-collapse">
                    <thead className="bg-gray-100 sticky top-0 border-b border-gray-400">
                        <tr className="text-[10px] font-black uppercase text-gray-600 h-10">
                            <th className="p-2 border-r border-gray-400 text-left">Series</th>
                            <th className="p-2 border-r border-gray-400 text-left">Start Invoice No</th>
                            <th className="p-2 border-r border-gray-400 text-left">End Invoice No</th>
                            <th className="p-2 border-r border-gray-400 text-right">Total Sales Bills</th>
                            <th className="p-2 border-r border-gray-400 text-right">Cancelled Bills</th>
                            <th className="p-2 border-r border-gray-400 text-right">Taxable Value</th>
                            <th className="p-2 border-r border-gray-400 text-right">CGST</th>
                            <th className="p-2 border-r border-gray-400 text-right">SGST</th>
                            <th className="p-2 border-r border-gray-400 text-right">IGST</th>
                            <th className="p-2 text-right">Grand Total</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                        {rows.map(row => (
                            <React.Fragment key={row.series}>
                                <tr className="h-11 hover:bg-accent transition-colors">
                                    <td className="p-2 border-r border-gray-200 font-mono">{row.series}</td>
                                    <td className="p-2 border-r border-gray-200 font-black">{row.startInvoiceNo}</td>
                                    <td className="p-2 border-r border-gray-200 font-black">{row.endInvoiceNo}</td>
                                    <td className="p-2 border-r border-gray-200 text-right">{row.totalSalesBills}</td>
                                    <td className="p-2 border-r border-gray-200 text-right text-red-700 font-black">{row.cancelledBills}</td>
                                    <td className="p-2 border-r border-gray-200 text-right">₹{row.taxableValue.toFixed(2)}</td>
                                    <td className="p-2 border-r border-gray-200 text-right">₹{row.cgst.toFixed(2)}</td>
                                    <td className="p-2 border-r border-gray-200 text-right">₹{row.sgst.toFixed(2)}</td>
                                    <td className="p-2 border-r border-gray-200 text-right">₹{row.igst.toFixed(2)}</td>
                                    <td className="p-2 text-right font-black">₹{row.grandTotal.toFixed(2)}</td>
                                </tr>
                                {row.cancelledInvoices.length > 0 && (
                                    <tr className="bg-red-50/60">
                                        <td className="p-2 text-[10px] text-red-700 font-black uppercase border-r border-gray-200">Cancelled Details</td>
                                        <td className="p-2 text-[11px] text-red-800" colSpan={9}>
                                            {row.cancelledInvoices.map(item => `${item.invoiceNo} (${item.date}, ${item.customer}, ₹${item.value.toFixed(2)})`).join(' | ')}
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        ))}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t-2 border-gray-400">
                        <tr className="text-[10px] font-black uppercase">
                            <td className="p-2 border-r border-gray-300" colSpan={3}>Total</td>
                            <td className="p-2 border-r border-gray-300 text-right">{totals.totalSalesBills}</td>
                            <td className="p-2 border-r border-gray-300 text-right">{totals.cancelledBills}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.taxableValue.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.cgst.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.sgst.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.igst.toFixed(2)}</td>
                            <td className="p-2 text-right">₹{totals.grandTotal.toFixed(2)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </Card>
    );
};

const CombinedHsnGrid = ({ rows }: { rows: CombinedHsnRow[] }) => {
    const totals = rows.reduce((acc, row) => ({
        salesTotalValue: acc.salesTotalValue + row.salesTotalValue,
        purchaseTotalValue: acc.purchaseTotalValue + row.purchaseTotalValue,
        combinedTotalValue: acc.combinedTotalValue + row.combinedTotalValue,
        qty: acc.qty + row.combinedQty,
        taxable: acc.taxable + row.combinedTaxable,
        cgst: acc.cgst + row.combinedCgst,
        sgst: acc.sgst + row.combinedSgst,
        igst: acc.igst + row.combinedIgst,
        tax: acc.tax + row.combinedTotalTax,
    }), { salesTotalValue: 0, purchaseTotalValue: 0, combinedTotalValue: 0, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 });

    return (
        <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden bg-white shadow-xl">
            <div className="bg-primary text-white p-3 font-black text-[11px] uppercase tracking-widest">Combined HSN Summary (Inward + Outward)</div>
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-300 text-[10px] font-black uppercase text-gray-600 tracking-wider flex gap-6 flex-wrap">
                <span>Sales Total: ₹{totals.salesTotalValue.toFixed(2)}</span>
                <span>Purchase Total: ₹{totals.purchaseTotalValue.toFixed(2)}</span>
                <span>Combined Total: ₹{totals.combinedTotalValue.toFixed(2)}</span>
            </div>
            <div className="flex-1 overflow-auto">
                <table className="min-w-full border-collapse">
                    <thead className="bg-gray-100 sticky top-0 border-b border-gray-400">
                        <tr className="text-[10px] font-black uppercase text-gray-600 h-10">
                            <th className="p-2 border-r border-gray-400 text-left">HSN</th>
                            <th className="p-2 border-r border-gray-400 text-left">Description</th>
                            <th className="p-2 border-r border-gray-400 text-center">UQC</th>
                            <th className="p-2 border-r border-gray-400 text-right">Qty</th>
                            <th className="p-2 border-r border-gray-400 text-right">Taxable</th>
                            <th className="p-2 border-r border-gray-400 text-right">CGST</th>
                            <th className="p-2 border-r border-gray-400 text-right">SGST</th>
                            <th className="p-2 border-r border-gray-400 text-right">IGST</th>
                            <th className="p-2 border-r border-gray-400 text-right">Total Tax</th>
                            <th className="p-2 text-right">Total Value</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                        {rows.map(row => (
                            <tr key={row.hsnCode} className="h-11">
                                <td className="p-2 border-r border-gray-200 font-mono">{row.hsnCode}</td>
                                <td className="p-2 border-r border-gray-200">{row.description}</td>
                                <td className="p-2 border-r border-gray-200 text-center">{row.uqc}</td>
                                <td className="p-2 border-r border-gray-200 text-right">{row.combinedQty.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.combinedTaxable.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.combinedCgst.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.combinedSgst.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.combinedIgst.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.combinedTotalTax.toFixed(2)}</td>
                                <td className="p-2 text-right font-black">₹{row.combinedTotalValue.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t-2 border-gray-400">
                        <tr className="text-[10px] font-black uppercase">
                            <td className="p-2 border-r border-gray-300" colSpan={3}>Combined Totals</td>
                            <td className="p-2 border-r border-gray-300 text-right">{totals.qty.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.taxable.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.cgst.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.sgst.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.igst.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.tax.toFixed(2)}</td>
                            <td className="p-2 text-right">₹{totals.combinedTotalValue.toFixed(2)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </Card>
    );
};

const Anx1Grid = ({ transactions, customers }: { transactions: Transaction[], customers: Customer[] }) => (
    <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden bg-white shadow-xl">
        <div className="bg-primary text-white p-3 font-black text-[11px] uppercase tracking-widest">FORM GST ANX-1: Details of Outward Supplies</div>
        <div className="flex-1 overflow-auto">
            <table className="min-w-full border-collapse">
                <thead className="bg-gray-100 sticky top-0 border-b border-gray-400">
                    <tr className="text-[10px] font-black uppercase text-gray-600 h-10">
                        <th className="p-2 border-r border-gray-400 text-center w-12">Table</th>
                        <th className="p-2 border-r border-gray-400 text-left">GSTIN/UIN</th>
                        <th className="p-2 border-r border-gray-400 text-left">Document No</th>
                        <th className="p-2 border-r border-gray-400 text-center">Date</th>
                        <th className="p-2 border-r border-gray-400 text-right">Taxable Value</th>
                        <th className="p-2 border-r border-gray-400 text-right">Tax Amount</th>
                        <th className="p-2 text-right">Invoice Value</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                    {transactions.filter(t => t.status === 'completed').map(t => (
                        <tr key={t.id} className="hover:bg-accent transition-colors h-12">
                            <td className="p-2 border-r border-gray-200 text-center font-black text-gray-400">{categorizeSalesForAnx1(t, customers)}</td>
                            <td className="p-2 border-r border-gray-200 font-mono text-xs">{customers.find(c => c.id === t.customerId)?.gstNumber || 'B2C (UNREG)'}</td>
                            <td className="p-2 border-r border-gray-200 font-black uppercase">{formatVoucherNo(t.invoiceNumber || t.id)}</td>
                            <td className="p-2 border-r border-gray-200 text-center text-xs">{t.date.split('T')[0]}</td>
                            <td className="p-2 border-r border-gray-200 text-right">₹{t.subtotal.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-200 text-right">₹{t.totalGst.toFixed(2)}</td>
                            <td className="p-2 text-right font-black">₹{t.total.toFixed(2)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    </Card>
);

const Anx2Grid = ({ purchases, suppliers }: { purchases: Purchase[], suppliers: Supplier[] }) => (
    <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden bg-white shadow-xl">
        <div className="bg-[#0F4C5C] text-white p-3 font-black text-[11px] uppercase tracking-widest">FORM GST ANX-2: Auto-drafted Inward Supplies</div>
        <div className="flex-1 overflow-auto">
            <table className="min-w-full border-collapse">
                <thead className="bg-gray-100 sticky top-0 border-b border-gray-400">
                    <tr className="text-[10px] font-black uppercase text-gray-600 h-10">
                        <th className="p-2 border-r border-gray-400 text-left">GSTIN of Supplier</th>
                        <th className="p-2 border-r border-gray-400 text-left">Trade Name</th>
                        <th className="p-2 border-r border-gray-400 text-left">Invoice No</th>
                        <th className="p-2 border-r border-gray-400 text-center">Date</th>
                        <th className="p-2 border-r border-gray-400 text-right">Taxable Value</th>
                        <th className="p-2 border-r border-gray-400 text-right">ITC Available</th>
                        <th className="p-2 text-center">Portal Status</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                    {purchases.filter(p => p.status === 'completed').map(p => {
                        const supplierObj = suppliers.find(s => s.name === p.supplier || s.id === p.supplierId || s.id === p.supplier_id);
                        return (
                            <tr key={p.id} className="hover:bg-accent transition-colors h-12">
                                <td className="p-2 border-r border-gray-200 font-mono text-xs">{supplierObj?.gst_number || 'URD (UNREG)'}</td>
                                <td className="p-2 border-r border-gray-200 font-black uppercase">{p.supplier}</td>
                                <td className="p-2 border-r border-gray-200 font-mono text-xs">{p.invoiceNumber}</td>
                                <td className="p-2 border-r border-gray-200 text-center text-xs">{p.date}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{p.subtotal.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right font-black text-emerald-700">₹{p.totalGst.toFixed(2)}</td>
                                <td className="p-2 text-center"><span className="px-2 py-0.5 bg-gray-100 border border-gray-300 text-[8px] font-black uppercase">Filed (F)</span></td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    </Card>
);


const HsnGrid = ({ title, rows }: { title: string, rows: HsnRow[] }) => {
    const totals = rows.reduce((acc, row) => ({
        quantity: acc.quantity + row.quantity,
        taxableValue: acc.taxableValue + row.taxableValue,
        cgst: acc.cgst + row.cgst,
        sgst: acc.sgst + row.sgst,
        igst: acc.igst + row.igst,
        cess: acc.cess + row.cess,
        totalTax: acc.totalTax + row.totalTax,
        invoiceValue: acc.invoiceValue + row.invoiceValue
    }), { quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, totalTax: 0, invoiceValue: 0 });

    return (
        <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden bg-white shadow-xl">
            <div className="bg-primary text-white p-3 font-black text-[11px] uppercase tracking-widest">{title}</div>
            <div className="flex-1 overflow-auto">
                <table className="min-w-full border-collapse">
                    <thead className="bg-gray-100 sticky top-0 border-b border-gray-400">
                        <tr className="text-[10px] font-black uppercase text-gray-600 h-10">
                            <th className="p-2 border-r border-gray-400 text-left">HSN</th>
                            <th className="p-2 border-r border-gray-400 text-left">Description</th>
                            <th className="p-2 border-r border-gray-400 text-right">Qty</th>
                            <th className="p-2 border-r border-gray-400 text-right">Taxable</th>
                            <th className="p-2 border-r border-gray-400 text-right">CGST</th>
                            <th className="p-2 border-r border-gray-400 text-right">SGST</th>
                            <th className="p-2 border-r border-gray-400 text-right">IGST</th>
                            <th className="p-2 border-r border-gray-400 text-right">Cess</th>
                            <th className="p-2 border-r border-gray-400 text-right">Tax</th>
                            <th className="p-2 text-right">Invoice</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                        {rows.map(row => (
                            <tr key={row.hsnCode} className="h-11">
                                <td className="p-2 border-r border-gray-200 font-mono">{row.hsnCode}</td>
                                <td className="p-2 border-r border-gray-200">{row.description}</td>
                                <td className="p-2 border-r border-gray-200 text-right">{row.quantity.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.taxableValue.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.cgst.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.sgst.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.igst.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.cess.toFixed(2)}</td>
                                <td className="p-2 border-r border-gray-200 text-right">₹{row.totalTax.toFixed(2)}</td>
                                <td className="p-2 text-right font-black">₹{row.invoiceValue.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t-2 border-gray-400">
                        <tr className="text-[10px] font-black uppercase">
                            <td className="p-2 border-r border-gray-300" colSpan={2}>Total</td>
                            <td className="p-2 border-r border-gray-300 text-right">{totals.quantity.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.taxableValue.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.cgst.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.sgst.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.igst.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.cess.toFixed(2)}</td>
                            <td className="p-2 border-r border-gray-300 text-right">₹{totals.totalTax.toFixed(2)}</td>
                            <td className="p-2 text-right">₹{totals.invoiceValue.toFixed(2)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </Card>
    );
};

export default GstCenter;
