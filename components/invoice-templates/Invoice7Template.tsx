import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DetailedBill, InventoryItem, AppConfigurations } from '../../types';
import { formatPackLooseQuantity } from '../../utils/quantity';
import { isRateFieldAvailable, resolveEffectivePricingMode, resolvePosLineAmountCalculationMode } from '../../utils/billing';

interface TemplateProps {
  bill: DetailedBill & { inventory?: InventoryItem[]; configurations: AppConfigurations; };
}

type BillItem = {
  id: string;
  name: string;
  quantity: number;
  looseQuantity?: number;
  freeQuantity?: number;
  gstPercent?: number;
  finalPrice: number;
};

const MM_TO_PX = 3.7795275591;
const PAGE_HEIGHT_MM = 150;
const PAGE_PADDING_MM = 4;
const PAGE_HEIGHT_PX = 566; // 150mm thermal page height baseline used for pagination
const VERTICAL_PADDING_PX = PAGE_PADDING_MM * 2 * MM_TO_PX;

// Fixed sections for smart pagination (header/footer).
const HEADER_BLOCK_HEIGHT_PX = 135;
const TABLE_HEADER_HEIGHT_PX = 20;
const FOOTER_BLOCK_HEIGHT_PX = 95;
const ITEM_ROW_BASE_HEIGHT_PX = 20;
const ITEM_ROW_COMPACT_HEIGHT_PX = 16;

