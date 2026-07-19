import React, { useMemo } from 'react';
import type { DetailedBill, InventoryItem, AppConfigurations } from '@core/types';
import { formatExpiryToMMYY } from "@core/utils/helpers";
import { formatPackLooseQuantity } from "@core/utils/quantity";
import { isRateFieldAvailable, resolveEffectivePricingMode, resolvePosLineAmountCalculationMode, getPrintGrandTotal } from "@core/utils/billing";

interface TemplateProps {
  bill: DetailedBill & { inventory?: InventoryItem[]; configurations: AppConfigurations; };
}

const ThermalTemplate: React.FC<TemplateProps> = ({ bill }) => {
  const isNonGst = bill.billType === 'non-gst';
  const isCredit = bill.paymentMode === 'Credit';
  const showRateColumn = isRateFieldAvailable(bill.configurations);
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
      const finalPrice = isIncludingDiscountMode
        ? Math.max(0, grossAmount - itemTotalDiscount)
        : Math.max(0, grossAmount);
      
      const effectiveGstPercent = isNonGst ? 0 : (item.gstPercent || 0);
      const isInclusive = effectivePricingMode === 'mrp';

      const taxableValue = isInclusive && effectiveGstPercent > 0
        ? finalPrice / (1 + (effectiveGstPercent / 100))
        : finalPrice;
      const gstAmount = isInclusive ? (finalPrice - taxableValue) : (taxableValue * (effectiveGstPercent / 100));

      subtotal += finalPrice;
      totalGst += gstAmount;
      totalQty += item.quantity;
      totalDiscountValue += itemTotalDiscount;

      const inventoryItem = bill.inventory?.find((inv) => inv.id === item.inventoryItemId);
      const batch = item.batch || inventoryItem?.batch || '';
      const expiry = formatExpiryToMMYY(item.expiry || inventoryItem?.expiry);

      return {
        ...item,
        rate,
        finalPrice,
        gstAmount,
        taxableValue,
        itemTotalDiscount,
        batch,
        expiry,
        billedRate: rate
      };
    });

    const gstBreakdown: Record<number, { taxable: number; tax: number }> = {};
    (items || []).forEach((item) => {
      const rate = item.gstPercent || 0;
      if (!gstBreakdown[rate]) gstBreakdown[rate] = { taxable: 0, tax: 0 };
      gstBreakdown[rate].taxable += item.taxableValue;
      gstBreakdown[rate].tax += item.gstAmount;
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
      totalGst: (isNonGst ? 0 : (bill.totalGst || 0)),
      gstBreakdown,
      totalQty,
      totalDiscountValue,
      adjustment,
      grandTotal,
      printGrandTotal
    };
  }, [bill, isNonGst, isIncludingDiscountMode]);

  return (
    <div className="w-[76mm] max-w-[76mm] text-black font-mono text-[10px] leading-tight px-[4mm] py-1">
      <div className="text-center mb-1">
        <h1 className="text-sm font-bold uppercase tracking-tight">{bill.pharmacy.pharmacy_name}</h1>
        <p className="text-[9px] leading-snug whitespace-pre-line">{bill.pharmacy.address}</p>
        <div className="text-[9px] mt-0.5 space-y-[1px] font-normal">
          <p>PH: {companyPhone}</p>
          <p>GSTIN: {companyGstin}</p>
          <p>DL NO: {companyDrugLicense}</p>
        </div>
      </div>

      <div className="border-t border-b border-dashed border-black py-0.5 mb-1 flex justify-between items-center gap-1 text-[9px]">
        <span className="truncate">Bill: {bill.invoiceNumber || bill.id}</span>
        <span>{new Date(bill.date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
      </div>

      {bill.customerName && bill.customerName.toLowerCase() !== 'cash' && (
        <div className="text-[9px] border-b border-dashed border-black pb-0.5 mb-1">
          <p>Customer: {bill.customerName}</p>
          {bill.customerPhone && <p>Ph: {bill.customerPhone}</p>}
          {bill.customerDetails?.gstNumber ? (
            <p>GSTIN: {bill.customerDetails.gstNumber}</p>
          ) : bill.customerDetails?.panNumber ? (
            <p>PAN: {bill.customerDetails.panNumber}</p>
          ) : null}
          {bill.customerDetails?.drugLicense && <p>DL NO: {bill.customerDetails.drugLicense}</p>}
        </div>
      )}

      {isCredit && <div className="text-center text-[9px] font-bold uppercase border-b border-dashed border-black pb-0.5 mb-1">CREDIT BILL</div>}

      <table className="w-full table-fixed text-[9px]">
        <thead>
          <tr className="font-bold border-b border-dashed border-black">
            <th className="w-[44%] text-left pb-0.5">Description</th>
            <th className="w-[12%] text-center pb-0.5">Qty</th>
            {showRateColumn && <th className="w-[20%] text-right pb-0.5">Rate</th>}
            <th className="w-[24%] text-right pb-0.5">Amount</th>
          </tr>
        </thead>
        <tbody>
          {(billDetails.items || []).map((item) => (
            <tr key={item.id} className="align-top">
              <td className="py-0.5 pr-1 break-words">
                <div className="font-semibold">{item.name}</div>
                <div className="text-[8px] text-gray-700">
                  {item.batch && <span>{item.batch}</span>}
                  {item.batch && item.expiry && <span> | </span>}
                  {item.expiry && <span>Exp {item.expiry}</span>}
                </div>
              </td>
              <td className="py-0.5 text-center">{formatPackLooseQuantity(item.quantity, item.looseQuantity, item.freeQuantity)}</td>
              {showRateColumn && <td className="py-0.5 text-right">{(item.billedRate || 0).toFixed(2)}</td>}
              <td className="py-0.5 text-right font-semibold">{item.finalPrice.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t border-dashed border-black mt-1 pt-1 space-y-0.5 text-[9px]">
        <div className="flex justify-between"><span>Items</span><span>{billDetails.totalQty}</span></div>
        <div className="flex justify-between"><span>Subtotal</span><span>₹{billDetails.subtotal.toFixed(2)}</span></div>
        {billDetails.discount > 0 && (
          <div className="flex justify-between"><span>Discount</span><span>-₹{billDetails.discount.toFixed(2)}</span></div>
        )}
        <div className="flex justify-between"><span>Taxable Amount</span><span>₹{billDetails.taxableAmount.toFixed(2)}</span></div>

        {!isNonGst && (
          <>
            {Object.entries(billDetails.gstBreakdown).map(([rate, data]) => {
              if (parseFloat(rate) === 0) return null;
              const typedData = data as { taxable: number; tax: number };
              return (
                <div key={rate} className="flex justify-between gap-2">
                  <span className="truncate">GST {rate}% on {typedData.taxable.toFixed(2)}</span>
                  <span>₹{typedData.tax.toFixed(2)}</span>
                </div>
              );
            })}
          </>
        )}

        {(bill.roundOff || 0) !== 0 && <div className="flex justify-between"><span>Round Off</span><span>{bill.roundOff > 0 ? '+' : ''}{bill.roundOff.toFixed(2)}</span></div>}
        {(billDetails.totalDiscountValue + (bill.schemeDiscount || 0)) > 0 && (
          <div className="flex justify-between font-semibold">
            <span>Savings</span>
            <span>{(billDetails.totalDiscountValue + (bill.schemeDiscount || 0)).toFixed(2)}</span>
          </div>
        )}
      </div>

      <div className="border-t border-b border-dashed border-black mt-1 py-0.5 flex justify-between text-[11px] font-bold">
        <span>TOTAL</span>
        <span>{billDetails.printGrandTotal.toFixed(2)}</span>
      </div>

      <div className="text-[9px] mt-1">
        <div className="flex justify-between"><span>Payment</span><span>{bill.paymentMode || 'Cash'}</span></div>
        <div className="flex justify-between"><span>Tax Total</span><span>{billDetails.totalGst.toFixed(2)}</span></div>
      </div>

      <p className="text-center text-[9px] mt-1">Thank You • Visit Again</p>
    </div>
  );
};

export default ThermalTemplate;
