import React, { useEffect, useMemo, useRef, useState } from 'react';
import Card from '@core/components/ui/Card';
import { Customer, InventoryItem, RegisteredPharmacy, Transaction, AppConfigurations, CustomerPriceMasterEntry, MaterialPriceMasterEntry } from '@core/types';
import * as storage from '@core/services/storageService';
import { fuzzyMatch } from '@core/utils/search';
import { handleEnterToNextField } from '@core/utils/navigation';
import { fetchGlMasterForBooks, fetchGlAssignmentsForBooks, fetchSetOfBooksById } from '@modules/accounting/services/accountingService';
import { fetchTransactions } from '@modules/sales/services/salesService';
import { fetchPriceMaster, fetchMaterialPriceMaster } from '@modules/customers/services/customerService';

interface ManualSalesEntryProps {
  currentUser: RegisteredPharmacy | null;
  customers: Customer[];
  inventory: InventoryItem[];
  configurations: AppConfigurations;
  addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
  onSaved: () => Promise<void>;
}

type GlOption = { id: string; label: string };

type ManualLine = {
  id: string;
  description: string;
  qty: number;
  rate: number;           // = displayRate (what shows on line item)
  amount: number;
  discount: number;
  taxPercent: number;
  taxAmount: number;
  lineTotal: number;
  itemCode?: string;
  inventoryItemId?: string;
  mrp?: number;
  // Price Master fields
  displayRate: number;             // actual rate shown on line item and used for system total
  fkPrice?: number;                // FK Price — stored for print-time use ONLY
  customerActualPrice?: number;    // from Price Master (audit)
  pricingModeUsed?: 'fk_price' | 'customer_price_master' | 'material_price_master' | 'inventory'; // audit
};

const round2 = (n: number) => Number((n || 0).toFixed(2));

const newLine = (): ManualLine => ({
  id: crypto.randomUUID(),
  description: '',
  qty: 1,
  rate: 0,
  amount: 0,
  discount: 0,
  taxPercent: 0,
  taxAmount: 0,
  lineTotal: 0,
  displayRate: 0,
});

const recalcLine = (line: ManualLine): ManualLine => {
  const amount = round2(Math.max(0, line.qty) * Math.max(0, line.rate));
  const discount = round2(Math.max(0, line.discount));
  const taxable = round2(Math.max(0, amount - discount));
  const taxAmount = round2((taxable * Math.max(0, line.taxPercent)) / 100);
  return { ...line, amount, discount, taxAmount, lineTotal: round2(taxable + taxAmount) };
};