const Invoice7Template: React.FC<TemplateProps> = ({ bill }) => {
  const isNonGst = bill.billType === 'non-gst';
  const isCredit = bill.paymentMode === 'Credit';
  const _showRateColumn = isRateFieldAvailable(bill.configurations);
  const posLineAmountMode = resolvePosLineAmountCalculationMode(bill.configurations);
  const isIncludingDiscountMode = posLineAmountMode === 'including_discount';
  const companyPhone = String(bill.pharmacy.mobile || '-').trim().toUpperCase();
  const companyGstin = String(bill.pharmacy.gstin || '-').trim().toUpperCase();
  const companyDrugLicense = String((bill.pharmacy as any).drug_license || (bill.pharmacy as any).drugLicense || '-').trim().toUpperCase();

  const billDetails = useMemo(() => {
    let subtotal = 0;
    let totalGst = 0;
    let totalQty = 0;
    let totalDiscountValue = 0;

    const effectivePricingMode = resolveEffectivePricingMode(bill.pharmacy?.organization_type, bill.pricingMode, bill.configurations);

    const items = (bill.items || []).map((item) => {
      const rate = effectivePricingMode === 'mrp' ? (item.mrp ?? 0) : (item.rate ?? item.mrp ?? 0);
      const unitsPerPack = item.unitsPerPack || 1;
      const billedQty = (item.quantity || 0) + ((item.looseQuantity || 0) / unitsPerPack);
      const grossAmount = rate * billedQty;
      const tradeDiscountAmount = grossAmount * ((item.discountPercent || 0) / 100);
      const schemeDiscountAmount = item.schemeDiscountAmount || 0;
      const itemTotalDiscount = tradeDiscountAmount + schemeDiscountAmount;
      const finalPrice = isIncludingDiscountMode ? Math.max(0, grossAmount - itemTotalDiscount) : Math.max(0, grossAmount);

      const effectiveGstPercent = isNonGst ? 0 : (item.gstPercent || 0);
      const isInclusive = effectivePricingMode === 'mrp';
      const taxableValue = isInclusive && effectiveGstPercent > 0 ? finalPrice / (1 + (effectiveGstPercent / 100)) : finalPrice;
      const gstAmount = isInclusive ? (finalPrice - taxableValue) : (taxableValue * (effectiveGstPercent / 100));

      subtotal += finalPrice;
      totalGst += gstAmount;
      totalQty += item.quantity;
      totalDiscountValue += itemTotalDiscount;

      return { ...item, rate, finalPrice, gstAmount, taxableValue, itemTotalDiscount, billedRate: rate };
    });

    const adjustment = bill.adjustment || 0;
    const grandTotal = bill.total || 0;
    const taxableAmount = Number(bill.subtotal || subtotal || 0);
    const summarySubtotal = Number(taxableAmount + (bill.totalItemDiscount || 0) + (bill.schemeDiscount || 0));
    const discount = Math.max(0, Number(summarySubtotal - taxableAmount));

    return {
      items,
      subtotal: summarySubtotal,
      taxableAmount,
      discount,
      totalGst: (isNonGst ? 0 : (bill.totalGst || totalGst)),
      totalQty,
      totalDiscountValue,
      adjustment,
      grandTotal
    };
  }, [bill, isNonGst, isIncludingDiscountMode]);

  const itemCount = billDetails.items?.length || 0;
  const compactMode = itemCount > 30;
  const dynamicFontSize = itemCount > 45 ? '7px' : itemCount > 25 ? '8px' : '9px';

  const measureRef = useRef<HTMLDivElement | null>(null);
  const [layoutMetrics, setLayoutMetrics] = useState({
    headerHeight: HEADER_BLOCK_HEIGHT_PX,
    footerHeight: FOOTER_BLOCK_HEIGHT_PX,
    rowHeight: compactMode ? ITEM_ROW_COMPACT_HEIGHT_PX : ITEM_ROW_BASE_HEIGHT_PX,
    tableHeaderHeight: TABLE_HEADER_HEIGHT_PX,
  });

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;

    const headerHeight = root.querySelector('.measure-header')?.getBoundingClientRect().height ?? HEADER_BLOCK_HEIGHT_PX;
    const footerHeight = root.querySelector('.measure-footer')?.getBoundingClientRect().height ?? FOOTER_BLOCK_HEIGHT_PX;
    const rowHeight = root.querySelector('.measure-row')?.getBoundingClientRect().height ?? (compactMode ? ITEM_ROW_COMPACT_HEIGHT_PX : ITEM_ROW_BASE_HEIGHT_PX);
    const tableHeaderHeight = root.querySelector('.measure-table-head')?.getBoundingClientRect().height ?? TABLE_HEADER_HEIGHT_PX;

    setLayoutMetrics({ headerHeight, footerHeight, rowHeight, tableHeaderHeight });
  }, [bill.id, compactMode, dynamicFontSize, billDetails.items.length]);

  const paginatedItems = useMemo(() => {
    const allItems = (billDetails.items || []) as BillItem[];
    if (allItems.length === 0) return [];

    const rowHeightPx = Math.max(1, Math.ceil(layoutMetrics.rowHeight));
    const headerPx = Math.ceil(layoutMetrics.headerHeight + layoutMetrics.tableHeaderHeight);
    const footerPx = Math.ceil(layoutMetrics.footerHeight);
    const availableWithoutFooter = Math.max(1, PAGE_HEIGHT_PX - VERTICAL_PADDING_PX - headerPx);
    const availableWithFooter = Math.max(1, PAGE_HEIGHT_PX - VERTICAL_PADDING_PX - headerPx - footerPx);
    const rowsWithoutFooter = Math.max(1, Math.floor(availableWithoutFooter / rowHeightPx));
    const rowsWithFooter = Math.max(1, Math.floor(availableWithFooter / rowHeightPx));

    const pages: BillItem[][] = [];
    let cursor = 0;
    while (cursor < allItems.length) {
      pages.push(allItems.slice(cursor, cursor + rowsWithoutFooter));
      cursor += rowsWithoutFooter;
    }

    if (pages.length > 0 && pages[0].length === 0) {
      pages.shift();
    }

    const renderedItems = pages.flat().length;
    if (renderedItems !== allItems.length) {
      console.error('Pagination error: Missing items', { expected: allItems.length, renderedItems });
    }

    console.log({
      totalItems: allItems.length,
      rowsPerPage: rowsWithoutFooter,
      totalPages: pages.length,
      renderedItems,
      pageHeight: PAGE_HEIGHT_PX,
      headerHeight: headerPx,
      footerHeight: footerPx,
      rowHeight: rowHeightPx,
      rowsWithFooter,
    });

    return pages;
  }, [billDetails.items, layoutMetrics]);

  return (
    <div className="invoice-7 invoice-wrapper invoice-print-root w-[100mm] max-w-[100mm] text-black font-mono" style={{ ['--invoice-font' as string]: dynamicFontSize, fontSize: 'var(--invoice-font, 9px)' }}>
      <style>{`
        @media print {
          @page { size: 100mm 150mm; margin: 4mm; }
          html, body {
            height: auto !important;
            overflow: visible !important;
          }
          body {
            margin: 0;
            padding: 0;
          }
          .invoice-wrapper {
            height: auto !important;
            min-height: auto !important;
            transform: none !important;
          }
          .invoice-print-root {
            width: 100mm;
            margin: 0 auto;
          }
          .invoice-page {
            width: 100mm;
            min-height: 150mm;
            padding: 4mm;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            page-break-after: always;
            page-break-before: auto;
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .invoice-page:first-child {
            page-break-before: auto !important;
          }
          .invoice-page:empty {
            display: none !important;
          }
          .header { flex: 0 0 auto; }
          .items { flex: 1 1 auto; }
          .footer { flex: 0 0 auto; }
          .invoice-page:last-child { page-break-after: auto; }
        }
      `}</style>

      <div ref={measureRef} className="absolute -left-[9999px] top-0 w-[100mm] pointer-events-none opacity-0" aria-hidden>
        <div className="measure-header text-[8px] leading-[1.2]">
          <div className="mb-1">Header</div>
          <div className="mb-1">Meta</div>
          <div className="mb-1">Customer</div>
        </div>
        <table className="w-full table-fixed text-[8px] leading-[1.2]"><thead className="measure-table-head"><tr><th className="py-0.5">Qty</th></tr></thead></table>
        <table className="w-full table-fixed text-[8px] leading-[1.2]"><tbody><tr className="measure-row"><td className="py-0.5">1</td><td className="py-0.5">Item</td><td className="py-0.5">10.00</td></tr></tbody></table>
        <div className="measure-footer text-[8px] leading-[1.2] mt-1 pt-1">Footer block</div>
      </div>

      {paginatedItems.map((pageItems, pageIndex) => {
        const isLastPage = pageIndex === paginatedItems.length - 1;

        return (
          <div key={`invoice-7-page-${pageIndex}`} className="invoice-page leading-[1.2]">
            <div className="header">
              <div className="text-center mb-1">
                <h1 className="text-[10px] font-bold uppercase tracking-tight">{bill.pharmacy.pharmacy_name}</h1>
                <p className="text-[8px] leading-[1.2] whitespace-pre-line">{bill.pharmacy.address}</p>
                <div className="text-[8px] mt-0.5 space-y-0">
                  <p>PH: {companyPhone}</p>
                  <p>GSTIN: {companyGstin}</p>
                  <p>DL NO: {companyDrugLicense}</p>
                </div>
              </div>

              <div className="border-t border-b border-dashed border-black py-0.5 mb-1 flex justify-between items-center gap-1 text-[8px]">
                <span className="truncate">Bill: {bill.invoiceNumber || bill.id}</span>
                <span>{new Date(bill.date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
              </div>

              {bill.customerName && bill.customerName.toLowerCase() !== 'cash' && (
                <div className="text-[8px] border-b border-dashed border-black pb-0.5 mb-1">
                  <p>Customer: {bill.customerName}</p>
                  {bill.customerPhone && <p>Ph: {bill.customerPhone}</p>}
                </div>
              )}

              {isCredit && <div className="text-center text-[8px] font-bold uppercase border-b border-dashed border-black pb-0.5 mb-1">CREDIT BILL</div>}

            </div>

            <div className="items">
              <table className="w-full table-fixed text-[8px] leading-[1.2]">
                <thead>
                  <tr className="table-header font-bold border-b border-dashed border-black">
                    <th className="qty w-[15%] text-left pb-0.5">Qty</th>
                    <th className="item w-[45%] text-left pb-0.5">Item</th>
                    <th className="gst w-[15%] text-center pb-0.5">GST%</th>
                    <th className="amt w-[25%] text-right pb-0.5">Amt</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item: any) => (
                    item.__empty ? null : (
                      <tr key={item.id} className="item-row align-top">
                        <td className="qty py-0.5 text-left">{formatPackLooseQuantity(item.quantity, item.looseQuantity, item.freeQuantity)}</td>
                        <td className="item py-0.5 pr-1 break-words">
                          <div className="font-semibold">{item.name}</div>
                        </td>
                        <td className="gst py-0.5 text-center">{item.gst_rate ?? item.gst ?? item.tax ?? item.gstPercent ?? 0}%</td>
                        <td className="amt py-0.5 text-right font-semibold">{item.finalPrice.toFixed(2)}</td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
            </div>

            {isLastPage && (
              <div className="footer">
                <div className="border-t border-dashed border-black mt-1 pt-1 space-y-0.5 text-[8px]">
                  <div className="flex justify-between"><span>Subtotal</span><span>₹{billDetails.subtotal.toFixed(2)}</span></div>
                  {billDetails.discount > 0 && <div className="flex justify-between"><span>Discount</span><span>-₹{billDetails.discount.toFixed(2)}</span></div>}
                  <div className="flex justify-between"><span>Taxable</span><span>₹{billDetails.taxableAmount.toFixed(2)}</span></div>
                  {!isNonGst && <div className="flex justify-between"><span>GST</span><span>₹{billDetails.totalGst.toFixed(2)}</span></div>}
                </div>

                <div className="border-t border-b border-dashed border-black mt-1 py-0.5 flex justify-between text-[10px] font-bold">
                  <span>TOTAL</span>
                  <span>₹{(bill.total || 0).toFixed(2)}</span>
                </div>

                <p className="text-center text-[8px] mt-1">Thank You • Visit Again</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default Invoice7Template;
