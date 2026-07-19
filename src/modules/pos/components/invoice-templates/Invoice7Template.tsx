import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DetailedBill, InventoryItem, AppConfigurations } from '@core/types';
import { formatPackLooseQuantity } from "@core/utils/quantity";
import { isRateFieldAvailable, resolveEffectivePricingMode, resolvePosLineAmountCalculationMode, getPrintGrandTotal } from "@core/utils/billing";

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
    const printGrandTotal = getPrintGrandTotal(bill);
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
      grandTotal,
      printGrandTotal
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

    setLayoutMetrics({ 
      headerHeight: Math.max(headerHeight, 50), 
      footerHeight: Math.max(footerHeight, 40), 
      rowHeight: Math.max(rowHeight, 12), 
      tableHeaderHeight: Math.max(tableHeaderHeight, 15) 
    });
  }, [bill.id, compactMode, dynamicFontSize, billDetails.items.length]);

  const paginatedItems = useMemo(() => {
    const allItems = (billDetails.items || []) as BillItem[];
    if (allItems.length === 0) return [];

    const rowHeightPx = Math.max(1, layoutMetrics.rowHeight);
    const headerPx = layoutMetrics.headerHeight + layoutMetrics.tableHeaderHeight;
    const footerPx = layoutMetrics.footerHeight;
    
    const safePageHeight = PAGE_HEIGHT_PX - VERTICAL_PADDING_PX - 4; 

    const availableWithoutFooter = Math.max(1, safePageHeight - headerPx);
    const availableWithFooter = Math.max(1, safePageHeight - headerPx - footerPx);
    
    const rowsWithoutFooter = Math.max(1, Math.floor(availableWithoutFooter / rowHeightPx));
    const rowsWithFooter = Math.max(1, Math.floor(availableWithFooter / rowHeightPx));

    const pages: BillItem[][] = [];
    let cursor = 0;
    
    while (cursor < allItems.length) {
      const remaining = allItems.length - cursor;
      
      if (remaining <= rowsWithFooter) {
        pages.push(allItems.slice(cursor));
        break;
      }
      
      const take = Math.max(1, Math.min(remaining - 1, rowsWithoutFooter));
      pages.push(allItems.slice(cursor, cursor + take));
      cursor += take;
    }

    const renderedItems = pages.flat().length;
    if (renderedItems !== allItems.length) {
      console.error('Pagination error: Missing items', { expected: allItems.length, renderedItems });
    }

    return pages;
  }, [billDetails.items, layoutMetrics]);

  return (
    <div className="invoice-7 w-[100mm] max-w-[100mm] text-black font-mono" style={{ ['--invoice-font' as string]: dynamicFontSize, fontSize: 'var(--invoice-font, 9px)' }}>
      <style>{`
        @media print {
          @page { size: 100mm 150mm; margin: 0; }
          body { margin: 0; padding: 0; }
          .invoice-7 { width: 100mm !important; max-width: 100mm !important; margin: 0 !important; }
          .invoice-page {
            width: 100mm;
            height: 150mm;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            page-break-after: always;
            page-break-inside: avoid;
            break-inside: avoid;
            overflow: hidden;
            box-sizing: border-box;
          }
          .header { flex: 0 0 auto; }
          .items { flex: 1 1 auto; overflow: hidden; }
          .footer { flex: 0 0 auto; }
          .invoice-page:last-child { page-break-after: auto; }
        }
      `}</style>

      <div ref={measureRef} className="absolute -left-[9999px] top-0 w-[100mm] pointer-events-none opacity-0" aria-hidden>
        <div className="measure-header text-[8px] leading-[1.2]">
          <div className="text-center mb-1">
            <h1 className="text-[10px] font-bold uppercase">Pharmacy Name Sample</h1>
            <p className="whitespace-pre-line">Sample Address Line 1\nSample Address Line 2</p>
            <div className="mt-0.5">
              <p>PH: 0000000000</p>
              <p>GSTIN: 00AAAAAAAAA0A0Z0</p>
              <p>DL NO: DL-00000-00</p>
            </div>
          </div>
          <div className="border-t border-b border-dashed border-black py-0.5 mb-1 flex justify-between text-[8px]">
            <span>Bill: INV000</span>
            <span>01/01/26</span>
          </div>
          <div className="text-[8px] border-b border-dashed border-black pb-0.5 mb-1">
            <p>Customer: Sample Customer Name</p>
          </div>
        </div>
        <table className="w-full table-fixed text-[8px] leading-[1.2]">
          <thead className="measure-table-head">
            <tr className="font-bold border-b border-dashed border-black">
              <th className="w-[14%] pb-0.5">Qty</th>
              <th className="w-[60%] pb-0.5">Item</th>
              <th className="w-[26%] pb-0.5">Amt</th>
            </tr>
          </thead>
        </table>
        <table className="w-full table-fixed text-[8px] leading-[1.2]">
          <tbody>
            <tr className="measure-row align-top">
              <td className="py-0.5 text-center">1</td>
              <td className="py-0.5 pr-1">Sample Item Name that might wrap to two lines</td>
              <td className="py-0.5 text-right font-semibold">10.00</td>
            </tr>
          </tbody>
        </table>
        <div className="measure-footer text-[8px] leading-[1.2] mt-1 pt-1 border-t border-dashed border-black">
          <div className="space-y-0.5">
            <div className="flex justify-between"><span>Subtotal</span><span>₹0.00</span></div>
            <div className="flex justify-between"><span>Taxable</span><span>₹0.00</span></div>
          </div>
          <div className="border-t border-b border-dashed border-black mt-1 py-0.5 flex justify-between text-[10px] font-bold">
            <span>TOTAL</span>
            <span>₹0.00</span>
          </div>
          <p className="text-center mt-1">Thank You</p>
        </div>
      </div>

      {paginatedItems.map((pageItems, pageIndex) => {
        const isLastPage = pageIndex === paginatedItems.length - 1;

        return (
          <div key={`invoice-7-page-${pageIndex}`} className="invoice-page px-[4mm] py-[4mm] leading-[1.2]">
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
                  <tr className="font-bold border-b border-dashed border-black">
                    <th className="w-[14%] text-center pb-0.5">Qty</th>
                    <th className="w-[60%] text-left pb-0.5">Item</th>
                    <th className="w-[26%] text-right pb-0.5">Amt</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item: any) => (
                    item.__empty ? null : (
                      <tr key={item.id} className="item-row align-top">
                        <td className="py-0.5 text-center">{formatPackLooseQuantity(item.quantity, item.looseQuantity, item.freeQuantity)}</td>
                        <td className="py-0.5 pr-1 break-words">
                          <div className="font-semibold">{item.name}</div>
                          <div className="text-[7px] text-gray-700">GST {item.gstPercent || 0}%</div>
                        </td>
                        <td className="py-0.5 text-right font-semibold">{item.finalPrice.toFixed(2)}</td>
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
                  <span>₹{billDetails.printGrandTotal.toFixed(2)}</span>
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
