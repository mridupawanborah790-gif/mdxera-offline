import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import type { Customer, DeliveryChallan, InventoryItem, Purchase, SalesChallan, Transaction } from '@core/types';
import { SalesChallanStatus } from '@core/types';

type ReportMenuGroup = {
  id: string;
  label: string;
  children?: Array<{ id: string; label: string }>;
};

interface DailyReportsProps {
  transactions: Transaction[];
  inventory: InventoryItem[];
  purchases: Purchase[];
  salesChallans: SalesChallan[];
  deliveryChallans: DeliveryChallan[];
  customers: Customer[];
  reportId?: string;
}

const reportMenuGroups: ReportMenuGroup[] = [
  {
    id: 'dailyWorking',
    label: 'Daily Working',
    children: [
      { id: 'dispatchSummary', label: 'Dispatch Summary' },
      { id: 'reorderManagement', label: 'Re-order Management' },
      { id: 'stockSaleAnalysis', label: 'Stock & Sale Analysis' },
      { id: 'multiBillPrinting', label: 'Multi Bill / Other Printing' },
      { id: 'challanToBill', label: 'Challan to Bill' },
      { id: 'pendingChallans', label: 'Pending Challans' },
      { id: 'dispatchManagementReports', label: 'Dispatch Management Reports' },
      { id: 'rateComparisonStatement', label: 'Rate Comparison Statement' },
      { id: 'mergeBillsSingleOrder', label: 'Merge Bills in Single Order' },
      { id: 'partyNotVisited', label: 'Party Not Visited' },
      { id: 'billNotPrinted', label: 'Bill Not Printed' },
    ],
  },
  { id: 'fastReports', label: 'Fast Reports' },
  { id: 'businessAnalysis', label: 'Business Analysis' },
  { id: 'orderCrm', label: 'Order CRM' },
  { id: 'saleReport', label: 'Sale Report' },
  { id: 'purchaseReport', label: 'Purchase Report' },
  { id: 'inventoryReports', label: 'Inventory Reports' },
  { id: 'abcAnalysis', label: 'ABC Analysis' },
  { id: 'allAccountingRecords', label: 'All Accounting Records' },
  { id: 'purchasePlanning', label: 'Purchase Planning' },
];

const reportNameMap = new Map(reportMenuGroups.flatMap(group => (group.children || [{ id: group.id, label: group.label }]).map(item => [item.id, item.label])));

const getPeriodDefaults = () => {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const toIso = (date: Date) => date.toISOString().slice(0, 10);

  return {
    from: toIso(monthStart),
    to: toIso(today),
  };
};

