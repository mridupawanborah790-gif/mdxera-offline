import React, { useEffect, useMemo, useState } from 'react';
import Modal from '../components/Modal';
import type { InventoryItem, Transaction, Purchase, Distributor, Customer, SalesReturn, PurchaseReturn, ModuleConfig, DoctorMaster } from '../types';
import { calculateCustomerReceivableBreakdown, calculateSupplierPayableBreakdown, getCustomerInvoiceOutstandingTotalFromTransactions, getOutstandingBalance, getSupplierInvoiceOutstandingTotalFromPurchases } from '../utils/helpers';
import { getStockBreakup } from '../utils/stock';
import { formatPackLooseQuantity } from '../utils/quantity';

interface ReportsProps {
  inventory: InventoryItem[];
  transactions: Transaction[];
  purchases: Purchase[];
  distributors: Distributor[];
  customers: Customer[];
  doctors: DoctorMaster[];
  salesReturns: SalesReturn[];
  purchaseReturns: PurchaseReturn[];
  onPrintReport: (report: { title: string; data: any[]; headers: string[]; filters: any; }) => void;
  config?: ModuleConfig;
}

interface ReportDefinition {
  id: string;
  name: string;
  group: string;
}

type SortDirection = 'asc' | 'desc';
type MfrSalesViewMode = 'detailed' | 'productSummary';
type StockMovementViewMode = 'detailed' | 'productSummary';
type InventoryValueViewMode = 'batchWise' | 'productWise';

const round2 = (value: number) => Number((Number(value || 0)).toFixed(2));
const parsePackSize = (pack: string | null | undefined) => {
  const matchedPackSize = String(pack || '').match(/\d+(\.\d+)?/);
  const parsedPackSize = matchedPackSize ? Number(matchedPackSize[0]) : NaN;
  return Number.isFinite(parsedPackSize) && parsedPackSize > 0 ? parsedPackSize : 1;
};

const REPORT_LIST: ReportDefinition[] = [
  { id: 'salesRegister', name: 'Sales Register', group: 'Sales Reports' },
  { id: 'salesSummary', name: 'Sales Summary', group: 'Sales Reports' },
  { id: 'billWiseSales', name: 'Bill-wise Sales', group: 'Sales Reports' },
  { id: 'rxMedicineSalesReport', name: 'RX Medicine Sales Report', group: 'Sales Reports' },
  { id: 'dateWiseSales', name: 'Date-wise Sales', group: 'Sales Reports' },
  { id: 'partyWiseSales', name: 'Party-wise Sales', group: 'Sales Reports' },
  { id: 'doctorWiseSales', name: 'Doctor-wise Sales', group: 'Sales Reports' },
  { id: 'doctorWiseSalesSummaryReport', name: 'Doctor-wise Sales Summary Report', group: 'Sales Reports' },
  { id: 'doctorsSalesDetailedReport', name: 'Doctors Sales Detailed Report', group: 'Sales Reports' },
  { id: 'mfrWiseSalesDetailedReport', name: 'MFR-wise Sales Detailed Report', group: 'Sales Reports' },
  { id: 'mfrWiseSalesSummaryReport', name: 'MFR-wise Sales Summary Report', group: 'Sales Reports' },
  { id: 'itemWiseSales', name: 'Item-wise Sales', group: 'Sales Reports' },
  { id: 'categoryWiseSales', name: 'Category-wise Sales', group: 'Sales Reports' },
  { id: 'areaWiseSales', name: 'Area-wise Sales', group: 'Sales Reports' },
  { id: 'salesReturnRegister', name: 'Sales Return Register', group: 'Sales Reports' },
  { id: 'creditNoteRegister', name: 'Credit Note Register', group: 'Sales Reports' },
  { id: 'schemeDiscountReport', name: 'Scheme/Discount Report', group: 'Sales Reports' },
  { id: 'freeQuantityReport', name: 'Free Quantity Report', group: 'Sales Reports' },
  { id: 'profitOnSales', name: 'Profit on Sales', group: 'Sales Reports' },
  { id: 'marginAnalysis', name: 'Margin Analysis', group: 'Sales Reports' },
  { id: 'cancelledDeletedBills', name: 'Cancelled Bills', group: 'Sales Reports' },

  { id: 'purchaseRegister', name: 'Purchase Register', group: 'Purchase Reports' },
  { id: 'purchaseSummary', name: 'Purchase Summary', group: 'Purchase Reports' },
  { id: 'billWisePurchase', name: 'Bill-wise Purchase', group: 'Purchase Reports' },
  { id: 'supplierWisePurchase', name: 'Supplier-wise Purchase', group: 'Purchase Reports' },
  { id: 'itemWisePurchase', name: 'Item-wise Purchase', group: 'Purchase Reports' },
  { id: 'purchaseReturnRegister', name: 'Purchase Return Register', group: 'Purchase Reports' },
  { id: 'debitNoteRegister', name: 'Debit Note Register', group: 'Purchase Reports' },

  { id: 'stockSummary', name: 'Stock Summary', group: 'Inventory Reports' },
  { id: 'batchWiseStock', name: 'Batch-wise Stock', group: 'Inventory Reports' },
  { id: 'expiryWiseStock', name: 'Expiry-wise Stock', group: 'Inventory Reports' },
  { id: 'nearExpiryReport', name: 'Near Expiry Report', group: 'Inventory Reports' },
  { id: 'expiredStockReport', name: 'Expired Stock Report', group: 'Inventory Reports' },
  { id: 'negativeStock', name: 'Negative Stock Report', group: 'Inventory Reports' },
  { id: 'reorderLevelReport', name: 'Reorder Level Report', group: 'Inventory Reports' },
  { id: 'stockMovementSummary', name: 'Stock Movement Summary', group: 'Inventory Reports' },
  { id: 'inventoryValue', name: 'Inventory Value', group: 'Inventory Reports' },

  { id: 'ledgerReport', name: 'Account Ledger', group: 'Accounting Reports' },
  { id: 'accountLedgerCustomer', name: 'Account Ledger for Customer', group: 'Accounting Reports' },
  { id: 'accountLedgerSupplier', name: 'Account Ledger for Supplier', group: 'Accounting Reports' },
  { id: 'dayBook', name: 'Day Book', group: 'Accounting Reports' },
  { id: 'outstandingReceivables', name: 'Outstanding Receivables', group: 'Accounting Reports' },
  { id: 'outstandingPayables', name: 'Outstanding Payables', group: 'Accounting Reports' },
  { id: 'customerPartyWiseFullStatement', name: 'Customer Party-wise Full Statement', group: 'Accounting Reports' },
  { id: 'supplierPartyWiseFullStatement', name: 'Supplier Party-wise Full Statement', group: 'Accounting Reports' },
];

const isDateWithinRange = (isoDate: string, startIso: string, endIso: string) => {
  const date = new Date(isoDate);
  const start = new Date(startIso);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endIso);
  end.setHours(23, 59, 59, 999);
  return date >= start && date <= end;
};

