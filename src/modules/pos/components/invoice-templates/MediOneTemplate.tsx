

import React, { useMemo } from 'react';
import type { DetailedBill, InventoryItem, AppConfigurations } from '@core/types';
import { formatPackLooseQuantity } from "@core/utils/quantity";
import { numberToWords } from "@core/utils/numberToWords";
import { resolveEffectivePricingMode, resolvePosLineAmountCalculationMode, getPrintGrandTotal } from "@core/utils/billing";
import BankDetailsInline from './BankDetailsInline';

interface TemplateProps {
  bill: DetailedBill & { inventory?: InventoryItem[]; configurations: AppConfigurations; };
  orientation?: 'portrait' | 'landscape';
}

const ITEMS_PER_PAGE = 6;      // footer renders on every page, so keep items low
const ITEMS_LAST_PAGE = 5;     // last page also has tfoot row

const MediOneTemplate: React.FC<TemplateProps> = ({ bill, orientation = 'portrait' }) => {
  const isNonGst = bill.billType === 'non-gst';
  const isLandscape = orientation === 'landscape';
  const companyPhone = String(bill.pharmacy.mobile || '-').trim().toUpperCase();
  const companyGstin = String(bill.pharmacy.gstin || '-').trim().toUpperCase();
  const companyDrugLicense = String((bill.pharmacy as any).drug_license || (bill.pharmacy as any).drugLicense || '-').trim().toUpperCase();
  const companyBankName = (bill.pharmacy as any).bank_account_name || (bill.pharmacy as any).bank_name;
  const companyAccountNumber = (bill.pharmacy as any).bank_account_number || (bill.pharmacy as any).account_number;
  const companyIfscCode = (bill.pharmacy as any).bank_ifsc_code || (bill.pharmacy as any).ifsc_code;
  const posLineAmountMode = resolvePosLineAmountCalculationMode(bill.configurations);
  const isIncludingDiscountMode = posLineAmountMode === 'including_discount';

  const calculations = useMemo(() => {
    let subtotalValue = 0;
    let totalGst = 0;

    const effectivePricingMode = resolveEffectivePricingMode(bill.pharmacy?.organization_type, bill.pricingMode, bill.configurations);

    const items = (bill.items || []).map((item, idx) => {
      const inventoryItem = bill.inventory?.find(inv => inv.id === item.inventoryItemId);
      
      const rate = effectivePricingMode === 'mrp' ? (item.mrp ?? 0) : (item.rate ?? item.mrp ?? 0);
      const unitsPerPack = item.unitsPerPack || 1;
      const billedQty = (item.quantity || 0) + ((item.looseQuantity || 0) / unitsPerPack);
      const grossAmount = billedQty * rate;
      const tradeDiscountAmount = grossAmount * ((item.discountPercent || 0) / 100);
      const schemeDiscountAmount = item.schemeDiscountAmount || 0;
      const flatDiscountAmount = item.itemFlatDiscount || 0;
      const lineAmount = isIncludingDiscountMode
        ? Math.max(0, grossAmount - tradeDiscountAmount - schemeDiscountAmount - flatDiscountAmount)
        : Math.max(0, grossAmount);
      
      const effectiveGst = isNonGst ? 0 : (item.gstPercent || 0);
      const isInclusive = effectivePricingMode === 'mrp';

      const taxableVal = isInclusive && effectiveGst > 0
        ? lineAmount / (1 + (effectiveGst / 100))
        : lineAmount;
      const gstAmt = isInclusive ? (lineAmount - taxableVal) : (taxableVal * (effectiveGst / 100));
      
      subtotalValue += taxableVal;
      totalGst += gstAmt;

      return {
        ...item,
        sn: idx + 1,
        hsn: item.hsnCode || inventoryItem?.hsnCode || '',
        packSize: item.packType || inventoryItem?.packType || item.unitOfMeasurement || (item.unitsPerPack ? `${item.unitsPerPack} units` : ''),
        batch: item.batch || inventoryItem?.batch || '',
        expiry: item.expiry || (inventoryItem?.expiry ? new Date(inventoryItem.expiry).toLocaleDateString('en-GB', { month: '2-digit', year: '2-digit' }) : ''),
        taxableVal,
        gstAmt,
        lineTotal: lineAmount,
        billedRate: rate,
        displayName: (() => {
          const packLabel = item.packType?.trim() || inventoryItem?.packType?.trim() || '';
          return packLabel ? `${item.name} (${packLabel})` : item.name;
        })()
      };
    });

    // Two-tier chunking: keep last page lighter so the footer fits
    const chunks: (typeof items)[] = [];
    let idx = 0;
    while (idx < items.length) {
      const remaining = items.length - idx;
      if (remaining <= ITEMS_LAST_PAGE) {
        chunks.push(items.slice(idx));
        break;
      }
      if (remaining - ITEMS_PER_PAGE > ITEMS_LAST_PAGE) {
        chunks.push(items.slice(idx, idx + ITEMS_PER_PAGE));
        idx += ITEMS_PER_PAGE;
      } else {
        const takeNow = remaining - ITEMS_LAST_PAGE;
        chunks.push(items.slice(idx, idx + takeNow));
        idx += takeNow;
      }
    }
    const itemChunks = chunks.length > 0 ? chunks : [[]];

    const billDiscount = bill.schemeDiscount || 0;
    const roundOff = bill.roundOff || 0;
    const adjustment = bill.adjustment || 0;
    const grandTotal = bill.total || 0;
    const hasFkPrice = (bill.items || []).some((it: any) => it.fk_price_applied != null);
    const printGrandTotal = getPrintGrandTotal(bill);

    return { items, itemChunks, subtotalValue, totalGst: (isNonGst ? 0 : (bill.totalGst || 0)), billDiscount, adjustment, roundOff, grandTotal, printGrandTotal, hasFkPrice };
  }, [bill, isNonGst, isIncludingDiscountMode]);

  return (
    <div className="invoice-container bg-white text-black font-sans w-full mx-auto leading-tight min-h-full flex flex-col antialiased border border-gray-200" style={{ fontSize: '8.25pt', fontWeight: 400 }}>
      <style>{`
        @media print {
          .invoice-container { page-break-inside: avoid; break-inside: avoid; }
          .invoice-footer, .amount-in-words, .bank-details { page-break-inside: avoid; break-inside: avoid; }
          @page { 
            margin: 0mm !important; 
            size: A5 ${orientation}; 
          }
          body { margin: 0; padding: 0; background: white !important; }
          .medi-page {
            page-break-after: always;
            break-after: always;
            width: ${isLandscape ? '210mm' : '148mm'};
            height: auto;
            padding: 5mm !important;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            overflow: visible;
            background: white !important;
            border: 0 !important;
          }
          .medi-page:last-child {
            page-break-after: auto;
          }
        }
        @media screen {
          .medi-page {
            width: ${isLandscape ? '210mm' : '148mm'};
            min-height: ${isLandscape ? '148mm' : '210mm'};
            height: auto;
            padding: 5mm;
            background: white;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
            margin: 10px auto;
            overflow: visible;
          }
        }
        .med-table { border-collapse: collapse; width: 100%; border: 1px solid black; }
        .med-table th { border: 1px solid black; padding: 2px 4px; font-weight: 600; font-size: 7.5pt; text-transform: uppercase; background: #f8f9fa; }
        .med-table td { border-left: 1px solid black; border-right: 1px solid black; padding: 2px 4px; font-size: 8.25pt; height: 22px; font-weight: 500; }
        .med-table tfoot td { border-top: 1px solid black; font-weight: 600; }
        .border-top { border-top: 1px solid black; }
        .border-bottom { border-bottom: 1px solid black; }
        .invoice-container { padding-bottom: 20px; min-height: 100%; height: auto; overflow: visible; }
        .invoice-bottom { display: flex; justify-content: space-between; align-items: flex-end; }
        .amount-in-words, .bank-details, .invoice-footer { page-break-inside: avoid; break-inside: avoid; }
      `}</style>

      {calculations.itemChunks.map((chunk, pageIdx) => (
        <div key={pageIdx} className="medi-page">
          {/* Header Section */}
          <div className="flex justify-between items-start mb-2">
            <div className="flex-1">
              <h1 className="text-lg font-black uppercase text-blue-800 leading-none">{bill.pharmacy.pharmacy_name}</h1>
              <p className="text-[7pt] font-bold text-gray-600 mt-1 uppercase whitespace-pre-line leading-tight">{bill.pharmacy.address}</p>
              <div className="text-[7.5pt] mt-1 space-x-3 font-normal leading-tight">
                <span>PH: {companyPhone}</span>
                <span>GSTIN: {companyGstin}</span>
                <span>DL NO: {companyDrugLicense}</span>
              </div>
            </div>
            <div className="text-right flex-shrink-0 ml-4">
                <h2 className="text-sm font-black border-2 border-black px-3 py-1 uppercase tracking-widest inline-block bg-gray-50">
                    {isNonGst ? 'Estimate' : 'Tax Invoice'}
                </h2>
                <div className="mt-2 text-[8pt] font-bold">
                    <p>INV NO: <span className="font-mono text-blue-900">{bill.invoiceNumber || bill.id}</span></p>
                    <p>DATE: {new Date(bill.date).toLocaleDateString('en-GB')}</p>
                </div>
            </div>
          </div>

          {/* Party Details */}
          <div className="border border-black p-2 mb-2 bg-slate-50 flex justify-between">
            <div className="flex-1">
                <p className="text-[7pt] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">Billed To:</p>
                <p className="text-[9pt] font-black uppercase text-gray-900">{bill.customerName}</p>
                {bill.customerDetails?.address && <p className="text-[7.5pt] font-medium text-gray-600 truncate max-w-[250px]">{bill.customerDetails.address}</p>}
                {bill.customerDetails?.gstNumber ? (
                  <p className="text-[7.5pt] font-medium text-gray-600">GSTIN: {bill.customerDetails.gstNumber}</p>
                ) : bill.customerDetails?.panNumber ? (
                  <p className="text-[7.5pt] font-medium text-gray-600">PAN: {bill.customerDetails.panNumber}</p>
                ) : null}
                {bill.customerDetails?.drugLicense && <p className="text-[7.5pt] font-medium text-gray-600">DL: {bill.customerDetails.drugLicense}</p>}
            </div>
            <div className="text-right">
                {bill.customerDetails?.phone && <p className="text-[8pt] font-bold">Mob: {bill.customerDetails.phone}</p>}
                {bill.referredBy && <p className="text-[7.5pt] font-bold mt-1 text-blue-700">Dr. {bill.referredBy}</p>}
            </div>
          </div>

          {/* Items Table */}
          <table className="med-table flex-1">
            <thead>
              <tr>
                <th className="w-[5%]">#</th>
                <th className="text-left w-[32%]">Item Description</th>
                <th className="w-[8%]">Pack</th>
                <th className="w-[12%]">Batch</th>
                <th className="w-[8%]">Exp</th>
                <th className="w-[8%]">Qty</th>
                <th className="w-[10%] text-right">MRP</th>
                <th className="w-[17%] text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {chunk.map((item, idx) => (
                <tr key={item.id}>
                  <td className="text-center">{(pageIdx * ITEMS_PER_PAGE) + idx + 1}</td>
                  <td className="font-semibold uppercase truncate">{item.displayName}</td>
                  <td className="text-center font-mono text-[7.5pt]">{item.batch}</td>
                  <td className="text-center text-[7pt]">{item.expiry}</td>
                  <td className="text-center font-semibold">{formatPackLooseQuantity(item.quantity, item.looseQuantity, item.freeQuantity)}</td>
                  <td className="text-right">{(item.mrp || 0).toFixed(2)}</td>
                  <td className="text-right font-semibold">{(item.lineTotal || 0).toFixed(2)}</td>
                </tr>
              ))}

            </tbody>
            {pageIdx === calculations.itemChunks.length - 1 && (
                <tfoot>
                    <tr className="bg-gray-50">
                        <td colSpan={5} className="text-right p-1 uppercase text-[7pt]">Page Total Items:</td>
                        <td className="text-center p-1">{chunk.reduce((sum, i) => sum + i.quantity, 0)}</td>
                        <td colSpan={2} className="text-right p-1 text-[9pt]">₹ {chunk.reduce((sum, i) => sum + (i.lineTotal || 0), 0).toFixed(2)}</td>
                    </tr>
                </tfoot>
            )}
          </table>

          {/* Footer */}
          <div className="invoice-footer mt-2 flex flex-col">
              <div className="invoice-bottom border border-black p-2 bg-gray-50">
                  <div className="flex-1">
                      <BankDetailsInline
                        bankName={companyBankName}
                        accountNumber={companyAccountNumber}
                        ifscCode={companyIfscCode}
                        className="bank-details text-[7pt] text-gray-700 mb-1 leading-tight"
                      />
                      <p className="amount-in-words text-[7.5pt] font-semibold uppercase italic leading-tight">
                        {numberToWords(calculations.printGrandTotal)}
                      </p>
                      <div className="mt-4 text-[7pt] text-gray-500 italic">
                        <p>Subject to local jurisdiction. E.&O.E.</p>
                      </div>
                  </div>
                  <div className="w-[140px] space-y-1 text-[8.5pt]">
                      <div className="flex justify-between font-bold text-gray-600">
                          <span>Subtotal:</span>
                          <span>{(calculations.subtotalValue || 0).toFixed(2)}</span>
                      </div>
                      {!isNonGst && (
                        <div className="flex justify-between font-bold text-gray-600">
                            <span>GST:</span>
                            <span>+{(calculations.totalGst || 0).toFixed(2)}</span>
                        </div>
                      )}
                      <div className="flex justify-between font-bold text-emerald-700">
                          <span>Savings:</span>
                          <span>-{(calculations.billDiscount || 0).toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between font-semibold text-blue-900 border-t border-black pt-1 text-[11pt]">
                          <span>NET AMT:</span>
                          <span>₹ {calculations.printGrandTotal.toFixed(2)}</span>
                      </div>
                  </div>
              </div>
              
              <div className="mt-4 flex justify-between items-end px-1">
                  <div className="text-[7pt] font-bold text-gray-400">
                      <p>Generated by Medimart Retail ERP</p>
                  </div>
                  <div className="text-center min-w-[150px]">
                      <p className="text-[7pt] font-semibold uppercase mb-6">For {bill.pharmacy.pharmacy_name}</p>
                      <p className="border-t border-black pt-1 px-4 text-[8pt] font-semibold uppercase">Auth. Signatory</p>
                  </div>
              </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default MediOneTemplate;