const formatDate = (date: string) => {
  if (!date) return '--';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '--';
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

type ReportRow = {
  id: string;
  date: string;
  partyName: string;
  remark: string;
  voucherNo: string;
  debit: number;
  credit: number;
  type: string;
  items: Array<{ name: string; quantity: number | string }>;
};

const isWithinPeriod = (value: string, fromDate: string, toDate: string) => {
  const from = fromDate ? new Date(fromDate) : null;
  const to = toDate ? new Date(toDate) : null;
  const current = new Date(value);
  if (from && current < from) return false;
  if (to) {
    const endOfDay = new Date(to);
    endOfDay.setHours(23, 59, 59, 999);
    if (current > endOfDay) return false;
  }
  return true;
};

const DailyReports: React.FC<DailyReportsProps> = ({
  transactions, inventory, purchases, salesChallans, deliveryChallans, customers, reportId
}) => {
  const defaultReportId = reportId && reportNameMap.has(reportId) ? reportId : 'dispatchSummary';
  const [activeGroup, setActiveGroup] = useState('dailyWorking');
  const [activeReportId, setActiveReportId] = useState(defaultReportId);
  const [pendingReportId, setPendingReportId] = useState(defaultReportId);
  const [isPeriodModalOpen, setIsPeriodModalOpen] = useState(true);
  const [selectedRow, setSelectedRow] = useState(0);
  const [fromDate, setFromDate] = useState(getPeriodDefaults().from);
  const [toDate, setToDate] = useState(getPeriodDefaults().to);
  const [scrollMode, setScrollMode] = useState<'fit' | 'scroll'>('scroll');
  const fromDateRef = useRef<HTMLInputElement>(null);
  const toDateRef = useRef<HTMLInputElement>(null);
  const generateButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!reportId || !reportNameMap.has(reportId)) return;
    setPendingReportId(reportId);
    setIsPeriodModalOpen(true);
    const parentGroup = reportMenuGroups.find(group => group.children?.some(child => child.id === reportId));
    if (parentGroup) setActiveGroup(parentGroup.id);
  }, [reportId]);

  useEffect(() => {
    if (!isPeriodModalOpen) return;
    const defaults = getPeriodDefaults();
    setFromDate(defaults.from);
    setToDate(defaults.to);
    fromDateRef.current?.focus();
  }, [isPeriodModalOpen]);

  const openPeriodModal = useCallback((nextReportId: string) => {
    setPendingReportId(nextReportId);
    const parentGroup = reportMenuGroups.find(group => group.children?.some(child => child.id === nextReportId));
    if (parentGroup) {
      setActiveGroup(parentGroup.id);
    }
    setIsPeriodModalOpen(true);
  }, []);

  const handleGenerateReport = useCallback(() => {
    if (!fromDate || !toDate || new Date(fromDate) > new Date(toDate)) {
      return;
    }
    setActiveReportId(pendingReportId);
    setIsPeriodModalOpen(false);
  }, [fromDate, pendingReportId, toDate]);

  const handleClearPeriod = useCallback(() => {
    const defaults = getPeriodDefaults();
    setFromDate(defaults.from);
    setToDate(defaults.to);
  }, []);

  const handleCancelPeriodModal = useCallback(() => {
    setIsPeriodModalOpen(false);
  }, []);

  const reportRows = useMemo<ReportRow[]>(() => {
    const validTransactions = transactions.filter(tx => isWithinPeriod(tx.date, fromDate, toDate));
    const validSalesChallans = salesChallans.filter(ch => isWithinPeriod(ch.date, fromDate, toDate));
    const validDeliveryChallans = deliveryChallans.filter(ch => isWithinPeriod(ch.date, fromDate, toDate));
    const validPurchases = purchases.filter(pu => isWithinPeriod(pu.date, fromDate, toDate));

    switch (activeReportId) {
      case 'dispatchSummary':
        return validSalesChallans.slice(0, 60).map(ch => ({
          id: ch.id,
          date: formatDate(ch.date),
          partyName: ch.customerName || 'Unknown Party',
          remark: `Dispatched Items: ${ch.items.length}`,
          voucherNo: ch.challanSerialId,
          debit: Number(ch.totalAmount || 0),
          credit: 0,
          type: `Delivery ${ch.status}`,
          items: ch.items.map(item => ({ name: item.name, quantity: item.quantity })),
        }));

      case 'reorderManagement':
        return inventory
          .filter(item => Number(item.stock || 0) < Number(item.minStockLimit || 0))
          .slice(0, 80)
          .map(item => ({
            id: item.id,
            date: '--',
            partyName: item.supplierName || 'Unmapped Supplier',
            remark: `Required Qty: ${Math.max(Number(item.minStockLimit || 0) - Number(item.stock || 0), 0)}`,
            voucherNo: item.code || item.id,
            debit: Number(item.stock || 0),
            credit: Number(item.minStockLimit || 0),
            type: 'Below Reorder Level',
            items: [{ name: item.name, quantity: item.stock }],
          }));

      case 'stockSaleAnalysis': {
        const soldByItem = new Map<string, { qty: number; amount: number }>();
        validTransactions.forEach(tx => {
          tx.items.forEach(item => {
            const key = item.inventoryItemId || item.name;
            const qty = Number(item.quantity || 0);
            const amount = Number(item.amount || item.finalAmount || 0);
            const current = soldByItem.get(key) || { qty: 0, amount: 0 };
            soldByItem.set(key, { qty: current.qty + qty, amount: current.amount + amount });
          });
        });

        return inventory.slice(0, 80).map(item => {
          const key = item.id || item.name;
          const sold = soldByItem.get(key) || { qty: 0, amount: 0 };
          const movementType = sold.qty >= 20 ? 'Fast Moving' : sold.qty > 0 ? 'Slow Moving' : 'No Movement';
          return {
            id: item.id,
            date: '--',
            partyName: item.name,
            remark: `Stock: ${item.stock} | Sold: ${sold.qty}`,
            voucherNo: item.code || item.id,
            debit: Number(item.stock || 0),
            credit: sold.qty,
            type: movementType,
            items: [{ name: item.name, quantity: sold.qty }],
          };
        });
      }

      case 'multiBillPrinting':
        return validTransactions.slice(0, 80).map(tx => ({
          id: tx.id,
          date: formatDate(tx.date),
          partyName: tx.customerName || 'Walk-in Customer',
          remark: 'Available for multi bill print selection',
          voucherNo: tx.id,
          debit: Number(tx.total || 0),
          credit: 0,
          type: tx.status,
          items: tx.items.map(item => ({ name: item.name, quantity: item.quantity })),
        }));

      case 'challanToBill':
        return validSalesChallans
          .filter(ch => ch.status === SalesChallanStatus.OPEN)
          .slice(0, 80)
          .map(ch => ({
            id: ch.id,
            date: formatDate(ch.date),
            partyName: ch.customerName || 'Unknown Party',
            remark: 'Pending conversion to invoice',
            voucherNo: ch.challanSerialId,
            debit: Number(ch.totalAmount || 0),
            credit: 0,
            type: ch.status,
            items: ch.items.map(item => ({ name: item.name, quantity: item.quantity })),
          }));

      case 'pendingChallans':
        return validSalesChallans
          .filter(ch => ch.status === SalesChallanStatus.OPEN)
          .slice(0, 80)
          .map(ch => ({
            id: ch.id,
            date: formatDate(ch.date),
            partyName: ch.customerName || 'Unknown Party',
            remark: 'Open challan',
            voucherNo: ch.challanSerialId,
            debit: Number(ch.totalAmount || 0),
            credit: 0,
            type: 'Pending Challan',
            items: ch.items.map(item => ({ name: item.name, quantity: item.quantity })),
          }));

      case 'dispatchManagementReports':
        return validDeliveryChallans.slice(0, 80).map(ch => ({
          id: ch.id,
          date: formatDate(ch.date),
          partyName: ch.supplier,
          remark: `Dispatch tracking: ${ch.items.length} items`,
          voucherNo: ch.challanSerialId,
          debit: Number(ch.totalAmount || 0),
          credit: 0,
          type: `Dispatch ${ch.status}`,
          items: ch.items.map(item => ({ name: item.name, quantity: item.quantity })),
        }));

      case 'rateComparisonStatement': {
        const purchaseRates = new Map<string, { total: number; qty: number }>();
        validPurchases.forEach(pu => {
          pu.items.forEach(item => {
            const key = item.inventoryItemId || item.name;
            const qty = Number(item.quantity || 0);
            const total = Number(item.purchasePrice || 0) * qty;
            const current = purchaseRates.get(key) || { total: 0, qty: 0 };
            purchaseRates.set(key, { total: current.total + total, qty: current.qty + qty });
          });
        });

        const salesRates = new Map<string, { total: number; qty: number }>();
        validTransactions.forEach(tx => {
          tx.items.forEach(item => {
            const key = item.inventoryItemId || item.name;
            const qty = Number(item.quantity || 0);
            const total = Number(item.amount || item.finalAmount || 0);
            const current = salesRates.get(key) || { total: 0, qty: 0 };
            salesRates.set(key, { total: current.total + total, qty: current.qty + qty });
          });
        });

        return inventory.slice(0, 80).map(item => {
          const key = item.id || item.name;
          const purchase = purchaseRates.get(key) || { total: 0, qty: 0 };
          const sales = salesRates.get(key) || { total: 0, qty: 0 };
          const avgPurchase = purchase.qty ? purchase.total / purchase.qty : 0;
          const avgSale = sales.qty ? sales.total / sales.qty : 0;
          return {
            id: item.id,
            date: '--',
            partyName: item.name,
            remark: `Purchase Avg: ${avgPurchase.toFixed(2)} | Sale Avg: ${avgSale.toFixed(2)}`,
            voucherNo: item.code || item.id,
            debit: avgPurchase,
            credit: avgSale,
            type: 'Rate Comparison',
            items: [{ name: item.name, quantity: `${purchase.qty}/${sales.qty}` }],
          };
        });
      }

      case 'mergeBillsSingleOrder': {
        const grouped = validTransactions.reduce((acc, tx) => {
          const key = `${tx.customerId || tx.customerName}-${formatDate(tx.date)}`;
          const bucket = acc.get(key) || [];
          bucket.push(tx);
          acc.set(key, bucket);
          return acc;
        }, new Map<string, Transaction[]>());

        return Array.from(grouped.entries())
          .filter(([, txs]) => txs.length > 1)
          .slice(0, 80)
          .map(([key, txs]) => ({
            id: key,
            date: formatDate(txs[0]?.date || ''),
            partyName: txs[0]?.customerName || 'Walk-in Customer',
            remark: `Merge ${txs.length} bills in single order`,
            voucherNo: txs.map(tx => tx.id).join(', '),
            debit: txs.reduce((sum, tx) => sum + Number(tx.total || 0), 0),
            credit: 0,
            type: 'Merge Candidate',
            items: txs.flatMap(tx => tx.items).slice(0, 10).map(item => ({ name: item.name, quantity: item.quantity })),
          }));
      }

      case 'partyNotVisited': {
        const visitedPartyIds = new Set(validTransactions.map(tx => tx.customerId).filter(Boolean));
        const visitedPartyNames = new Set(validTransactions.map(tx => tx.customerName));
        return customers
          .filter(c => !visitedPartyIds.has(c.id) && !visitedPartyNames.has(c.name))
          .slice(0, 80)
          .map(c => ({
            id: c.id,
            date: '--',
            partyName: c.name,
            remark: 'No visit/sales activity in selected period',
            voucherNo: c.id,
            debit: 0,
            credit: 0,
            type: 'Not Visited',
            items: [{ name: c.name, quantity: '-' }],
          }));
      }

      case 'billNotPrinted':
        return validTransactions
          .filter(tx => {
            const anyTx = tx as any;
            return anyTx.printed === false || anyTx.isPrinted === false || anyTx.printFlag === false || (!anyTx.printedAt && anyTx.status === 'completed');
          })
          .slice(0, 80)
          .map(tx => ({
            id: tx.id,
            date: formatDate(tx.date),
            partyName: tx.customerName || 'Walk-in Customer',
            remark: 'Invoice print pending',
            voucherNo: tx.id,
            debit: Number(tx.total || 0),
            credit: 0,
            type: tx.status,
            items: tx.items.map(item => ({ name: item.name, quantity: item.quantity })),
          }));

      case 'fastReports':
      default:
        return validTransactions
          .slice(0, 80)
          .map(tx => ({
            id: tx.id,
            date: formatDate(tx.date),
            partyName: tx.customerName || 'Walk-in Customer',
            remark: tx.referredBy || tx.paymentMode || '-',
            voucherNo: tx.id,
            debit: tx.paymentMode === 'Credit' ? Number(tx.total || 0) : 0,
            credit: tx.paymentMode !== 'Credit' ? Number(tx.total || 0) : 0,
            type: tx.status || 'Sale',
            items: tx.items.map(item => ({ name: item.name, quantity: item.quantity })),
          }));
    }
  }, [
    activeReportId,
    customers,
    deliveryChallans,
    fromDate,
    inventory,
    purchases,
    salesChallans,
    toDate,
    transactions,
  ]);

  useEffect(() => {
    setSelectedRow(0);
  }, [activeReportId, fromDate, toDate]);

  const selectedVoucher = reportRows[selectedRow];

  const handleKeyNav = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!reportRows.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedRow(prev => Math.min(prev + 1, reportRows.length - 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedRow(prev => Math.max(prev - 1, 0));
    }
    if (event.key.toLowerCase() === 'home') {
      event.preventDefault();
      setSelectedRow(0);
    }
    if (event.key.toLowerCase() === 'end') {
      event.preventDefault();
      setSelectedRow(reportRows.length - 1);
    }
  }, [reportRows.length]);

  const totalDebit = reportRows.reduce((sum, row) => sum + row.debit, 0);
  const totalCredit = reportRows.reduce((sum, row) => sum + row.credit, 0);
  const periodError = !fromDate || !toDate ? 'Please select both dates.' : new Date(fromDate) > new Date(toDate) ? 'Period From cannot be after To date.' : '';

  return (
    <main className="flex-1 overflow-hidden flex bg-[#d4d8d3] font-mono" tabIndex={0} onKeyDown={handleKeyNav}>
      <aside className="w-80 border-r-2 border-[#83918e] bg-[#e8ece8] overflow-y-auto">
        <div className="bg-[#3f6e68] text-white px-3 py-2 text-sm font-bold tracking-wide">MDXERA Daily Reports</div>
        {reportMenuGroups.map(group => (
          <div key={group.id} className="border-b border-[#b2b9b5]">
            <button
              onClick={() => {
                if (group.children) {
                  setActiveGroup(group.id);
                  return;
                }
                openPeriodModal(group.id);
              }}
              className={`w-full text-left px-3 py-2 text-[15px] font-semibold ${activeGroup === group.id ? 'bg-[#d6dfdb] text-[#14302b]' : 'hover:bg-[#dee4e1] text-[#2f3836]'}`}
            >
              {group.label}
            </button>
            {activeGroup === group.id && group.children && (
              <div className="bg-white border-t border-[#c2ccc8]">
                {group.children.map(child => (
                  <button
                    key={child.id}
                    onClick={() => openPeriodModal(child.id)}
                    className={`w-full text-left px-5 py-2 text-[14px] border-b border-gray-200 transition-colors ${activeReportId === child.id ? 'bg-primary text-white font-bold shadow-md' : 'text-gray-700 hover:bg-primary hover:text-white'}`}
                  >
                    {child.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </aside>

      <section className="flex-1 flex flex-col overflow-hidden">
        <div className="h-10 bg-[#335f59] text-white px-4 flex items-center justify-between border-b-2 border-[#233f3a]">
          <h1 className="text-lg font-bold tracking-wide">{reportNameMap.get(activeReportId) || 'Daily Reports'} - MDXERA ERP</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setScrollMode(prev => prev === 'fit' ? 'scroll' : 'fit')}
              className="px-2.5 py-1 bg-white/10 hover:bg-white/20 active:bg-white/30 border border-white/20 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 focus:outline-none"
            >
              {scrollMode === 'fit' ? '↔ Enable Scroll' : '⊙ Fit Columns'}
            </button>
            <span className="text-xs uppercase tracking-widest text-[#e4f2ee]">Period: {formatDate(fromDate)} to {formatDate(toDate)} · ↑↓ Move · Home/End Jump</span>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto bg-[#f5f6f3] min-w-0">
            <table className={`${scrollMode === 'scroll' ? 'w-max min-w-full md:min-w-[1200px]' : 'w-full'} text-[13px] leading-tight`}>
              <thead className="sticky top-0 bg-[#d5dfdb] border-b-2 border-[#83918e] text-[#1c3531]">
                <tr>
                  <th className="px-2 py-1 text-left">Date</th>
                  <th className="px-2 py-1 text-left">Party Name</th>
                  <th className="px-2 py-1 text-left">Remark</th>
                  <th className="px-2 py-1 text-left">Voucher No</th>
                  <th className="px-2 py-1 text-right">Debit</th>
                  <th className="px-2 py-1 text-right">Credit</th>
                  <th className="px-2 py-1 text-left">Type</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.map((row, index) => (
                  <tr 
                    key={row.id} 
                    onClick={() => setSelectedRow(index)}
                    className={`cursor-pointer transition-colors ${selectedRow === index ? 'bg-primary text-white font-bold shadow-md' : 'border-b border-[#d4d8d3] hover:bg-primary/10'}`}
                  >
                    <td className="px-2">{row.date}</td>
                    <td className="px-2">{row.partyName}</td>
                    <td className="px-2">{row.remark}</td>
                    <td className="px-2">{row.voucherNo}</td>
                    <td className={`px-2 text-right ${selectedRow === index ? 'text-white' : 'text-[#2f5d57]'}`}>{row.debit ? row.debit.toFixed(2) : '-'}</td>
                    <td className={`px-2 text-right ${selectedRow === index ? 'text-white' : 'text-[#2f5d57]'}`}>{row.credit ? row.credit.toFixed(2) : '-'}</td>
                    <td className="px-2">{row.type}</td>
                  </tr>
                ))}
                {!reportRows.length && (
                  <tr>
                    <td className="px-2 py-4 text-center text-sm text-gray-500" colSpan={7}>No vouchers found for selected period.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="w-80 border-l-2 border-[#889792] bg-[#ecefed] overflow-auto">
            <div className="bg-[#406a64] text-white px-3 py-2 text-sm font-bold">Voucher Detail Panel</div>
            {selectedVoucher ? (
              <div className="p-3 text-sm space-y-2">
                <p><span className="font-bold">Voucher:</span> {selectedVoucher.voucherNo}</p>
                <p><span className="font-bold">Date:</span> {selectedVoucher.date}</p>
                <p><span className="font-bold">Party:</span> {selectedVoucher.partyName}</p>
                <p><span className="font-bold">Type:</span> {selectedVoucher.type}</p>
                <p><span className="font-bold">Remark:</span> {selectedVoucher.remark}</p>
                <div className="pt-2 border-t border-[#b9c4be]">
                  <p className="font-bold text-xs uppercase mb-1">Line Items</p>
                  <ul className="space-y-1">
                    {selectedVoucher.items.slice(0, 6).map((item: any, idx: number) => (
                      <li key={`${item.name}-${idx}`} className="text-xs flex justify-between gap-2"><span>{item.name}</span><span>{item.quantity}</span></li>
                    ))}
                    {!selectedVoucher.items.length && <li className="text-xs text-gray-500">No line items available.</li>}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="p-3 text-sm text-gray-500">Select a row to view voucher details.</p>
            )}
          </div>
        </div>

        <div className="h-12 bg-[#dae2de] border-t-2 border-[#8c9995] px-4 flex items-center justify-between text-[13px] font-bold text-[#1f3833]">
          <span>Total Vouchers: {reportRows.length}</span>
          <span>Debit Total: {totalDebit.toFixed(2)} | Credit Total: {totalCredit.toFixed(2)}</span>
        </div>
      </section>

      {isPeriodModalOpen && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center px-4 z-50"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              handleCancelPeriodModal();
            }
          }}
        >
          <div className="w-full max-w-lg bg-[#eef2ee] border-2 border-[#5d726d] shadow-2xl" role="dialog" aria-modal="true" aria-label="Select Report Period">
            <div className="bg-[#335f59] text-white px-4 py-2 font-bold tracking-wide">Select Report Period</div>
            <div className="p-4 space-y-4">
              <p className="text-sm text-[#1f3833] font-semibold">{reportNameMap.get(pendingReportId) || 'Selected Report'}</p>
              <div className="grid grid-cols-[120px_1fr] items-center gap-3">
                <label className="text-sm font-bold text-[#1f3833]" htmlFor="period-from">Period From :</label>
                <input
                  ref={fromDateRef}
                  id="period-from"
                  type="date"
                  value={fromDate}
                  onChange={e => setFromDate(e.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      toDateRef.current?.focus();
                    }
                  }}
                  className="border border-[#7f8f8a] px-2 py-1 bg-white text-sm"
                  autoFocus
                />

                <label className="text-sm font-bold text-[#1f3833]" htmlFor="period-to">To :</label>
                <input
                  ref={toDateRef}
                  id="period-to"
                  type="date"
                  value={toDate}
                  onChange={e => setToDate(e.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      generateButtonRef.current?.focus();
                    }
                  }}
                  className="border border-[#7f8f8a] px-2 py-1 bg-white text-sm"
                />
              </div>
              {periodError && <p className="text-xs text-red-700 font-semibold">{periodError}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  ref={generateButtonRef}
                  onClick={handleGenerateReport}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleGenerateReport();
                    }
                  }}
                  className="px-3 py-1.5 border border-[#365852] bg-[#335f59] text-white text-xs font-bold uppercase"
                >
                  Generate Report
                </button>
                <button onClick={handleClearPeriod} className="px-3 py-1.5 border border-[#6b7a76] bg-white text-xs font-bold uppercase">Clear</button>
                <button onClick={handleCancelPeriodModal} className="px-3 py-1.5 border border-[#6b7a76] bg-white text-xs font-bold uppercase">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

export default DailyReports;
