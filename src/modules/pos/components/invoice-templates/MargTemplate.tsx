import React, { useMemo, useRef, useState, useLayoutEffect, useCallback } from 'react';
import type { DetailedBill, InventoryItem, AppConfigurations } from '@core/types';
import { numberToWords } from "@core/utils/numberToWords";
import {
  getDisplaySchemePercent,
  hasLineLevelSchemeDiscount,
  isRateFieldAvailable,
  resolveEffectivePricingMode,
  resolvePosLineAmountCalculationMode,
  getPrintGrandTotal,
} from "@core/utils/billing";

import { calculateCustomerReceivableBreakdown } from "@core/utils/helpers";
import { formatPackLooseQuantity } from "@core/utils/quantity";
import BankDetailsInline from './BankDetailsInline';

interface TemplateProps {
  bill: DetailedBill & { inventory?: InventoryItem[]; configurations: AppConfigurations };
  orientation?: 'portrait' | 'landscape';
}

// ─── mm → px conversion (96 dpi screen, 25.4 mm/inch) ───────────────────────
const MM_TO_PX = 96 / 25.4;
function mmToPx(mm: number) { return mm * MM_TO_PX; }

// ─── Page physical dimensions ─────────────────────────────────────────────────
const PAGE_DIMS = {
  portrait:  { wMm: 148, hMm: 210 },
  landscape: { wMm: 210, hMm: 148 },
};
const PAGE_PADDING_MM = 4; // 4 mm all sides

// ─────────────────────────────────────────────────────────────────────────────
// Greedy chunker — purely index-based, caps supplied externally
// ─────────────────────────────────────────────────────────────────────────────
function chunkByCapacity(
  totalItems: number,
  regularCap: number,
  lastCap: number,
): number[][] {
  if (totalItems === 0) return [[]];

  const pages: number[][] = [];
  let start = 0;

  while (start < totalItems) {
    const remaining = totalItems - start;

    // Everything remaining fits on the final page (with full last-page footer)
    if (remaining <= lastCap) {
      pages.push(Array.from({ length: remaining }, (_, i) => start + i));
      break;
    }

    // remaining > lastCap from here — need at least one more page before the last
    const afterFull = remaining - regularCap;

    if (afterFull <= 0) {
      // All items fit on a regular page (small continuation footer) but NOT on the
      // last page (large footer). Fill page 1 as much as possible so it looks full;
      // the last page gets only what remains (minimum 1 item).
      const firstCount = remaining - 1;
      pages.push(Array.from({ length: firstCount }, (_, i) => start + i));
      start += firstCount;
      pages.push(Array.from({ length: 1 }, (_, i) => start + i));
      break;
    }

    if (afterFull <= lastCap) {
      // Fill this page fully, the tail goes on the last page
      pages.push(Array.from({ length: regularCap }, (_, i) => start + i));
      start += regularCap;
      pages.push(Array.from({ length: afterFull }, (_, i) => start + i));
      break;
    }

    // More items remain than can fit on two pages; fill and continue
    pages.push(Array.from({ length: regularCap }, (_, i) => start + i));
    start += regularCap;
  }

  return pages;
}

