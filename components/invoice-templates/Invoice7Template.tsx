import React, { useMemo } from 'react';
import type { DetailedBill, InventoryItem, AppConfigurations } from '../../types';
import { formatPackLooseQuantity } from '../../utils/quantity';
import { isRateFieldAvailable, resolveEffectivePricingMode, resolvePosLineAmountCalculationMode } from '../../utils/billing';

interface TemplateProps {
  bill: DetailedBill & { inventory?: InventoryItem[]; configurations: AppConfigurations; };
}

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

  return (
    <div className="invoice-7 w-[100mm] max-w-[100mm] text-black font-mono text-[8px] leading-[1.2] px-1 py-1">
      <style>{`
        @media print {
          @page {
            size: 100mm 150mm;
            margin: 5mm;
          }
          .invoice-7, .invoice-7 *, .invoice-7 tr {
            page-break-inside: avoid;
            break-inside: avoid;
          }
        }
      `}</style>

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

      <table className="w-full table-fixed text-[8px] leading-[1.2]">
        <thead>
          <tr className="font-bold border-b border-dashed border-black">
            <th className="w-[14%] text-center pb-0.5">Qty</th>
            <th className="w-[60%] text-left pb-0.5">Item</th>
            <th className="w-[26%] text-right pb-0.5">Amt</th>
          </tr>
        </thead>
        <tbody>
          {(billDetails.items || []).map((item) => (
            <tr key={item.id} className="align-top">
              <td className="py-0.5 text-center">{formatPackLooseQuantity(item.quantity, item.looseQuantity, item.freeQuantity)}</td>
              <td className="py-0.5 pr-1 break-words">
                <div className="font-semibold">{item.name}</div>
                <div className="text-[7px] text-gray-700">GST {item.gstPercent || 0}%</div>
              </td>
              <td className="py-0.5 text-right font-semibold">{item.finalPrice.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
  );
};

export default Invoice7Template;