const ManualSalesEntry = React.forwardRef<any, ManualSalesEntryProps>(({ currentUser, customers, inventory, configurations, addNotification, onSaved }, ref) => {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [customerId, setCustomerId] = useState('');
  const [phone, setPhone] = useState('');
  const [voucherNo, setVoucherNo] = useState('');
  const [paymentMode, setPaymentMode] = useState('Cash');
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<ManualLine[]>([newLine()]);
  const [hoveredLineId, setHoveredLineId] = useState<string | null>(null);
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [priceMasterEntries, setPriceMasterEntries] = useState<CustomerPriceMasterEntry[]>([]);
  const [materialPriceEntries, setMaterialPriceEntries] = useState<MaterialPriceMasterEntry[]>([]);
  const [salesGlId, setSalesGlId] = useState('');
  const [discountGlId, setDiscountGlId] = useState('');
  const [taxGlId, setTaxGlId] = useState('');
  const [defaultCustomerControlGlId, setDefaultCustomerControlGlId] = useState('');
  const [customerControlGlId, setCustomerControlGlId] = useState('');
  const [salesOptions, setSalesOptions] = useState<GlOption[]>([]);
  const [taxOptions, setTaxOptions] = useState<GlOption[]>([]);
  const [expenseOptions, setExpenseOptions] = useState<GlOption[]>([]);
  const [searchText, setSearchText] = useState('');
  const [salesHistory, setSalesHistory] = useState<Transaction[]>([]);
  const [stats, setStats] = useState({ monthTotal: 0, todayTotal: 0, monthCount: 0 });

  const fetchHistory = async () => {
    if (!currentUser) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      const startOfMonthStr = startOfMonth.toISOString().slice(0, 10);

      // Read from SQLite-first salesService, then derive recent + month stats client-side
      const allTx = await fetchTransactions(currentUser);
      const filtered = allTx.filter((t: any) =>
        (t.status === 'completed') &&
        (!customerId || t.customer_id === customerId)
      );

      const recent = [...filtered]
        .sort((a: any, b: any) => String(b.created_at ?? b.date ?? '').localeCompare(String(a.created_at ?? a.date ?? '')))
        .slice(0, 20);
      setSalesHistory(recent.map(r => storage.toCamel(r)));

      const monthData = filtered.filter((t: any) => {
        const d = String(t.date ?? '').slice(0, 10);
        return d >= startOfMonthStr;
      });
      const monthTotal = monthData.reduce((sum: number, s: any) => sum + (Number(s.total) || 0), 0);
      const todayTotal = monthData
        .filter((s: any) => String(s.date ?? '').slice(0, 10) === today)
        .reduce((sum: number, s: any) => sum + (Number(s.total) || 0), 0);
      setStats({
        monthTotal,
        todayTotal,
        monthCount: monthData.length,
      });
    } catch (e) {
      console.error('Error fetching history:', e);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [currentUser, customerId]);

  const isPriceMasterEnabled = configurations.displayOptions?.enablePriceMaster ?? true;

  // Load Price Master data once on mount
  useEffect(() => {
    if (!currentUser || !isPriceMasterEnabled) return;
    fetchPriceMaster(currentUser)
      .then(setPriceMasterEntries)
      .catch(() => { /* non-fatal: fall back to inventory pricing */ });
    fetchMaterialPriceMaster(currentUser)
      .then(setMaterialPriceEntries)
      .catch(() => { /* non-fatal */ });
  }, [currentUser, isPriceMasterEnabled]);

  const activeLine = useMemo(() => {
    if (hoveredLineId) return lines.find(l => l.id === hoveredLineId);
    return lines[lines.length - 1];
  }, [hoveredLineId, lines]);

  const activeInventoryItem = useMemo(() => {
    if (!activeLine || !activeLine.description) return null;
    return inventory.find(i => 
      (activeLine.inventoryItemId && i.id === activeLine.inventoryItemId) || 
      (i.name.toLowerCase() === activeLine.description.toLowerCase())
    );
  }, [activeLine, inventory]);

  const dateInputRef = useRef<HTMLInputElement>(null);
  const customerInputRef = useRef<HTMLSelectElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const productSearchInputRef = useRef<HTMLInputElement>(null);

  const canEditRate = configurations.modules?.['pos']?.fields?.allowRateEdit !== false;
  const defaultRateTier = configurations.displayOptions?.defaultRateTier || 'mrp';

  const matchingItems = useMemo(() => {
    const term = searchText.trim();
    if (!term) return [] as InventoryItem[];
    return inventory
      .filter((item) => item.is_active !== false && String(item.is_active) !== '0')
      .filter((item) => fuzzyMatch(item.name, term) || fuzzyMatch(item.code || '', term) || fuzzyMatch(item.barcode || '', term))
      .slice(0, 12);
  }, [inventory, searchText]);

  const metrics = useMemo(() => {
    const subTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const totalDiscount = round2(lines.reduce((s, l) => s + l.discount, 0));
    const taxableValue = round2(subTotal - totalDiscount);
    const tax = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
    const grandTotal = round2(taxableValue + tax);
    return { subTotal, totalDiscount, taxableValue, tax, grandTotal };
  }, [lines]);

  useEffect(() => {
    const loadSetup = async () => {
      if (!currentUser) return;
      const ctx = await (await import('@core/services/companyDefaultsService')).loadDefaultPostingContext(currentUser.organization_id);
      const setOfBooksId = ctx.setOfBooksId;
      const [glRows, assignments, books] = await Promise.all([
        fetchGlMasterForBooks(currentUser, setOfBooksId),
        fetchGlAssignmentsForBooks(currentUser, setOfBooksId),
        fetchSetOfBooksById(currentUser, setOfBooksId),
      ]);

      const allowedGlIds = new Set((assignments || []).flatMap((a: any) => [a.sales_gl, a.discount_gl, a.tax_gl].filter(Boolean).map(String)));
      const inBookRows = (glRows || []).filter((g: any) => g.set_of_books_id === setOfBooksId);
      const sales = inBookRows
        .filter((g: any) => g.gl_type === 'Income' && g.posting_allowed && (allowedGlIds.size === 0 || allowedGlIds.has(String(g.id))))
        .map((g: any) => ({ id: String(g.id), label: `${g.gl_code} - ${g.gl_name}` }));
      const taxs = inBookRows.filter((g: any) => /tax|gst/i.test(`${g.gl_code} ${g.gl_name}`)).map((g: any) => ({ id: String(g.id), label: `${g.gl_code} - ${g.gl_name}` }));
      const expenses = inBookRows.filter((g: any) => g.gl_type === 'Expense').map((g: any) => ({ id: String(g.id), label: `${g.gl_code} - ${g.gl_name}` }));

      setSalesOptions(sales);
      setTaxOptions(taxs);
      setExpenseOptions(expenses);
      setSalesGlId(sales[0]?.id || '');
      setDiscountGlId(expenses.find((g) => /discount/i.test(g.label))?.id || expenses[0]?.id || '');
      setTaxGlId(taxs.find((g) => /output|gst/i.test(g.label))?.id || taxs[0]?.id || '');
      const defaultGl = String((books as any)?.default_customer_gl_id || '');
      setDefaultCustomerControlGlId(defaultGl);
      setCustomerControlGlId(defaultGl);

    };

    loadSetup().catch((e) => addNotification(e?.message || 'Unable to load GL setup', 'error'));
  }, [addNotification, currentUser]);

  useEffect(() => {
    const selectedCustomer = customers.find((c) => c.id === customerId);
    if (selectedCustomer?.phone) setPhone(selectedCustomer.phone);
    setCustomerControlGlId(selectedCustomer?.controlGlId || defaultCustomerControlGlId);
  }, [customerId, customers, defaultCustomerControlGlId]);

  useEffect(() => {
    const timer = setTimeout(() => dateInputRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, []);

  const updateLine = (id: string, patch: Partial<ManualLine>) => {
    setLines((prev) => prev.map((line) => (line.id === id ? recalcLine({ ...line, ...patch }) : line)));
  };


  const ensureVoucherNumber = async (): Promise<string> => {
    if (voucherNo) return voucherNo;
    if (!currentUser) throw new Error('User context missing.');
    const reservation = await storage.reserveVoucherNumber('sales-gst', currentUser);
    setVoucherNo(reservation.documentNumber);
    return reservation.documentNumber;
  };

  const getRateByTier = (item: InventoryItem): number => {
    if (defaultRateTier === 'rateA') return Number(item.rateA || item.mrp || 0);
    if (defaultRateTier === 'rateB') return Number(item.rateB || item.mrp || 0);
    if (defaultRateTier === 'rateC') return Number(item.rateC || item.mrp || 0);
    if (defaultRateTier === 'ptr') return Number(item.ptr || item.mrp || 0);
    return Number(item.mrp || 0);
  };

  /**
   * Resolve which price to use for a given item+customer based on
   * the configured pricingPriority. FK Price is stored for print-time
   * use only — it NEVER changes the system total or displayed rate.
   */
  const resolvePricing = (item: InventoryItem, cId: string) => {
    const inventoryRate = getRateByTier(item);

    // Look up active Customer Price Master entry for this customer+item
    const priceEntry = (isPriceMasterEnabled && cId)
      ? priceMasterEntries.find(
          p => p.customer_id === cId &&
               (p.material_id === item.id || p.material_id === item.code) &&
               p.status === 'active'
        )
      : null;

    // Look up active Material Price Master entry for this item
    const materialPriceRecord = isPriceMasterEnabled
      ? materialPriceEntries.find(
          p => (p.material_id === item.id || p.material_id === item.code) &&
               p.status === 'active'
        )
      : null;

    const customerActualPrice = priceEntry?.special_price != null ? Number(priceEntry.special_price) : undefined;
    const fkPrice = priceEntry?.fk_price != null ? Number(priceEntry.fk_price) : undefined;
    const matPrice = materialPriceRecord?.price != null ? Number(materialPriceRecord.price) : undefined;

    const priorities = [
      configurations.pricingPriority?.priority1 ?? 'customer_price_master',
      configurations.pricingPriority?.priority2 ?? 'material_price_master',
      configurations.pricingPriority?.priority3 ?? 'inventory',
    ];

    let displayRate = inventoryRate;
    let resolvedFkPrice: number | undefined = fkPrice;
    let pricingModeUsed: 'fk_price' | 'customer_price_master' | 'material_price_master' | 'inventory' = 'inventory';

    for (const priority of priorities) {
      if (priority === 'customer_price_master' && customerActualPrice !== undefined) {
        displayRate = customerActualPrice;
        pricingModeUsed = 'customer_price_master';
        break;
      }
      if (priority === 'material_price_master' && matPrice !== undefined) {
        displayRate = matPrice;
        pricingModeUsed = 'material_price_master';
        break;
      }
      if (priority === 'inventory') {
        displayRate = inventoryRate;
        pricingModeUsed = 'inventory';
        break;
      }
    }

    return { displayRate, fkPrice: resolvedFkPrice, customerActualPrice, pricingModeUsed };
  };

  const addItemLine = (item: InventoryItem) => {
    const targetLine = lines.find((line) => !line.description.trim());
    const { displayRate, fkPrice, customerActualPrice, pricingModeUsed } =
      resolvePricing(item, customerId);

    const basePatch: Partial<ManualLine> = {
      description: item.name,
      itemCode: item.code,
      inventoryItemId: item.id,
      qty: 1,
      rate: displayRate,
      taxPercent: Number(item.gstPercent || 0),
      mrp: Number(item.mrp || 0),
      displayRate,
      fkPrice,
      customerActualPrice,
      pricingModeUsed,
    };

    if (targetLine) {
      updateLine(targetLine.id, basePatch);
    } else {
      setLines((prev) => [...prev, recalcLine({ ...newLine(), ...basePatch })]);
    }
    setSearchText('');

    setTimeout(() => {
      const nextId = (targetLine?.id || lines[lines.length - 1]?.id);
      if (nextId) {
        const el = document.getElementById(`qty-${nextId}`);
        el?.focus();
        if (el instanceof HTMLInputElement) el.select();
      }
    }, 0);
  };

  const handleDeleteRow = (id: string, index: number) => {
    setLines((prev) => {
      const newLines = prev.filter((line) => line.id !== id);
      if (newLines.length === 0) return [newLine()];
      return newLines;
    });
  };

  const handleRowNavigation = (e: React.KeyboardEvent<HTMLInputElement>, id: string) => {
    if (e.key === 'Delete') {
      e.preventDefault();
      const index = lines.findIndex(l => l.id === id);
      handleDeleteRow(id, index);
      return;
    }
    const fieldOrder = ['qty', 'rate', 'discount', 'tax'];
    const fieldId = e.currentTarget.id;
    const fieldIndex = fieldOrder.findIndex((f) => fieldId.startsWith(`${f}-`));
    if (fieldIndex === -1) return;
    if (!['Enter', 'Tab', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;

    const isPrev = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey);
    const lineIndex = lines.findIndex((line) => line.id === id);
    if (lineIndex === -1) return;

    e.preventDefault();
    const targetFieldIndex = isPrev ? fieldIndex - 1 : fieldIndex + 1;
    if (targetFieldIndex >= 0 && targetFieldIndex < fieldOrder.length) {
      const target = document.getElementById(`${fieldOrder[targetFieldIndex]}-${id}`);
      target?.focus();
      if (target instanceof HTMLInputElement) target.select();
      return;
    }

    const targetLineIndex = isPrev ? lineIndex - 1 : lineIndex + 1;
    if (targetLineIndex < 0) {
      productSearchInputRef.current?.focus();
      return;
    }

    if (targetLineIndex >= lines.length) {
      setLines((prev) => [...prev, newLine()]);
      setTimeout(() => {
        const lastId = lines[lines.length - 1]?.id;
        const target = lastId ? document.getElementById(`qty-${lastId}`) : null;
        target?.focus();
      }, 0);
      return;
    }

    const targetLineId = lines[targetLineIndex].id;
    const targetField = isPrev ? fieldOrder[fieldOrder.length - 1] : fieldOrder[0];
    const target = document.getElementById(`${targetField}-${targetLineId}`);
    target?.focus();
    if (target instanceof HTMLInputElement) target.select();
  };

  const validate = async (): Promise<string | null> => {
    if (!currentUser) return 'User context missing.';
    if (!salesGlId) return 'Sales GL is mandatory.';
    for (const [idx, line] of lines.entries()) {
      if (!line.description.trim()) return `Description is mandatory for line ${idx + 1}.`;
      if (line.qty < 0 || line.rate < 0) return `Qty and Rate must be ≥ 0 (line ${idx + 1}).`;
    }
    if (voucherNo) {
      // Check both local cache and (when online) server for duplicate
      const allTx = await fetchTransactions(currentUser);
      const duplicate = allTx.find((t: any) => t.invoice_number === voucherNo || t.id === voucherNo);
      if (duplicate) return `Voucher number ${voucherNo} already exists.`;
    }
    return null;
  };

  const buildTransaction = (status: 'draft' | 'completed', docNumber: string): Transaction => {
    const selectedCustomer = customers.find((c) => c.id === customerId);
    return {
      id: crypto.randomUUID(),
      invoiceNumber: docNumber,
      organization_id: currentUser!.organization_id,
      user_id: currentUser!.user_id,
      date,
      customerName: selectedCustomer?.name || 'Walking Customer',
      customerId: selectedCustomer?.id || null,
      customerPhone: phone || selectedCustomer?.phone || '',
      referredBy: narration,
      items: lines.map((line) => ({
        id: line.id,
        inventoryItemId: '',
        name: line.description,
        mrp: line.rate,
        quantity: line.qty,
        unit: 'pack',
        gstPercent: line.taxPercent,
        discountPercent: 0,
        itemFlatDiscount: line.discount,
        amount: line.amount,
        finalAmount: line.lineTotal,
        rate: line.rate,
        taxableValue: round2(line.amount - line.discount),
        gstAmount: line.taxAmount,
        // Price Master audit fields (fk_price stored for print-time use only)
        fk_price_applied: line.fkPrice ?? null,
        customer_actual_price: line.customerActualPrice ?? null,
        pricing_mode_used: line.pricingModeUsed ?? 'inventory',
      } as any)),
      total: metrics.grandTotal,
      itemCount: lines.length,
      status,
      paymentMode,
      billType: 'regular',
      subtotal: metrics.subTotal,
      totalItemDiscount: metrics.totalDiscount,
      totalGst: metrics.tax,
      schemeDiscount: 0,
      roundOff: 0,
      amountReceived: ['Cash', 'Card', 'UPI'].includes(paymentMode) ? metrics.grandTotal : 0,
      createdAt: new Date().toISOString(),
    };
  };

  const onSaveDraft = async () => {
    const err = await validate();
    if (err) return addNotification(err, 'error');
    const docNumber = await ensureVoucherNumber();
    await storage.saveData('sales_bill', buildTransaction('draft', docNumber), currentUser);
    setVoucherNo('');
    addNotification('Manual sales voucher saved as draft.', 'success');
    await fetchHistory();
    await onSaved();
  };

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName.toLowerCase();
      const isInputFocused = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';

      if (!isInputFocused && lines.length > 0) {
        const itemIdx = lines.findIndex(l => l.id === hoveredLineId);
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const targetIdx = Math.max(0, itemIdx - 1);
          setHoveredLineId(lines[targetIdx].id);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const targetIdx = Math.min(lines.length - 1, itemIdx + 1);
          setHoveredLineId(lines[targetIdx].id);
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [lines, hoveredLineId]);

  const onPost = async () => {
    const err = await validate();
    if (err) return addNotification(err, 'error');

    const docNumber = await ensureVoucherNumber();
    await storage.saveData('sales_bill', buildTransaction('draft', docNumber), currentUser);
    try {
      await storage.postManualSalesVoucher({
        voucherId: docNumber,
        voucherDate: date,
        paymentMode,
        grandTotal: metrics.grandTotal,
        taxableValue: metrics.taxableValue,
        taxAmount: metrics.tax,
        discountAmount: metrics.totalDiscount,
        salesGlId,
        taxGlId,
        discountGlId,
        customerControlGlId,
        narration,
      }, currentUser!);
      setVoucherNo('');
      addNotification('Manual sales voucher posted successfully.', 'success');
      await fetchHistory();
      await onSaved();
    } catch (e: any) {
      addNotification(e?.message || 'Posting failed', 'error');
    }
  };

  React.useImperativeHandle(ref, () => ({
    handleSubmit: () => onPost(),
    resetForm: () => {
      setDate(new Date().toISOString().slice(0, 10));
      setCustomerId('');
      setPhone('');
      setNarration('');
      setLines([newLine()]);
      setVoucherNo('');
    },
    isDirty: lines.some(l => l.description.trim() !== '' || l.rate > 0) || customerId !== '' || narration !== ''
  }), [lines, customerId, narration, onPost]);

  return (
    <div className="flex h-full bg-app-bg overflow-hidden">
      <div className="flex-1 flex flex-col h-full overflow-hidden border-r border-gray-300" onKeyDown={handleEnterToNextField}>
        <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
          <span className="text-[10px] font-black uppercase tracking-widest">Accounting Voucher Creation (Sales)</span>
          <span className="text-[10px] font-black uppercase text-accent">No. {voucherNo || 'AUTO'}</span>
        </div>

        <div className="p-2 flex-1 flex flex-col gap-2 overflow-hidden">
          <Card className="p-1.5 bg-white border border-app-border rounded-none grid grid-cols-1 md:grid-cols-5 gap-2 items-end flex-shrink-0">
            <div>
              <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Date</label>
              <input ref={dateInputRef} className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none focus:bg-yellow-50" type="date" value={date} onChange={(e) => setDate(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && customerInputRef.current?.focus()} />
            </div>
            <div className="md:col-span-2">
              <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Particulars (Customer Name)</label>
              <select ref={customerInputRef} className="w-full h-8 border border-gray-400 p-1 text-xs font-bold uppercase outline-none focus:bg-yellow-50" value={customerId} onChange={(e) => setCustomerId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && phoneInputRef.current?.focus()}>
                <option value="">Walking Customer</option>
                {customers.filter((c) => c.is_blocked !== true && c.is_active !== false).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Phone Number</label>
              <input ref={phoneInputRef} className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none focus:bg-yellow-50" placeholder="Customer Phone" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && productSearchInputRef.current?.focus()} />
            </div>
            <div>
              <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Payment Mode</label>
              <select className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none focus:bg-yellow-50" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
                {['Cash', 'Card', 'UPI', 'Credit'].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </Card>

          <Card className="p-1.5 bg-white border border-app-border rounded-none flex-shrink-0">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <div className="md:col-span-2 relative">
                <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Item Search (Name / Code)</label>
                <input
                  ref={productSearchInputRef}
                  className="w-full h-8 border border-gray-400 p-1 text-xs font-bold uppercase outline-none focus:bg-yellow-50"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matchingItems.length > 0) {
                      e.preventDefault();
                      addItemLine(matchingItems[0]);
                    }
                  }}
                  placeholder="Search item by name/code and press Enter"
                />
                {searchText && matchingItems.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full max-h-44 overflow-y-auto bg-white border border-gray-300 shadow">
                    {matchingItems.map((item) => (
                      <button key={item.id} type="button" className="w-full text-left px-2 py-1 text-xs hover:bg-yellow-50 border-b border-gray-100" onClick={() => addItemLine(item)}>
                        {item.name} {item.code ? `(${item.code})` : ''} - ₹{getRateByTier(item).toFixed(2)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5 ml-0.5">Narration / Remarks</label>
                <input className="w-full h-8 border border-gray-400 p-1 text-xs font-bold outline-none focus:bg-yellow-50" value={narration} onChange={(e) => setNarration(e.target.value)} />
              </div>
            </div>
          </Card>

          <div className="bg-white border border-app-border overflow-auto flex-1">
            <table className="min-w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-gray-100 border-b border-gray-400 z-10">
                <tr className="text-[10px] font-black uppercase text-gray-700 tracking-wide">
                  <th className="p-2 border-r border-gray-300 w-10 text-center">#</th>
                  <th className="p-2 border-r border-gray-300 text-left">Description</th>
                  <th className="p-2 border-r border-gray-300 w-20 text-center">Qty</th>
                  <th className="p-2 border-r border-gray-300 w-28 text-right">Rate</th>
                  <th className="p-2 border-r border-gray-300 w-28 text-right">Amount</th>
                  <th className="p-2 border-r border-gray-300 w-28 text-right">Discount</th>
                  <th className="p-2 border-r border-gray-300 w-20 text-center">Tax %</th>
                  <th className="p-2 border-r border-gray-300 w-28 text-right">Tax Amt</th>
                  <th className="p-2 w-32 text-right">Line Total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr 
                    key={line.id} 
                    onMouseEnter={() => setHoveredLineId(line.id)}
                    onMouseLeave={() => setHoveredLineId(null)}
                    className={`border-b border-gray-200 h-10 text-xs font-bold uppercase transition-colors group ${hoveredLineId === line.id || activeLineId === line.id ? 'bg-primary text-white shadow-lg' : 'hover:bg-primary hover:text-white'}`}
                  >
                    <td 
                      className={`p-2 border-r border-gray-200 text-center cursor-pointer hover:bg-red-600 hover:text-white transition-colors group/del ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white' : 'group-hover:text-white text-gray-500'}`}
                      onClick={(e) => { e.stopPropagation(); handleDeleteRow(line.id, i); }}
                      title="Click to delete this line item"
                    >
                      <span className="group-hover/del:hidden">{i + 1}</span>
                      <span className="hidden group-hover/del:inline">✕</span>
                    </td>
                    <td className="p-2 border-r border-gray-200">
                      <input 
                        className={`w-full bg-transparent outline-none ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white placeholder:text-white/50' : 'group-hover:text-white group-hover:placeholder:text-white/50'}`} 
                        value={line.description} 
                        onChange={(e) => updateLine(line.id, { description: e.target.value })} 
                        onFocus={() => setActiveLineId(line.id)}
                        placeholder="Item description" 
                      />
                    </td>
                    <td className="p-2 border-r border-gray-200">
                      <input id={`qty-${line.id}`} className={`w-full text-center bg-transparent outline-none ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white' : 'group-hover:text-white'}`} type="number" min={0} value={line.qty || ''} onChange={(e) => updateLine(line.id, { qty: Number(e.target.value) })} onFocus={() => setActiveLineId(line.id)} onKeyDown={(e) => handleRowNavigation(e, line.id)} />
                    </td>
                    <td className="p-2 border-r border-gray-200">
                      <input id={`rate-${line.id}`} className={`w-full text-right bg-transparent outline-none ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white' : 'group-hover:text-white'}`} type="number" min={0} value={line.rate || ''} onChange={(e) => { const newRate = Number(e.target.value); if (line.mrp && line.mrp > 0 && newRate > line.mrp) { addNotification(`Rate cannot exceed MRP (₹${line.mrp.toFixed(2)})`, 'warning'); updateLine(line.id, { rate: line.mrp }); } else { updateLine(line.id, { rate: newRate }); } }} onFocus={() => setActiveLineId(line.id)} onKeyDown={(e) => handleRowNavigation(e, line.id)} disabled={!canEditRate} />
                    </td>
                    <td className={`p-2 border-r border-gray-200 text-right ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white' : 'group-hover:text-white text-gray-700'}`}>{line.amount.toFixed(2)}</td>
                    <td className="p-2 border-r border-gray-200">
                      <input id={`discount-${line.id}`} className={`w-full text-right bg-transparent outline-none ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white' : 'group-hover:text-white'}`} type="number" min={0} value={line.discount || ''} onChange={(e) => updateLine(line.id, { discount: Number(e.target.value) })} onFocus={() => setActiveLineId(line.id)} onKeyDown={(e) => handleRowNavigation(e, line.id)} />
                    </td>
                    <td className="p-2 border-r border-gray-200">
                      <input id={`tax-${line.id}`} className={`w-full text-center bg-transparent outline-none ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white' : 'group-hover:text-white'}`} type="number" min={0} value={line.taxPercent || ''} onChange={(e) => updateLine(line.id, { taxPercent: Number(e.target.value) })} onFocus={() => setActiveLineId(line.id)} onKeyDown={(e) => handleRowNavigation(e, line.id)} />
                    </td>
                    <td className={`p-2 border-r border-gray-200 text-right ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white' : 'group-hover:text-white text-gray-700'}`}>{line.taxAmount.toFixed(2)}</td>
                    <td className={`p-2 text-right font-black ${hoveredLineId === line.id || activeLineId === line.id ? 'text-white' : 'group-hover:text-white text-gray-800'}`}>{line.lineTotal.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-app-border p-1.5 grid grid-cols-1 md:grid-cols-2 gap-2 flex-shrink-0">
            {activeInventoryItem && (
              <div className="md:col-span-2 bg-emerald-50 border border-emerald-200 p-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px] font-bold uppercase animate-in fade-in duration-200">
                <div className="text-emerald-800">Item: <span className="text-primary">{activeInventoryItem.name}</span></div>
                <div className="text-emerald-800">Stock: <span className="text-primary">{activeInventoryItem.stock}</span></div>
                <div className="text-emerald-800">MRP: <span className="text-primary">₹{(activeInventoryItem.mrp || 0).toFixed(2)}</span></div>
                <div className="text-emerald-800">Batch: <span className="text-primary">{activeInventoryItem.batch || '-'}</span></div>
                <div className="text-emerald-800">Expiry: <span className="text-primary">{activeInventoryItem.expiry || '-'}</span></div>
              </div>
            )}
            <select className="h-8 border border-gray-400 p-1 text-xs font-bold" value={salesGlId} onChange={(e) => setSalesGlId(e.target.value)}>
              <option value="">Select Sales GL *</option>
              {salesOptions.map((gl) => <option key={gl.id} value={gl.id}>{gl.label}</option>)}
            </select>
            <select className="h-8 border border-gray-400 p-1 text-xs font-bold" value={discountGlId} onChange={(e) => setDiscountGlId(e.target.value)}>
              <option value="">Discount GL (optional)</option>
              {expenseOptions.map((gl) => <option key={gl.id} value={gl.id}>{gl.label}</option>)}
            </select>
            <select className="h-8 border border-gray-400 p-1 text-xs font-bold" value={taxGlId} onChange={(e) => setTaxGlId(e.target.value)}>
              <option value="">Tax Output GL (optional)</option>
              {taxOptions.map((gl) => <option key={gl.id} value={gl.id}>{gl.label}</option>)}
            </select>
            <input className="h-8 border border-gray-300 p-1 text-xs font-bold bg-gray-100" value={customerControlGlId} readOnly placeholder="Customer/Receivable GL" />
          </div>

          <div className="bg-gray-100 border border-gray-300 px-3 py-2 text-[10px] xl:text-[13px] font-bold flex flex-wrap gap-4 xl:gap-8 justify-end flex-shrink-0 uppercase tracking-tight">
            <div>Sub Total: <span className="text-gray-800">₹{metrics.subTotal.toFixed(2)}</span></div>
            <div>SGST: <span className="text-blue-700">₹{(metrics.tax / 2).toFixed(2)}</span></div>
            <div>CGST: <span className="text-blue-700">₹{(metrics.tax / 2).toFixed(2)}</span></div>
            <div>GST Amount: <span className="text-gray-800">₹{metrics.tax.toFixed(2)}</span></div>
            <div>Total Discount: <span className="text-red-600">₹{metrics.totalDiscount.toFixed(2)}</span></div>
            <div>Taxable Value: <span className="text-gray-800">₹{metrics.taxableValue.toFixed(2)}</span></div>
            <div className="text-primary font-black text-xs xl:text-base">Grand Total: ₹{metrics.grandTotal.toFixed(2)}</div>
          </div>

          <div className="flex gap-2 justify-end flex-shrink-0">
            <button className="px-4 h-9 border border-gray-400 bg-white text-xs font-bold uppercase" onClick={onSaveDraft}>Save Draft</button>
            <button className="px-4 h-9 bg-emerald-600 text-white text-xs font-bold uppercase" onClick={onPost}>Post Voucher</button>
          </div>
        </div>
      </div>

      <div className="w-64 h-full bg-white flex flex-col overflow-hidden shadow-xl shrink-0">
        <div className="bg-gray-800 text-white h-7 flex items-center px-4 shrink-0">
          <span className="text-[10px] font-black uppercase tracking-widest">Sales Insights</span>
        </div>
        
        <div className="p-3 border-b border-gray-200 bg-gray-50 flex flex-col gap-2">
          <div className="flex gap-2">
            <div className="flex-1 bg-white p-2 border border-gray-300 shadow-sm">
              <div className="text-[9px] font-bold text-gray-500 uppercase">This Month</div>
              <div className="text-xs font-black text-primary">₹{stats.monthTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
            </div>
            <div className="flex-1 bg-white p-2 border border-gray-300 shadow-sm">
              <div className="text-[9px] font-bold text-gray-500 uppercase">Today</div>
              <div className="text-xs font-black text-emerald-600">₹{stats.todayTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
            </div>
          </div>
          <div className="bg-white p-2 border border-gray-300 shadow-sm flex justify-between items-center">
            <div className="text-[9px] font-bold text-gray-500 uppercase">Orders Count (MTD)</div>
            <div className="text-sm font-black text-gray-800">{stats.monthCount}</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 bg-gray-50/50">
          <div className="text-[10px] font-black text-gray-400 uppercase mb-2 ml-1">Last 20 Sales</div>
          <div className="space-y-1.5">
            {salesHistory.map((sale) => (
              <div key={sale.id} className="p-2 bg-white border border-gray-200 hover:border-primary/50 hover:bg-sky-50 transition-colors cursor-pointer text-[11px] shadow-sm">
                <div className="flex justify-between items-start mb-0.5">
                  <span className="font-black text-gray-800 uppercase truncate pr-2 flex-1" title={sale.customerName}>{sale.customerName}</span>
                  <span className="shrink-0 font-black text-primary">₹{sale.total.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-[9px] text-gray-400 font-bold uppercase">
                  <span>{sale.invoiceNumber || sale.id}</span>
                  <span>{(sale.date || '').split('T')[0]}</span>
                </div>
              </div>
            ))}
            {salesHistory.length === 0 && (
              <div className="text-center py-10 text-gray-400 text-xs italic">No recent sales</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default ManualSalesEntry;
