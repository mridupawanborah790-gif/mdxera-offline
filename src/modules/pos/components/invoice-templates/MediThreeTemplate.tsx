import React, { useMemo } from 'react';
import type { AppConfigurations, DetailedBill, InventoryItem } from '@core/types';
import { numberToWords } from "@core/utils/numberToWords";
import { isRateFieldAvailable, resolveEffectivePricingMode, resolvePosLineAmountCalculationMode, getPrintGrandTotal } from "@core/utils/billing";
import { formatPackLooseQuantity } from "@core/utils/quantity";
import BankDetailsInline from './BankDetailsInline';

interface TemplateProps {
  bill: DetailedBill & { inventory?: InventoryItem[]; configurations: AppConfigurations };
  orientation?: 'portrait' | 'landscape';
}

const MAX_ITEMS_PER_PAGE = 16;  // intermediate pages
const MAX_ITEMS_LAST_PAGE = 10; // last page (shares space with footer)

const MediThreeTemplate: React.FC<TemplateProps> = ({ bill, orientation = 'portrait' }) => {
  const isNonGst = bill.billType === 'non-gst';
  const isLandscape = orientation === 'landscape';
  const companyPhone = String(bill.pharmacy.mobile || '-').trim().toUpperCase();
  const companyGstin = String(bill.pharmacy.gstin || '-').trim().toUpperCase();
  const companyDrugLicense = String((bill.pharmacy as any).drug_license || (bill.pharmacy as any).drugLicense || '-').trim().toUpperCase();
  const companyBankName = (bill.pharmacy as any).bank_account_name || (bill.pharmacy as any).bank_name;
  const companyAccountNumber = (bill.pharmacy as any).bank_account_number || (bill.pharmacy as any).account_number;
  const companyIfscCode = (bill.pharmacy as any).bank_ifsc_code || (bill.pharmacy as any).ifsc_code;
  const showRateColumn = isRateFieldAvailable(bill.configurations);
  const posLineAmountMode = resolvePosLineAmountCalculationMode(bill.configurations);
  const isIncludingDiscountMode = posLineAmountMode === 'including_discount';


  const calculations = useMemo(() => {
    const effectivePricingMode = resolveEffectivePricingMode(bill.pharmacy?.organization_type, bill.pricingMode, bill.configurations);

    const items = (bill.items || []).map((item, index) => {
      const inventoryItem = bill.inventory?.find(inv => inv.id === item.inventoryItemId);
      const unitsPerPack = item.unitsPerPack || 1;
      const billedQty = (item.quantity || 0) + ((item.looseQuantity || 0) / unitsPerPack);
      const rate = effectivePricingMode === 'mrp' ? (item.mrp ?? 0) : (item.rate ?? item.mrp ?? 0);
      const gross = billedQty * rate;
      const tradeDiscount = gross * ((item.discountPercent || 0) / 100);
      const flatDiscount = item.itemFlatDiscount || 0;
      const schemeDiscount = item.schemeDiscountAmount || 0;
      const lineAmount = isIncludingDiscountMode
        ? Math.max(0, gross - tradeDiscount - flatDiscount - schemeDiscount)
        : Math.max(0, gross);

      const gstPercent = isNonGst ? 0 : (item.gstPercent || 0);
      const isInclusive = effectivePricingMode === 'mrp';
      const taxable = isInclusive && gstPercent > 0 ? lineAmount / (1 + gstPercent / 100) : lineAmount;
      const gstAmount = isInclusive ? Math.max(0, lineAmount - taxable) : (taxable * (gstPercent / 100));

      return {
        ...item,
        sn: index + 1,
        manufacturer: item.manufacturer || inventoryItem?.manufacturer || '-',
        pack: item.packType || inventoryItem?.packType || item.unitOfMeasurement || (item.unitsPerPack ? `${item.unitsPerPack}` : '-'),
        hsn: item.hsnCode || inventoryItem?.hsnCode || '-',
        batch: item.batch || inventoryItem?.batch || '-',
        qtyText: formatPackLooseQuantity(item.quantity, item.looseQuantity, item.freeQuantity),
        expiry: item.expiry || (inventoryItem?.expiry ? new Date(inventoryItem.expiry).toLocaleDateString('en-GB', { month: '2-digit', year: '2-digit' }) : '-'),
        sgstRate: gstPercent / 2,
        cgstRate: gstPercent / 2,
        taxable,
        gstAmount,
        lineAmount,
        billedRate: rate
      };
    });

    return { items };
  }, [bill.items, bill.inventory, isNonGst, bill.pricingMode, bill.pharmacy?.organization_type, bill.configurations, isIncludingDiscountMode]);

  const totals = {
    subTotal: calculations.items.reduce((sum, item) => sum + item.lineAmount, 0),
    tradeDiscount: bill.totalItemDiscount || 0,
    discount: bill.schemeDiscount || 0,
    adjustment: bill.adjustment || 0,
    taxTotal: isNonGst ? 0 : (bill.totalGst || 0),
    grandTotal: bill.total || 0,
    printGrandTotal: getPrintGrandTotal(bill),
  };

  const paginatedItems = useMemo(() => {
    const items = calculations.items;
    const chunks: typeof items[] = [];
    let idx = 0;
    while (idx < items.length) {
      const remaining = items.length - idx;
      if (remaining <= MAX_ITEMS_LAST_PAGE) {
        chunks.push(items.slice(idx));
        break;
      }
      if (remaining - MAX_ITEMS_PER_PAGE > MAX_ITEMS_LAST_PAGE) {
        chunks.push(items.slice(idx, idx + MAX_ITEMS_PER_PAGE));
        idx += MAX_ITEMS_PER_PAGE;
      } else {
        const takeNow = remaining - MAX_ITEMS_LAST_PAGE;
        chunks.push(items.slice(idx, idx + takeNow));
        idx += takeNow;
      }
    }
    return chunks.length > 0 ? chunks : [[]];
  }, [calculations.items]);

  const columnWidths = isLandscape
    ? {
        sn: '3%',
        description: '24%',
        manufacturer: '10%',
        pack: '6%',
        hsn: '7%',
        batch: '7%',
        qty: '7%',
        mrp: '6%',
        rate: '6%',
        expiry: '6%',
        discount: '5%',
        sgst: '4%',
        cgst: '4%',
        amount: '5%',
      }
    : {
        sn: '3%',
        description: '18%',
        manufacturer: '8%',
        pack: '5%',
        hsn: '8%',
        batch: '8%',
        qty: '7%',
        mrp: '6%',
        rate: '6%',
        expiry: '6%',
        discount: '5%',
        sgst: '5%',
        cgst: '5%',
        amount: '10%',
      };

  return (
    <div className={`invoice-container medi-three-template text-black bg-white w-full font-sans text-[10.8px] leading-tight ${isLandscape ? 'medi-three-landscape' : 'medi-three-portrait'}`}>
      <style>{`
        .medi-three-template {
          display: flex;
          flex-direction: column;
          gap: 1.5mm;
          box-sizing: border-box;
          width: ${isLandscape ? '210mm' : '148mm'};
        }
        .medi-three-page {
          padding: 1.5mm;
          box-sizing: border-box;
          width: ${isLandscape ? '210mm' : '148mm'};
          height: auto;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        @media screen {
          .medi-three-page {
            min-height: ${isLandscape ? '148mm' : '210mm'};
            overflow: visible;
          }
        }
        .medi-three-box {
          border: 1px solid #111;
          --section-gap: 1.5mm;
          --header-height: ${isLandscape ? '38mm' : '62mm'};
          --items-height: ${isLandscape ? '75mm' : '106mm'};
          --footer-height: ${isLandscape ? '28mm' : '35mm'};
          --row-height: ${isLandscape ? '4mm' : '5.85mm'};
          display: grid;
          grid-template-rows: auto 1fr auto;
          row-gap: var(--section-gap);
          flex: 1;
          min-height: 0;
          box-sizing: border-box;
        }
        .medi-three-header {
          min-height: 0;
          overflow: visible;
        }
        .medi-three-items {
          min-height: 0;
          overflow: visible;
          display: flex;
          align-items: stretch;
        }
        .medi-three-grid {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
          height: auto;
          align-self: stretch;
          border-bottom: 1px solid #111;
        }
        .medi-three-grid th,
        .medi-three-grid td { border: 1px solid #111; padding: 1px 2px; vertical-align: middle; }
        .medi-three-grid thead th {
          font-size: 10.35px;
          font-weight: 700;
          text-transform: uppercase;
          background: #fff;
          white-space: normal;
        }
        .medi-three-grid tbody td {
          font-size: 10.2px;
          padding-top: 2.85px;
          padding-bottom: 2.85px;
          line-height: 1.15;
        }
        .medi-three-grid tbody {
          border-bottom: 1px solid #111;
        }
        .medi-three-grid tbody tr:last-child td,
        .medi-three-grid tbody tr:last-child th {
          border-bottom: 1px solid #111;
        }
        .medi-three-row,
        .medi-three-row-empty { height: var(--row-height); }
        .medi-three-row-empty td {
          color: transparent;
        }
        .medi-three-grid .right { text-align: right; }
        .medi-three-grid .center { text-align: center; }
        .medi-three-grid .left { text-align: left; }
        .medi-three-grid .num { font-size: 10.2px; }
        .medi-three-grid .desc { font-size: 10.2px; }
        .medi-three-grid .desc { white-space: nowrap; overflow: visible; text-overflow: ellipsis; }
        .medi-three-title { font-size: 21px; font-weight: 800; letter-spacing: 0.1em; text-align: center; padding: 3px 0 2px; }
        .medi-three-meta { display: grid; grid-template-columns: 1fr 1fr; }
        .medi-three-meta > div { border-top: 1px solid #111; padding: 3px 4px; min-height: 35px; }
        .medi-three-meta > div:first-child { border-right: 1px solid #111; }
        .medi-three-company { font-size: 11.25px; line-height: 1.25; }
        .medi-three-company-name { font-size: 12.75px; font-weight: 800; }
        .medi-three-company .invoice-meta { font-size: 11.25px; }
        .medi-three-customer { font-size: 10.8px; line-height: 1.25; }
        .medi-three-summary {
          border: 1px solid #111;
          display: grid;
          grid-template-columns: 1fr ${isLandscape ? '220px' : '190px'};
          height: auto;
          width: 100%;
          box-sizing: border-box;
          background: #fff;
        }
        .medi-three-footer {
          min-height: 0;
          display: flex;
          overflow: visible;
          align-items: stretch;
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .medi-three-footer > * {
          width: 100%;
        }
        .medi-three-summary-placeholder {
          border: 0;
          height: 100%;
        }
        .medi-three-summary-left { padding: 5px 4px; font-size: 10.8px; }
        .invoice-container { padding-bottom: 20px; min-height: 100%; height: auto; overflow: visible; }
        .invoice-bottom { display: flex; justify-content: space-between; align-items: flex-end; }
        .medi-three-bank-line { font-size: 9.4px; line-height: 1.2; margin-bottom: 3px; color: #333; }
        .medi-three-summary-right {
          padding: 5px 4px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 3px;
          border-left: 1px solid #111;
          background: #fff;
        }
        .medi-three-summary-right .row { display: flex; justify-content: space-between; margin-bottom: 0; font-size: 10.95px; }
        .medi-three-summary-right .grand { border-top: 1px solid #111; padding-top: 4px; margin-top: 2px; font-size: 17px; font-weight: 800; }
        @media print {
          .invoice-container { page-break-inside: avoid; break-inside: avoid; }
          .invoice-footer, .amount-in-words, .bank-details { page-break-inside: avoid; break-inside: avoid; }
          @page { size: A5 ${orientation}; margin: 0; }
          .medi-three-template { gap: 0; }
          .medi-three-page {
            margin: 0;
            break-after: page;
            page-break-after: always;
            break-inside: avoid;
            page-break-inside: avoid;
            overflow: hidden;
          }
          .medi-three-page:last-child {
            break-after: auto;
            page-break-after: auto;
          }
          .medi-three-grid thead { display: table-header-group; }
          .medi-three-grid tfoot { display: table-row-group; }
          .medi-three-row { break-inside: avoid; page-break-inside: avoid; }
          .medi-three-grid { width: 100%; }
          .medi-three-box {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .medi-three-items,
          .medi-three-grid,
          .medi-three-grid tbody,
          .medi-three-grid tbody tr:last-child td,
          .medi-three-footer,
          .medi-three-summary {
            break-inside: avoid;
            page-break-inside: avoid;
          }
        }

        @media screen {
          .medi-three-page {
            box-shadow: 0 0 0 1px #d6d6d6;
          }
        }
      `}</style>

      {paginatedItems.map((itemsOnPage, pageIndex) => {
        const isLastPage = pageIndex === paginatedItems.length - 1;
        const blankRows = Math.max(0, MAX_ITEMS_PER_PAGE - itemsOnPage.length);

        return (
          <div key={`page-${pageIndex + 1}`} className="medi-three-page">
            <div className="medi-three-box">
              <div className="medi-three-header">
                <div className="medi-three-title">GST INVOICE</div>

                <div className="medi-three-meta medi-three-company">
                  <div>
                    <div className="medi-three-company-name">{bill.pharmacy.pharmacy_name}</div>
                    <div>{bill.pharmacy.address}</div>
                    <div>PH: {companyPhone}</div>
                    <div>GSTIN: {companyGstin}</div>
                    <div>DL NO: {companyDrugLicense}</div>
                  </div>
                  <div className="invoice-meta">
                    <div><strong>Invoice No:</strong> {bill.invoiceNumber || bill.id}</div>
                    <div><strong>Invoice Date:</strong> {new Date(bill.date).toLocaleDateString('en-GB')}</div>
                    <div><strong>Terms:</strong> Cash</div>
                    <div><strong>Page:</strong> {pageIndex + 1} / {paginatedItems.length}</div>
                  </div>
                </div>

                <div className="medi-three-meta medi-three-customer" style={{ gridTemplateColumns: '1fr' }}>
                  <div style={{ borderRight: 0 }}>
                    <div><strong>Customer:</strong> {bill.customerName || 'Walk-in Customer'}</div>
                    <div><strong>Address:</strong> {bill.customerDetails?.address || '-'}</div>
                    <div><strong>Phone:</strong> {bill.customerDetails?.phone || bill.customerPhone || '-'}</div>
                    {bill.customerDetails?.gstNumber ? (
                      <div><strong>GSTIN:</strong> {bill.customerDetails.gstNumber}</div>
                    ) : bill.customerDetails?.panNumber ? (
                      <div><strong>PAN:</strong> {bill.customerDetails.panNumber}</div>
                    ) : null}
                    {bill.customerDetails?.drugLicense && (
                      <div><strong>DL NO:</strong> {bill.customerDetails.drugLicense}</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="medi-three-items">
                <table className="medi-three-grid">
                <thead>
                  <tr>
                    <th style={{ width: '3%' }}>S.N</th>
                    <th style={{ width: columnWidths.description }}>Product Description</th>
                    <th style={{ width: columnWidths.manufacturer }}>Mfr.</th>
                    <th style={{ width: columnWidths.pack }}>Pack</th>
                    <th style={{ width: columnWidths.hsn }}>HSN</th>
                    <th style={{ width: columnWidths.batch }}>Batch</th>
                    <th style={{ width: columnWidths.qty }}>Qty + Free</th>
                    <th style={{ width: columnWidths.mrp }}>MRP</th>
                    {showRateColumn && <th style={{ width: columnWidths.rate }}>Rate</th>}
                    <th style={{ width: columnWidths.expiry }}>Expiry</th>
                    <th style={{ width: columnWidths.discount }}>Disc%</th>
                    <th style={{ width: columnWidths.sgst }}>SGST</th>
                    <th style={{ width: columnWidths.cgst }}>CGST</th>
                    <th style={{ width: columnWidths.amount }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsOnPage.map(item => (
                    <tr key={item.id} className="medi-three-row">
                      <td className="center">{item.sn}</td>
                      <td className="left desc">{item.name}</td>
                      <td className="left">{item.manufacturer}</td>
                      <td className="center">{item.pack}</td>
                      <td className="center">{item.hsn}</td>
                      <td className="center">{item.batch}</td>
                      <td className="center">{item.qtyText}</td>
                      <td className="right num">{(item.mrp || 0).toFixed(2)}</td>
                      {showRateColumn && <td className="right num">{(item.billedRate || 0).toFixed(2)}</td>}
                      <td className="center">{item.expiry}</td>
                      <td className="center">{(item.discountPercent || 0).toFixed(2)}</td>
                      <td className="center num">{item.sgstRate.toFixed(2)}%</td>
                      <td className="center num">{item.cgstRate.toFixed(2)}%</td>
                      <td className="right num">{item.lineAmount.toFixed(2)}</td>
                    </tr>
                  ))}

                </tbody>
                </table>
              </div>

              <div className="medi-three-footer">
                {isLastPage ? (
                  <div className="invoice-footer medi-three-summary">
                    <div className="medi-three-summary-left amount-in-words">
                      <BankDetailsInline
                        bankName={companyBankName}
                        accountNumber={companyAccountNumber}
                        ifscCode={companyIfscCode}
                        className="bank-details medi-three-bank-line"
                      />
                      <div><strong>Amount in words:</strong> {numberToWords(totals.printGrandTotal)}</div>
                    </div>
                    <div className="invoice-bottom medi-three-summary-right">
                      <div className="row"><span>Sub Total</span><strong>{totals.subTotal.toFixed(2)}</strong></div>
                      {!isIncludingDiscountMode && totals.tradeDiscount > 0 && <div className="row"><span>Trade Discount</span><strong>-{totals.tradeDiscount.toFixed(2)}</strong></div>}
                      {totals.discount > 0 && <div className="row"><span>Discount</span><strong>-{totals.discount.toFixed(2)}</strong></div>}
                      <div className="row"><span>Tax Total</span><strong>{totals.taxTotal.toFixed(2)}</strong></div>
                      <div className="row grand"><span>Grand Total</span><span>{totals.printGrandTotal.toFixed(2)}</span></div>
                    </div>
                  </div>
                ) : (
                  <div className="medi-three-summary-placeholder" aria-hidden="true" />
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default MediThreeTemplate;