// ─────────────────────────────────────────────────────────────────────────────
// MargTemplate
// ─────────────────────────────────────────────────────────────────────────────
const MargTemplate: React.FC<TemplateProps> = ({ bill, orientation = 'portrait' }) => {
  const isNonGst    = bill.billType === 'non-gst';
  const isLandscape = orientation === 'landscape';

  const displayOptions          = bill.configurations?.displayOptions || {};
  const showBillDiscount        = displayOptions.showBillDiscountOnPrint !== false;
  const isMode8                 = displayOptions.calculationMode === '8';
  const showItemWiseDisc        = displayOptions.showItemWiseDiscountOnPrint !== false;
  const showTradeDiscountColumn = showItemWiseDisc && (bill.items || []).some(item => (item.discountPercent || 0) > 0);
  const showSchemeColumn        = (bill.items || []).some(item => hasLineLevelSchemeDiscount(item));
  const showRateColumn          = isRateFieldAvailable(bill.configurations);
  const posLineAmountMode       = resolvePosLineAmountCalculationMode(bill.configurations);
  const isIncludingDiscountMode = posLineAmountMode === 'including_discount';

  // ── Pre-compute all item data ──────────────────────────────────────────────
  const { items, gstSummary, subtotalValue, totalGst, roundOff, grandTotal, printGrandTotal, hasFkPrice,
          tradeDiscount, schemeDiscount, billDiscount, adjustment, taxableValue, printSubtotal, printTaxAmount } = useMemo(() => {
    let subtotalValue = 0;
    let totalSgst = 0;
    let totalCgst = 0;

    const effectivePricingMode = resolveEffectivePricingMode(
      bill.pharmacy?.organization_type,
      bill.pricingMode,
      bill.configurations,
    );

    const items = (bill.items || []).map(item => {
      const inventoryItem = bill.inventory?.find(inv => inv.id === item.inventoryItemId);

      const rate         = effectivePricingMode === 'mrp' ? (item.mrp ?? 0) : (item.rate ?? item.mrp ?? 0);
      const unitsPerPack = item.unitsPerPack || 1;
      const billedQty    = (item.quantity || 0) + ((item.looseQuantity || 0) / unitsPerPack);

      // Display rate and gross in the line items
      const displayRate = rate;
      const displayGross = billedQty * displayRate;
      const displayTradeDisc = displayGross * ((item.discountPercent || 0) / 100);
      const displayLineFlat = item.itemFlatDiscount || 0;
      const displaySchemeDis = item.schemeDiscountAmount || 0;
      const displayAmount = isIncludingDiscountMode
        ? Math.max(0, displayGross - displayTradeDisc - displaySchemeDis - displayLineFlat)
        : Math.max(0, displayGross);

      // If an FK price was applied at billing time, use it for calculations
      const fkRate       = item.fk_price_applied != null ? Number(item.fk_price_applied) : null;
      const effectiveRate = fkRate != null ? fkRate : rate;

      const itemGross    = billedQty * effectiveRate;
      const tradeDisc    = itemGross * ((item.discountPercent || 0) / 100);
      const lineFlat     = item.itemFlatDiscount || 0;
      const schemeDis    = item.schemeDiscountAmount || 0;

      const lineAmount = isIncludingDiscountMode
        ? Math.max(0, itemGross - tradeDisc - schemeDis - lineFlat)
        : Math.max(0, itemGross);

      const effectiveGst = isNonGst ? 0 : (item.gstPercent || 0);
      const isInclusive  = effectivePricingMode === 'mrp';

      const taxableVal = isInclusive && effectiveGst > 0
        ? lineAmount / (1 + effectiveGst / 100) : lineAmount;
      const gstAmt = isInclusive
        ? lineAmount - taxableVal
        : taxableVal * (effectiveGst / 100);

      subtotalValue += lineAmount;
      totalSgst     += gstAmt / 2;
      totalCgst     += gstAmt / 2;

      return {
        ...item,
        hsn: item.hsnCode || inventoryItem?.hsnCode || '',
        pack: item.packType || inventoryItem?.packType || item.unitOfMeasurement || (item.unitsPerPack ? `${item.unitsPerPack}` : ''),
        batch: item.batch || inventoryItem?.batch || '',
        expiry: item.expiry || (inventoryItem?.expiry
          ? new Date(inventoryItem.expiry).toLocaleDateString('en-GB', { month: '2-digit', year: '2-digit' })
          : ''),
        billedQty, 
        billedRate: displayRate,
        displayAmount: displayAmount,
        displayQty: formatPackLooseQuantity(item.quantity, item.looseQuantity, item.freeQuantity),
        taxableVal, gstAmt, lineTotal: lineAmount,
        displayName: (() => {
          const p = item.packType?.trim() || inventoryItem?.packType?.trim() || '';
          return p ? `${item.name} (${p})` : item.name;
        })(),
      };
    });

    const gstSummary: Record<number, { taxable: number; sgst: number; cgst: number }> = {};
    items.forEach(item => {
      const r = item.gstPercent || 0;
      if (!gstSummary[r]) gstSummary[r] = { taxable: 0, sgst: 0, cgst: 0 };
      gstSummary[r].taxable += item.taxableVal;
      gstSummary[r].sgst    += item.gstAmt / 2;
      gstSummary[r].cgst    += item.gstAmt / 2;
    });

    const tradeDiscount  = bill.totalItemDiscount || 0;
    const billDiscount   = showBillDiscount ? (bill.schemeDiscount || 0) : 0;
    const taxableValue   = Math.max(0, (bill.total || 0) - (bill.totalGst || 0) - (bill.roundOff || 0));
    const totalGst       = isNonGst ? 0 : (bill.totalGst || 0);
    const roundOff       = bill.roundOff || 0;
    const adjustment     = bill.adjustment || 0;
    const grandTotal     = bill.total || 0;
    const schemeDiscount = (bill.items || []).reduce((s, it) => s + Number(it.schemeDiscountAmount || 0), 0);

    // FK Price: when FK rate is active, recompute sub-total and tax from FK rate so
    // the entire summary section is consistent with the printed grand total.
    const hasFkPrice = (bill.items || []).some((it: any) => it.fk_price_applied != null);
    const printGrandTotal = getPrintGrandTotal(bill);

    let printSubtotal = subtotalValue;
    let printTaxAmount = totalGst;
    if (hasFkPrice && !isNonGst) {
      let fkTaxable = 0;
      let fkGst = 0;
      items.forEach((it: any) => {
        fkTaxable += it.taxableVal;
        fkGst += it.gstAmt;
      });
      printSubtotal = fkTaxable;
      printTaxAmount = fkGst;
    }

    return { items, gstSummary, subtotalValue, totalSgst, totalCgst,
             tradeDiscount, schemeDiscount, billDiscount, adjustment,
             taxableValue, totalGst, roundOff, grandTotal, printGrandTotal, hasFkPrice,
             printSubtotal, printTaxAmount };
  }, [bill, isNonGst, showBillDiscount, isIncludingDiscountMode]);


  // ── Address helpers ────────────────────────────────────────────────────────
  const toUpper = (v?: string | null) => (v || '').toString().trim().toUpperCase();

  const customerAddressLine1 = toUpper(bill.customerDetails?.address_line1 || bill.customerDetails?.address);
  const customerDistrict     = toUpper(bill.customerDetails?.district);
  const customerState        = toUpper(bill.customerDetails?.state);
  const customerPincode      = toUpper(bill.customerDetails?.pincode);
  const customerAddressParts = [customerAddressLine1, customerDistrict, customerState].filter(Boolean);
  const customerAddressCompact = customerAddressParts.length > 0
    ? `${customerAddressParts.join(', ')}${customerPincode ? ` - ${customerPincode}` : ''}`
    : customerPincode || '';

  const customerPhone       = toUpper(bill.customerPhone || bill.customerDetails?.phone);
  const customerGstin       = toUpper(bill.customerDetails?.gstNumber);
  const customerDrugLicense = toUpper(bill.customerDetails?.drugLicense);
  const companyPhone        = toUpper(bill.pharmacy.mobile || '-');
  const companyGstin        = toUpper(bill.pharmacy.gstin || '-');
  const companyDrugLicense  = toUpper((bill.pharmacy as any).drug_license || (bill.pharmacy as any).drugLicense || '-');
  const companyBankName      = (bill.pharmacy as any).bank_account_name || (bill.pharmacy as any).bank_name;
  const companyAccountNumber = (bill.pharmacy as any).bank_account_number || (bill.pharmacy as any).account_number;
  const companyIfscCode      = (bill.pharmacy as any).bank_ifsc_code || (bill.pharmacy as any).ifsc_code;

  // ── Balance ────────────────────────────────────────────────────────────────
  const isCreditBill           = String(bill.paymentMode || '').trim().toLowerCase() === 'credit';
  const hasSelectedCustomer    = Boolean(bill.customerDetails?.id);
  const netOutstanding         = hasSelectedCustomer
    ? calculateCustomerReceivableBreakdown(bill.customerDetails).netOutstanding : 0;
  const capturedPrev           = Number(bill.previousBalanceBeforeBill);
  const hasCapturedPrev        = Number.isFinite(capturedPrev);
  const previousBalance = hasSelectedCustomer
    ? hasCapturedPrev ? capturedPrev
      : isCreditBill ? netOutstanding - grandTotal : netOutstanding
    : 0;
  const balanceAfterBill = hasSelectedCustomer
    ? isCreditBill ? Number((previousBalance + grandTotal).toFixed(2))
      : Number(previousBalance.toFixed(2))
    : 0;

  // ── Page dimensions ────────────────────────────────────────────────────────
  const dims  = PAGE_DIMS[isLandscape ? 'landscape' : 'portrait'];
  const pageW = isLandscape ? '210mm' : '148mm';
  const pageH = isLandscape ? '148mm' : '210mm';
  const pageHPx = mmToPx(dims.hMm);
  const pagePadPx = mmToPx(PAGE_PADDING_MM) * 2; // top + bottom

  // ── Phase 1: measure refs ─────────────────────────────────────────────────
  const probeRef      = useRef<HTMLDivElement>(null);
  const probeHeadRef  = useRef<HTMLDivElement>(null);
  const probeFootRef  = useRef<HTMLDivElement>(null);
  const probeCFRef    = useRef<HTMLDivElement>(null);
  const probeTheadRef = useRef<HTMLTableSectionElement>(null);
  const probeTbodyRef = useRef<HTMLTableSectionElement>(null);

  const [caps, setCaps] = useState<{ regular: number; last: number } | null>(null);

  const measure = useCallback(() => {
    const probe      = probeRef.current;
    const head       = probeHeadRef.current;
    const foot       = probeFootRef.current;
    const cfoot      = probeCFRef.current;
    const thead      = probeTheadRef.current;
    const tbody      = probeTbodyRef.current;

    if (!probe || !head || !foot || !cfoot || !thead || !tbody) return;

    const availH     = pageHPx - pagePadPx;

    const headH      = head.getBoundingClientRect().height;
    const theadH     = thead.getBoundingClientRect().height;
    const footH      = foot.getBoundingClientRect().height;
    const cfootH     = cfoot.getBoundingClientRect().height;

    const rows = Array.from(tbody.rows);
    const rowH = rows.length > 0
      ? rows.reduce((s, r) => s + r.getBoundingClientRect().height, 0) / rows.length
      : 14;

    const bodyAvailRegular = availH - headH - theadH - cfootH;
    const bodyAvailLast    = availH - headH - theadH - footH;

    const regularCap = Math.max(1, Math.floor(bodyAvailRegular / rowH));
    const lastCap    = Math.max(1, Math.floor(bodyAvailLast    / rowH));

    setCaps({ regular: regularCap, last: lastCap });
  }, [pageHPx, pagePadPx]);

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => { measure(); });
    return () => cancelAnimationFrame(id);
  }, [measure, orientation, bill]);

  // ── Phase 2: chunk using measured caps ───────────────────────────────────
  const pages = useMemo(() => {
    if (!caps) return null;
    const indices = chunkByCapacity(items.length, caps.regular, caps.last);
    return indices.map(idxArr => idxArr.map(i => items[i]));
  }, [caps, items]);

  // ── Column divider positions for the spacer ──────────────────────────────
  // Mirrors the exact column widths from TableHeader so lines stay aligned.
  // Uses actual border elements (not background-image) so lines print correctly.
  const colDividerPositions = useMemo(() => {
    const rawWidths = [
      4, 10, 23, 8, 7, 9, 7, 8,
      ...(showRateColumn          ? [8] : []),
      ...(showTradeDiscountColumn ? [5] : []),
      ...(showSchemeColumn        ? [5] : []),
      5, 11,
    ];
    const total = rawWidths.reduce((a, b) => a + b, 0);
    const positions: number[] = [];
    let pct = 0;
    for (let i = 0; i < rawWidths.length - 1; i++) {
      pct += (rawWidths[i] / total) * 100;
      positions.push(pct);
    }
    return positions;
  }, [showRateColumn, showTradeDiscountColumn, showSchemeColumn]);

  // ── Shared CSS ─────────────────────────────────────────────────────────────
  const sharedStyles = `
    @media print {
      @page { margin: 0mm !important; size: ${pageW} ${pageH}; }
      body  { margin: 0; padding: 0; }
      .marg-page {
        width: ${pageW}; height: ${pageH};
        padding: ${PAGE_PADDING_MM}mm !important;
        box-sizing: border-box;
        display: flex !important; flex-direction: column !important;
        overflow: hidden; background: white !important;
        page-break-after: always; break-after: always;
        page-break-inside: avoid; break-inside: avoid;
      }
      .marg-page:last-child { page-break-after: auto; break-after: auto; }
      .marg-items-wrapper { flex: 0 0 auto !important; overflow: hidden !important; }
      .marg-spacer        { flex: 1 1 0 !important; min-height: 0 !important; }
      .marg-header              { flex-shrink: 0; }
      .invoice-footer-block     { flex-shrink: 0; page-break-inside: avoid; break-inside: avoid; }
      .marg-continuation-footer { flex-shrink: 0; }
      .invoice-items tr         { page-break-inside: avoid; break-inside: avoid; }
    }
    @media screen {
      .marg-page {
        width: ${pageW}; min-height: ${pageH};
        padding: ${PAGE_PADDING_MM}mm;
        background: white; box-shadow: 0 2px 8px rgba(0,0,0,.12);
        margin-bottom: 12px; box-sizing: border-box;
        display: flex; flex-direction: column;
      }
      .marg-items-wrapper { flex: 0 0 auto; }
      .marg-spacer        { flex: 1 1 0; }
    }
    /* Probe page: invisible but still laid out so measurements are accurate */
    .marg-probe {
      position: fixed; top: 0; left: -9999px;
      width: ${pageW};
      height: ${pageH};
      padding: ${PAGE_PADDING_MM}mm;
      box-sizing: border-box;
      display: flex; flex-direction: column;
      visibility: hidden; pointer-events: none; z-index: -1;
      overflow: hidden;
    }
    .erp-table { border: 1px solid black; border-collapse: collapse; }
    .erp-table th { border: 1px solid black; padding: 1px 3px; font-weight: 600; font-size: 7.5pt; }
    .erp-table td { border-left: 1px solid black; border-right: 1px solid black; padding: 1px 3px; font-size: 8pt; font-weight: 500; }
    .invoice-items {
      width: 100%; table-layout: fixed; border-collapse: collapse;
      border-top: 1px solid #000; border-left: 1px solid #000; border-right: 1px solid #000; border-bottom: none;
    }
    .invoice-items thead tr { background: #f3f4f6; }
    .invoice-items thead th {
      border: none; border-bottom: 1.5px solid #000; border-right: 1px solid #d1d5db;
      padding: 2px 3px; font-size: 7pt; font-weight: 600; line-height: 1.15;
      vertical-align: middle; white-space: nowrap;
    }
    .invoice-items thead th:last-child { border-right: none; }
    .invoice-items tbody td {
      border: none !important; border-right: 1px solid #d1d5db !important;
      padding: 1.5px 3px; font-size: 8pt; font-weight: 400; line-height: 1.2;
      vertical-align: middle; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .invoice-items tbody td:last-child { border-right: none !important; }
    .invoice-items tbody tr { background: white; }
    .footer-border { border: 1px solid black; }
    .invoice-bottom { display: flex; justify-content: space-between; align-items: flex-end; }
    .invoice-header-right { width: 100%; display: flex; justify-content: flex-end; }
    .invoice-meta { display: flex; justify-content: flex-end; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  `;

  // ── Sub-components ─────────────────────────────────────────────────────────
  const TableHeader = () => (
    <tr>
      <th style={{ width: '4%',  textAlign: 'center' }}>#</th>
      <th style={{ width: '10%', textAlign: 'center' }}>QTY+F</th>
      <th style={{ width: '23%', textAlign: 'left'   }}>DESCRIPTION</th>
      <th style={{ width: '8%',  textAlign: 'center' }}>HSN</th>
      <th style={{ width: '7%',  textAlign: 'center' }}>PACK</th>
      <th style={{ width: '9%',  textAlign: 'center' }}>BATCH</th>
      <th style={{ width: '7%',  textAlign: 'center' }}>EXP.</th>
      <th style={{ width: '8%',  textAlign: 'right'  }}>M.R.P</th>
      {showRateColumn          && <th style={{ width: '8%', textAlign: 'right'  }}>RATE</th>}
      {showTradeDiscountColumn && <th style={{ width: '5%', textAlign: 'center' }}>D%</th>}
      {showSchemeColumn        && <th style={{ width: '5%', textAlign: 'center' }}>SCH%</th>}
      <th style={{ width: '5%',  textAlign: 'center' }}>GST%</th>
      <th style={{ width: '11%', textAlign: 'right'  }}>AMOUNT</th>
    </tr>
  );

  const ItemRow = ({ item, serial }: { item: (typeof items)[0]; serial: number }) => (
    <tr key={item.id}>
      <td style={{ textAlign: 'center' }}>{serial}</td>
      <td style={{ textAlign: 'center' }}>{item.displayQty}</td>
      <td style={{ textTransform: 'uppercase', color: '#111827', maxWidth: 0 }}>{item.displayName}</td>
      <td style={{ textAlign: 'center' }}>{item.hsn}</td>
      <td style={{ textAlign: 'center', fontSize: '7pt' }}>{item.pack}</td>
      <td style={{ textAlign: 'center' }}>{item.batch}</td>
      <td style={{ textAlign: 'center', fontSize: '7pt' }}>{item.expiry}</td>
      <td style={{ textAlign: 'right' }}>{(item.mrp || 0).toFixed(2)}</td>
      {showRateColumn          && <td style={{ textAlign: 'right',  color: '#1e40af' }}>{(item.billedRate || 0).toFixed(2)}</td>}
      {showTradeDiscountColumn && <td style={{ textAlign: 'center', color: '#dc2626' }}>{item.discountPercent || '0'}</td>}
      {showSchemeColumn        && <td style={{ textAlign: 'center', color: '#059669' }}>{getDisplaySchemePercent(item) > 0 ? getDisplaySchemePercent(item).toFixed(2) : ''}</td>}
      <td style={{ textAlign: 'center' }}>{(item.gstPercent || 0).toFixed(0)}</td>
      <td style={{ textAlign: 'right', color: '#111827' }}>{(item.displayAmount || 0).toFixed(2)}</td>
    </tr>
  );

  const PageHeader = () => (
    <div className="marg-header">
      <div className="grid grid-cols-3 border-t border-x border-black">
        <div className="p-1.5 border-r border-black">
          <h1 className="text-base font-black uppercase text-blue-900 mb-0.5 leading-none">{bill.pharmacy.pharmacy_name}</h1>
          {bill.pharmacy.address && (
            <p className="text-[6.5pt] uppercase font-bold text-gray-700 leading-tight whitespace-pre-line">{bill.pharmacy.address}</p>
          )}
          <p className="text-[7.5pt] mt-0.5 font-normal leading-none">PH: {companyPhone}</p>
          <p className="text-[7.5pt] font-normal leading-none">GSTIN: {companyGstin}</p>
          <p className="text-[7.5pt] font-normal leading-none">DL NO: {companyDrugLicense}</p>
        </div>
        <div className="flex flex-col items-center justify-center border-r border-black p-1">
          {bill.pharmacy.pharmacy_logo_url
            ? <img src={bill.pharmacy.pharmacy_logo_url} alt="Logo" className="h-8 w-auto object-contain mb-0.5" />
            : <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center font-black text-sm border border-black mb-0.5">M</div>}
          <span className="text-[8pt] font-black uppercase text-center border-y border-black w-full py-0.5 bg-gray-50">
            {bill.paymentMode === 'Credit' ? 'CREDIT' : 'CASH'}
          </span>
        </div>
        <div className="p-1.5">
          <h3 className="text-[6pt] font-black uppercase underline mb-0.5 text-gray-500">Party Details:</h3>
          <p className="uppercase text-[8.5pt] text-gray-950 leading-tight">{toUpper(bill.customerName)}</p>
          <div className="mt-0.5 space-y-0.5 text-[7pt] font-normal text-gray-700">
            {customerPhone        && <p>PH: {customerPhone}</p>}
            {customerAddressCompact && <p className="leading-tight">ADDRESS: {customerAddressCompact}</p>}
            {customerGstin
              ? <p>GSTIN: {customerGstin}</p>
              : bill.customerDetails?.panNumber ? <p>PAN: {toUpper(bill.customerDetails.panNumber)}</p> : null}
            {customerDrugLicense  && <p>DL NO: {customerDrugLicense}</p>}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 border-y border-x border-black bg-gray-100">
        <div className="col-span-2 py-0.5 flex items-center justify-center border-r border-black">
          <h2 className="text-lg font-black uppercase tracking-[0.2em] text-gray-900 leading-none">
            {isNonGst ? 'ESTIMATE' : 'GST INVOICE'}
          </h2>
        </div>
        <div className="p-0.5 pl-2 flex items-center">
          <div className="invoice-header-right">
            <div className="invoice-meta">
              <span>INV: <span className="font-mono font-black text-blue-900">{bill.invoiceNumber || bill.id}</span></span>
              <span>|</span>
              <span>DATE: {new Date(bill.date).toLocaleDateString('en-GB')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const LastPageFooter = () => (
    <div className="invoice-footer-block">
      <div className="invoice-footer grid grid-cols-2 footer-border bg-white">
        <div className="border-r border-black p-1.5 flex flex-col justify-between">
          {!isNonGst && (
            <table className="w-full erp-table" style={{ fontSize: '6.5pt', borderCollapse: 'collapse', marginBottom: 4 }}>
              <thead className="bg-gray-100 uppercase font-black">
                <tr>
                  <th className="text-left py-0.5">GST Rate</th>
                  <th className="text-right py-0.5">Taxable</th>
                  <th className="text-right py-0.5">SGST</th>
                  <th className="text-right py-0.5">CGST</th>
                </tr>
              </thead>
              <tbody className="font-black">
                {Object.entries(gstSummary).map(([rate, vals]) => {
                  if (parseFloat(rate) === 0) return null;
                  return (
                    <tr key={rate}>
                      <td className="font-black">{rate}%</td>
                      <td className="text-right">{vals.taxable.toFixed(2)}</td>
                      <td className="text-right">{vals.sgst.toFixed(2)}</td>
                      <td className="text-right">{vals.cgst.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div style={{ marginTop: 4 }}>
            <BankDetailsInline
              bankName={companyBankName} accountNumber={companyAccountNumber} ifscCode={companyIfscCode}
              className="bank-details text-[7pt] text-gray-700 leading-tight mb-1.5"
            />
            <p className="amount-in-words font-black uppercase text-gray-950 leading-tight"
              style={{ fontSize: '7.5pt', borderBottom: '1px dashed #d1d5db', paddingBottom: 4, marginBottom: 4 }}>
              {numberToWords(printGrandTotal)}
            </p>
            <div className="invoice-bottom" style={{ marginTop: 8 }}>
              <div>
                {hasSelectedCustomer && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '8pt', fontWeight: 900, textTransform: 'uppercase' }}>Previous Bal:</span>
                      <span style={{ fontSize: '8pt', fontWeight: 900, color: '#dc2626' }}>₹{previousBalance.toFixed(2)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '8pt', fontWeight: 900, textTransform: 'uppercase' }}>Balance After Bill:</span>
                      <span style={{ fontSize: '8pt', fontWeight: 900, color: '#dc2626' }}>₹{balanceAfterBill.toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="text-center" style={{ paddingRight: 4 }}>
                <p className="font-black uppercase" style={{ fontSize: '6pt', letterSpacing: '0.05em', marginBottom: 16 }}>
                  FOR {bill.pharmacy.pharmacy_name}
                </p>
                <p className="font-black uppercase leading-none"
                  style={{ fontSize: '7pt', borderTop: '1px solid black', paddingTop: 2, paddingLeft: 16, paddingRight: 16, display: 'inline-block' }}>
                  Auth. Signatory
                </p>
              </div>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', background: 'rgba(249,250,251,0.8)' }}>
          <div style={{ padding: 8, flex: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '8.5pt', fontWeight: 700 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>SUB TOTAL</span>
                <span style={{ fontWeight: 900 }}>₹ {(printSubtotal || 0).toFixed(2)}</span>
              </div>
              {!isIncludingDiscountMode && tradeDiscount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#4338ca', fontWeight: 900 }}>
                  <span>Trade Discount (₹)</span><span>- {tradeDiscount.toFixed(2)}</span>
                </div>
              )}
              {schemeDiscount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#059669', fontWeight: 900 }}>
                  <span>Scheme Discount (₹)</span><span>- {schemeDiscount.toFixed(2)}</span>
                </div>
              )}
              {showBillDiscount && billDiscount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#4338ca', fontWeight: 900 }}>
                  <span>{isMode8 ? 'Adjustment (Mode 8)' : 'Bill Discount'}</span><span>- {billDiscount.toFixed(2)}</span>
                </div>
              )}
              {!isNonGst && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#4b5563' }}>
                  <span>Tax Amount</span>
                  <span style={{ fontWeight: 900, color: '#111827' }}>{(printTaxAmount || 0).toFixed(2)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280' }}>
                <span>Round Off</span>
                <span style={{ fontWeight: 400 }}>{(roundOff || 0).toFixed(2)}</span>
              </div>
            </div>
          </div>
            <div style={{ padding: 8, background: 'white', borderTop: '1px solid black', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 900, color: '#1f2937', letterSpacing: '-0.025em' }}>GRAND TOTAL</span>
            <span style={{ fontSize: '1.5rem',   fontWeight: 900, color: '#1d4ed8', letterSpacing: '-0.025em' }}>
              ₹ {printGrandTotal.toFixed(2)}
            </span>
          </div>

        </div>
      </div>
    </div>
  );

  const ContinuationFooter = ({ pageNum, totalPages, pageTotal }: { pageNum: number; totalPages: number; pageTotal: number }) => (
    <div className="marg-continuation-footer grid grid-cols-2 border border-black bg-white">
      <div className="border-r border-black p-1.5">
        <p className="text-[8pt] font-black text-gray-700 uppercase">
          Continued on next page… (Page {pageNum} of {totalPages})
        </p>
      </div>
      <div className="p-1.5 flex justify-between items-center bg-gray-50">
        <span className="text-sm font-black text-gray-800 tracking-tighter">PAGE TOTAL</span>
        <span className="text-2xl font-black text-blue-900 tracking-tighter">₹ {pageTotal.toFixed(2)}</span>
      </div>
    </div>
  );

  // ── Font size ──────────────────────────────────────────────────────────────
  const baseFontSize = isLandscape ? '8pt' : '8.5pt';

  return (
    <div
      className="invoice-container bg-white text-black font-sans w-full mx-auto leading-tight antialiased"
      style={{ fontSize: baseFontSize }}
    >
      <style>{sharedStyles}</style>

      {/* ══════════════════════════════════════════════════════════════════
          PHASE 1 — INVISIBLE PROBE PAGE
          Contains: real header + all items + real last-page footer + real
          continuation footer. We read their heights after first paint.
      ══════════════════════════════════════════════════════════════════ */}
      <div ref={probeRef} className="marg-probe" aria-hidden="true">
        {/* Header */}
        <div ref={probeHeadRef}><PageHeader /></div>

        {/* Items table — all rows for accurate avg row-height */}
        <div className="marg-items-wrapper">
          <table className="invoice-items">
            <thead ref={probeTheadRef}><TableHeader /></thead>
            <tbody ref={probeTbodyRef}>
              {items.map((item, i) => <ItemRow key={item.id} item={item} serial={i + 1} />)}
            </tbody>
          </table>
        </div>

        {/* Spacer */}
        <div className="marg-spacer" style={{ borderLeft: '1px solid #000', borderRight: '1px solid #000' }} />

        {/* Real last-page footer — measure this to know how much it costs */}
        <div ref={probeFootRef}><LastPageFooter /></div>

        {/* Real continuation footer */}
        <div ref={probeCFRef}>
          <ContinuationFooter pageNum={1} totalPages={99} pageTotal={0} />
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          PHASE 2 — ACTUAL PAGES (rendered only after measurement)
      ══════════════════════════════════════════════════════════════════ */}
      {pages && pages.map((chunk, pageIdx) => {
        const isLastPage = pageIdx === pages.length - 1;
        const startSerial = pages.slice(0, pageIdx).reduce((s, c) => s + c.length, 0);
        const pageTotal  = chunk.reduce((s, it) => s + (it.displayAmount || 0), 0);

        return (
          <div key={pageIdx} className="marg-page">
            <PageHeader />

            {/* Items */}
            <div className="marg-items-wrapper">
              <table className="invoice-items">
                <thead><TableHeader /></thead>
                <tbody>
                  {chunk.map((item, idx) => (
                    <ItemRow key={item.id} item={item} serial={startSerial + idx + 1} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Spacer keeps footer pinned to bottom; column lines extend through it */}
            <div className="marg-spacer" style={{ borderLeft: '1px solid #000', borderRight: '1px solid #000', position: 'relative' }}>
              {colDividerPositions.map((pct, i) => (
                <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${pct.toFixed(4)}%`, width: 0, borderLeft: '1px solid #d1d5db', pointerEvents: 'none' }} />
              ))}
            </div>

            {/* Footer */}
            {isLastPage
              ? <LastPageFooter />
              : <ContinuationFooter pageNum={pageIdx + 1} totalPages={pages.length} pageTotal={pageTotal} />}
          </div>
        );
      })}
    </div>
  );
};

export default MargTemplate;