

import React, { useMemo } from 'react';
import type { DetailedBill, InventoryItem, AppConfigurations } from '@core/types';
import { numberToWords } from "@core/utils/numberToWords";
import { formatPackLooseQuantity } from "@core/utils/quantity";
import { getDisplaySchemePercent, hasLineLevelSchemeDiscount, isRateFieldAvailable, resolveEffectivePricingMode, resolvePosLineAmountCalculationMode, getPrintGrandTotal } from "@core/utils/billing";
import BankDetailsInline from './BankDetailsInline';

interface TemplateProps {
  bill: DetailedBill & { inventory?: InventoryItem[]; configurations: AppConfigurations; };
}

const ITEMS_PER_PAGE = 10;     // intermediate pages
const ITEMS_LAST_PAGE = 7;     // last page shares space with the footer

const GftTemplate: React.FC<TemplateProps> = ({ bill }) => {
  const isNonGst = bill.billType === 'non-gst';
  const companyBankName = (bill.pharmacy as any).bank_account_name || (bill.pharmacy as any).bank_name;
  const companyAccountNumber = (bill.pharmacy as any).bank_account_number || (bill.pharmacy as any).account_number;
  const companyIfscCode = (bill.pharmacy as any).bank_ifsc_code || (bill.pharmacy as any).ifsc_code;
  const isCredit = bill.paymentMode === 'Credit';
  const showTradeDiscountColumn = (bill.items || []).some(item => (item.discountPercent || 0) > 0);
  const showSchemeColumn = (bill.items || []).some(item => hasLineLevelSchemeDiscount(item));
  const showRateColumn = isRateFieldAvailable(bill.configurations);
  const posLineAmountMode = resolvePosLineAmountCalculationMode(bill.configurations);
  const isIncludingDiscountMode = posLineAmountMode === 'including_discount';
  
  const billDetails = useMemo(() => {
    let subtotal = 0;
    let totalCgst = 0;
    let totalSgst = 0;

    const effectivePricingMode = resolveEffectivePricingMode(bill.pharmacy?.organization_type, bill.pricingMode, bill.configurations);

    const itemsWithCalculations = bill.items.map(item => {
        const rate = effectivePricingMode === 'mrp' ? (item.mrp ?? 0) : (item.rate ?? item.mrp ?? 0);
        const unitsPerPack = item.unitsPerPack || 1;
        const billedQty = (item.quantity || 0) + ((item.looseQuantity || 0) / unitsPerPack);

        // Display rate and gross in the line items
        const displayRate = rate;
        const displayGross = billedQty * displayRate;
        const displayTradeDisc = displayGross * ((item.discountPercent || 0) / 100);
        const displayFlat = item.itemFlatDiscount || 0;
        const displayScheme = item.schemeDiscountAmount || 0;
        const displayAmount = isIncludingDiscountMode
          ? Math.max(0, displayGross - displayTradeDisc - displayScheme - displayFlat)
          : Math.max(0, displayGross);

        // If an FK price was applied at billing time, use it for calculations
        const fkRate = (item as any).fk_price_applied != null ? Number((item as any).fk_price_applied) : null;
        const effectiveRate = fkRate != null ? fkRate : rate;
        const grossAmount = billedQty * effectiveRate;
        const tradeDiscountAmount = grossAmount * ((item.discountPercent || 0) / 100);
        const schemeDiscountAmount = item.schemeDiscountAmount || 0;
        const flatDiscountAmount = item.itemFlatDiscount || 0;
        const finalAmount = isIncludingDiscountMode
          ? Math.max(0, grossAmount - tradeDiscountAmount - schemeDiscountAmount - flatDiscountAmount)
          : Math.max(0, grossAmount);

        const effectiveGst = isNonGst ? 0 : (item.gstPercent || 0);
        const isInclusive = effectivePricingMode === 'mrp';

        const taxableValue = isInclusive && effectiveGst > 0
          ? finalAmount / (1 + (effectiveGst / 100))
          : finalAmount;
        const gstAmount = isInclusive ? (finalAmount - taxableValue) : (taxableValue * (effectiveGst / 100));

        subtotal += finalAmount;
        totalCgst += gstAmount / 2;
        totalSgst += gstAmount / 2;

        const inventoryItem = bill.inventory?.find(inv => inv.id === item.inventoryItemId);

        const batch = item.batch || inventoryItem?.batch || '';
        const expiry = item.expiry || (inventoryItem?.expiry ? new Date(inventoryItem.expiry).toLocaleDateString('en-GB', { month: '2-digit', year: '2-digit' }) : '');
        const hsn = item.hsnCode || inventoryItem?.hsnCode || '';
        const packSize = item.packType || inventoryItem?.packType || item.unitOfMeasurement || (item.unitsPerPack ? `${item.unitsPerPack} units` : '');

        return {
            ...item,
            batch,
            expiry,
            hsn,
            displayName: (() => {
          const packLabel = item.packType?.trim() || inventoryItem?.packType?.trim() || '';
          return packLabel ? `${item.name} (${packLabel})` : item.name;
        })(),
            finalAmount: displayAmount,
            taxableValue,
            billedRate: displayRate
        };
    });

    // Two-tier chunking: keep last page lighter so the footer fits
    const chunks: (typeof itemsWithCalculations)[] = [];
    let idx = 0;
    while (idx < itemsWithCalculations.length) {
      const remaining = itemsWithCalculations.length - idx;
      if (remaining <= ITEMS_LAST_PAGE) {
        chunks.push(itemsWithCalculations.slice(idx));
        break;
      }
      if (remaining - ITEMS_PER_PAGE > ITEMS_LAST_PAGE) {
        chunks.push(itemsWithCalculations.slice(idx, idx + ITEMS_PER_PAGE));
        idx += ITEMS_PER_PAGE;
      } else {
        const takeNow = remaining - ITEMS_LAST_PAGE;
        chunks.push(itemsWithCalculations.slice(idx, idx + takeNow));
        idx += takeNow;
      }
    }
    const itemChunks = chunks.length > 0 ? chunks : [[]];

    const billDiscount = bill.schemeDiscount || 0;
    const roundOff = bill.roundOff || 0;
    const adjustment = bill.adjustment || 0;
    const totalTaxFromBill = isNonGst ? 0 : (bill.totalGst || 0);
    const grandTotal = bill.total || 0;
    const printGrandTotal = getPrintGrandTotal(bill);

    const tradeDiscount = bill.totalItemDiscount || 0;
    const schemeDiscount = (bill.items || []).reduce((sum, item) => sum + Number(item.schemeDiscountAmount || 0), 0);
    return { items: itemsWithCalculations, itemChunks, subtotal, totalCgst, totalSgst, totalTaxFromBill, tradeDiscount, schemeDiscount, billDiscount, adjustment, roundOff, grandTotal, printGrandTotal };
  }, [bill, isNonGst, isIncludingDiscountMode]);

  const termsList = bill.pharmacy.terms_and_conditions 
    ? bill.pharmacy.terms_and_conditions.split('\n').filter(t => t.trim() !== '')
    : [
        'Goods once sold will not be taken back.',
        'Interest @ 18% p.a. will be charged if payment is not made within due date.',
        `Subject to ${bill.pharmacy.address ? (bill.pharmacy.address.split(',').pop()?.trim() || 'local') : 'local'} jurisdiction.`
    ];

  return (
    <div className="bg-white text-black font-sans min-h-full leading-tight text-xs w-full max-w-4xl mx-auto" style={{ fontWeight: 400 }}>
      <style>{`
        @media print {
          @page { margin: 0 !important; size: auto; }
          .gft-page {
            page-break-after: always;
          }
          .gft-page:last-child {
            page-break-after: auto;
          }
        }
      `}</style>
      {billDetails.itemChunks.map((chunk, pageIdx) => (
      <div key={pageIdx} className="gft-page p-8">
        <div className="flex justify-between items-start mb-2">
            <div className="flex-1">
                <h1 className="text-3xl font-extrabold text-[#2e3b84] uppercase tracking-wide">
                    {bill.pharmacy.pharmacy_name}
                </h1>
                {!isNonGst && (
                    <div className="text-xs font-bold text-gray-800 mt-1">
                       <span className="mr-3">GSTIN: {bill.pharmacy.gstin}</span>
                       <span>D.L.No: {bill.pharmacy.drug_license}</span>
                    </div>
                )}
            </div>
            <div className="w-24 flex flex-col items-end">
                 {bill.pharmacy.pharmacy_logo_url && (
                    <img src={bill.pharmacy.pharmacy_logo_url} alt="Logo" className="h-16 w-auto object-contain" />
                 )}
            </div>
        </div>

        <div className="bg-[#00a99d] text-white font-bold py-1.5 px-3 mb-3 text-sm uppercase tracking-wider rounded-sm">
            Pharmaceutical Distributors & Retailers
        </div>

        <div className="flex justify-between items-end mb-3">
            <div className="max-w-[60%] text-sm">
                <p className="whitespace-pre-line">{bill.pharmacy.address}</p>
            </div>
            <div className="text-right text-sm">
                <p><span className="font-semibold">Tel :</span> {bill.pharmacy.mobile}</p>
                {bill.pharmacy.email && <p><span className="font-semibold">Web :</span> {bill.pharmacy.email}</p>}
            </div>
        </div>

        <div className="border-2 border-black flex mb-0 bg-white">
            <div className="w-1/3 border-r-2 border-black p-1 pl-2 font-bold text-sm flex items-center">
                PAN : {bill.pharmacy.pan_number || 'N/A'}
            </div>
            <div className="w-1/3 text-center text-lg font-bold p-1 self-center border-r-2 border-black uppercase">
                {isCredit ? 'CREDIT BILL' : (isNonGst ? 'ESTIMATE' : 'TAX INVOICE')}
            </div>
            <div className="w-1/3 text-right p-1 pr-2 text-[10px] self-center font-bold text-gray-600">
                ORIGINAL FOR RECIPIENT
            </div>
        </div>

        <div className="border-x-2 border-b-2 border-black flex text-sm">
            <div className="w-1/2 border-r-2 border-black">
                <div className="border-b-2 border-black text-center font-bold bg-gray-100 p-1">
                    Customer Detail
                </div>
                <div className="p-2 space-y-1">
                    <div className="flex"><span className="w-24 font-bold flex-shrink-0">M/S</span><span>: {bill.customerName}</span></div>
                    <div className="flex"><span className="w-24 font-bold flex-shrink-0">Address</span><span className="break-words max-w-[200px]">: {bill.customerDetails?.address || ''}</span></div>
                    <div className="flex"><span className="w-24 font-bold flex-shrink-0">Phone</span><span>: {bill.customerDetails?.phone || ''}</span></div>
                    {bill.customerDetails?.gstNumber ? (
                      <div className="flex"><span className="w-24 font-bold flex-shrink-0">GSTIN</span><span>: {bill.customerDetails.gstNumber}</span></div>
                    ) : bill.customerDetails?.panNumber ? (
                      <div className="flex"><span className="w-24 font-bold flex-shrink-0">PAN</span><span>: {bill.customerDetails.panNumber}</span></div>
                    ) : null}
                    {bill.customerDetails?.drugLicense && (
                      <div className="flex"><span className="w-24 font-bold flex-shrink-0">DL No</span><span>: {bill.customerDetails.drugLicense}</span></div>
                    )}
                    <div className="flex"><span className="w-24 font-bold flex-shrink-0">Place of Supply</span><span>: {bill.customerDetails?.address ? (bill.customerDetails.address.split(',').pop() || '') : ''}</span></div>
                </div>
            </div>

            <div className="w-1/2 text-sm">
                <div className="grid grid-cols-2 h-full content-start">
                    <div className="p-1 pl-2 border-b border-r border-black font-bold flex items-center bg-gray-50">Invoice No.</div>
                    <div className="p-1 pl-2 border-b border-black font-semibold flex items-center">{bill.invoiceNumber || bill.id}</div>
                    <div className="p-1 pl-2 border-b border-r border-black font-bold flex items-center bg-gray-50">Invoice Date</div>
                    <div className="p-1 pl-2 border-b border-black flex items-center">{new Date(bill.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric'})}</div>
                </div>
            </div>
        </div>

        <div className="border-x-2 border-b-2 border-black">
            <table className="w-full text-xs">
                <thead>
                    <tr className="border-b-2 border-black bg-gray-100">
                        <th className="p-1 border-r border-black w-[4%] text-center">Sr.</th>
                        <th className="p-1 border-r border-black text-left w-[20%]">Product Description</th>
                        <th className="p-1 border-r border-black text-left w-[7%]">Pack</th>
                        <th className="p-1 border-r border-black text-left w-[7%]">HSN</th>
                        <th className="p-1 border-r border-black text-left w-[9%]">Batch</th>
                        <th className="p-1 border-r border-black text-center w-[7%]">Exp.</th>
                        <th className="p-1 border-r border-black text-center w-[6%]">Qty</th>
                        {showRateColumn && <th className="p-1 border-r border-black text-right w-[7%]">Rate</th>}
                        {showTradeDiscountColumn && <th className="p-1 border-r border-black text-right w-[5%]">Disc%</th>}
                        {showSchemeColumn && <th className="p-1 border-r border-black text-right w-[5%]">Sch%</th>}
                        {!isNonGst && <th className="p-1 border-r border-black text-right w-[5%]">GST%</th>}
                        <th className="p-1 text-right w-[11%]">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    {chunk.map((item, index) => (
                        <tr key={item.id} className="border-b border-gray-300 last:border-b-0">
                            <td className="p-1 border-r border-black text-center">{(pageIdx * ITEMS_PER_PAGE) + index + 1}</td>
                            <td className="p-1 border-r border-black font-semibold">{item.displayName}</td>
                            <td className="p-1 border-r border-black">{item.hsn}</td>
                            <td className="p-1 border-r border-black">{item.batch}</td>
                            <td className="p-1 border-r border-black text-center">{item.expiry}</td>
                            <td className="p-1 border-r border-black text-center font-bold">
                                {formatPackLooseQuantity(item.quantity, item.looseQuantity, item.freeQuantity)}
                            </td>
                            {showRateColumn && <td className="p-1 border-r border-black text-right">{(item.billedRate || 0).toFixed(2)}</td>}
                            {showTradeDiscountColumn && <td className="p-1 border-r border-black text-right">{item.discountPercent || 0}</td>}
                            {showSchemeColumn && (
                              <td className="p-1 border-r border-black text-right">
                                {getDisplaySchemePercent(item) > 0 ? getDisplaySchemePercent(item).toFixed(2) : ''}
                              </td>
                            )}
                            {!isNonGst && <td className="p-1 border-r border-black text-right">{item.gstPercent}</td>}
                            <td className="p-1 text-right font-bold">{(item.finalAmount || 0).toFixed(2)}</td>
                        </tr>
                    ))}

                </tbody>
            </table>
        </div>

        <div className="border-x-2 border-b-2 border-black flex text-sm">
            <div className="w-2/3 flex flex-col border-r-2 border-black">
                <div className="p-2 border-b border-black flex-1">
                    <BankDetailsInline
                      bankName={companyBankName}
                      accountNumber={companyAccountNumber}
                      ifscCode={companyIfscCode}
                      className="text-[10px] text-gray-700 mb-1 leading-tight"
                    />
                    <p className="font-bold underline mb-1 text-xs">Amount In Words:</p>
                    <p className="capitalize italic font-medium">{numberToWords(billDetails.printGrandTotal || 0)}</p>
                </div>
                
                <div className="p-2 flex-1 flex justify-between items-start">
                    {bill.pharmacy.bank_upi_id && !isNonGst && (
                        <div className="text-center ml-2">
                             <img
                                src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(`upi://pay?pa=${bill.pharmacy.bank_upi_id}&pn=${encodeURIComponent(bill.pharmacy.pharmacy_name)}&am=${(billDetails.printGrandTotal || 0).toFixed(2)}&cu=INR`)}`}
                                alt="UPI QR"
                                className="w-20 h-20 border border-black p-0.5 rendering-pixelated"
                            />
                            <p className="text-[8px] font-bold mt-0.5">SCAN TO PAY</p>
                        </div>
                    )}
                </div>

                <div className="p-2 border-t border-black text-[10px]">
                    <p className="font-bold">Terms & Conditions:</p>
                    <ol className="list-decimal pl-3 space-y-0.5 text-gray-700">
                        {termsList.map((term, index) => (
                            <li key={index}>{term}</li>
                        ))}
                    </ol>
                </div>
            </div>
            
            <div className="w-1/3 flex flex-col">
                <div className="p-2 space-y-1 text-xs">
                    <div className="flex justify-between"><span>Total Amount (MRP):</span> <span className="font-bold">{(billDetails.subtotal || 0).toFixed(2)}</span></div>
                    {!isIncludingDiscountMode && billDetails.tradeDiscount > 0 && <div className="flex justify-between text-indigo-700"><span>Trade Discount (₹):</span> <span>-{(billDetails.tradeDiscount).toFixed(2)}</span></div>}
                    {billDetails.schemeDiscount > 0 && <div className="flex justify-between text-emerald-700"><span>Scheme Discount (₹):</span> <span>-{(billDetails.schemeDiscount).toFixed(2)}</span></div>}
                    {billDetails.billDiscount > 0 && <div className="flex justify-between text-green-700"><span>Less Bill Discount:</span> <span>-{(billDetails.billDiscount).toFixed(2)}</span></div>}
                    {!isNonGst && (
                        <>
                            <div className="flex justify-between"><span>Add CGST:</span> <span>{((billDetails.totalTaxFromBill || 0) / 2).toFixed(2)}</span></div>
                            <div className="flex justify-between"><span>Add SGST:</span> <span>{((billDetails.totalTaxFromBill || 0) / 2).toFixed(2)}</span></div>
                        </>
                    )}
                    <div className="flex justify-between"><span>Round Off:</span> <span>{(billDetails.roundOff || 0).toFixed(2)}</span></div>
                </div>
                
                <div className="border-t-2 border-black p-2 bg-gray-100">
                    <div className="flex justify-between text-lg font-extrabold text-[#2e3b84]">
                        <span>Grand Total:</span>
                        <span>₹ {(billDetails.printGrandTotal || 0).toFixed(2)}</span>
                    </div>
                </div>

                <div className="mt-auto p-2 pt-8 text-center">
                    <p className="font-bold text-xs mb-8 text-right pr-4">For {bill.pharmacy.pharmacy_name}</p>
                    <div className="flex justify-end">
                        <p className="text-[10px] border-t border-black inline-block px-4 font-semibold">Authorized Signatory</p>
                    </div>
                </div>
            </div>
        </div>
      </div>
      ))}
    </div>
  );
};

export default GftTemplate;
