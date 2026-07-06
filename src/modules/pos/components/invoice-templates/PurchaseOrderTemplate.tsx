
import React from 'react';
import type { PurchaseOrder, Distributor, RegisteredPharmacy } from '@core/types';
import { numberToWords } from "@core/utils/numberToWords";
import { useMemo } from 'react';
import { PurchaseOrderStatus } from '@core/types';

interface TemplateProps {
  purchaseOrder: PurchaseOrder & { distributor: Distributor };
  pharmacy: RegisteredPharmacy;
}

const ITEMS_PER_PAGE = 25;
const ROW_HEIGHT_PX = 32;

const PurchaseOrderTemplate: React.FC<TemplateProps> = ({ purchaseOrder, pharmacy }) => {
  const displayUppercase = (value?: string | null) => value?.toUpperCase() || '';
  const getFreeQty = (item: any): number => Number(item?.freeQuantity ?? item?.freeQty ?? item?.free_qty ?? 0);
  const formatQtyWithFree = (item: any): string => {
    const paidQty = Number(item?.quantity || 0);
    const freeQty = getFreeQty(item);
    return freeQty > 0 ? `${paidQty} + ${freeQty}` : `${paidQty}`;
  };
  const subtotal = purchaseOrder.totalAmount || 0;
  const totalGst = purchaseOrder.items.reduce((acc, item) => {
    const itemTotal = (Number(item.purchasePrice || 0)) * (item.quantity || 0);
    const gstAmount = itemTotal * ((Number(item.gstPercent || 0)) / 100);
    return acc + gstAmount;
  }, 0);
  const grandTotal = subtotal + totalGst;

  const isReceived = purchaseOrder.status === PurchaseOrderStatus.RECEIVED;

  const customTerms = pharmacy.purchase_order_terms
    ? pharmacy.purchase_order_terms.split('\n').filter(t => t.trim() !== '')
    : [
        'Please supply the items as per the quantities and rates specified.',
        'Items must have at least 12 months of remaining shelf life upon delivery.',
        'Any price discrepancy or stock unavailability must be reported within 24 hours.',
        'Goods should be accompanied by a proper Tax Invoice.'
      ];

  const itemChunks = useMemo(() => {
    const items = purchaseOrder.items;
    const total = items.length;
    const CAPACITY_NORMAL = 20;
    const CAPACITY_LAST = 12;

    if (total <= CAPACITY_LAST) {
      return [items];
    }

    const chunks: Array<typeof purchaseOrder.items> = [];
    let currentIndex = 0;

    while (currentIndex < total) {
      const remaining = total - currentIndex;
      if (remaining <= CAPACITY_LAST) {
        chunks.push(items.slice(currentIndex));
        break;
      }

      let chunkSize = CAPACITY_NORMAL;
      if (remaining > CAPACITY_LAST && remaining <= CAPACITY_NORMAL) {
        // Split so the next (last) page doesn't exceed CAPACITY_LAST
        chunkSize = 10;
      }

      chunks.push(items.slice(currentIndex, currentIndex + chunkSize));
      currentIndex += chunkSize;
    }

    return chunks.length > 0 ? chunks : [[]];
  }, [purchaseOrder.items]);

  return (
    <div className="text-gray-800 font-sans bg-white w-full">
      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 0 !important;
          }
          .po-page {
            height: 297mm;
            box-sizing: border-box;
            padding: 6mm;
            display: flex;
            flex-direction: column;
            break-after: page;
            page-break-after: always;
          }
          .po-page:last-of-type {
            break-after: auto;
            page-break-after: auto;
          }
          .po-page table,
          .po-page tr,
          .po-page td,
          .po-page th {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .po-items-table {
            table-layout: fixed;
            width: 100%;
            border-collapse: collapse;
          }
          .po-items-table thead {
            display: table-header-group;
          }
          .po-row {
            height: ${ROW_HEIGHT_PX}px;
            min-height: ${ROW_HEIGHT_PX}px;
            max-height: ${ROW_HEIGHT_PX}px;
          }
          .po-items-wrapper {
            flex: 1;
            display: flex;
            flex-direction: column;
          }
          .po-last-page-footer {
            margin-top: 8px;
          }
          #print-area {
            padding: 0 !important;
            margin: 0 !important;
          }
        }
        .uppercase-text {
          text-transform: uppercase;
        }
      `}</style>

      {itemChunks.map((chunk, pageIndex) => {
        const isLastPage = pageIndex === itemChunks.length - 1;
        const pageCapacity = isLastPage ? 12 : 20;
        const fillerRows = isLastPage ? 0 : Math.max(0, pageCapacity - chunk.length);
        return (
          <div key={pageIndex} className="po-page mb-6 print:mb-0">
            <header className="mb-3 pt-1">
              <div className="grid grid-cols-2 gap-3 items-stretch">
                <div className="flex flex-col justify-between min-h-[98px] border border-gray-200 rounded-md p-2.5">
                  {pharmacy.pharmacy_logo_url && (
                    <img src={pharmacy.pharmacy_logo_url} alt="Logo" className="h-10 w-auto max-h-10 object-contain mb-1" />
                  )}
                  <h1 className="text-lg font-bold text-blue-700 leading-tight uppercase-text">{displayUppercase(pharmacy.pharmacy_name)}</h1>
                  <div className="text-[11px] text-gray-600 space-y-0 mt-1">
                    <p>Ph: <span className="font-semibold text-gray-800">{pharmacy.mobile}</span></p>
                    {pharmacy.email && <p>Email: {pharmacy.email}</p>}
                    <p>GSTIN: <span className="font-semibold text-gray-800 uppercase-text">{displayUppercase(pharmacy.gstin)}</span></p>
                  </div>
                </div>
                <div className="border border-gray-200 rounded-md p-2.5 min-h-[98px] flex flex-col justify-between">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-2xl font-black tracking-tight text-gray-900 leading-none">PURCHASE ORDER</h2>
                    <div className="text-[10px] text-gray-500 whitespace-nowrap pt-0.5">Page {pageIndex + 1} of {itemChunks.length}</div>
                  </div>
                  <div className="text-xs bg-gray-50 p-2 rounded-md border border-gray-200 text-left">
                    <p className="flex justify-between"><strong>PO Number:</strong> <span className="font-mono ml-4">{purchaseOrder.serialId}</span></p>
                    <p className="flex justify-between"><strong>Date:</strong> <span className="ml-4">{new Date(purchaseOrder.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span></p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-2 mb-2 text-xs items-stretch">
                <div className="border border-blue-200 bg-blue-50/50 p-2.5 rounded-md min-h-[92px]">
                  <h3 className="text-[10px] font-bold text-blue-800 uppercase tracking-widest mb-0.5">Vendor / Supplier</h3>
                  <p className="font-bold text-gray-900 text-sm uppercase-text leading-tight">{displayUppercase(purchaseOrder.distributorName)}</p>
                  {purchaseOrder.distributor.address && <p className="text-[11px] text-gray-600 mt-0.5 line-clamp-2 uppercase-text leading-snug">{displayUppercase(purchaseOrder.distributor.address)}</p>}
                  {purchaseOrder.distributor.gst_number && <p className="text-[11px] font-medium text-gray-700 mt-0.5 uppercase-text">GSTIN: {displayUppercase(purchaseOrder.distributor.gst_number)}</p>}
                </div>
                <div className="border border-green-200 bg-green-50/50 p-2.5 rounded-md min-h-[92px]">
                  <h3 className="text-[10px] font-bold text-green-800 uppercase tracking-widest mb-0.5">Ship To / Deliver To</h3>
                  <p className="font-bold text-gray-900 text-sm uppercase-text leading-tight">{displayUppercase(pharmacy.pharmacy_name)}</p>
                  <p className="text-[11px] text-gray-600 mt-0.5 line-clamp-2 uppercase-text leading-snug">{displayUppercase(pharmacy.address)}</p>
                </div>
              </div>
            </header>

            <div className="po-items-wrapper">
              <table className="po-items-table w-full text-[11px] border-collapse mt-1">
                <thead className="bg-gray-800 text-white">
                  <tr>
                    <th className="py-1.5 px-1.5 text-center font-bold w-10 border border-gray-700">SL No</th>
                    <th className="py-1.5 px-1.5 text-center font-bold w-16 border border-gray-700">Qty + F</th>
                    <th className="py-1.5 px-2 text-left font-bold border border-gray-700">Item Description</th>
                    <th className="py-1.5 px-1.5 text-center font-bold w-14 border border-gray-700">HSN</th>
                    <th className="py-1.5 px-1.5 text-center font-bold w-12 border border-gray-700">Pack</th>
                    <th className="py-1.5 px-1.5 text-right font-bold w-16 border border-gray-700">Rate</th>
                    <th className="py-1.5 px-1.5 text-right font-bold w-16 border border-gray-700">MRP</th>
                    <th className="py-1.5 px-1.5 text-center font-bold w-10 border border-gray-700">GST%</th>
                    <th className="py-1.5 px-1.5 text-right font-bold w-20 border border-gray-700">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const startIndex = itemChunks.slice(0, pageIndex).reduce((acc, c) => acc + c.length, 0);
                    return chunk.map((item, index) => {
                      const itemTotal = (Number(item.purchasePrice || 0)) * (item.quantity || 0);
                      const actualIndex = startIndex + index + 1;
                      return (
                        <tr key={item.id} className="po-row border-b border-gray-300">
                          <td className="py-1 px-1.5 border-x border-gray-300 text-center align-middle">{actualIndex}</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 text-center font-semibold align-middle">{formatQtyWithFree(item)}</td>
                          <td className="py-1 px-2 border-r border-gray-300 align-middle">
                            <p className="font-semibold text-gray-900 leading-tight">{item.name}</p>
                          </td>
                          <td className="py-1 px-1.5 border-r border-gray-300 text-center align-middle">{item.hsnCode || '-'}</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 text-center align-middle">{item.packType || item.unitOfMeasurement || '—'}</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 text-right align-middle">₹{Number(item.purchasePrice || 0).toFixed(2)}</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 text-right align-middle">₹{Number(item.mrp || 0).toFixed(2)}</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 text-center align-middle">{Number(item.gstPercent || 0)}%</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 text-right font-bold text-gray-900 align-middle">₹{Number(itemTotal || 0).toFixed(2)}</td>
                        </tr>
                      );
                    });
                  })()}

                  {(() => {
                    const startIndex = itemChunks.slice(0, pageIndex).reduce((acc, c) => acc + c.length, 0);
                    return Array.from({ length: fillerRows }).map((_, fillerIndex) => {
                      const serial = startIndex + chunk.length + fillerIndex + 1;
                      return (
                        <tr key={`filler-${pageIndex}-${fillerIndex}`} className="po-row border-b border-gray-300">
                          <td className="py-1 px-1.5 border-x border-gray-300 text-center align-middle text-gray-300">{serial}</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 align-middle">&nbsp;</td>
                          <td className="py-1 px-2 border-r border-gray-300 align-middle">&nbsp;</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 align-middle">&nbsp;</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 align-middle">&nbsp;</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 align-middle">&nbsp;</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 align-middle">&nbsp;</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 align-middle">&nbsp;</td>
                          <td className="py-1 px-1.5 border-r border-gray-300 align-middle">&nbsp;</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>

            {isLastPage && (
              <div className="po-last-page-footer mt-3 pt-3 border-t-2 border-gray-200">
                <div className="flex justify-between items-start">
                  <div className="w-7/12">
                    {isReceived && purchaseOrder.remarks && (
                      <div className="mb-6 p-3 bg-green-50 border-l-4 border-green-500 rounded-r-lg">
                          <p className="text-[10px] font-black text-green-800 uppercase tracking-widest mb-1">Receipt / Closure Remarks</p>
                          <p className="text-sm font-medium text-gray-800 leading-snug">{purchaseOrder.remarks}</p>
                      </div>
                    )}

                    <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                      <p className="text-[10px] font-bold text-gray-500 uppercase mb-1">Total Amount in Words</p>
                      <p className="text-sm font-bold text-gray-800 italic leading-snug">{numberToWords(grandTotal || 0)}</p>
                    </div>

                    <div className="mt-6">
                      <h3 className="text-xs font-bold text-gray-700 uppercase mb-1 underline">Terms & Instructions</h3>
                      <ul className="text-[10px] text-gray-600 list-disc list-inside space-y-1">
                        {customTerms.map((term, i) => (
                          <li key={i}>{term}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="w-4/12">
                    <div className="bg-blue-50/30 p-4 rounded-xl border-2 border-blue-100 space-y-2.5">
                      <div className="flex justify-between text-xs font-medium text-gray-600">
                        <span>Subtotal</span>
                        <span>₹{Number(subtotal || 0).toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-xs font-medium text-gray-600 pb-2 border-b border-blue-100">
                        <span>GST (Estimated)</span>
                        <span>₹{Number(totalGst || 0).toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between items-center text-lg font-black text-blue-900 pt-1">
                        <span>TOTAL</span>
                        <span>₹{Number(grandTotal || 0).toFixed(2)}</span>
                      </div>
                    </div>

                    <div className="mt-12 text-center">
                      <div className="h-16 flex items-end justify-center">
                        <div className="border-b-2 border-gray-400 w-3/4 mx-auto"></div>
                      </div>
                      <p className="mt-2 text-xs font-bold text-gray-900 uppercase">{pharmacy.full_name}</p>
                      <p className="text-[10px] text-gray-500 font-medium">Authorized Signatory</p>
                    </div>
                  </div>
                </div>

                <div className="mt-12 text-center text-[9px] text-gray-400 border-t border-gray-100 pt-4">
                  <p>This is a computer generated Purchase Order from <strong>MDXERA Retail ERP</strong>. E.&O.E.</p>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PurchaseOrderTemplate;