const Reports: React.FC<ReportsProps> = ({
  inventory, transactions, purchases, distributors, customers, doctors, salesReturns, purchaseReturns, onPrintReport,
}) => {
  const todayIso = new Date().toISOString().split('T')[0];
  const firstOfMonthIso = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

  const [periodStartDate, setPeriodStartDate] = useState(firstOfMonthIso);
  const [periodEndDate, setPeriodEndDate] = useState(todayIso);
  const [periodModalOpen, setPeriodModalOpen] = useState(false);
  const [pendingReportId, setPendingReportId] = useState<string>('salesRegister');
  const [partyModalOpen, setPartyModalOpen] = useState(false);
  const [selectedPartyId, setSelectedPartyId] = useState<string>('');

  const [activeReportId, setActiveReportId] = useState<string>('salesRegister');
  const [activeReportTitle, setActiveReportTitle] = useState<string>('Sales Register');
  const [headers, setHeaders] = useState<string[]>([]);
  const [baseData, setBaseData] = useState<any[]>([]);
  const [filteredData, setFilteredData] = useState<any[]>([]);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  const [activeFilters, setActiveFilters] = useState<Record<string, string[]>>({});
  const [sortConfig, setSortConfig] = useState<{ column: string; direction: SortDirection } | null>(null);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [columnModalOpen, setColumnModalOpen] = useState(false);
  const [mfrSalesViewMode, setMfrSalesViewMode] = useState<MfrSalesViewMode>('detailed');
  const [stockMovementViewMode, setStockMovementViewMode] = useState<StockMovementViewMode>('detailed');
  const [inventoryValueViewMode, setInventoryValueViewMode] = useState<InventoryValueViewMode>('batchWise');

  const reportById = useMemo(() => new Map(REPORT_LIST.map(r => [r.id, r])), []);
  const groupedReports = useMemo(() => {
    return REPORT_LIST.reduce<Record<string, ReportDefinition[]>>((acc, report) => {
      if (!acc[report.group]) acc[report.group] = [];
      acc[report.group].push(report);
      return acc;
    }, {});
  }, []);

  const applyFiltersAndSort = (source: any[], filters: Record<string, string[]>, sorter: { column: string; direction: SortDirection } | null) => {
    let next = [...source];

    Object.entries(filters).forEach(([field, values]) => {
      if (!values.length) return;
      next = next.filter(row => values.includes(String(row[field] ?? '')));
    });

    if (sorter) {
      next.sort((a, b) => {
        const aValue = a[sorter.column];
        const bValue = b[sorter.column];

        const aNum = Number(aValue);
        const bNum = Number(bValue);
        const isNumeric = !Number.isNaN(aNum) && !Number.isNaN(bNum) && aValue !== '' && bValue !== '';

        let result = 0;
        if (isNumeric) {
          result = aNum - bNum;
        } else {
          result = String(aValue ?? '').localeCompare(String(bValue ?? ''), undefined, { numeric: true });
        }

        return sorter.direction === 'asc' ? result : -result;
      });
    }

    return next;
  };

  const loadReportData = (reportId: string, startDate: string, endDate: string) => {
    let rows: any[] = [];
    let reportHeaders: string[] = [];
    let title = reportById.get(reportId)?.name || 'MIS Report';

    const customerByName = new Map(customers.map(c => [c.name, c]));
    const doctorById = new Map(doctors.map(d => [d.id, d]));
    const doctorByName = new Map(doctors.filter(d => (d.name || '').trim()).map(d => [(d.name || '').trim().toLowerCase(), d] as const));

    const sales = transactions.filter(tx => tx.status !== 'draft' && isDateWithinRange(tx.date, startDate, endDate));
    const completedSales = sales.filter(tx => tx.status !== 'cancelled');
    const completedOnlySales = sales.filter(tx => String(tx.status || '').toLowerCase() === 'completed');
    const cancelledSales = sales.filter(tx => tx.status === 'cancelled');
    const filteredPurchases = purchases.filter(p => p.status !== 'draft' && isDateWithinRange(p.date, startDate, endDate));
    const completedPurchases = filteredPurchases.filter(p => p.status !== 'cancelled');
    const filteredSalesReturns = salesReturns.filter(s => isDateWithinRange(s.date, startDate, endDate));
    const filteredPurchaseReturns = purchaseReturns.filter(p => isDateWithinRange(p.date, startDate, endDate));

    switch (reportId) {
      case 'salesRegister':
        reportHeaders = ['Bill No', 'Bill Date', 'Customer Name', 'GSTIN', 'Billing Category', 'Taxable Amount', 'GST Amount', 'Discount', 'Net Amount', 'Status'];
        rows = completedSales.map(tx => ({
          'Bill No': tx.invoiceNumber || tx.id,
          'Bill Date': new Date(tx.date).toLocaleDateString('en-GB'),
          'Customer Name': tx.customerName,
          'GSTIN': customerByName.get(tx.customerName)?.gstNumber || 'N/A',
          'Billing Category': tx.billType || 'regular',
          'Taxable Amount': round2(tx.subtotal - tx.totalItemDiscount - tx.schemeDiscount),
          'GST Amount': round2(tx.totalGst || 0),
          'Discount': round2((tx.totalItemDiscount || 0) + (tx.schemeDiscount || 0)),
          'Net Amount': round2(tx.total || 0),
          'Status': tx.status
        }));
        break;
      case 'salesSummary':
        reportHeaders = ['Total Sales Bills', 'Total Gross Sales', 'Total Discount', 'Total Taxable Value', 'Total GST', 'Net Sales', 'Cash Sales', 'Credit Sales'];
        rows = [{
          'Total Sales Bills': completedSales.length,
          'Total Gross Sales': round2(completedSales.reduce((sum, tx) => sum + Number(tx.subtotal || 0), 0)),
          'Total Discount': round2(completedSales.reduce((sum, tx) => sum + Number(tx.totalItemDiscount || 0) + Number(tx.schemeDiscount || 0), 0)),
          'Total Taxable Value': round2(completedSales.reduce((sum, tx) => sum + Number(tx.subtotal || 0) - Number(tx.totalItemDiscount || 0) - Number(tx.schemeDiscount || 0), 0)),
          'Total GST': round2(completedSales.reduce((sum, tx) => sum + Number(tx.totalGst || 0), 0)),
          'Net Sales': round2(completedSales.reduce((sum, tx) => sum + Number(tx.total || 0), 0)),
          'Cash Sales': round2(completedSales.filter(tx => tx.paymentMode?.toLowerCase().includes('cash')).reduce((sum, tx) => sum + Number(tx.total || 0), 0)),
          'Credit Sales': round2(completedSales.filter(tx => tx.paymentMode?.toLowerCase().includes('credit')).reduce((sum, tx) => sum + Number(tx.total || 0), 0))
        }];
        break;
      case 'billWiseSales':
        reportHeaders = ['Bill No', 'Date', 'Customer', 'Amount', 'Discount', 'GST', 'Final Bill Amount'];
        rows = completedSales.map(tx => ({
          'Bill No': tx.invoiceNumber || tx.id,
          'Date': new Date(tx.date).toLocaleDateString('en-GB'),
          'Customer': tx.customerName,
          'Amount': round2(tx.subtotal || 0),
          'Discount': round2((tx.totalItemDiscount || 0) + (tx.schemeDiscount || 0)),
          'GST': round2(tx.totalGst || 0),
          'Final Bill Amount': round2(tx.total || 0),
        }));
        break;
      case 'rxMedicineSalesReport': {
        reportHeaders = ['Bill Date', 'Sales Bill Number', 'Product Name', 'Batch', 'Qty', 'Rate', 'Taxable Amount', 'GST Amount', 'Bill Amount (With GST)', 'Without GST Amount', 'Customer Name', 'Phone Number', 'Address', 'Referred By', 'Bill Category', 'User / Operator', 'Bill Number', 'Doctor Name'];
        const normalize = (value: unknown) => String(value ?? '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ');
        const inventoryById = new Map(inventory.map(inv => [String(inv.id), inv]));
        const inventoryByCode = new Map(
          inventory
            .filter(inv => String((inv as any).code ?? '').trim())
            .map(inv => [String((inv as any).code).trim().toLowerCase(), inv] as const)
        );
        const inventoryBySku = new Map(
          inventory
            .filter(inv => String((inv as any).sku ?? '').trim())
            .map(inv => [String((inv as any).sku).trim().toLowerCase(), inv] as const)
        );
        const inventoryByName = new Map(
          inventory
            .filter(inv => normalize(inv.name))
            .map(inv => [normalize(inv.name), inv] as const)
        );

        rows = completedSales.flatMap(tx => {
          return (tx.items || [])
            .filter(item => {
              const rxSignals = [
                (item as any).is_rx,
                (item as any).rx_flag,
                (item as any).isPrescriptionRequired,
                (item as any).prescriptionRequired,
              ];

              const linkedInventory = inventoryById.get(String((item as any).inventoryItemId || ''))
                || inventoryById.get(String((item as any).product_id || ''))
                || inventoryById.get(String((item as any).material_id || ''))
                || inventoryById.get(String((item as any).sku_id || ''))
                || inventoryBySku.get(String((item as any).sku || '').trim().toLowerCase())
                || inventoryByCode.get(String((item as any).itemCode || (item as any).code || '').trim().toLowerCase())
                || inventoryByName.get(normalize((item as any).name));

              const masterRxSignals = [
                (linkedInventory as any)?.isPrescriptionRequired,
                (linkedInventory as any)?.prescription_required,
              ];

              return [...rxSignals, ...masterRxSignals].some(value => value === true || value === 'true' || value === 1 || value === '1');
            })
            .map(item => {
              const qty = Number(item.quantity || 0) + Number(item.looseQuantity || 0);
              const rate = Number(item.rate ?? item.mrp ?? 0);
              const taxableAmount = round2(Number(item.finalAmount ?? item.amount ?? rate * qty));
              const gstAmount = round2(taxableAmount * (Number(item.gstPercent || 0) / 100));
              const billAmount = round2(taxableAmount + gstAmount);
              return {
                'Bill Date': new Date(tx.date).toLocaleDateString('en-GB'),
                'Sales Bill Number': tx.invoiceNumber || tx.id,
                'Product Name': item.name || '-',
                'Batch': item.batch || '-',
                'Qty': round2(qty),
                'Rate': round2(rate),
                'Taxable Amount': taxableAmount,
                'GST Amount': gstAmount,
                'Bill Amount (With GST)': billAmount,
                'Without GST Amount': taxableAmount,
                'Customer Name': tx.customerName || '-',
                'Phone Number': tx.customerPhone || '-',
                'Address': tx.customerAddress || '-',
                'Referred By': tx.referredBy || '-',
                'Bill Category': tx.billType || 'regular',
                'User / Operator': tx.billedByName || tx.user_id || '-',
                'Bill Number': tx.invoiceNumber || tx.id,
                'Doctor Name': tx.referredBy || '-',
              };
            });
        });
        break;
      }
      case 'dateWiseSales': {
        reportHeaders = ['Date', 'Number of Bills', 'Gross Sales', 'Discount', 'GST', 'Net Sales'];
        const map = new Map<string, any>();
        completedSales.forEach(tx => {
          const date = new Date(tx.date).toLocaleDateString('en-GB');
          const current = map.get(date) || { bills: 0, gross: 0, discount: 0, gst: 0, net: 0 };
          map.set(date, { bills: current.bills + 1, gross: current.gross + Number(tx.subtotal || 0), discount: current.discount + Number(tx.totalItemDiscount || 0) + Number(tx.schemeDiscount || 0), gst: current.gst + Number(tx.totalGst || 0), net: current.net + Number(tx.total || 0) });
        });
        rows = Array.from(map.entries()).map(([date, value]) => ({ 'Date': date, 'Number of Bills': value.bills, 'Gross Sales': round2(value.gross), 'Discount': round2(value.discount), 'GST': round2(value.gst), 'Net Sales': round2(value.net) }));
        break;
      }
      case 'partyWiseSales': {
        reportHeaders = ['Customer Name', 'Number of Bills', 'Total Sales', 'Discount', 'GST', 'Net Amount', 'Outstanding'];
        const map = new Map<string, any>();
        completedSales.forEach(tx => {
          const current = map.get(tx.customerName) || { bills: 0, sales: 0, discount: 0, gst: 0, net: 0 };
          map.set(tx.customerName, { bills: current.bills + 1, sales: current.sales + Number(tx.subtotal || 0), discount: current.discount + Number(tx.totalItemDiscount || 0) + Number(tx.schemeDiscount || 0), gst: current.gst + Number(tx.totalGst || 0), net: current.net + Number(tx.total || 0) });
        });
        rows = Array.from(map.entries()).map(([name, value]) => ({ 'Customer Name': name, 'Number of Bills': value.bills, 'Total Sales': round2(value.sales), 'Discount': round2(value.discount), 'GST': round2(value.gst), 'Net Amount': round2(value.net), 'Outstanding': round2(getOutstandingBalance(customerByName.get(name))) }));
        break;
      }
      case 'doctorWiseSales': {
        reportHeaders = ['Doctor Name', 'Doctor Code', 'Specialization', 'Mobile', 'Area', 'Number of Bills', 'Number of Customers', 'Total Sales Amount', 'Total Discount', 'Total GST', 'Net Sales Value'];
        const map = new Map<string, any>();
        completedSales.forEach(tx => {
          const doctorFromId = tx.doctorId ? doctorById.get(tx.doctorId) : undefined;
          const doctorFromName = !doctorFromId ? doctorByName.get((tx.referredBy || '').trim().toLowerCase()) : undefined;
          const doctor = doctorFromId || doctorFromName;
          const doctorName = (doctor?.name || tx.referredBy || '').trim();
          if (!doctorName) return;
          const key = doctor?.id || doctorName.toLowerCase();
          const current = map.get(key) || { doctorName, doctorCode: doctor?.doctorCode || 'N/A', specialization: doctor?.specialization || 'N/A', mobile: doctor?.mobile || 'N/A', area: doctor?.area || 'N/A', bills: 0, customers: new Set<string>(), sales: 0, discount: 0, gst: 0, net: 0 };
          current.bills += 1;
          current.customers.add(tx.customerId || tx.customerName || 'Walk-in');
          current.sales += Number(tx.subtotal || 0);
          current.discount += Number(tx.totalItemDiscount || 0) + Number(tx.schemeDiscount || 0);
          current.gst += Number(tx.totalGst || 0);
          current.net += Number(tx.total || 0);
          map.set(key, current);
        });
        rows = Array.from(map.values()).map((value: any) => ({ 'Doctor Name': value.doctorName, 'Doctor Code': value.doctorCode, 'Specialization': value.specialization, 'Mobile': value.mobile, 'Area': value.area, 'Number of Bills': value.bills, 'Number of Customers': value.customers.size, 'Total Sales Amount': round2(value.sales), 'Total Discount': round2(value.discount), 'Total GST': round2(value.gst), 'Net Sales Value': round2(value.net) }));
        break;
      }
      case 'doctorWiseSalesSummaryReport': {
        reportHeaders = ['Doctor Name', 'Number of Bills', 'Number of Customers', 'Total Quantity', 'Total Free Quantity', 'Total Taxable Value', 'Total Discount', 'Total GST Amount', 'Net Sales Value', 'Total Profit Margin'];
        const map = new Map<string, any>();
        completedOnlySales.forEach(tx => {
          const doctorFromId = tx.doctorId ? doctorById.get(tx.doctorId) : undefined;
          const doctorFromName = !doctorFromId ? doctorByName.get((tx.referredBy || '').trim().toLowerCase()) : undefined;
          const doctorName = (doctorFromId?.name || doctorFromName?.name || tx.referredBy || '').trim();
          if (!doctorName) return;
          const key = (doctorFromId?.id || doctorFromName?.id || doctorName).toLowerCase();
          const current = map.get(key) || { doctorName, bills: new Set<string>(), customers: new Set<string>(), qty: 0, freeQty: 0, taxable: 0, discount: 0, gst: 0, net: 0, profit: 0 };
          current.bills.add(String(tx.invoiceNumber || tx.id));
          current.customers.add(String(tx.customerId || tx.customerName || 'Walk-in'));
          (tx.items || []).forEach((item: any) => {
            const qty = Number(item.quantity || 0);
            const freeQty = Number(item.freeQuantity || 0);
            const salesRate = Number(item.rate ?? item.mrp ?? 0);
            const lineDiscount = Number(item.itemFlatDiscount || 0)
              + (qty * salesRate * (Number(item.discountPercent || 0) / 100))
              + Number(item.schemeDiscountAmount || 0);
            const lineTaxableAmount = Number(item.finalAmount ?? item.amount ?? ((qty * salesRate) - lineDiscount));
            const sgst = Number(item.sgstAmount || 0);
            const cgst = Number(item.cgstAmount || 0);
            const gstAmount = (sgst + cgst) || (lineTaxableAmount * (Number(item.gstPercent || 0) / 100));
            const inv = inventory.find(invItem => invItem.id === item.inventoryItemId || invItem.name === item.name);
            const purchaseRate = Number(item.ptr ?? inv?.purchasePrice ?? inv?.ptr ?? 0);
            const profit = purchaseRate > 0 ? (salesRate - purchaseRate) * qty : 0;

            current.qty += qty;
            current.freeQty += freeQty;
            current.taxable += lineTaxableAmount;
            current.discount += lineDiscount;
            current.gst += gstAmount;
            current.net += lineTaxableAmount + gstAmount - lineDiscount;
            current.profit += profit;
          });
          map.set(key, current);
        });
        rows = Array.from(map.values()).map((value: any) => ({
          'Doctor Name': value.doctorName,
          'Number of Bills': value.bills.size,
          'Number of Customers': value.customers.size,
          'Total Quantity': round2(value.qty),
          'Total Free Quantity': round2(value.freeQty),
          'Total Taxable Value': round2(value.taxable),
          'Total Discount': round2(value.discount),
          'Total GST Amount': round2(value.gst),
          'Net Sales Value': round2(value.net),
          'Total Profit Margin': round2(value.profit),
        })).sort((a, b) => Number(b['Net Sales Value']) - Number(a['Net Sales Value']));
        setSortConfig({ column: 'Net Sales Value', direction: 'desc' });
        break;
      }

      case 'doctorsSalesDetailedReport': {
        reportHeaders = ['Doctor Name', 'Sales Bill No', 'Sales Bill Date', 'Product Name', 'Quantity', 'Product MFR', 'MRP', 'Sales Rate', 'Purchase Rate', 'Discount', 'Profit Margin', 'Amount', 'Status'];
        rows = completedSales.flatMap(tx => {
          const doctorFromId = tx.doctorId ? doctorById.get(tx.doctorId) : undefined;
          const doctorFromName = !doctorFromId ? doctorByName.get((tx.referredBy || '').trim().toLowerCase()) : undefined;
          const doctor = doctorFromId || doctorFromName;
          const doctorName = (doctor?.name || tx.referredBy || '').trim();
          if (!doctorName) return [];

          return (tx.items || []).map((item: any) => {
            const qty = Number(item.quantity || 0);
            const freeQty = Number(item.freeQuantity || 0);
            const salesRate = Number(item.rate ?? item.mrp ?? 0);
            const lineDiscount = Number(item.itemFlatDiscount || 0)
              + (qty * salesRate * (Number(item.discountPercent || 0) / 100))
              + Number(item.schemeDiscountAmount || 0);
            const amount = (qty * salesRate) - lineDiscount;
            const inv = inventory.find(invItem => invItem.id === item.inventoryItemId || invItem.name === item.name);
            const purchaseRate = Number(item.ptr ?? inv?.purchasePrice ?? inv?.ptr ?? 0);
            const marginPerUnit = purchaseRate > 0 ? (salesRate - purchaseRate) : 0;
            const totalProfitMargin = qty > 1 ? (marginPerUnit * qty) : marginPerUnit;

            return {
              'Doctor Name': doctorName,
              'Sales Bill No': tx.invoiceNumber || tx.id,
              'Sales Bill Date': new Date(tx.date).toLocaleDateString('en-GB'),
              'Product Name': item.name || 'N/A',
              'Quantity': formatPackLooseQuantity(qty, Number(item.looseQuantity || 0), freeQty),
              'Product MFR': item.manufacturer || inv?.manufacturer || 'N/A',
              'MRP': round2(Number(item.mrp ?? inv?.mrp ?? 0)),
              'Sales Rate': round2(salesRate),
              'Purchase Rate': purchaseRate > 0 ? round2(purchaseRate) : 'N/A',
              'Discount': round2(lineDiscount),
              'Profit Margin': purchaseRate > 0 ? round2(totalProfitMargin) : 0,
              'Amount': round2(Number(item.finalAmount ?? item.amount ?? amount ?? 0)),
              'Status': 'Completed',
              '_sortDoctor': doctorName.toLowerCase(),
              '_sortDate': new Date(tx.date).getTime(),
              '_doctorBillKey': `${doctorName.toLowerCase()}|${tx.invoiceNumber || tx.id}`,
            };
          });
        }).sort((a, b) => a._sortDoctor.localeCompare(b._sortDoctor) || b._sortDate - a._sortDate);
        break;
      }
      case 'mfrWiseSalesDetailedReport': {
        if (mfrSalesViewMode === 'productSummary') {
          reportHeaders = ['MFR Name', 'Product Name', 'Total Quantity', 'Total Free Qty', 'Average Sales Rate', 'Average Purchase Rate', 'Total Taxable Amount', 'Total GST Amount', 'Total Discount', 'Total Profit Margin', 'Total Net Amount', 'Number of Bills'];
          const map = new Map<string, any>();
          completedOnlySales.forEach(tx => {
            const billNo = String(tx.invoiceNumber || tx.id);
            (tx.items || []).forEach((item: any) => {
              const qty = Number(item.quantity || 0);
              const freeQty = Number(item.freeQuantity || 0);
              const salesRate = Number(item.rate ?? item.mrp ?? 0);
              const lineDiscount = Number(item.itemFlatDiscount || 0)
                + (qty * salesRate * (Number(item.discountPercent || 0) / 100))
                + Number(item.schemeDiscountAmount || 0);
              const inv = inventory.find(invItem => invItem.id === item.inventoryItemId || invItem.name === item.name);
              const purchaseRate = Number(item.ptr ?? inv?.purchasePrice ?? inv?.ptr ?? 0);
              const taxableAmount = (qty * salesRate) - lineDiscount;
              const sgst = Number(item.sgstAmount || 0);
              const cgst = Number(item.cgstAmount || 0);
              const gstAmount = (sgst + cgst) || (taxableAmount * (Number(item.gstPercent || 0) / 100));
              const netAmount = Number(item.finalAmount ?? item.amount ?? (taxableAmount + gstAmount));
              const mfrName = item.manufacturer || inv?.manufacturer || 'N/A';
              const productName = item.name || 'N/A';
              const key = `${String(mfrName).trim().toLowerCase()}|${String(productName).trim().toLowerCase()}`;
              const current = map.get(key) || { mfrName, productName, qty: 0, freeQty: 0, salesRateTotal: 0, purchaseRateTotal: 0, lineCount: 0, taxable: 0, gst: 0, discount: 0, profit: 0, net: 0, bills: new Set<string>() };

              current.qty += qty;
              current.freeQty += freeQty;
              current.salesRateTotal += salesRate;
              current.purchaseRateTotal += purchaseRate;
              current.lineCount += 1;
              current.taxable += taxableAmount;
              current.gst += gstAmount;
              current.discount += lineDiscount;
              current.profit += (salesRate - purchaseRate) * qty;
              current.net += netAmount;
              current.bills.add(billNo);
              map.set(key, current);
            });
          });

          rows = Array.from(map.values()).map((value: any) => ({
            'MFR Name': value.mfrName,
            'Product Name': value.productName,
            'Total Quantity': round2(value.qty),
            'Total Free Qty': round2(value.freeQty),
            'Average Sales Rate': round2(value.lineCount ? (value.salesRateTotal / value.lineCount) : 0),
            'Average Purchase Rate': round2(value.lineCount ? (value.purchaseRateTotal / value.lineCount) : 0),
            'Total Taxable Amount': round2(value.taxable),
            'Total GST Amount': round2(value.gst),
            'Total Discount': round2(value.discount),
            'Total Profit Margin': round2(value.profit),
            'Total Net Amount': round2(value.net),
            'Number of Bills': value.bills.size,
            '_sortMfr': String(value.mfrName || '').toLowerCase(),
            '_sortProduct': String(value.productName || '').toLowerCase(),
          })).sort((a, b) => a._sortMfr.localeCompare(b._sortMfr) || a._sortProduct.localeCompare(b._sortProduct));
          break;
        }
        reportHeaders = ['MFR Name', 'Product Name', 'Sales Bill No', 'Sales Bill Date', 'Customer Name', 'Quantity', 'Free Qty', 'MRP', 'Sales Rate', 'Purchase Rate', 'Discount', 'Taxable Amount', 'GST Amount', 'Profit Margin', 'Net Amount'];
        rows = completedOnlySales.flatMap(tx => {
          return (tx.items || []).map((item: any) => {
            const qty = Number(item.quantity || 0);
            const freeQty = Number(item.freeQuantity || 0);
            const salesRate = Number(item.rate ?? item.mrp ?? 0);
            const lineDiscount = Number(item.itemFlatDiscount || 0)
              + (qty * salesRate * (Number(item.discountPercent || 0) / 100))
              + Number(item.schemeDiscountAmount || 0);
            const inv = inventory.find(invItem => invItem.id === item.inventoryItemId || invItem.name === item.name);
            const purchaseRate = Number(item.ptr ?? inv?.purchasePrice ?? inv?.ptr ?? 0);
            const taxableAmount = (qty * salesRate) - lineDiscount;
            const gstAmount = taxableAmount * (Number(item.gstPercent || 0) / 100);
            const effectiveQty = qty + freeQty;
            const profitMargin = (salesRate - purchaseRate) * (effectiveQty > 0 ? effectiveQty : qty);

            return {
              'MFR Name': item.manufacturer || inv?.manufacturer || 'N/A',
              'Product Name': item.name || 'N/A',
              'Sales Bill No': tx.invoiceNumber || tx.id,
              'Sales Bill Date': new Date(tx.date).toLocaleDateString('en-GB'),
              'Customer Name': tx.customerName || 'Walk-in',
              'Quantity': formatPackLooseQuantity(qty, Number(item.looseQuantity || 0), freeQty),
              'Free Qty': round2(freeQty),
              'MRP': round2(Number(item.mrp ?? inv?.mrp ?? 0)),
              'Sales Rate': round2(salesRate),
              'Purchase Rate': purchaseRate > 0 ? round2(purchaseRate) : 0,
              'Discount': round2(lineDiscount),
              'Taxable Amount': round2(taxableAmount),
              'GST Amount': round2(gstAmount),
              'Profit Margin': round2(profitMargin),
              'Net Amount': round2(Number(item.finalAmount ?? item.amount ?? (taxableAmount + gstAmount))),
              '_qty': qty,
              '_freeQty': freeQty,
              '_sortMfr': String(item.manufacturer || inv?.manufacturer || 'N/A').toLowerCase(),
              '_sortProduct': String(item.name || '').toLowerCase(),
              '_sortDate': new Date(tx.date).getTime(),
            };
          });
        }).sort((a, b) => a._sortMfr.localeCompare(b._sortMfr) || a._sortProduct.localeCompare(b._sortProduct) || b._sortDate - a._sortDate);
        break;
      }
      case 'mfrWiseSalesSummaryReport': {
        reportHeaders = ['MFR Name', 'Number of Bills', 'Total Quantity', 'Total Free Qty', 'Total MRP Value', 'Total Sales Value (Taxable)', 'Total Discount', 'Total GST Amount', 'Net Sales Value', 'Total Profit Margin'];
        const map = new Map<string, any>();
        completedOnlySales.forEach(tx => {
          const billNo = String(tx.invoiceNumber || tx.id);
          (tx.items || []).forEach((item: any) => {
            const qty = Number(item.quantity || 0);
            const freeQty = Number(item.freeQuantity || 0);
            const salesRate = Number(item.rate ?? item.mrp ?? 0);
            const inv = inventory.find(invItem => invItem.id === item.inventoryItemId || invItem.name === item.name);
            const mfrName = item.manufacturer || inv?.manufacturer || 'N/A';
            const purchaseRate = Number(item.ptr ?? inv?.purchasePrice ?? inv?.ptr ?? 0);
            const lineDiscount = Number(item.itemFlatDiscount || 0)
              + (qty * salesRate * (Number(item.discountPercent || 0) / 100))
              + Number(item.schemeDiscountAmount || 0);
            const taxableAmount = (qty * salesRate) - lineDiscount;
            const sgst = Number(item.sgstAmount || 0);
            const cgst = Number(item.cgstAmount || 0);
            const gstAmount = sgst + cgst || (taxableAmount * (Number(item.gstPercent || 0) / 100));
            const mrp = Number(item.mrp ?? inv?.mrp ?? salesRate);
            const profit = (salesRate - purchaseRate) * qty;

            const current = map.get(mfrName) || { mfrName, bills: new Set<string>(), qty: 0, freeQty: 0, mrpValue: 0, taxable: 0, discount: 0, gst: 0, net: 0, profit: 0 };
            current.bills.add(billNo);
            current.qty += qty;
            current.freeQty += freeQty;
            current.mrpValue += (mrp * qty);
            current.taxable += taxableAmount;
            current.discount += lineDiscount;
            current.gst += gstAmount;
            current.net += taxableAmount + gstAmount - lineDiscount;
            current.profit += profit;
            map.set(mfrName, current);
          });
        });
        rows = Array.from(map.values()).map((value: any) => ({
          'MFR Name': value.mfrName,
          'Number of Bills': value.bills.size,
          'Total Quantity': round2(value.qty),
          'Total Free Qty': round2(value.freeQty),
          'Total MRP Value': round2(value.mrpValue),
          'Total Sales Value (Taxable)': round2(value.taxable),
          'Total Discount': round2(value.discount),
          'Total GST Amount': round2(value.gst),
          'Net Sales Value': round2(value.net),
          'Total Profit Margin': round2(value.profit),
        })).sort((a, b) => Number(b['Net Sales Value']) - Number(a['Net Sales Value']));
        setSortConfig({ column: 'Net Sales Value', direction: 'desc' });
        break;
      }

      case 'itemWiseSales': {
        reportHeaders = ['Item Name', 'HSN', 'Quantity Sold', 'Free Qty', 'Gross Value', 'Discount', 'GST', 'Net Value'];
        const map = new Map<string, any>();
        completedSales.forEach(tx => tx.items.forEach((item: any) => {
          const key = `${item.name}|${item.hsnCode || ''}`;
          const current = map.get(key) || { name: item.name, hsn: item.hsnCode || 'N/A', qty: 0, free: 0, gross: 0, discount: 0, gst: 0, net: 0 };
          const gross = (Number(item.quantity || 0) + Number(item.freeQuantity || 0)) * Number(item.rate ?? item.mrp ?? 0);
          const discount = Number(item.itemFlatDiscount || 0) + (Number(item.quantity || 0) * Number(item.rate ?? item.mrp ?? 0) * (Number(item.discountPercent || 0) / 100)) + Number(item.schemeDiscountAmount || 0);
          const taxable = Number(item.quantity || 0) * Number(item.rate ?? item.mrp ?? 0) - discount;
          const gst = taxable * (Number(item.gstPercent || 0) / 100);
          map.set(key, { ...current, qty: current.qty + Number(item.quantity || 0), free: current.free + Number(item.freeQuantity || 0), gross: current.gross + gross, discount: current.discount + discount, gst: current.gst + gst, net: current.net + (gross - discount + gst) });
        }));
        rows = Array.from(map.values()).map((v: any) => ({ 'Item Name': v.name, 'HSN': v.hsn, 'Quantity Sold': round2(v.qty), 'Free Qty': round2(v.free), 'Gross Value': round2(v.gross), 'Discount': round2(v.discount), 'GST': round2(v.gst), 'Net Value': round2(v.net) }));
        break;
      }
      case 'categoryWiseSales': {
        reportHeaders = ['Category', 'Quantity', 'Gross Amount', 'Discount', 'GST', 'Net Sales'];
        const categoryMap = completedSales.flatMap(tx => tx.items).reduce((acc: Map<string, any>, item: any) => {
          const key = item.category || 'Uncategorized';
          const current = acc.get(key) || { qty: 0, gross: 0, discount: 0, gst: 0, net: 0 };
          const gross = (Number(item.quantity || 0) + Number(item.freeQuantity || 0)) * Number(item.rate ?? item.mrp ?? 0);
          const discount = Number(item.itemFlatDiscount || 0) + (Number(item.quantity || 0) * Number(item.rate ?? item.mrp ?? 0) * (Number(item.discountPercent || 0) / 100));
          const gst = (gross - discount) * (Number(item.gstPercent || 0) / 100);
          acc.set(key, { qty: current.qty + Number(item.quantity || 0), gross: current.gross + gross, discount: current.discount + discount, gst: current.gst + gst, net: current.net + (gross - discount + gst) });
          return acc;
        }, new Map<string, any>());
        rows = Array.from(categoryMap.entries()).map(([k, v]) => ({ 'Category': k, 'Quantity': round2(v.qty), 'Gross Amount': round2(v.gross), 'Discount': round2(v.discount), 'GST': round2(v.gst), 'Net Sales': round2(v.net) }));
        break;
      }
      case 'areaWiseSales': {
        reportHeaders = ['Area / Locality', 'Number of Bills', 'Sales Amount', 'GST', 'Net Value'];
        const areaMap = completedSales.reduce((acc: Map<string, any>, tx) => {
          const key = customerByName.get(tx.customerName)?.area || 'Unknown';
          const current = acc.get(key) || { bills: 0, sales: 0, gst: 0, net: 0 };
          acc.set(key, { bills: current.bills + 1, sales: current.sales + Number(tx.subtotal || 0), gst: current.gst + Number(tx.totalGst || 0), net: current.net + Number(tx.total || 0) });
          return acc;
        }, new Map<string, any>());
        rows = Array.from(areaMap.entries()).map(([k, v]) => ({ 'Area / Locality': k, 'Number of Bills': v.bills, 'Sales Amount': round2(v.sales), 'GST': round2(v.gst), 'Net Value': round2(v.net) }));
        break;
      }
      case 'salesReturnRegister':
      case 'creditNoteRegister':
        reportHeaders = reportId === 'salesReturnRegister' ? ['Return Voucher No', 'Date', 'Original Bill No', 'Customer', 'Item / Amount', 'Tax Reversal', 'Return Total'] : ['Credit Note No', 'Date', 'Customer', 'Reference Bill', 'Amount', 'Reason'];
        rows = filteredSalesReturns.map(ret => reportId === 'salesReturnRegister' ? ({ 'Return Voucher No': ret.id, 'Date': new Date(ret.date).toLocaleDateString('en-GB'), 'Original Bill No': ret.originalInvoiceNumber || ret.originalInvoiceId, 'Customer': ret.customerName, 'Item / Amount': `${ret.items.length} items`, 'Tax Reversal': round2(ret.items.reduce((sum: number, i: any) => sum + (Number(i.returnQuantity || 0) * Number(i.rate ?? i.mrp ?? 0) * (Number(i.gstPercent || 0) / 100)), 0)), 'Return Total': round2(ret.totalRefund || 0) }) : ({ 'Credit Note No': `CN-${ret.id}`, 'Date': new Date(ret.date).toLocaleDateString('en-GB'), 'Customer': ret.customerName, 'Reference Bill': ret.originalInvoiceNumber || ret.originalInvoiceId, 'Amount': round2(ret.totalRefund || 0), 'Reason': ret.remarks || 'Sales return adjustment' }));
        break;
      case 'schemeDiscountReport':
        reportHeaders = ['Bill No', 'Date', 'Customer', 'Item', 'Trade Discount', 'Bill Discount', 'Scheme Discount', 'Net Impact'];
        rows = completedSales.flatMap(tx => tx.items.map((item: any) => {
          const tradeDiscount = Number(item.itemFlatDiscount || 0) + (Number(item.quantity || 0) * Number(item.rate ?? item.mrp ?? 0) * (Number(item.discountPercent || 0) / 100));
          const schemeDiscount = Number(item.schemeDiscountAmount || 0);
          const billDiscount = (Number(tx.totalItemDiscount || 0) + Number(tx.schemeDiscount || 0)) / Math.max(tx.items.length, 1);
          return { 'Bill No': tx.invoiceNumber || tx.id, 'Date': new Date(tx.date).toLocaleDateString('en-GB'), 'Customer': tx.customerName, 'Item': item.name, 'Trade Discount': round2(tradeDiscount), 'Bill Discount': round2(billDiscount), 'Scheme Discount': round2(schemeDiscount), 'Net Impact': round2(tradeDiscount + billDiscount + schemeDiscount) };
        }));
        break;
      case 'freeQuantityReport':
        reportHeaders = ['Bill No', 'Date', 'Customer', 'Item', 'Sold Qty', 'Free Qty', 'Effective Rate'];
        rows = completedSales.flatMap(tx => tx.items.filter((i: any) => Number(i.freeQuantity || 0) > 0).map((i: any) => ({ 'Bill No': tx.invoiceNumber || tx.id, 'Date': new Date(tx.date).toLocaleDateString('en-GB'), 'Customer': tx.customerName, 'Item': i.name, 'Sold Qty': round2(i.quantity || 0), 'Free Qty': round2(i.freeQuantity || 0), 'Effective Rate': round2((Number(i.rate ?? i.mrp ?? 0) * Number(i.quantity || 0)) / Math.max(Number(i.quantity || 0) + Number(i.freeQuantity || 0), 1)) })));
        break;
      case 'profitOnSales':
      case 'marginAnalysis':
        reportHeaders = reportId === 'profitOnSales' ? ['Bill No / Item', 'Sales Value', 'Cost Value', 'Gross Profit', 'Profit %'] : ['Item Name', 'Sales Rate', 'Cost Rate', 'Margin Amount', 'Margin %'];
        rows = completedSales.flatMap(tx => tx.items.map((i: any) => {
          const inv = inventory.find(item => item.id === i.inventoryItemId || item.name === i.name);
          const salesRate = Number(i.rate ?? i.mrp ?? 0);
          const costRate = Number(inv?.purchasePrice || inv?.ptr || 0);
          const salesValue = Number(i.quantity || 0) * salesRate;
          const costValue = Number(i.quantity || 0) * costRate;
          const profit = salesValue - costValue;
          return reportId === 'profitOnSales' ? { 'Bill No / Item': `${tx.invoiceNumber || tx.id} / ${i.name}`, 'Sales Value': round2(salesValue), 'Cost Value': round2(costValue), 'Gross Profit': round2(profit), 'Profit %': salesValue > 0 ? round2((profit / salesValue) * 100) : 0 } : { 'Item Name': i.name, 'Sales Rate': round2(salesRate), 'Cost Rate': round2(costRate), 'Margin Amount': round2(salesRate - costRate), 'Margin %': salesRate > 0 ? round2(((salesRate - costRate) / salesRate) * 100) : 0 };
        }));
        break;
      case 'cancelledDeletedBills':
        reportHeaders = ['Bill No', 'Date', 'Customer', 'Amount', 'Cancelled On', 'Cancelled By'];
        rows = cancelledSales.map(tx => ({ 'Bill No': tx.invoiceNumber || tx.id, 'Date': new Date(tx.date).toLocaleDateString('en-GB'), 'Customer': tx.customerName, 'Amount': round2(tx.total || 0), 'Cancelled On': tx.createdAt ? new Date(tx.createdAt).toLocaleDateString('en-GB') : new Date(tx.date).toLocaleDateString('en-GB'), 'Cancelled By': tx.billedByName || 'System' }));
        break;
      case 'purchaseRegister':
      case 'billWisePurchase':
        reportHeaders = reportId === 'purchaseRegister' ? ['Purchase Bill No', 'Date', 'Supplier', 'Taxable Amount', 'GST', 'Discount', 'Net Amount'] : ['Bill No', 'Date', 'Supplier', 'Amount', 'GST', 'Discount', 'Final Amount'];
        rows = completedPurchases.map(p => ({ [reportId === 'purchaseRegister' ? 'Purchase Bill No' : 'Bill No']: p.invoiceNumber, 'Date': new Date(p.date).toLocaleDateString('en-GB'), 'Supplier': p.supplier, [reportId === 'purchaseRegister' ? 'Taxable Amount' : 'Amount']: round2(p.subtotal - p.totalItemDiscount - p.totalItemSchemeDiscount - p.schemeDiscount), 'GST': round2(p.totalGst || 0), 'Discount': round2((p.totalItemDiscount || 0) + (p.totalItemSchemeDiscount || 0) + (p.schemeDiscount || 0)), [reportId === 'purchaseRegister' ? 'Net Amount' : 'Final Amount']: round2(p.totalAmount || 0) }));
        break;
      case 'purchaseSummary':
        reportHeaders = ['Total Purchase Bills', 'Gross Purchase', 'Discount', 'Taxable Value', 'GST', 'Net Purchase'];
        rows = [{ 'Total Purchase Bills': completedPurchases.length, 'Gross Purchase': round2(completedPurchases.reduce((s, p) => s + Number(p.subtotal || 0), 0)), 'Discount': round2(completedPurchases.reduce((s, p) => s + Number(p.totalItemDiscount || 0) + Number(p.totalItemSchemeDiscount || 0) + Number(p.schemeDiscount || 0), 0)), 'Taxable Value': round2(completedPurchases.reduce((s, p) => s + Number(p.subtotal || 0) - Number(p.totalItemDiscount || 0) - Number(p.totalItemSchemeDiscount || 0) - Number(p.schemeDiscount || 0), 0)), 'GST': round2(completedPurchases.reduce((s, p) => s + Number(p.totalGst || 0), 0)), 'Net Purchase': round2(completedPurchases.reduce((s, p) => s + Number(p.totalAmount || 0), 0)) }];
        break;
      case 'supplierWisePurchase':
      case 'itemWisePurchase': {
        if (reportId === 'supplierWisePurchase') {
          reportHeaders = ['Supplier', 'Number of Bills', 'Purchase Amount', 'Discount', 'GST', 'Net Purchase'];
          const map = new Map<string, any>();
          completedPurchases.forEach(p => {
            const current = map.get(p.supplier) || { bills: 0, purchase: 0, discount: 0, gst: 0, net: 0 };
            map.set(p.supplier, { bills: current.bills + 1, purchase: current.purchase + Number(p.subtotal || 0), discount: current.discount + Number(p.totalItemDiscount || 0) + Number(p.totalItemSchemeDiscount || 0) + Number(p.schemeDiscount || 0), gst: current.gst + Number(p.totalGst || 0), net: current.net + Number(p.totalAmount || 0) });
          });
          rows = Array.from(map.entries()).map(([k, v]) => ({ 'Supplier': k, 'Number of Bills': v.bills, 'Purchase Amount': round2(v.purchase), 'Discount': round2(v.discount), 'GST': round2(v.gst), 'Net Purchase': round2(v.net) }));
        } else {
          reportHeaders = ['Item Name', 'Quantity Purchased', 'Free Qty', 'Purchase Value', 'GST', 'Net Value'];
          const map = new Map<string, any>();
          completedPurchases.forEach(p => p.items.forEach((i: any) => {
            const current = map.get(i.name) || { qty: 0, free: 0, value: 0, gst: 0, net: 0 };
            const gross = (Number(i.quantity || 0) + Number(i.freeQuantity || 0)) * Number(i.purchasePrice || 0);
            const discount = Number(i.discountPercent || 0) * Number(i.purchasePrice || 0) * Number(i.quantity || 0) / 100 + Number(i.schemeDiscountAmount || 0);
            const taxable = gross - discount;
            const gst = taxable * Number(i.gstPercent || 0) / 100;
            map.set(i.name, { qty: current.qty + Number(i.quantity || 0), free: current.free + Number(i.freeQuantity || 0), value: current.value + gross, gst: current.gst + gst, net: current.net + taxable + gst });
          }));
          rows = Array.from(map.entries()).map(([k, v]) => ({ 'Item Name': k, 'Quantity Purchased': round2(v.qty), 'Free Qty': round2(v.free), 'Purchase Value': round2(v.value), 'GST': round2(v.gst), 'Net Value': round2(v.net) }));
        }
        break;
      }
      case 'purchaseReturnRegister':
      case 'debitNoteRegister':
        reportHeaders = reportId === 'purchaseReturnRegister' ? ['Return No', 'Date', 'Supplier', 'Original Bill Ref', 'Return Amount', 'Tax Effect'] : ['Debit Note No', 'Date', 'Supplier', 'Reference', 'Amount', 'Reason'];
        rows = filteredPurchaseReturns.map(ret => reportId === 'purchaseReturnRegister' ? ({ 'Return No': ret.id, 'Date': new Date(ret.date).toLocaleDateString('en-GB'), 'Supplier': ret.supplier, 'Original Bill Ref': ret.originalPurchaseInvoiceId, 'Return Amount': round2(ret.totalValue || 0), 'Tax Effect': round2((ret.totalValue || 0) * 0.12) }) : ({ 'Debit Note No': `DN-${ret.id}`, 'Date': new Date(ret.date).toLocaleDateString('en-GB'), 'Supplier': ret.supplier, 'Reference': ret.originalPurchaseInvoiceId, 'Amount': round2(ret.totalValue || 0), 'Reason': ret.remarks || 'Purchase return adjustment' }));
        break;
      case 'stockSummary':
      case 'batchWiseStock':
      case 'expiryWiseStock':
        reportHeaders = reportId === 'stockSummary' ? ['Item Name', 'Batch', 'Pack', 'Stock (Pack / Loose / Total)', 'MRP', 'MRP Amount', 'PTR / Cost', 'PTR Amount', 'Expiry'] : reportId === 'batchWiseStock' ? ['Item', 'Batch', 'Expiry', 'Quantity', 'Value'] : ['Item', 'Batch', 'Expiry', 'Qty', 'Value'];
        rows = inventory.map(item => {
          const breakup = getStockBreakup(item.stock, item.unitsPerPack);
          const packSize = parsePackSize(item.packType);
          const packQty = Number(breakup.pack || 0);
          const looseQty = Number(breakup.loose || 0);
          const mrp = Number(item.mrp || 0);
          const ptrCost = Number(item.ptr || item.purchasePrice || 0);
          const mrpAmount = (packQty * mrp) + (looseQty * (mrp / packSize));
          const ptrAmount = (packQty * ptrCost) + (looseQty * (ptrCost / packSize));
          return {
            'Item Name': item.name,
            'Item': item.name,
            'Batch': item.batch,
            'Pack': item.packType || 'N/A',
            'Stock (Pack / Loose / Total)': `${packQty} / ${looseQty} / ${breakup.totalUnits}`,
            'MRP': round2(mrp),
            'MRP Amount': round2(mrpAmount),
            'PTR / Cost': round2(ptrCost),
            'PTR Amount': round2(ptrAmount),
            'Value': round2(mrpAmount),
            'Expiry': item.expiry ? new Date(item.expiry).toLocaleDateString('en-GB') : 'N/A',
            'Quantity': breakup.totalUnits,
            'Qty': breakup.totalUnits,
            _sort: item.expiry ? new Date(item.expiry).getTime() : Number.MAX_SAFE_INTEGER
          };
        });
        if (reportId === 'expiryWiseStock') rows = rows.sort((a, b) => a._sort - b._sort);
        break;
      case 'nearExpiryReport':
      case 'expiredStockReport': {
        reportHeaders = reportId === 'nearExpiryReport' ? ['Item', 'Batch', 'Expiry', 'Remaining Days', 'Qty', 'Value'] : ['Item', 'Batch', 'Expiry', 'Qty', 'Value'];
        const now = new Date();
        rows = inventory.map(item => {
          const breakup = getStockBreakup(item.stock, item.unitsPerPack, item.packType);
          const expiryDate = item.expiry ? new Date(item.expiry) : null;
          const remainingDays = expiryDate ? Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : null;
          return { 'Item': item.name, 'Batch': item.batch, 'Expiry': expiryDate ? expiryDate.toLocaleDateString('en-GB') : 'N/A', 'Remaining Days': remainingDays ?? 'N/A', 'Qty': breakup.totalUnits, 'Value': round2(breakup.totalUnits * Number(item.purchasePrice || item.ptr || 0)), _remainingDays: remainingDays };
        }).filter(row => reportId === 'nearExpiryReport' ? typeof row._remainingDays === 'number' && row._remainingDays >= 0 && row._remainingDays <= 90 : typeof row._remainingDays === 'number' && row._remainingDays < 0);
        break;
      }
      case 'negativeStock':
        reportHeaders = ['Item', 'Batch', 'Current Stock', 'Location'];
        rows = inventory.filter(i => Number(i.stock || 0) < 0).map(i => ({ 'Item': i.name, 'Batch': i.batch, 'Current Stock': Number(i.stock || 0), 'Location': i.rackNumber || 'N/A' }));
        break;


      case 'inventoryValue': {
        reportHeaders = ['Product Name', 'Material Code', 'Batch', 'Expiry', 'Quantity', 'Purchase Rate', 'Value', 'HSN Code', 'MFR', 'Pack', 'GST %', 'Valuation Method', 'Category'];
        const valuationMethod = String(activeFilters['Valuation Method']?.[0] || 'Moving Average');
        const shouldShowBatch = inventoryValueViewMode === 'batchWise';
        const inventoryRows = inventory
          .map(item => {
            const breakup = getStockBreakup(item.stock, item.unitsPerPack, item.packType);
            const qty = Number(breakup.totalUnits || 0);
            const batchRate = Number(item.ptr || item.purchasePrice || 0);
            const standardRate = Number(item.purchasePrice || item.ptr || 0);
            const purchaseRate = valuationMethod === 'Standard' ? standardRate : batchRate;
            return {
              'Product Name': item.name,
              'Material Code': item.code || item.id,
              'Batch': item.batch || 'N/A',
              'Expiry': item.expiry ? new Date(item.expiry).toLocaleDateString('en-GB') : 'N/A',
              'Quantity': qty,
              'Purchase Rate': round2(purchaseRate),
              'Value': round2(qty * purchaseRate),
              'HSN Code': item.hsnCode || 'N/A',
              'MFR': item.manufacturer || item.brand || 'N/A',
              'Pack': item.packType || 'N/A',
              'GST %': round2(Number(item.gstPercent || 0)),
              'Valuation Method': valuationMethod,
              'Category': item.category || 'N/A',
            };
          })
          .filter(row => Number(row['Quantity'] || 0) >= 0);

        if (shouldShowBatch) {
          rows = inventoryRows;
        } else {
          const grouped = new Map();
          inventoryRows.forEach((row:any) => {
            const key = `${String(row['Product Name']).toLowerCase()}|${String(row['Material Code']).toLowerCase()}`;
            const current:any = grouped.get(key) || { ...row, 'Batch': '-', 'Expiry': '-', 'Quantity': 0, 'Purchase Rate': 0, 'Value': 0, _weightedAmount: 0, _batches: 0 };
            current['Quantity'] = round2(Number(current['Quantity']) + Number(row['Quantity']));
            current['Value'] = round2(Number(current['Value']) + Number(row['Value']));
            current._weightedAmount = Number(current._weightedAmount) + (Number(row['Quantity']) * Number(row['Purchase Rate']));
            current._batches = Number(current._batches) + 1;
            grouped.set(key, current);
          });
          rows = Array.from(grouped.values()).map((row:any) => ({
            ...row,
            'Purchase Rate': round2(Number(row['Quantity']) ? Number(row._weightedAmount) / Number(row['Quantity']) : 0),
            'Value': round2(Number(row['Value'])),
            'Batch': 'Consolidated',
            'Expiry': '-',
          }));
        }
        if (inventoryValueViewMode !== 'batchWise') {
          reportHeaders = reportHeaders.filter(h => h !== 'Batch' && h !== 'Expiry');
        }
        break;
      }

      case 'stockMovementSummary': {
        const summaryHeaders = ['Product Name', 'MFR', 'Rate', 'Opening Qty', 'Opening Value', 'Receipt Qty', 'Receipt Value', 'Issue Qty', 'Issue Value', 'Closing Qty', 'Closing Value'];
        const detailedHeaders = ['Product Name', 'MFR', 'Rate', 'Batch', 'Movement Type', 'Reference No', 'Opening Qty', 'Opening Value', 'Receipt Qty', 'Receipt Value', 'Issue Qty', 'Issue Value', 'Closing Qty', 'Closing Value'];
        reportHeaders = stockMovementViewMode === 'productSummary' ? summaryHeaders : detailedHeaders;

        const detailedRows: any[] = [];
        const addDetailedRow = (payload: any) => {
          const rate = round2(Number(payload.rate || 0));
          const openingQty = round2(Number(payload.openingQty || 0));
          const receiptQty = round2(Number(payload.receiptQty || 0));
          const issueQty = round2(Number(payload.issueQty || 0));
          const closingQty = round2(openingQty + receiptQty - issueQty);
          detailedRows.push({
            'Product Name': payload.name,
            'MFR': payload.manufacturer || 'N/A',
            'Rate': rate,
            'Batch': payload.batch || 'N/A',
            'Movement Type': payload.movementType,
            'Reference No': payload.referenceNo || '-',
            'Opening Qty': openingQty,
            'Opening Value': round2(openingQty * rate),
            'Receipt Qty': receiptQty,
            'Receipt Value': round2(receiptQty * rate),
            'Issue Qty': issueQty,
            'Issue Value': round2(issueQty * rate),
            'Closing Qty': closingQty,
            'Closing Value': round2(closingQty * rate),
          });
        };

        purchases.filter(p => p.status !== 'draft' && p.status !== 'cancelled' && new Date(p.date) < new Date(startDate)).forEach(p => {
          (p.items || []).forEach((item: any) => {
            const qty = Number(item.quantity || 0) + Number(item.freeQuantity || 0);
            addDetailedRow({ name: item.name, manufacturer: item.manufacturer || item.brand || '', batch: item.batch, rate: Number(item.purchasePrice || item.ptr || 0), movementType: 'Opening', referenceNo: p.invoiceNumber || p.id, openingQty: qty });
          });
        });
        transactions.filter(tx => tx.status !== 'draft' && tx.status !== 'cancelled' && new Date(tx.date) < new Date(startDate)).forEach(tx => {
          (tx.items || []).forEach((item: any) => {
            const inv = inventory.find(i => i.name === item.name && (!item.batch || !i.batch || i.batch === item.batch));
            const qty = Number(item.quantity || 0) + Number(item.freeQuantity || 0);
            addDetailedRow({ name: item.name, manufacturer: item.manufacturer || inv?.manufacturer || item.brand || '', batch: item.batch || inv?.batch, rate: Number(item.rate ?? item.ptr ?? item.purchasePrice ?? inv?.ptr ?? inv?.purchasePrice ?? 0), movementType: 'Opening Adjustment', referenceNo: tx.invoiceNumber || tx.id, openingQty: -qty });
          });
        });
        purchases.filter(p => p.status !== 'draft' && p.status !== 'cancelled' && isDateWithinRange(p.date, startDate, endDate)).forEach(p => {
          (p.items || []).forEach((item: any) => {
            const qty = Number(item.quantity || 0) + Number(item.freeQuantity || 0);
            addDetailedRow({ name: item.name, manufacturer: item.manufacturer || item.brand || '', batch: item.batch, rate: Number(item.purchasePrice || item.ptr || 0), movementType: 'Receipt', referenceNo: p.invoiceNumber || p.id, receiptQty: qty });
          });
        });
        transactions.filter(tx => tx.status !== 'draft' && tx.status !== 'cancelled' && isDateWithinRange(tx.date, startDate, endDate)).forEach(tx => {
          (tx.items || []).forEach((item: any) => {
            const inv = inventory.find(i => i.name === item.name && (!item.batch || !i.batch || i.batch === item.batch));
            const qty = Number(item.quantity || 0) + Number(item.freeQuantity || 0);
            addDetailedRow({ name: item.name, manufacturer: item.manufacturer || inv?.manufacturer || item.brand || '', batch: item.batch || inv?.batch, rate: Number(item.rate ?? item.ptr ?? item.purchasePrice ?? inv?.ptr ?? inv?.purchasePrice ?? 0), movementType: 'Issue', referenceNo: tx.invoiceNumber || tx.id, issueQty: qty });
          });
        });

        if (stockMovementViewMode === 'productSummary') {
          const grouped = new Map<string, any>();
          detailedRows.forEach((row: any) => {
            const key = `${String(row['Product Name']).trim().toLowerCase()}|${String(row['MFR']).trim().toLowerCase()}|${Number(row['Rate'] || 0)}`;
            const current = grouped.get(key) || { ...summaryHeaders.reduce((acc: any, h) => ({ ...acc, [h]: 0 }), {}), 'Product Name': row['Product Name'], 'MFR': row['MFR'], 'Rate': row['Rate'] };
            current['Opening Qty'] = round2(Number(current['Opening Qty']) + Number(row['Opening Qty']));
            current['Opening Value'] = round2(Number(current['Opening Value']) + Number(row['Opening Value']));
            current['Receipt Qty'] = round2(Number(current['Receipt Qty']) + Number(row['Receipt Qty']));
            current['Receipt Value'] = round2(Number(current['Receipt Value']) + Number(row['Receipt Value']));
            current['Issue Qty'] = round2(Number(current['Issue Qty']) + Number(row['Issue Qty']));
            current['Issue Value'] = round2(Number(current['Issue Value']) + Number(row['Issue Value']));
            grouped.set(key, current);
          });
          rows = Array.from(grouped.values()).map((row: any) => ({ ...row, 'Closing Qty': round2(Number(row['Opening Qty']) + Number(row['Receipt Qty']) - Number(row['Issue Qty'])), 'Closing Value': round2((Number(row['Opening Qty']) + Number(row['Receipt Qty']) - Number(row['Issue Qty'])) * Number(row['Rate'])) })).sort((a,b)=>String(a['Product Name']).localeCompare(String(b['Product Name'])));
        } else {
          rows = detailedRows.sort((a,b)=>String(a['Product Name']).localeCompare(String(b['Product Name'])));
        }
        break;
      }
      case 'reorderLevelReport':
        reportHeaders = ['Item', 'Current Stock', 'Minimum Limit', 'Required Reorder Qty'];
        rows = inventory.map(i => {
          const breakup = getStockBreakup(i.stock, i.unitsPerPack, i.packType);
          const minLimit = Number(i.minStockLimit || 0);
          return { 'Item': i.name, 'Current Stock': breakup.totalUnits, 'Minimum Limit': minLimit, 'Required Reorder Qty': Math.max(minLimit - breakup.totalUnits, 0) };
        }).filter(i => i['Required Reorder Qty'] > 0);
        break;
      case 'ledgerReport': {
        reportHeaders = ['Date', 'Voucher No', 'Particulars', 'Debit', 'Credit', 'Running Balance'];
        const rowsPool = [
          ...customers.flatMap(c => (c.ledger || []).map(entry => ({ party: c.name, entry }))),
          ...distributors.flatMap(d => (d.ledger || []).map(entry => ({ party: d.name, entry })))
        ];
        rows = rowsPool
          .map(r => ({ date: r.entry.date, voucher: r.entry.referenceInvoiceNumber || r.entry.journalEntryNumber || r.entry.id, particulars: `${r.party} - ${r.entry.description}`, debit: Number(r.entry.debit || 0), credit: Number(r.entry.credit || 0), balance: Number(r.entry.balance || 0) }))
          .filter(r => isDateWithinRange(r.date, startDate, endDate))
          .map(r => ({ 'Date': new Date(r.date).toLocaleDateString('en-GB'), 'Voucher No': r.voucher, 'Particulars': r.particulars, 'Debit': round2(r.debit), 'Credit': round2(r.credit), 'Running Balance': round2(r.balance) }));
        break;
      }
      case 'dayBook':
        reportHeaders = ['Date', 'Voucher Type', 'Voucher No', 'Party / Ledger', 'Amount', 'Narration'];
        rows = [
          ...completedSales.map(tx => ({ 'Date': new Date(tx.date).toLocaleDateString('en-GB'), 'Voucher Type': 'Sales', 'Voucher No': tx.invoiceNumber || tx.id, 'Party / Ledger': tx.customerName, 'Amount': round2(tx.total || 0), 'Narration': `Sale (${tx.paymentMode || 'N/A'})`, _sort: tx.date })),
          ...completedPurchases.map(p => ({ 'Date': new Date(p.date).toLocaleDateString('en-GB'), 'Voucher Type': 'Purchase', 'Voucher No': p.invoiceNumber, 'Party / Ledger': p.supplier, 'Amount': round2(p.totalAmount || 0), 'Narration': 'Purchase entry', _sort: p.date })),
        ].sort((a, b) => new Date(a._sort).getTime() - new Date(b._sort).getTime());
        break;
      case 'outstandingReceivables':
        reportHeaders = ['Customer', 'Bill No', 'Bill Date', 'Due Amount', 'Received Amount', 'Balance Outstanding', 'Ageing'];
        rows = completedSales.map(tx => {
          const dueAmount = Number(tx.total || 0);
          const receivedAmount = Number(tx.amountReceived || 0);
          const balance = dueAmount - receivedAmount;
          return { 'Customer': tx.customerName, 'Bill No': tx.invoiceNumber || tx.id, 'Bill Date': new Date(tx.date).toLocaleDateString('en-GB'), 'Due Amount': round2(dueAmount), 'Received Amount': round2(receivedAmount), 'Balance Outstanding': round2(balance), 'Ageing': Math.max(0, Math.ceil((new Date().getTime() - new Date(tx.date).getTime()) / (1000 * 60 * 60 * 24))) };
        }).filter(r => r['Balance Outstanding'] > 0);
        break;
      case 'outstandingPayables':
        reportHeaders = ['Supplier', 'Bill No', 'Bill Date', 'Bill Amount', 'Paid Amount', 'Balance Outstanding', 'Ageing'];
        rows = completedPurchases.map(p => {
          const billAmount = Number(p.totalAmount || 0);
          const supplierOutstanding = Math.max(Number(getOutstandingBalance(distributors.find(d => d.name === p.supplier)) || 0), 0);
          const paidAmount = Math.max(billAmount - supplierOutstanding, 0);
          return { 'Supplier': p.supplier, 'Bill No': p.invoiceNumber, 'Bill Date': new Date(p.date).toLocaleDateString('en-GB'), 'Bill Amount': round2(billAmount), 'Paid Amount': round2(paidAmount), 'Balance Outstanding': round2(Math.max(billAmount - paidAmount, 0)), 'Ageing': Math.max(0, Math.ceil((new Date().getTime() - new Date(p.date).getTime()) / (1000 * 60 * 60 * 24))) };
        }).filter(r => r['Balance Outstanding'] > 0);
        break;
      case 'customerPartyWiseFullStatement':
      case 'supplierPartyWiseFullStatement':
      case 'accountLedgerCustomer':
      case 'accountLedgerSupplier': {
        const isCustomer = reportId === 'customerPartyWiseFullStatement' || reportId === 'accountLedgerCustomer';
        const party = isCustomer ? customers.find(c => c.id === selectedPartyId) : distributors.find(d => d.id === selectedPartyId);
        const partyName = party?.name || 'Selected Party';
        title = `${title} - ${partyName}`;
        const allLedgerRows = (party?.ledger || []).filter((entry: any) => entry && entry.date);
        const ledgerRows = allLedgerRows.filter((entry: any) => isDateWithinRange(entry.date, startDate, endDate));
        const normalizedPartyName = String(partyName || '').trim().toLowerCase();
        const generatedCustomerRows = isCustomer ? transactions
          .filter(tx => tx.status !== 'draft' && tx.status !== 'cancelled')
          .filter(tx => isDateWithinRange(tx.date, startDate, endDate))
          .filter(tx => {
            const txCustomerName = String(tx.customerName || '').trim().toLowerCase();
            const txCustomerId = String(tx.customerId || '').trim();
            return txCustomerName === normalizedPartyName || (selectedPartyId && txCustomerId === selectedPartyId);
          })
          .flatMap((tx: any) => {
            const invoiceNo = tx.invoiceNumber || tx.id;
            const invoiceAmount = round2(Number(tx.total || 0));
            const receivedAmount = round2(Number(tx.amountReceived || 0));
            const rowsForTx: any[] = [{
              id: `sales-${tx.id}`,
              date: tx.date,
              type: 'sale',
              description: `Sales invoice ${invoiceNo}`,
              debit: invoiceAmount,
              credit: 0,
              paymentMode: tx.paymentMode,
              referenceInvoiceNumber: invoiceNo,
              journalEntryNumber: invoiceNo,
              status: 'active',
            }];
            if (receivedAmount > 0) {
              rowsForTx.push({
                id: `receipt-${tx.id}`,
                date: tx.date,
                type: 'payment',
                description: String(tx.paymentMode || '').toLowerCase().includes('cash') ? 'Auto receipt against cash sale' : `Receipt against invoice ${invoiceNo}`,
                debit: 0,
                credit: receivedAmount,
                paymentMode: tx.paymentMode,
                referenceInvoiceNumber: invoiceNo,
                journalEntryNumber: 'AUTO RECEIPT',
                status: 'active',
              });
            }
            return rowsForTx;
          }) : [];
        const generatedCustomerReturnRows = isCustomer ? salesReturns
          .filter(ret => isDateWithinRange(ret.date, startDate, endDate))
          .filter(ret => String(ret.customerName || '').trim().toLowerCase() === normalizedPartyName)
          .map((ret: any) => ({
            id: `sales-return-${ret.id}`,
            date: ret.date,
            type: 'return',
            description: ret.remarks || 'Sales return / credit note',
            debit: 0,
            credit: round2(Number(ret.totalValue || 0)),
            referenceInvoiceNumber: ret.originalBillNumber || ret.originalInvoiceNumber || '-',
            journalEntryNumber: `SR-${ret.id}`,
            status: 'active',
          })) : [];
        const supplierGeneratedRows = !isCustomer ? (() => {
          const supplierId = String(selectedPartyId || '').trim();
          const supplierNameNormalized = String(partyName || '').trim().toLowerCase();
          const purchaseRows = purchases
            .filter((purchase: any) => purchase && purchase.status !== 'cancelled')
            .filter((purchase: any) => isDateWithinRange(purchase.date, startDate, endDate))
            .filter((purchase: any) => {
              const purchaseSupplierName = String(purchase.supplier || '').trim().toLowerCase();
              const purchaseSupplierId = String((purchase as any).supplierId || '').trim();
              return purchaseSupplierName === supplierNameNormalized || (supplierId && purchaseSupplierId === supplierId);
            })
            .map((purchase: any) => ({
              id: `purchase-${purchase.id}`,
              date: purchase.date,
              type: 'purchase',
              description: `Purchase invoice ${purchase.purchaseSerialId || purchase.id}`,
              debit: 0,
              credit: round2(Number(purchase.totalAmount || 0)),
              paymentMode: 'Credit',
              referenceInvoiceNumber: purchase.invoiceNumber || '-',
              referenceInvoiceId: purchase.id,
              journalEntryNumber: purchase.purchaseSerialId || purchase.id,
              status: String(purchase.status || 'completed').toLowerCase() === 'completed' ? 'completed' : 'active',
              supplierName: purchase.supplier || partyName,
            }));

          const supplierReturnRows = purchaseReturns
            .filter((ret: any) => ret && ret.status !== 'cancelled')
            .filter((ret: any) => isDateWithinRange(ret.date, startDate, endDate))
            .filter((ret: any) => {
              const returnSupplierName = String(ret.supplierName || '').trim().toLowerCase();
              const returnSupplierId = String((ret as any).supplierId || '').trim();
              return returnSupplierName === supplierNameNormalized || (supplierId && returnSupplierId === supplierId);
            })
            .map((ret: any) => ({
              id: `purchase-return-${ret.id}`,
              date: ret.date,
              type: 'return',
              description: ret.reason || ret.notes || 'Purchase return / debit note',
              debit: round2(Number(ret.totalAmount || ret.totalValue || 0)),
              credit: 0,
              referenceInvoiceNumber: ret.referenceInvoiceNumber || ret.originalBillNumber || ret.originalInvoiceNumber || '-',
              journalEntryNumber: ret.debitNoteNumber || `PR-${ret.id}`,
              status: 'active',
            }));

          const paymentRows = allLedgerRows
            .filter((entry: any) => entry.type === 'payment' && entry.status !== 'cancelled')
            .map((entry: any) => {
              const amount = round2(Number(entry.credit || entry.debit || 0));
              const adjustedAmount = round2(Number(entry.adjustedAmount || 0));
              return {
                ...entry,
                debit: amount,
                credit: 0,
                adjustedAmount,
                unadjustedAmount: round2(Math.max(amount - adjustedAmount, 0)),
              };
            });

          const openingRaw = Number((party as any)?.opening_balance || (party as any)?.openingBalance || 0);
          const openingRows = openingRaw !== 0 ? [{
            id: `opening-${supplierId || supplierNameNormalized || 'supplier'}`,
            date: startDate,
            type: 'openingBalance',
            description: 'Opening balance from supplier master',
            debit: openingRaw < 0 ? round2(Math.abs(openingRaw)) : 0,
            credit: openingRaw > 0 ? round2(openingRaw) : 0,
            referenceInvoiceNumber: '-',
            journalEntryNumber: 'OPENING',
            status: 'active',
          }] : [];

          return [...openingRows, ...purchaseRows, ...supplierReturnRows, ...paymentRows];
        })() : [];
        const baseLedgerRows = isCustomer
          ? (!ledgerRows.length ? [...generatedCustomerRows, ...generatedCustomerReturnRows] : ledgerRows)
          : supplierGeneratedRows;
        reportHeaders = ['Section', 'Date', 'Ref. Type', 'Voucher No', 'Reference Bill No', isCustomer ? 'Customer Name' : 'Supplier Name', 'Payment Mode', 'Bank/Cash Account', 'Description/Narration', 'Debit', 'Credit', 'Running Balance', 'Balance Type', 'Adjusted Amount', 'Unadjusted Amount', 'Status'];
        let supplierRunningBalance = 0;
        let customerRunningBalance = 0;
        const sortedLedgerRows = [...baseLedgerRows].sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
        const statementRows = sortedLedgerRows.map((entry: any) => {
          const status = entry.status || 'active';
          const rawDebit = round2(Number(entry.debit || 0));
          const rawCredit = round2(Number(entry.credit || 0));
          const displayDebit = rawDebit;
          const displayCredit = rawCredit;
          const movement = round2(displayCredit - displayDebit);
          const runningBalanceSigned = isCustomer
            ? round2((customerRunningBalance += round2(displayDebit - displayCredit)))
            : round2((supplierRunningBalance += movement));
          return {
            'Section': 'Ledger Statement',
            'Date': new Date(entry.date).toLocaleDateString('en-GB'),
            'Ref. Type': entry.type === 'sale' ? 'Sales Invoice' : entry.type === 'purchase' ? 'Purchase Invoice' : entry.type === 'return' ? (isCustomer ? 'Credit Note / Sales Return' : 'Debit Note / Purchase Return') : entry.type === 'openingBalance' ? 'Opening Balance' : (isCustomer ? 'Receipt / Payment' : 'Payment / Voucher'),
            'Voucher No': entry.journalEntryNumber || entry.id,
            'Reference Bill No': entry.referenceInvoiceNumber || '-',
            [isCustomer ? 'Customer Name' : 'Supplier Name']: entry.supplierName || partyName,
            'Payment Mode': entry.type === 'payment' ? (entry.paymentMode || '-') : '-',
            'Bank/Cash Account': entry.type === 'payment' ? (entry.bankName || 'Cash') : '-',
            'Description/Narration': entry.description || '-',
            'Debit': displayDebit,
            'Credit': displayCredit,
            'Adjusted Amount': entry.type === 'payment' ? round2(Number(entry.adjustedAmount || 0)) : 0,
            'Unadjusted Amount': entry.type === 'payment' ? round2(Number(entry.unadjustedAmount || 0)) : 0,
            'Running Balance': round2(Math.abs(runningBalanceSigned)),
            'Balance Type': runningBalanceSigned >= 0 ? 'Dr' : 'Cr',
            'Status': status,
          };
        });
        const billWiseRows = baseLedgerRows.filter((entry: any) => ['sale', 'purchase'].includes(entry.type) && String(entry.status || '').toLowerCase() !== 'cancelled').map((entry: any) => {
          const billAmount = isCustomer ? Number(entry.debit || 0) : Number(entry.debit || 0);
          return {
            'Section': 'Bill-wise Outstanding',
            'Date': new Date(entry.date).toLocaleDateString('en-GB'),
            'Ref. Type': isCustomer ? 'Sales Invoice' : 'Purchase Invoice',
            'Voucher No': entry.journalEntryNumber || entry.id,
            'Reference Bill No': entry.referenceInvoiceNumber || '-',
            'Description/Narration': `Bill Amount: ${round2(billAmount)} | Paid/Adjusted: 0 | Outstanding: ${round2(Math.max(billAmount, 0))} | Due Days: ${Math.max(0, Math.ceil((new Date().getTime() - new Date(entry.date).getTime()) / (1000 * 60 * 60 * 24)))}`,
            [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Debit': 0, 'Credit': 0, 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Running Balance': 0, 'Balance Type': '-', 'Status': entry.status || 'active',
          };
        });
        const paymentRows = baseLedgerRows.filter((entry: any) => entry.type === 'payment' && String(entry.status || '').toLowerCase() !== 'cancelled').map((entry: any) => {
          const amount = isCustomer ? Number(entry.credit || 0) : (Number(entry.credit || 0) > 0 ? Number(entry.credit || 0) : Number(entry.debit || 0));
          const adjusted = Number(entry.adjustedAmount || 0);
          return {
            'Section': 'Payment History',
            'Date': new Date(entry.date).toLocaleDateString('en-GB'),
            'Ref. Type': isCustomer ? 'Receipt' : 'Payment',
            'Voucher No': entry.journalEntryNumber || entry.id,
            'Reference Bill No': entry.referenceInvoiceNumber || '-',
            'Description/Narration': `Mode: ${entry.paymentMode || '-'} | A/C: ${entry.bankName || 'Cash'} | Amount: ${round2(amount)} | Adjusted: ${round2(adjusted)} | Unadjusted: ${round2(Math.max(amount - adjusted, 0))} | ${entry.description || '-'}`,
            [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Payment Mode': entry.paymentMode || '-', 'Bank/Cash Account': entry.bankName || 'Cash', 'Debit': isCustomer ? 0 : round2(amount), 'Credit': isCustomer ? round2(amount) : 0, 'Adjusted Amount': round2(adjusted), 'Unadjusted Amount': round2(Math.max(amount - adjusted, 0)), 'Running Balance': 0, 'Balance Type': '-', 'Status': entry.status || 'active',
          };
        });
        const activeStatementRows = statementRows.filter((row: any) => String(row.Status || '').toLowerCase() !== 'cancelled');
        const totalDebit = round2(activeStatementRows.reduce((sum: number, row: any) => sum + Number(row.Debit || 0), 0));
        const totalCredit = round2(activeStatementRows.reduce((sum: number, row: any) => sum + Number(row.Credit || 0), 0));

        const customerInvoiceOutstanding = isCustomer
          ? getCustomerInvoiceOutstandingTotalFromTransactions((party as Customer) || null, transactions)
          : 0;
        const customerBreakdown = isCustomer
          ? calculateCustomerReceivableBreakdown((party as Customer) || null, customerInvoiceOutstanding)
          : null;

        const supplierInvoiceOutstanding = !isCustomer
          ? getSupplierInvoiceOutstandingTotalFromPurchases((party as Distributor) || null, purchases)
          : 0;
        const supplierBreakdown = !isCustomer
          ? calculateSupplierPayableBreakdown((party as Distributor) || null, supplierInvoiceOutstanding)
          : null;
        const openingBalance = round2(isCustomer ? Number(customerBreakdown?.openingBalanceSigned || 0) : Number(supplierBreakdown?.openingBalanceSigned || 0));
        const closingBalanceSigned = round2(isCustomer ? Number(customerBreakdown?.netOutstanding || 0) : Number(supplierBreakdown?.netOutstanding || 0));
        const monthlySummaryRows: any[] = [];
        const monthAccumulator = new Map<string, { debit: number; credit: number; closing: number }>();
        activeStatementRows.forEach((row: any) => {
          const d = row.Date ? row.Date.split('/').reverse().join('-') : '';
          if (!d) return;
          const dt = new Date(d);
          const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
          const prev = monthAccumulator.get(key) || { debit: 0, credit: 0, closing: 0 };
          prev.debit = round2(prev.debit + Number(row.Debit || 0));
          prev.credit = round2(prev.credit + Number(row.Credit || 0));
          prev.closing = Number(row['Running Balance'] || prev.closing);
          monthAccumulator.set(key, prev);
        });
        Array.from(monthAccumulator.entries()).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([month, sums]) => {
          monthlySummaryRows.push({ 'Section': 'Monthly Summary', 'Date': '-', 'Ref. Type': `Month ${month}`, [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Voucher No': '-', 'Reference Bill No': '-', 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Description/Narration': 'Monthly Difference', 'Debit': round2(sums.debit), 'Credit': round2(sums.credit), 'Running Balance': round2(Math.abs(sums.closing)), 'Balance Type': sums.closing >= 0 ? 'Dr' : 'Cr', 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Status': '-' });
        });

        const summaryRows = [
          { 'Section': 'Summary', 'Date': '-', 'Ref. Type': 'Opening Balance', [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Voucher No': '-', 'Reference Bill No': '-', 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Description/Narration': '', 'Debit': openingBalance > 0 ? openingBalance : 0, 'Credit': openingBalance < 0 ? Math.abs(openingBalance) : 0, 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Running Balance': 0, 'Balance Type': openingBalance >= 0 ? 'Dr' : 'Cr', 'Status': '-' },
          { 'Section': 'Summary', 'Date': '-', 'Ref. Type': 'Total Debit', [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Voucher No': '-', 'Reference Bill No': '-', 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Description/Narration': '', 'Debit': totalDebit, 'Credit': 0, 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Running Balance': 0, 'Balance Type': '-', 'Status': '-' },
          { 'Section': 'Summary', 'Date': '-', 'Ref. Type': 'Total Credit', [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Voucher No': '-', 'Reference Bill No': '-', 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Description/Narration': '', 'Debit': 0, 'Credit': totalCredit, 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Running Balance': 0, 'Balance Type': '-', 'Status': '-' },
          ...(isCustomer ? [
            { 'Section': 'Summary', 'Date': '-', 'Ref. Type': 'Gross Receivable', [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Voucher No': '-', 'Reference Bill No': '-', 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Description/Narration': 'Matches Sundry Debtors', 'Debit': round2(Number(customerBreakdown?.grossReceivable || 0)), 'Credit': 0, 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Running Balance': 0, 'Balance Type': 'Dr', 'Status': '-' },
            { 'Section': 'Summary', 'Date': '-', 'Ref. Type': 'Adjusted Receipt', [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Voucher No': '-', 'Reference Bill No': '-', 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Description/Narration': 'Receipt adjusted against invoices', 'Debit': 0, 'Credit': round2(Number(customerBreakdown?.adjustedReceipts || 0)), 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Running Balance': 0, 'Balance Type': '-', 'Status': '-' },
            { 'Section': 'Summary', 'Date': '-', 'Ref. Type': 'Unadjusted Advance', [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Voucher No': '-', 'Reference Bill No': '-', 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Description/Narration': 'Available customer advance', 'Debit': 0, 'Credit': round2(Number(customerBreakdown?.unadjustedAdvance || 0)), 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Running Balance': 0, 'Balance Type': 'Cr', 'Status': '-' },
          ] : []),
          { 'Section': 'Summary', 'Date': '-', 'Ref. Type': 'Closing Balance', [isCustomer ? 'Customer Name' : 'Supplier Name']: partyName, 'Voucher No': '-', 'Reference Bill No': '-', 'Payment Mode': '-', 'Bank/Cash Account': '-', 'Description/Narration': '', 'Debit': closingBalanceSigned > 0 ? closingBalanceSigned : 0, 'Credit': closingBalanceSigned < 0 ? Math.abs(closingBalanceSigned) : 0, 'Adjusted Amount': 0, 'Unadjusted Amount': 0, 'Running Balance': round2(Math.abs(closingBalanceSigned)), 'Balance Type': closingBalanceSigned >= 0 ? (isCustomer ? 'Dr' : 'Cr') : (isCustomer ? 'Cr' : 'Dr'), 'Status': '-' },
        ];
        rows = [...statementRows, ...monthlySummaryRows, ...billWiseRows, ...paymentRows, ...summaryRows];
        break;
      }
      default:
        reportHeaders = ['Message'];
        rows = [{ Message: 'No report logic configured.' }];
    }

    setActiveReportId(reportId);
    setActiveReportTitle(title);
    setHeaders(reportHeaders);
    setBaseData(rows);
    setActiveFilters({});
    if (reportId !== 'mfrWiseSalesSummaryReport' && reportId !== 'doctorWiseSalesSummaryReport') setSortConfig(null);
    setVisibleColumns(reportHeaders);
    setFilteredData(rows);
    setSelectedRowIndex(rows.length ? 0 : -1);
  };

  useEffect(() => {
    loadReportData('salesRegister', periodStartDate, periodEndDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeReportId !== 'mfrWiseSalesDetailedReport') return;
    loadReportData(activeReportId, periodStartDate, periodEndDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mfrSalesViewMode]);

  useEffect(() => {
    if (activeReportId !== 'stockMovementSummary') return;
    loadReportData(activeReportId, periodStartDate, periodEndDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockMovementViewMode]);

  const filterOptions = useMemo(() => {
    return headers.reduce<Record<string, string[]>>((acc, col) => {
      acc[col] = Array.from(new Set(baseData.map(row => String(row[col] ?? '')).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return acc;
    }, {});
  }, [headers, baseData]);

  const totals = useMemo(() => {
    const numericColumns = headers.filter(col => filteredData.some(row => typeof row[col] === 'number'));
    const sums = numericColumns.reduce<Record<string, number>>((acc, col) => {
      acc[col] = round2(filteredData.reduce((sum, row) => sum + (typeof row[col] === 'number' ? Number(row[col]) : 0), 0));
      return acc;
    }, {});
    return { recordCount: filteredData.length, sums };
  }, [headers, filteredData]);

  const formatInrAmount = (amount: number) => `₹${Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const selectedRow = selectedRowIndex >= 0 ? filteredData[selectedRowIndex] : null;

  const doctorDetailSummary = useMemo(() => {
    if (activeReportId !== 'doctorsSalesDetailedReport' || !selectedRow) return null;
    const doctorName = String(selectedRow['Doctor Name'] || '').trim();
    if (!doctorName) return null;

    const doctorRows = filteredData.filter(row => String(row['Doctor Name'] || '').trim() === doctorName);
    const totalSales = round2(doctorRows.reduce((sum, row) => sum + Number(row['Amount'] || 0), 0));
    const totalDiscount = round2(doctorRows.reduce((sum, row) => sum + Number(row['Discount'] || 0), 0));
    const totalProfit = round2(doctorRows.reduce((sum, row) => sum + Number(row['Profit Margin'] || 0), 0));
    const totalBills = new Set(doctorRows.map(row => String(row['Sales Bill No'] || ''))).size;

    return { doctorName, totalSales, totalBills, totalDiscount, totalProfit };
  }, [activeReportId, filteredData, selectedRow]);

  const mfrDetailSummary = useMemo(() => {
    if (activeReportId !== 'mfrWiseSalesDetailedReport' || !selectedRow) return null;
    const mfrName = String(selectedRow['MFR Name'] || '').trim();
    if (!mfrName) return null;

    const mfrRows = filteredData.filter(row => String(row['MFR Name'] || '').trim() === mfrName);
    const totalSales = round2(mfrRows.reduce((sum, row) => sum + Number(row['Net Amount'] || 0), 0));
    const totalDiscount = round2(mfrRows.reduce((sum, row) => sum + Number(row['Discount'] || 0), 0));
    const totalGst = round2(mfrRows.reduce((sum, row) => sum + Number(row['GST Amount'] || 0), 0));
    const totalProfit = round2(mfrRows.reduce((sum, row) => sum + Number(row['Profit Margin'] || 0), 0));
    const totalQuantity = round2(mfrRows.reduce((sum, row) => sum + Number(row._qty || 0) + Number(row._freeQty || 0), 0));
    const totalBills = new Set(mfrRows.map(row => String(row['Sales Bill No'] || ''))).size;

    return { mfrName, totalSales, totalBills, totalDiscount, totalGst, totalProfit, totalQuantity };
  }, [activeReportId, filteredData, selectedRow]);

  const mfrSummary = useMemo(() => {
    if (activeReportId !== 'mfrWiseSalesSummaryReport') return null;
    return {
      totalMfr: filteredData.length,
      totalSales: round2(filteredData.reduce((sum, row) => sum + Number(row['Net Sales Value'] || 0), 0)),
      totalQuantity: round2(filteredData.reduce((sum, row) => sum + Number(row['Total Quantity'] || 0) + Number(row['Total Free Qty'] || 0), 0)),
      totalDiscount: round2(filteredData.reduce((sum, row) => sum + Number(row['Total Discount'] || 0), 0)),
      totalGst: round2(filteredData.reduce((sum, row) => sum + Number(row['Total GST Amount'] || 0), 0)),
      totalProfit: round2(filteredData.reduce((sum, row) => sum + Number(row['Total Profit Margin'] || 0), 0)),
    };
  }, [activeReportId, filteredData]);

  const doctorSummary = useMemo(() => {
    if (activeReportId !== 'doctorWiseSalesSummaryReport') return null;
    return {
      totalDoctors: filteredData.length,
      totalBills: filteredData.reduce((sum, row) => sum + Number(row['Number of Bills'] || 0), 0),
      totalCustomers: filteredData.reduce((sum, row) => sum + Number(row['Number of Customers'] || 0), 0),
      totalSales: round2(filteredData.reduce((sum, row) => sum + Number(row['Net Sales Value'] || 0), 0)),
      totalDiscount: round2(filteredData.reduce((sum, row) => sum + Number(row['Total Discount'] || 0), 0)),
      totalGst: round2(filteredData.reduce((sum, row) => sum + Number(row['Total GST Amount'] || 0), 0)),
      totalProfit: round2(filteredData.reduce((sum, row) => sum + Number(row['Total Profit Margin'] || 0), 0)),
    };
  }, [activeReportId, filteredData]);

  const stockMovementTotalRow = useMemo(() => {
    if (activeReportId !== 'stockMovementSummary') return null;
    const numericKeys = ['Opening Qty', 'Opening Value', 'Receipt Qty', 'Receipt Value', 'Issue Qty', 'Issue Value', 'Closing Qty', 'Closing Value'];
    const row: Record<string, any> = { 'Product Name': 'TOTAL', 'MFR': '-', 'Rate': '-' };
    numericKeys.forEach(key => {
      row[key] = round2(filteredData.reduce((sum, item) => sum + Number(item[key] || 0), 0));
    });
    return row;
  }, [activeReportId, filteredData]);

  const reportDataWithTotalRow = useMemo(() => {
    if (activeReportId !== 'stockMovementSummary' || !stockMovementTotalRow) return filteredData;
    return [...filteredData, stockMovementTotalRow];
  }, [activeReportId, filteredData, stockMovementTotalRow]);

  const activeFilterChips = useMemo(() => {
    return Object.entries(activeFilters).flatMap(([field, values]) => values.map(value => ({ field, value })));
  }, [activeFilters]);

  const toggleFilterValue = (field: string, value: string) => {
    const next = { ...activeFilters };
    const fieldValues = new Set(next[field] || []);
    if (fieldValues.has(value)) fieldValues.delete(value);
    else fieldValues.add(value);

    if (!fieldValues.size) delete next[field];
    else next[field] = Array.from(fieldValues);

    const nextData = applyFiltersAndSort(baseData, next, sortConfig);
    setActiveFilters(next);
    setFilteredData(nextData);
    setSelectedRowIndex(nextData.length ? 0 : -1);
  };

  const clearAllFilters = () => {
    setActiveFilters({});
    const nextData = applyFiltersAndSort(baseData, {}, sortConfig);
    setFilteredData(nextData);
    setSelectedRowIndex(nextData.length ? 0 : -1);
  };

  const removeChip = (field: string, value: string) => {
    toggleFilterValue(field, value);
  };

  const toggleSort = (column: string) => {
    let nextSort: { column: string; direction: SortDirection } | null = { column, direction: 'asc' };
    if (sortConfig?.column === column) {
      nextSort = sortConfig.direction === 'asc' ? { column, direction: 'desc' } : null;
    }
    setSortConfig(nextSort);
    const nextData = applyFiltersAndSort(baseData, activeFilters, nextSort);
    setFilteredData(nextData);
    setSelectedRowIndex(nextData.length ? 0 : -1);
  };

  const onColumnToggle = (column: string) => {
    setVisibleColumns(prev => prev.includes(column) ? prev.filter(c => c !== column) : [...prev, column]);
  };

  const downloadFile = (filename: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const rows = [visibleColumns.join(','), ...reportDataWithTotalRow.map(row => visibleColumns.map(col => `"${String(row[col] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    downloadFile(`${activeReportTitle.replace(/\s+/g, '_')}.csv`, rows, 'text/csv;charset=utf-8;');
  };

  const exportXlsx = () => {
    const rows = [visibleColumns.join('\t'), ...reportDataWithTotalRow.map(row => visibleColumns.map(col => String(row[col] ?? '')).join('\t'))].join('\n');
    downloadFile(`${activeReportTitle.replace(/\s+/g, '_')}.xlsx`, rows, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };

  const handlePreview = () => {
    onPrintReport({ title: activeReportTitle, data: reportDataWithTotalRow, headers: visibleColumns, filters: { startDate: periodStartDate, endDate: periodEndDate, activeFilters } });
  };

  const handlePrint = () => {
    onPrintReport({ title: `${activeReportTitle} (Print)`, data: reportDataWithTotalRow, headers: visibleColumns, filters: { startDate: periodStartDate, endDate: periodEndDate, activeFilters } });
  };

  const onPickReport = (reportId: string) => {
    setPendingReportId(reportId);
    if (reportId === 'customerPartyWiseFullStatement' || reportId === 'supplierPartyWiseFullStatement' || reportId === 'accountLedgerCustomer' || reportId === 'accountLedgerSupplier') {
      setPartyModalOpen(true);
      return;
    }
    setPeriodModalOpen(true);
  };

  return (
    <main className="flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg">
      <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
        <span className="text-[10px] font-black uppercase tracking-widest">Display Reports & Analysis (MIS)</span>
        <span className="text-[10px] font-black uppercase text-accent">Management Info System</span>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr_300px] gap-2 p-2 overflow-hidden">
        <section className="border border-gray-300 bg-white min-h-0 flex flex-col">
          <div className="px-2 py-1 border-b text-[10px] font-bold uppercase bg-gray-100">MIS Reports List</div>
          <div className="min-h-0 overflow-y-auto p-1 text-[11px]">
            {Object.entries(groupedReports).map(([group, items]) => (
              <div key={group} className="mb-2">
                <div className="px-1 py-1 text-[10px] font-bold uppercase text-primary border-b border-gray-200">{group}</div>
                <div className="mt-1 space-y-0.5">
                  {items.map(report => (
                    <button
                      key={report.id}
                      className={`w-full text-left px-2 py-1 border ${activeReportId === report.id ? 'bg-primary text-white border-primary' : 'bg-white hover:bg-primary-extralight border-transparent'}`}
                      onClick={() => onPickReport(report.id)}
                    >
                      {report.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border border-gray-300 bg-white min-h-0 flex flex-col">
          <div className="px-2 py-1 border-b bg-gray-100 flex items-center justify-between gap-2">
            <div>
              <div className="text-[11px] font-bold">{activeReportTitle}</div>
              <div className="text-[10px] text-gray-500">Period: {new Date(periodStartDate).toLocaleDateString('en-GB')} to {new Date(periodEndDate).toLocaleDateString('en-GB')}</div>
            </div>
            <div className="flex gap-1 text-[10px] items-center">
              {(activeReportId === 'mfrWiseSalesDetailedReport' || activeReportId === 'stockMovementSummary' || activeReportId === 'inventoryValue') && (
                <div className="flex items-center gap-1 mr-2">
                  <span className="text-gray-600">View Mode:</span>
                  {activeReportId === 'mfrWiseSalesDetailedReport' ? (
                    <select value={mfrSalesViewMode} onChange={(e) => setMfrSalesViewMode(e.target.value as MfrSalesViewMode)} className="px-1 py-1 border border-gray-300 bg-white">
                      <option value="detailed">Detailed View</option>
                      <option value="productSummary">Product Summary View</option>
                    </select>
                  ) : activeReportId === 'stockMovementSummary' ? (
                    <select value={stockMovementViewMode} onChange={(e) => setStockMovementViewMode(e.target.value as StockMovementViewMode)} className="px-1 py-1 border border-gray-300 bg-white">
                      <option value="detailed">Detailed View</option>
                      <option value="productSummary">Product Summary View</option>
                    </select>
                  ) : (
                    <select value={inventoryValueViewMode} onChange={(e) => setInventoryValueViewMode(e.target.value as InventoryValueViewMode)} className="px-1 py-1 border border-gray-300 bg-white">
                      <option value="batchWise">Batch-wise View</option>
                      <option value="productWise">Product-wise Consolidated</option>
                    </select>
                  )}
                </div>
              )}
              <button onClick={() => setFilterModalOpen(true)} className="px-2 py-1 border border-gray-300 hover:bg-gray-100">Filter</button>
              <button onClick={() => setColumnModalOpen(true)} className="px-2 py-1 border border-gray-300 hover:bg-gray-100">Columns</button>
              <button onClick={handlePreview} className="px-2 py-1 border border-gray-300 hover:bg-gray-100">Preview</button>
              <button onClick={exportCsv} className="px-2 py-1 border border-gray-300 hover:bg-gray-100">CSV</button>
              <button onClick={exportXlsx} className="px-2 py-1 border border-gray-300 hover:bg-gray-100">XLSX</button>
              <button onClick={handlePrint} className="px-2 py-1 border border-gray-300 hover:bg-gray-100">Print / PDF</button>
            </div>
          </div>

          {!!activeFilterChips.length && (
            <div className="px-2 py-1 border-b flex flex-wrap gap-1 text-[10px]">
              {activeFilterChips.map(chip => (
                <button key={`${chip.field}-${chip.value}`} onClick={() => removeChip(chip.field, chip.value)} className="px-1 py-0.5 border border-primary text-primary bg-primary-extralight">
                  {chip.field}: {chip.value} ✕
                </button>
              ))}
              <button onClick={clearAllFilters} className="px-1 py-0.5 border border-red-300 text-red-700">Clear all</button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {filteredData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-500">
                {activeReportId === 'rxMedicineSalesReport' ? 'No Prescription Medicine Sales Found For Selected Period' : 'No records found for selected period'}
              </div>
            ) : (
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-gray-100 z-10">
                  <tr>
                    {visibleColumns.map(col => (
                      <th key={col} onClick={() => toggleSort(col)} className={`px-2 py-1 border-b border-r whitespace-nowrap cursor-pointer select-none ${col === 'Doctor Name' ? 'text-left' : (filteredData.some(row => typeof row[col] === 'number') ? 'text-right' : 'text-left')}`}>
                        {col} {sortConfig?.column === col ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredData.map((row, idx) => (
                    <tr
                      key={`${activeReportId}-${idx}`}
                      onClick={() => setSelectedRowIndex(idx)}
                      className={`${selectedRowIndex === idx ? 'bg-primary/20' : idx % 2 ? 'bg-white' : 'bg-gray-50'} hover:bg-primary/10 cursor-pointer`}
                    >
                      {visibleColumns.map(col => (
                        <td key={`${idx}-${col}`} className={`px-2 py-1 border-b border-r whitespace-nowrap ${col === 'Doctor Name' ? 'text-left' : (typeof row[col] === 'number' ? 'text-right' : 'text-left')}`}>{String(row[col] ?? '-')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {activeReportId === 'stockMovementSummary' && stockMovementTotalRow && (
                  <tfoot>
                    <tr className="bg-gray-200 font-bold">
                      {visibleColumns.map(col => (
                        <td key={`total-${col}`} className={`px-2 py-1 border-t border-r whitespace-nowrap ${typeof stockMovementTotalRow[col] === 'number' ? 'text-right' : 'text-left'}`}>{String(stockMovementTotalRow[col] ?? '-')}</td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </div>

          <div className="border-t px-2 py-1 text-[10px] bg-gray-100 flex flex-wrap gap-x-4 gap-y-1">
            {activeReportId === 'stockSummary' ? (
              <>
                <span><strong>Total Records:</strong> {totals.recordCount}</span>
                <span><strong>Total Stock Qty:</strong> {Math.round(totals.sums['Quantity'] || 0).toLocaleString('en-IN')}</span>
                <span><strong>MRP Amount:</strong> {formatInrAmount(totals.sums['MRP Amount'] || 0)}</span>
                <span><strong>PTR Amount:</strong> {formatInrAmount(totals.sums['PTR Amount'] || 0)}</span>
              </>
            ) : (
              <>
                <span><strong>Total Records:</strong> {totals.recordCount}</span>
                {Object.entries(totals.sums).slice(0, activeReportId === 'doctorWiseSalesSummaryReport' ? 8 : 6).map(([key, value]) => (
                  <span key={key}><strong>{key}:</strong> {value}</span>
                ))}
                {activeReportId === 'doctorWiseSalesSummaryReport' && <span><strong>Grand Total:</strong> {round2((totals.sums['Net Sales Value'] || 0) + (totals.sums['Total GST Amount'] || 0) - (totals.sums['Total Discount'] || 0))}</span>}
              </>
            )}
          </div>
        </section>

        <section className="border border-gray-300 bg-white min-h-0 flex flex-col">
          <div className="px-2 py-1 border-b text-[10px] font-bold uppercase bg-gray-100">{activeReportId === 'doctorsSalesDetailedReport' || activeReportId === 'doctorWiseSalesSummaryReport' ? 'Doctor Summary' : activeReportId === 'mfrWiseSalesDetailedReport' || activeReportId === 'mfrWiseSalesSummaryReport' ? 'MFR Summary' : 'Detail Preview'}</div>
          <div className="min-h-0 overflow-auto p-2 text-[11px] space-y-1">
            {activeReportId === 'doctorsSalesDetailedReport' && doctorDetailSummary ? (
              <div className="space-y-1">
                <div className="text-xs font-bold text-primary">{doctorDetailSummary.doctorName}</div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Sales</div><div>{doctorDetailSummary.totalSales}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Bills</div><div>{doctorDetailSummary.totalBills}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Discount</div><div>{doctorDetailSummary.totalDiscount}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Profit</div><div>{doctorDetailSummary.totalProfit}</div></div>
              </div>
            ) : activeReportId === 'mfrWiseSalesDetailedReport' && mfrDetailSummary ? (
              <div className="space-y-1">
                <div className="text-xs font-bold text-primary">{mfrDetailSummary.mfrName}</div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Sales</div><div>{mfrDetailSummary.totalSales}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Bills</div><div>{mfrDetailSummary.totalBills}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Quantity</div><div>{mfrDetailSummary.totalQuantity}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Discount</div><div>{mfrDetailSummary.totalDiscount}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total GST</div><div>{mfrDetailSummary.totalGst}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Profit</div><div>{mfrDetailSummary.totalProfit}</div></div>
              </div>
            ) : activeReportId === 'doctorWiseSalesSummaryReport' && doctorSummary ? (
              <div className="space-y-1">
                <div className="text-xs font-bold text-primary">DOCTOR SUMMARY</div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Doctors</div><div>{doctorSummary.totalDoctors}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Bills</div><div>{doctorSummary.totalBills}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Customers</div><div>{doctorSummary.totalCustomers}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Sales</div><div>₹ {doctorSummary.totalSales}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Discount</div><div>₹ {doctorSummary.totalDiscount}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total GST</div><div>₹ {doctorSummary.totalGst}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Profit</div><div>₹ {doctorSummary.totalProfit}</div></div>
              </div>
            ) : activeReportId === 'mfrWiseSalesSummaryReport' && mfrSummary ? (
              <div className="space-y-1">
                <div className="text-xs font-bold text-primary">MFR SUMMARY</div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total MFR</div><div>{mfrSummary.totalMfr}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Sales</div><div>₹ {mfrSummary.totalSales}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Quantity</div><div>{mfrSummary.totalQuantity}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Discount</div><div>₹ {mfrSummary.totalDiscount}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total GST</div><div>₹ {mfrSummary.totalGst}</div></div>
                <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1"><div className="font-semibold text-gray-600">Total Profit</div><div>₹ {mfrSummary.totalProfit}</div></div>
              </div>
            ) : !selectedRow ? (
              <div className="text-gray-500">Select a row to view details.</div>
            ) : (
              <>
                {Object.entries(selectedRow).map(([key, value]) => (
                  <div key={key} className="grid grid-cols-[120px_1fr] gap-2 border-b border-gray-100 py-1">
                    <div className="font-semibold text-gray-600">{key}</div>
                    <div className="break-words">{String(value ?? '-')}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      </div>

      <Modal isOpen={periodModalOpen} onClose={() => setPeriodModalOpen(false)} title="Select Report Period" widthClass="max-w-md">
        <div className="p-4 space-y-3 text-sm">
          <div>
            <label className="text-xs uppercase font-semibold text-gray-600">From Date</label>
            <input type="date" value={periodStartDate} onChange={e => setPeriodStartDate(e.target.value)} className="w-full border border-gray-300 p-2 mt-1" />
          </div>
          <div>
            <label className="text-xs uppercase font-semibold text-gray-600">To Date</label>
            <input type="date" value={periodEndDate} onChange={e => setPeriodEndDate(e.target.value)} className="w-full border border-gray-300 p-2 mt-1" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setPeriodStartDate(firstOfMonthIso); setPeriodEndDate(todayIso); }} className="px-3 py-1 border border-gray-300">Clear</button>
            <button onClick={() => setPeriodModalOpen(false)} className="px-3 py-1 border border-gray-300">Cancel</button>
            <button onClick={() => { loadReportData(pendingReportId, periodStartDate, periodEndDate); setPeriodModalOpen(false); }} className="px-3 py-1 border border-primary bg-primary text-white">Generate Report</button>
          </div>
        </div>
      </Modal>
      <Modal isOpen={partyModalOpen} onClose={() => setPartyModalOpen(false)} title="Select Party Name" widthClass="max-w-md">
        <div className="p-4 space-y-3 text-sm">
          <div>
            <label className="text-xs uppercase font-semibold text-gray-600">Party Name</label>
            <select value={selectedPartyId} onChange={(e) => setSelectedPartyId(e.target.value)} className="w-full border border-gray-300 p-2 mt-1">
              <option value="">Select Party</option>
              {(pendingReportId === 'customerPartyWiseFullStatement' || pendingReportId === 'accountLedgerCustomer' ? customers : distributors).map((party) => (
                <option key={party.id} value={party.id}>{party.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase font-semibold text-gray-600">From Date</label>
            <input type="date" value={periodStartDate} onChange={e => setPeriodStartDate(e.target.value)} className="w-full border border-gray-300 p-2 mt-1" />
          </div>
          <div>
            <label className="text-xs uppercase font-semibold text-gray-600">To Date</label>
            <input type="date" value={periodEndDate} onChange={e => setPeriodEndDate(e.target.value)} className="w-full border border-gray-300 p-2 mt-1" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setPartyModalOpen(false)} className="px-3 py-1 border border-gray-300">Cancel</button>
            <button disabled={!selectedPartyId} onClick={() => { loadReportData(pendingReportId, periodStartDate, periodEndDate); setPartyModalOpen(false); }} className="px-3 py-1 border border-primary bg-primary text-white disabled:opacity-50">Execute Report</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={filterModalOpen} onClose={() => setFilterModalOpen(false)} title="Filter Report" widthClass="max-w-3xl">
        <div className="p-3 overflow-auto text-xs">
          <div className="grid grid-cols-3 gap-3">
            {headers.map(col => (
              <div key={col} className="border border-gray-200 p-2">
                <div className="font-semibold mb-1">{col}</div>
                <div className="max-h-48 overflow-auto space-y-1">
                  {filterOptions[col]?.map(value => (
                    <label key={`${col}-${value}`} className="flex items-center gap-1">
                      <input type="checkbox" checked={(activeFilters[col] || []).includes(value)} onChange={() => toggleFilterValue(col, value)} />
                      <span className="truncate">{value || '(Blank)'}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end mt-3 gap-2">
            <button onClick={clearAllFilters} className="px-3 py-1 border border-gray-300">Clear All</button>
            <button onClick={() => setFilterModalOpen(false)} className="px-3 py-1 border border-primary bg-primary text-white">Done</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={columnModalOpen} onClose={() => setColumnModalOpen(false)} title="Show / Hide Columns" widthClass="max-w-md">
        <div className="p-4 text-sm space-y-2">
          {headers.map(col => (
            <label key={col} className="flex items-center gap-2">
              <input type="checkbox" checked={visibleColumns.includes(col)} onChange={() => onColumnToggle(col)} />
              <span>{col}</span>
            </label>
          ))}
          <div className="flex justify-end">
            <button onClick={() => setColumnModalOpen(false)} className="px-3 py-1 border border-primary bg-primary text-white text-xs">Done</button>
          </div>
        </div>
      </Modal>
    </main>
  );
};

export default Reports;
