import React, { useEffect, useMemo, useState } from 'react';
import type { InventoryItem, Purchase } from '@core/types';
import { arrayToCsvRow, downloadCsv } from '@core/utils/csv';

declare const XLSX: any;
declare const html2pdf: any;

type Props = {
  isOpen: boolean;
  product: InventoryItem | null;
  purchases: Purchase[];
  onClose: () => void;
};

const toDateValue = (value?: string) => new Date(value || 0).getTime();
const fmtDate = (value?: string) => value ? new Date(value).toLocaleDateString('en-IN') : '-';
const fmtMoney = (value: number) => `₹${(Number.isFinite(value) ? value : 0).toFixed(2)}`;

const ProductInsightsPanel: React.FC<Props> = ({ isOpen, product, purchases, onClose }) => {
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportStatus, setExportStatus] = useState<string>('');

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

  const purchaseSummary = useMemo(() => {
    const rates = purchaseRows.map((r) => r.rate);
    const last = rates[0] || 0;
    const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    const best = purchaseRows.reduce((acc, row) => row.rate < acc.rate ? row : acc, purchaseRows[0] || { rate: 0, supplier: '-' });
    return { last, avg30: avg, avg90: avg, best };
  }, [purchaseRows]);

  const runSimulatedExport = async (format: 'csv' | 'xlsx' | 'pdf', exportFn: () => void | Promise<void>) => {
    setExportProgress(0);
    setExportStatus('Reading purchase history...');
    await new Promise((r) => setTimeout(r, 200));

    setExportProgress(35);
    setExportStatus('Formatting columns...');
    await new Promise((r) => setTimeout(r, 200));

    setExportProgress(70);
    setExportStatus('Generating file...');
    await new Promise((r) => setTimeout(r, 250));

    setExportProgress(90);
    setExportStatus('Triggering download...');
    try {
      await exportFn();
      setExportProgress(100);
      setExportStatus('Export complete!');
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(err);
      setExportStatus('Export cancelled or failed');
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      setExportProgress(null);
      setExportStatus('');
    }
  };

  const exportCsv = () => {
    runSimulatedExport('csv', async () => {
      const headers = ['Date', 'Supplier', 'Voucher No', 'Batch', 'Expiry', 'Qty', 'Loose', 'Rate', 'Discount', 'Landed Cost', 'GST %', 'Invoice Value'];
      const csvContent = [
        arrayToCsvRow(headers),
        ...purchaseRows.map((r) => arrayToCsvRow([
          fmtDate(r.date),
          r.supplier,
          r.voucherNo,
          r.batch,
          r.expiry,
          r.qty,
          r.loose,
          fmtMoney(r.rate),
          `${r.discount.toFixed(2)}%`,
          fmtMoney(r.landedCost),
          `${r.gst}%`,
          fmtMoney(r.invoiceValue)
        ]))
      ].join('\n');
      await downloadCsv(csvContent, `${(product?.name || 'product').replace(/\s+/g, '_')}_purchase_history.csv`);
    });
  };

  const exportExcel = () => {
    runSimulatedExport('xlsx', () => {
      if (typeof XLSX === 'undefined') {
        alert("Excel library not loaded.");
        return;
      }
      const headers = ['Date', 'Supplier', 'Voucher No', 'Batch', 'Expiry', 'Qty', 'Loose', 'Rate', 'Discount', 'Landed Cost', 'GST %', 'Invoice Value'];
      const wsData = [
        headers,
        ...purchaseRows.map((r) => [
          fmtDate(r.date),
          r.supplier,
          r.voucherNo,
          r.batch,
          r.expiry,
          r.qty,
          r.loose,
          r.rate,
          r.discount,
          r.landedCost,
          r.gst,
          r.invoiceValue
        ])
      ];
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      XLSX.utils.book_append_sheet(wb, ws, "Purchase History");
      XLSX.writeFile(wb, `${(product?.name || 'product').replace(/\s+/g, '_')}_purchase_history.xlsx`);
    });
  };

  const exportPdf = () => {
    runSimulatedExport('pdf', () => {
      if (typeof html2pdf === 'undefined') {
        alert("PDF library not loaded.");
        return;
      }

      const headers = ['Date', 'Supplier', 'Voucher', 'Batch', 'Exp', 'Qty', 'PTR', 'Disc', 'Landed', 'GST', 'Invoice'];
      const element = document.createElement('div');
      element.style.padding = '20px';
      element.style.fontFamily = 'Arial, sans-serif';
      element.innerHTML = `
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="margin: 0; text-transform: uppercase;">Product Purchase History</h1>
          <h2 style="margin: 5px 0; color: #666;">${product?.name || 'Product'}</h2>
          <p style="font-size: 10px; color: #999;">Generated on: ${new Date().toLocaleString()}</p>
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 9px;">
          <thead>
            <tr style="background-color: #004242; color: white;">
              ${headers.map(h => `<th style="border: 1px solid #003333; padding: 6px; text-align: left;">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${purchaseRows.map(r => `
              <tr>
                <td style="border: 1px solid #eee; padding: 5px;">${fmtDate(r.date)}</td>
                <td style="border: 1px solid #eee; padding: 5px;">${r.supplier}</td>
                <td style="border: 1px solid #eee; padding: 5px;">${r.voucherNo}</td>
                <td style="border: 1px solid #eee; padding: 5px;">${r.batch}</td>
                <td style="border: 1px solid #eee; padding: 5px;">${r.expiry}</td>
                <td style="border: 1px solid #eee; padding: 5px;">${r.qty}/${r.loose}</td>
                <td style="border: 1px solid #eee; padding: 5px;">${fmtMoney(r.rate)}</td>
                <td style="border: 1px solid #eee; padding: 5px;">${r.discount.toFixed(2)}%</td>
                <td style="border: 1px solid #eee; padding: 5px;">${fmtMoney(r.landedCost)}</td>
                <td style="border: 1px solid #eee; padding: 5px;">${r.gst}%</td>
                <td style="border: 1px solid #eee; padding: 5px;">${fmtMoney(r.invoiceValue)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

      const opt = {
        margin: 10,
        filename: `${(product?.name || 'product').replace(/\s+/g, '_')}_purchase_history.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
      };

      return html2pdf().set(opt).from(element).save();
    });
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
            <button onClick={exportPdf} className="border border-gray-300 px-3 py-1.5 text-sm font-bold hover:bg-gray-50">PDF</button>
            <button onClick={onClose} className="border border-gray-300 px-3 py-1.5 text-sm font-bold hover:bg-gray-50">Close</button>
          </div>
        </div>
        <div className="flex-1 space-y-6 overflow-auto p-4 text-sm sm:p-6 sm:text-[15px]">
          <div>
            <p className="mb-2 text-base font-black uppercase text-gray-500 sm:text-lg">Purchase Summary</p>
            <p>Last Purchase Rate: <span className="font-bold">{fmtMoney(purchaseSummary.last)}</span> · Avg 30/90: <span className="font-bold">{fmtMoney(purchaseSummary.avg30)} / {fmtMoney(purchaseSummary.avg90)}</span> · Best: <span className="font-bold">{fmtMoney(purchaseSummary.best?.rate || 0)} ({purchaseSummary.best?.supplier || '-'})</span></p>
          </div>
          <table className="w-full border border-gray-300 text-sm leading-relaxed sm:text-[15px]">
            <thead>
              <tr className="bg-gray-50">
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Date</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Supplier</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Voucher</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Batch</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Exp</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Qty</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">PTR</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Disc</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Landed</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">GST</th>
                <th className="border border-gray-300 px-2 py-2 text-left text-[15px] font-bold sm:text-base">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {purchaseRows.map((r, idx) => (
                <tr key={idx} className="h-9">
                  <td className="border border-gray-300 px-2 py-1.5">{fmtDate(r.date)}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{r.supplier}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{r.voucherNo}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{r.batch}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{r.expiry}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{r.qty}/{r.loose}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{fmtMoney(r.rate)}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{r.discount.toFixed(2)}%</td>
                  <td className="border border-gray-300 px-2 py-1.5">{fmtMoney(r.landedCost)}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{r.gst}%</td>
                  <td className="border border-gray-300 px-2 py-1.5">{fmtMoney(r.invoiceValue)}</td>
                </tr>
              ))}
              {purchaseRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="border border-gray-300 px-2 py-8 text-center text-gray-400 font-bold italic uppercase tracking-wider">
                    No purchase history found for this product
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {exportProgress !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-[2px] animate-fade-in">
          <div className="bg-white border border-gray-300 shadow-2xl p-6 w-96 flex flex-col items-center">
            <p className="text-xs font-black uppercase tracking-[0.2em] text-primary mb-3">Exporting Data</p>
            <div className="w-full bg-gray-200 h-2 mb-2 relative overflow-hidden">
              <div 
                className="bg-primary h-full transition-all duration-300 ease-out" 
                style={{ width: `${exportProgress}%` }}
              />
            </div>
            <div className="flex justify-between w-full text-[10px] font-bold text-gray-500 uppercase">
              <span>{exportStatus}</span>
              <span>{exportProgress}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProductInsightsPanel;
