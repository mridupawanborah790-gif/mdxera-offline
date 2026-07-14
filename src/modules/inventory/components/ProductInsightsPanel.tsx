import React, { useEffect, useMemo } from 'react';
import type { InventoryItem, Purchase, Transaction } from '@core/types';
import { useModuleVisibility } from '@core/visibility/useModuleVisibility';

type Props = {
  isOpen: boolean;
  product: InventoryItem | null;
  purchases: Purchase[];
  sales: Transaction[];
  loading?: boolean;
  onClose: () => void;
};

const toDateValue = (value?: string) => new Date(value || 0).getTime();
const fmtDate = (value?: string) => value ? new Date(value).toLocaleDateString('en-IN') : '-';
const fmtMoney = (value: number) => `₹${(Number.isFinite(value) ? value : 0).toFixed(2)}`;

const ProductInsightsPanel: React.FC<Props> = ({ isOpen, product, purchases, sales, loading = false, onClose }) => {
  const { isFeatureHidden } = useModuleVisibility();
  const showProfit = !isFeatureHidden('posProductInsightsProfit');
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [isOpen, onClose]);

  const purchaseRows = useMemo(() => {
    if (!product) return [];
    const rows: any[] = [];
    purchases
      .filter((p) => p.status !== 'cancelled')
      .forEach((p) => {
        (p.items || []).forEach((it: any) => {
          const sameById = product.id && it.inventoryItemId && it.inventoryItemId === product.id;
          const sameByName = (it.name || '').toLowerCase().trim() === (product.name || '').toLowerCase().trim();
          if (!sameById && !sameByName) return;
          const qty = Number(it.quantity || 0);
          const loose = Number(it.looseQuantity || 0);
          const rate = Number(it.purchasePrice || 0);
          const disc = Number(it.discountPercent || 0) + Number(it.schemeDiscountPercent || 0);
          const gst = Number(it.gstPercent || 0);
          const invoiceValue = Number(it.lineTotal || (qty + loose) * rate || 0);
          rows.push({
            date: p.date,
            supplier: p.supplier,
            voucherNo: p.id || p.invoiceNumber,
            batch: it.batch || '-',
            expiry: it.expiry || '-',
            qty,
            loose,
            rate,
            discount: disc,
            landedCost: rate * (1 - disc / 100),
            gst,
            invoiceValue,
          });
        });
      });
    return rows.sort((a, b) => toDateValue(b.date) - toDateValue(a.date)).slice(0, 20);
  }, [purchases, product]);

  const salesRows = useMemo(() => {
    if (!product) return [];
    const rows: any[] = [];
    sales
      .filter((s) => s.status !== 'cancelled')
      .forEach((s) => {
        (s.items || []).forEach((it: any) => {
          const sameById = product.id && it.inventoryItemId && it.inventoryItemId === product.id;
          const sameByName = (it.name || '').toLowerCase().trim() === (product.name || '').toLowerCase().trim();
          if (!sameById && !sameByName) return;
          const qty = Number(it.quantity || 0) + Number(it.looseQuantity || 0);
          const rate = Number(it.rate || it.mrp || 0);
          const discount = Number(it.discountPercent || 0) + Number(it.schemeDiscountPercent || 0);
          const gst = Number(it.gstPercent || 0);
          const net = Number(it.finalAmount || it.amount || qty * rate || 0);
          rows.push({ date: s.date, customer: s.customerName || '-', billId: s.id, qty, rate, discount, gst, net });
        });
      });
    return rows.sort((a, b) => toDateValue(b.date) - toDateValue(a.date)).slice(0, 20);
  }, [sales, product]);

  const purchaseSummary = useMemo(() => {
    const rates = purchaseRows.map((r) => r.rate);
    const last = rates[0] || 0;
    const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    const best = purchaseRows.reduce((acc, row) => row.rate < acc.rate ? row : acc, purchaseRows[0] || { rate: 0, supplier: '-' });
    return { last, avg30: avg, avg90: avg, best };
  }, [purchaseRows]);

  const salesSummary = useMemo(() => {
    const rates = salesRows.map((r) => r.rate);
    const last = rates[0] || 0;
    const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    return { last, avg30: avg, avg90: avg };
  }, [salesRows]);

  const margin = useMemo(() => {
    const selling = salesSummary.last || Number(product?.mrp || 0);
    const purchase = purchaseSummary.avg30 || Number(product?.purchasePrice || 0);
    const profitPerUnit = selling - purchase;
    const currentMargin = selling > 0 ? (profitPerUnit / selling) * 100 : 0;
    return { selling, purchase, profitPerUnit, currentMargin };
  }, [purchaseSummary.avg30, salesSummary.last, product]);

  const exportCsv = () => {
    const lines = [
      ['Section', 'Date', 'Party', 'Ref', 'Qty', 'Rate', 'Net'].join(','),
      ...purchaseRows.map((r) => ['Purchase', r.date, r.supplier, r.voucherNo, `${r.qty}/${r.loose}`, r.rate, r.invoiceValue].join(',')),
      ...salesRows.map((r) => ['Sales', r.date, r.customer, r.billId, r.qty, r.rate, r.net].join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(product?.name || 'product').replace(/\s+/g, '_')}_insights.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = () => {
    const lines = [
      ['Section', 'Date', 'Party', 'Ref', 'Qty', 'Rate', 'Net'].join('\t'),
      ...purchaseRows.map((r) => ['Purchase', r.date, r.supplier, r.voucherNo, `${r.qty}/${r.loose}`, r.rate, r.invoiceValue].join('\t')),
      ...salesRows.map((r) => ['Sales', r.date, r.customer, r.billId, r.qty, r.rate, r.net].join('\t')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(product?.name || 'product').replace(/\s+/g, '_')}_insights.xls`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen || !product) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6">
      <div className="flex h-[85vh] w-[90vw] max-w-[1700px] flex-col overflow-hidden rounded-lg border border-gray-300 bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 p-4 sm:p-5">
          <div>
            <p className="text-base font-black uppercase tracking-widest text-gray-500 sm:text-lg">Product Details / Insights</p>
            <p className="text-lg font-bold leading-tight text-gray-900 sm:text-xl">{product.name}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button onClick={exportCsv} className="border border-gray-300 px-3 py-1.5 text-sm font-bold hover:bg-gray-50">CSV</button>
            <button onClick={exportExcel} className="border border-gray-300 px-3 py-1.5 text-sm font-bold hover:bg-gray-50">Excel</button>
            <button onClick={() => window.print()} className="border border-gray-300 px-3 py-1.5 text-sm font-bold hover:bg-gray-50">PDF</button>
            <button onClick={onClose} className="border border-gray-300 px-3 py-1.5 text-sm font-bold hover:bg-gray-50">Close</button>
          </div>
        </div>
        {loading ? <div className="space-y-4 p-6 animate-pulse"><div className="h-10 bg-gray-100" /><div className="h-24 bg-gray-100" /><div className="h-24 bg-gray-100" /></div> : (
        <div className="flex-1 space-y-6 overflow-auto p-4 text-sm sm:p-6 sm:text-[15px]">
          <div>
            <p className="mb-2 text-base font-black uppercase text-gray-500 sm:text-lg">Purchase Summary</p>
            <p>Last Purchase Rate: <span className="font-bold">{fmtMoney(purchaseSummary.last)}</span> · Avg 30/90: <span className="font-bold">{fmtMoney(purchaseSummary.avg30)} / {fmtMoney(purchaseSummary.avg90)}</span> · Best: <span className="font-bold">{fmtMoney(purchaseSummary.best?.rate || 0)} ({purchaseSummary.best?.supplier || '-'})</span></p>
          </div>
          <table className="w-full border border-gray-300 text-sm leading-relaxed sm:text-[15px]"><thead><tr className="bg-gray-50"><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Date</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Supplier</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Voucher</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Batch</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Exp</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Qty</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">PTR</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Disc</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Landed</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">GST</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Invoice</th></tr></thead><tbody>{purchaseRows.map((r,idx)=><tr key={idx} className="h-9"><td className="border border-gray-300 px-2 py-1.5">{fmtDate(r.date)}</td><td className="border border-gray-300 px-2 py-1.5">{r.supplier}</td><td className="border border-gray-300 px-2 py-1.5">{r.voucherNo}</td><td className="border border-gray-300 px-2 py-1.5">{r.batch}</td><td className="border border-gray-300 px-2 py-1.5">{r.expiry}</td><td className="border border-gray-300 px-2 py-1.5">{r.qty}/{r.loose}</td><td className="border border-gray-300 px-2 py-1.5">{fmtMoney(r.rate)}</td><td className="border border-gray-300 px-2 py-1.5">{r.discount.toFixed(2)}%</td><td className="border border-gray-300 px-2 py-1.5">{fmtMoney(r.landedCost)}</td><td className="border border-gray-300 px-2 py-1.5">{r.gst}%</td><td className="border border-gray-300 px-2 py-1.5">{fmtMoney(r.invoiceValue)}</td></tr>)}</tbody></table>

          <div>
            <p className="mb-2 text-base font-black uppercase text-gray-500 sm:text-lg">Sales Summary</p>
            <p>Last Selling Rate: <span className="font-bold">{fmtMoney(salesSummary.last)}</span> · Avg 30/90: <span className="font-bold">{fmtMoney(salesSummary.avg30)} / {fmtMoney(salesSummary.avg90)}</span></p>
          </div>
          <table className="w-full border border-gray-300 text-sm leading-relaxed sm:text-[15px]"><thead><tr className="bg-gray-50"><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Date</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Customer</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Bill</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Qty</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Rate</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Disc</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">GST</th><th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Net</th></tr></thead><tbody>{salesRows.map((r,idx)=><tr key={idx} className="h-9"><td className="border border-gray-300 px-2 py-1.5">{fmtDate(r.date)}</td><td className="border border-gray-300 px-2 py-1.5">{r.customer}</td><td className="border border-gray-300 px-2 py-1.5">{r.billId}</td><td className="border border-gray-300 px-2 py-1.5">{r.qty}</td><td className="border border-gray-300 px-2 py-1.5">{fmtMoney(r.rate)}</td><td className="border border-gray-300 px-2 py-1.5">{r.discount.toFixed(2)}%</td><td className="border border-gray-300 px-2 py-1.5">{r.gst}%</td><td className="border border-gray-300 px-2 py-1.5">{fmtMoney(r.net)}</td></tr>)}</tbody></table>

          {showProfit && (
            <div className="border border-gray-300 p-4">
              <p className="text-base font-black uppercase text-gray-500 sm:text-lg">Profit / Margin Summary</p>
              <p className={`${margin.currentMargin < 5 ? 'text-red-600' : 'text-gray-900'} text-sm font-bold sm:text-[15px]`}>Current Margin: {margin.currentMargin.toFixed(2)}%</p>
              <p className={`${margin.profitPerUnit < 0 ? 'text-red-600' : 'text-gray-900'} text-sm font-bold sm:text-[15px]`}>Profit per unit: {fmtMoney(margin.profitPerUnit)}</p>
            </div>
          )}
        </div>)}
      </div>
    </div>
  );
};

export default ProductInsightsPanel;
