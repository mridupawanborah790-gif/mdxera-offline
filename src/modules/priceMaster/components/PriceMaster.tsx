import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Card from '@core/components/ui/Card';
import type { RegisteredPharmacy, Customer, InventoryItem, CustomerPriceMasterEntry, MaterialPriceMasterEntry } from '@core/types';
import {
  fetchPriceMaster,
  savePriceMasterEntry,
  updatePriceMasterStatus,
  fetchMaterialPriceMaster,
  saveMaterialPriceMasterEntry,
  updateMaterialPriceMasterStatus,
} from '@modules/customers/services/customerService';
import { fuzzyMatch } from '@core/utils/search';

interface PriceMasterProps {
  currentUser: RegisteredPharmacy | null;
  customers: Customer[];
  inventory: InventoryItem[];
  addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
}

const round2 = (n: number) => Number((n || 0).toFixed(2));

const PriceMaster: React.FC<PriceMasterProps> = ({
  currentUser,
  customers,
  inventory,
  addNotification,
}) => {
  const [activeTab, setActiveTab] = useState<'customer_wise' | 'material_wise'>('customer_wise');

  // Customer-wise Price Master state
  const [custEntries, setCustEntries] = useState<CustomerPriceMasterEntry[]>([]);
  const [custLoading, setCustLoading] = useState(false);
  const [custShowForm, setCustShowForm] = useState(false);
  const [custEditingEntry, setCustEditingEntry] = useState<CustomerPriceMasterEntry | null>(null);
  const [custSearchText, setCustSearchText] = useState('');
  const [custFilterCustomerId, setCustFilterCustomerId] = useState('');
  const [custFilterStatus, setCustFilterStatus] = useState<'all' | 'active' | 'inactive'>('active');

  const [custFormCustomerId, setCustFormCustomerId] = useState('');
  const [custFormItemId, setCustFormItemId] = useState('');
  const [custFormActualPrice, setCustFormActualPrice] = useState('');
  const [custFormFkPrice, setCustFormFkPrice] = useState('');
  const [custFormStatus, setCustFormStatus] = useState<'active' | 'inactive'>('active');
  const [custItemSearch, setCustItemSearch] = useState('');
  const [custShowItemDropdown, setCustShowItemDropdown] = useState(false);
  const [custSaving, setCustSaving] = useState(false);

  // Material-wise Price Master state
  const [matEntries, setMatEntries] = useState<MaterialPriceMasterEntry[]>([]);
  const [matLoading, setMatLoading] = useState(false);
  const [matShowForm, setMatShowForm] = useState(false);
  const [matEditingEntry, setMatEditingEntry] = useState<MaterialPriceMasterEntry | null>(null);
  const [matSearchText, setMatSearchText] = useState('');
  const [matFilterStatus, setMatFilterStatus] = useState<'all' | 'active' | 'inactive'>('active');

  const [matFormItemId, setMatFormItemId] = useState('');
  const [matFormPrice, setMatFormPrice] = useState('');
  const [matFormStatus, setMatFormStatus] = useState<'active' | 'inactive'>('active');
  const [matItemSearch, setMatItemSearch] = useState('');
  const [matShowItemDropdown, setMatShowItemDropdown] = useState(false);
  const [matSaving, setMatSaving] = useState(false);

  // Confirmation Modal state for MRP warnings
  const [mrpWarningModal, setMrpWarningModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    enteredPriceText: string;
    latestMrpText: string;
    onConfirm: () => void;
  } | null>(null);

  // Load Customer Price Master entries
  const loadCustEntries = useCallback(async () => {
    if (!currentUser) return;
    setCustLoading(true);
    try {
      const data = await fetchPriceMaster(currentUser);
      setCustEntries(data);
    } catch (e: any) {
      addNotification(e?.message || 'Failed to load Customer Price Master', 'error');
    } finally {
      setCustLoading(false);
    }
  }, [currentUser, addNotification]);

  // Load Material Price Master entries
  const loadMatEntries = useCallback(async () => {
    if (!currentUser) return;
    setMatLoading(true);
    try {
      const data = await fetchMaterialPriceMaster(currentUser);
      setMatEntries(data);
    } catch (e: any) {
      addNotification(e?.message || 'Failed to load Material Price Master', 'error');
    } finally {
      setMatLoading(false);
    }
  }, [currentUser, addNotification]);

  useEffect(() => {
    loadCustEntries();
    loadMatEntries();
  }, [loadCustEntries, loadMatEntries]);

  // Helper rate calculation
  const calculateRateExcludingGst = (mrp: number, gstPercent: number): number => {
    const safeMrp = Number(mrp) || 0;
    const safeGst = Number(gstPercent) || 0;
    if (safeMrp <= 0) return 0;
    if (safeGst <= 0) return safeMrp;
    return round2(safeMrp / (1 + safeGst / 100));
  };

  const getLatestBatchForItem = (itemId: string): InventoryItem | null => {
    const targetItem = inventory.find(i => i.id === itemId);
    if (!targetItem) return null;

    const matchingBatches = inventory.filter(i =>
      i.id === itemId ||
      (i.code && targetItem.code && i.code === targetItem.code) ||
      (i.name && targetItem.name && i.name.trim().toLowerCase() === targetItem.name.trim().toLowerCase())
    );

    if (matchingBatches.length === 0) return targetItem;

    const sorted = [...matchingBatches].sort((a: any, b: any) => {
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (timeA !== timeB) return timeB - timeA;
      return 0;
    });

    return sorted[0] || targetItem;
  };

  // ---------------------------------------------------------------------------
  // Customer-Wise Handlers & Computed States
  // ---------------------------------------------------------------------------
  const custMatchingItems = useMemo(() => {
    if (!custItemSearch.trim()) return [];
    return inventory
      .filter(i => i.is_active !== false && String(i.is_active) !== '0')
      .filter(i => fuzzyMatch(i.name, custItemSearch) || fuzzyMatch(i.code || '', custItemSearch))
      .slice(0, 10);
  }, [inventory, custItemSearch]);

  const custSelectedItem = useMemo(
    () => inventory.find(i => i.id === custFormItemId),
    [inventory, custFormItemId]
  );

  const filteredCustEntries = useMemo(() => {
    return custEntries.filter(e => {
      if (custFilterStatus !== 'all' && e.status !== custFilterStatus) return false;
      if (custFilterCustomerId && e.customer_id !== custFilterCustomerId) return false;
      if (custSearchText.trim()) {
        const term = custSearchText.trim().toLowerCase();
        const itemName = e.item_name || inventory.find(i => i.id === e.material_id)?.name || '';
        const custName = e.customer_name || customers.find(c => c.id === e.customer_id)?.name || '';
        if (!itemName.toLowerCase().includes(term) && !custName.toLowerCase().includes(term)) return false;
      }
      return true;
    });
  }, [custEntries, custFilterStatus, custFilterCustomerId, custSearchText, inventory, customers]);

  const resetCustForm = () => {
    setCustFormCustomerId('');
    setCustFormItemId('');
    setCustFormActualPrice('');
    setCustFormFkPrice('');
    setCustFormStatus('active');
    setCustItemSearch('');
    setCustEditingEntry(null);
  };

  const openNewCustForm = () => {
    resetCustForm();
    setCustShowForm(true);
  };

  const openEditCustForm = (entry: CustomerPriceMasterEntry) => {
    setCustEditingEntry(entry);
    setCustFormCustomerId(entry.customer_id);
    setCustFormItemId(entry.material_id);
    const item = inventory.find(i => i.id === entry.material_id);
    setCustItemSearch(item?.name || entry.item_name || '');
    setCustFormActualPrice(entry.special_price != null ? String(entry.special_price) : '');
    setCustFormFkPrice(entry.fk_price != null ? String(entry.fk_price) : '');
    setCustFormStatus(entry.status || 'active');
    setCustShowForm(true);
  };

  const doSaveCustEntry = async (actualPrice?: number, fkPrice?: number) => {
    if (!currentUser) return;
    const item = inventory.find(i => i.id === custFormItemId);
    const customer = customers.find(c => c.id === custFormCustomerId);

    const entry: CustomerPriceMasterEntry = {
      id: custEditingEntry?.id || crypto.randomUUID(),
      organization_id: currentUser.organization_id,
      customer_id: custFormCustomerId,
      material_id: custFormItemId,
      special_price: actualPrice,
      fk_price: fkPrice,
      discount_percent: 0,
      status: custFormStatus,
      item_name: item?.name || '',
      customer_name: customer?.name || '',
      created_at: custEditingEntry?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: custEditingEntry?.created_by || currentUser.full_name,
      modified_by: currentUser.full_name,
      modified_at: new Date().toISOString(),
    };

    setCustSaving(true);
    try {
      await savePriceMasterEntry(entry, currentUser);
      addNotification(custEditingEntry ? 'Customer Price Master updated' : 'Customer Price Master entry saved', 'success');
      setCustShowForm(false);
      resetCustForm();
      await loadCustEntries();
    } catch (e: any) {
      addNotification(e?.message || 'Failed to save Customer Price entry', 'error');
    } finally {
      setCustSaving(false);
    }
  };

  const handleSaveCustEntry = async () => {
    if (!currentUser) return;
    if (!custFormCustomerId) return addNotification('Please select a customer', 'error');
    if (!custFormItemId) return addNotification('Please select an inventory item', 'error');
    if (!custFormActualPrice && !custFormFkPrice)
      return addNotification('At least one price (Customer Rate or FK Rate) must be provided', 'error');

    const actualPrice = custFormActualPrice ? parseFloat(custFormActualPrice) : undefined;
    const fkPrice = custFormFkPrice ? parseFloat(custFormFkPrice) : undefined;

    if (actualPrice !== undefined && actualPrice < 0)
      return addNotification('Customer selling rate cannot be negative', 'error');
    if (fkPrice !== undefined && fkPrice < 0)
      return addNotification('FK rate cannot be negative', 'error');

    // MRP Warning Check against latest batch
    const latestBatch = getLatestBatchForItem(custFormItemId);
    const latestMrp = latestBatch ? Number(latestBatch.mrp || 0) : 0;
    const gstPercent = custSelectedItem ? Number(custSelectedItem.gstPercent || 0) : 0;

    let warningMessage = '';
    let enteredText = '';

    if (latestMrp > 0) {
      if (actualPrice !== undefined) {
        const actualPriceInclGst = round2(actualPrice * (1 + gstPercent / 100));
        if (actualPrice > latestMrp || actualPriceInclGst > latestMrp) {
          warningMessage = `The entered customer price (₹${actualPrice.toFixed(2)}${gstPercent > 0 ? ` + GST = ₹${actualPriceInclGst.toFixed(2)}` : ''}) exceeds the MRP of the latest batch (₹${latestMrp.toFixed(2)}).`;
          enteredText = `₹${actualPrice.toFixed(2)}${gstPercent > 0 ? ` (Incl. GST: ₹${actualPriceInclGst.toFixed(2)})` : ''}`;
        }
      }
      if (!warningMessage && fkPrice !== undefined) {
        const fkPriceInclGst = round2(fkPrice * (1 + gstPercent / 100));
        if (fkPrice > latestMrp || fkPriceInclGst > latestMrp) {
          warningMessage = `The entered FK rate (₹${fkPrice.toFixed(2)}${gstPercent > 0 ? ` + GST = ₹${fkPriceInclGst.toFixed(2)}` : ''}) exceeds the MRP of the latest batch (₹${latestMrp.toFixed(2)}).`;
          enteredText = `₹${fkPrice.toFixed(2)}${gstPercent > 0 ? ` (Incl. GST: ₹${fkPriceInclGst.toFixed(2)})` : ''}`;
        }
      }
    }

    if (warningMessage) {
      setMrpWarningModal({
        isOpen: true,
        title: 'Warning: Price Exceeds Latest Batch MRP',
        message: warningMessage,
        enteredPriceText: enteredText,
        latestMrpText: `₹${latestMrp.toFixed(2)}`,
        onConfirm: () => doSaveCustEntry(actualPrice, fkPrice),
      });
      return;
    }

    await doSaveCustEntry(actualPrice, fkPrice);
  };

  const handleToggleCustStatus = async (entry: CustomerPriceMasterEntry) => {
    if (!currentUser) return;
    const newStatus = entry.status === 'active' ? 'inactive' : 'active';
    try {
      await updatePriceMasterStatus(entry.id, newStatus, currentUser);
      addNotification(`Customer price entry marked ${newStatus}`, 'success');
      await loadCustEntries();
    } catch (e: any) {
      addNotification(e?.message || 'Failed to update status', 'error');
    }
  };

  // Customer preview math
  const custItemGst = custSelectedItem ? Number(custSelectedItem.gstPercent || 0) : 0;
  const custDefaultMrp = custSelectedItem ? Number(custSelectedItem.mrp || 0) : 0;
  const custDefaultExGst = custSelectedItem
    ? (Number(custSelectedItem.rateA || custSelectedItem.ptr || 0) > 0
        ? Number(custSelectedItem.rateA || custSelectedItem.ptr)
        : calculateRateExcludingGst(custDefaultMrp, custItemGst))
    : 0;
  const custActualNum = custFormActualPrice ? parseFloat(custFormActualPrice) : undefined;
  const custFkNum = custFormFkPrice ? parseFloat(custFormFkPrice) : undefined;

  const custActiveExGst = custActualNum ?? custDefaultExGst;
  const custPosLineTotal = custActiveExGst * (1 + custItemGst / 100);
  const custPrintRateExGst = custFkNum ?? custActiveExGst;
  const custPrintTotal = custPrintRateExGst * (1 + custItemGst / 100);

  // ---------------------------------------------------------------------------
  // Material-Wise Handlers & Computed States
  // ---------------------------------------------------------------------------
  const matMatchingItems = useMemo(() => {
    if (!matItemSearch.trim()) return [];
    return inventory
      .filter(i => i.is_active !== false && String(i.is_active) !== '0')
      .filter(i => fuzzyMatch(i.name, matItemSearch) || fuzzyMatch(i.code || '', matItemSearch))
      .slice(0, 10);
  }, [inventory, matItemSearch]);

  const matSelectedItem = useMemo(
    () => inventory.find(i => i.id === matFormItemId),
    [inventory, matFormItemId]
  );

  const filteredMatEntries = useMemo(() => {
    return matEntries.filter(e => {
      if (matFilterStatus !== 'all' && e.status !== matFilterStatus) return false;
      if (matSearchText.trim()) {
        const term = matSearchText.trim().toLowerCase();
        const itemName = e.item_name || inventory.find(i => i.id === e.material_id)?.name || '';
        if (!itemName.toLowerCase().includes(term)) return false;
      }
      return true;
    });
  }, [matEntries, matFilterStatus, matSearchText, inventory]);

  const resetMatForm = () => {
    setMatFormItemId('');
    setMatFormPrice('');
    setMatFormStatus('active');
    setMatItemSearch('');
    setMatEditingEntry(null);
  };

  const openNewMatForm = () => {
    resetMatForm();
    setMatShowForm(true);
  };

  const openEditMatForm = (entry: MaterialPriceMasterEntry) => {
    setMatEditingEntry(entry);
    setMatFormItemId(entry.material_id);
    const item = inventory.find(i => i.id === entry.material_id);
    setMatItemSearch(item?.name || entry.item_name || '');
    setMatFormPrice(entry.price != null ? String(entry.price) : '');
    setMatFormStatus(entry.status || 'active');
    setMatShowForm(true);
  };

  const doSaveMatEntry = async (price: number) => {
    if (!currentUser) return;
    const item = inventory.find(i => i.id === matFormItemId);

    const entry: MaterialPriceMasterEntry = {
      id: matEditingEntry?.id || crypto.randomUUID(),
      organization_id: currentUser.organization_id,
      material_id: matFormItemId,
      price,
      status: matFormStatus,
      item_name: item?.name || '',
      created_at: matEditingEntry?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: matEditingEntry?.created_by || currentUser.full_name,
      modified_by: currentUser.full_name,
      modified_at: new Date().toISOString(),
    };

    setMatSaving(true);
    try {
      await saveMaterialPriceMasterEntry(entry, currentUser);
      addNotification(matEditingEntry ? 'Material Price Master updated' : 'Material Price Master entry saved', 'success');
      setMatShowForm(false);
      resetMatForm();
      await loadMatEntries();
    } catch (e: any) {
      addNotification(e?.message || 'Failed to save Material Price entry', 'error');
    } finally {
      setMatSaving(false);
    }
  };

  const handleSaveMatEntry = async () => {
    if (!currentUser) return;
    if (!matFormItemId) return addNotification('Please select a material / inventory item', 'error');
    if (!matFormPrice || isNaN(parseFloat(matFormPrice)))
      return addNotification('Please enter a valid material selling rate', 'error');

    const price = parseFloat(matFormPrice);
    if (price < 0) return addNotification('Material selling rate cannot be negative', 'error');

    // MRP Warning Check against latest batch
    const latestBatch = getLatestBatchForItem(matFormItemId);
    const latestMrp = latestBatch ? Number(latestBatch.mrp || 0) : 0;
    const gstPercent = matSelectedItem ? Number(matSelectedItem.gstPercent || 0) : 0;

    let warningMessage = '';
    let enteredText = '';

    if (latestMrp > 0) {
      const priceInclGst = round2(price * (1 + gstPercent / 100));
      if (price > latestMrp || priceInclGst > latestMrp) {
        warningMessage = `The entered material price (₹${price.toFixed(2)}${gstPercent > 0 ? ` + GST = ₹${priceInclGst.toFixed(2)}` : ''}) exceeds the MRP of the latest batch (₹${latestMrp.toFixed(2)}).`;
        enteredText = `₹${price.toFixed(2)}${gstPercent > 0 ? ` (Incl. GST: ₹${priceInclGst.toFixed(2)})` : ''}`;
      }
    }

    if (warningMessage) {
      setMrpWarningModal({
        isOpen: true,
        title: 'Warning: Material Price Exceeds Latest Batch MRP',
        message: warningMessage,
        enteredPriceText: enteredText,
        latestMrpText: `₹${latestMrp.toFixed(2)}`,
        onConfirm: () => doSaveMatEntry(price),
      });
      return;
    }

    await doSaveMatEntry(price);
  };

  const handleToggleMatStatus = async (entry: MaterialPriceMasterEntry) => {
    if (!currentUser) return;
    const newStatus = entry.status === 'active' ? 'inactive' : 'active';
    try {
      await updateMaterialPriceMasterStatus(entry.id, newStatus, currentUser);
      addNotification(`Material price entry marked ${newStatus}`, 'success');
      await loadMatEntries();
    } catch (e: any) {
      addNotification(e?.message || 'Failed to update status', 'error');
    }
  };

  // Material preview math
  const matItemGst = matSelectedItem ? Number(matSelectedItem.gstPercent || 0) : 0;
  const matDefaultMrp = matSelectedItem ? Number(matSelectedItem.mrp || 0) : 0;
  const matDefaultExGst = matSelectedItem
    ? (Number(matSelectedItem.rateA || matSelectedItem.ptr || 0) > 0
        ? Number(matSelectedItem.rateA || matSelectedItem.ptr)
        : calculateRateExcludingGst(matDefaultMrp, matItemGst))
    : 0;
  const matPriceNum = matFormPrice ? parseFloat(matFormPrice) : 0;
  const matPosLineTotal = matPriceNum * (1 + matItemGst / 100);

  return (
    <div className="flex flex-col h-full bg-app-bg overflow-hidden">
      {/* Header */}
      <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
        <span className="text-[10px] font-black uppercase tracking-widest">Price Master</span>
        <span className="text-[10px] text-accent font-bold uppercase">
          {activeTab === 'customer_wise'
            ? `${filteredCustEntries.length} Record${filteredCustEntries.length !== 1 ? 's' : ''}`
            : `${filteredMatEntries.length} Record${filteredMatEntries.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Tab Switcher */}
      <div className="bg-white border-b border-gray-300 flex gap-0 flex-shrink-0">
        <button
          onClick={() => setActiveTab('customer_wise')}
          className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all border-r border-gray-300 ${
            activeTab === 'customer_wise'
              ? 'bg-primary text-white'
              : 'text-gray-500 hover:bg-gray-50'
          }`}
        >
          Customer-Wise Price Mapping
        </button>
        <button
          onClick={() => setActiveTab('material_wise')}
          className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all border-r border-gray-300 ${
            activeTab === 'material_wise'
              ? 'bg-primary text-white'
              : 'text-gray-500 hover:bg-gray-50'
          }`}
        >
          Material-Wise Price Mapping
        </button>
      </div>

      {/* Main Tab Content Container */}
      <div className="flex flex-1 overflow-hidden">
        {/* =================================================================== */}
        {/* TAB 1: CUSTOMER-WISE PRICE MASTER                                  */}
        {/* =================================================================== */}
        {activeTab === 'customer_wise' && (
          <div className="flex w-full overflow-hidden">
            {/* Left Table Panel */}
            <div className={`flex flex-col ${custShowForm ? 'w-3/5' : 'w-full'} overflow-hidden border-r border-gray-300 transition-all`}>
              {/* Toolbar */}
              <div className="p-2 bg-white border-b border-gray-200 flex gap-2 flex-wrap items-end flex-shrink-0">
                <div className="flex-1 min-w-48">
                  <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5">Search Material / Customer</label>
                  <input
                    className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                    placeholder="Type to search..."
                    value={custSearchText}
                    onChange={e => setCustSearchText(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5">Filter Customer</label>
                  <select
                    className="h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                    value={custFilterCustomerId}
                    onChange={e => setCustFilterCustomerId(e.target.value)}
                  >
                    <option value="">All Customers</option>
                    {customers.filter(c => c.is_active !== false).map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5">Status</label>
                  <select
                    className="h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                    value={custFilterStatus}
                    onChange={e => setCustFilterStatus(e.target.value as 'all' | 'active' | 'inactive')}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="all">All</option>
                  </select>
                </div>
                <button
                  onClick={openNewCustForm}
                  className="h-8 px-4 bg-primary text-white text-xs font-black uppercase hover:opacity-90 transition-opacity"
                >
                  + New Customer Price Entry
                </button>
              </div>

              {/* Table */}
              <div className="flex-1 overflow-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-gray-100 border-b border-gray-400 z-10">
                    <tr className="text-[10px] font-black uppercase text-gray-700 tracking-wide">
                      <th className="p-2 border-r border-gray-300 text-left">Material / Item</th>
                      <th className="p-2 border-r border-gray-300 text-left">Customer</th>
                      <th className="p-2 border-r border-gray-300 text-right w-28">Default Rate (Excl. GST)</th>
                      <th className="p-2 border-r border-gray-300 text-right w-28">Customer Rate (Excl. GST)</th>
                      <th className="p-2 border-r border-gray-300 text-right w-28">FK Rate (Excl. GST)</th>
                      <th className="p-2 border-r border-gray-300 text-center w-20">Status</th>
                      <th className="p-2 text-center w-28">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {custLoading ? (
                      <tr>
                        <td colSpan={7} className="p-8 text-center text-xs text-gray-500 font-bold">
                          Loading customer price entries...
                        </td>
                      </tr>
                    ) : filteredCustEntries.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-8 text-center text-xs text-gray-500 font-bold">
                          No customer price records found.{' '}
                          <button onClick={openNewCustForm} className="text-primary underline font-black">Add one now</button>
                        </td>
                      </tr>
                    ) : (
                      filteredCustEntries.map(entry => {
                        const item = inventory.find(i => i.id === entry.material_id);
                        const customer = customers.find(c => c.id === entry.customer_id);
                        const itemName = item?.name || entry.item_name || entry.material_id;
                        const custName = customer?.name || entry.customer_name || entry.customer_id;
                        return (
                          <tr
                            key={entry.id}
                            className={`border-b border-gray-200 h-10 hover:bg-yellow-50 transition-colors group ${
                              entry.status === 'inactive' ? 'opacity-50' : ''
                            }`}
                          >
                            <td className="p-2 border-r border-gray-200 font-bold text-gray-800">
                              <div>{itemName}</div>
                              {item?.code && <div className="text-[9px] text-gray-400 font-normal">{item.code}</div>}
                            </td>
                            <td className="p-2 border-r border-gray-200 text-gray-700 font-medium">{custName}</td>
                            <td className="p-2 border-r border-gray-200 text-right text-gray-500">
                              {item ? (
                                <div>
                                  ₹{calculateRateExcludingGst(Number(item.mrp || 0), Number(item.gstPercent || 0)).toFixed(2)}
                                  <div className="text-[9px] text-gray-400">MRP: ₹{Number(item.mrp || 0).toFixed(2)}</div>
                                </div>
                              ) : '—'}
                            </td>
                            <td className="p-2 border-r border-gray-200 text-right font-bold text-emerald-700">
                              {entry.special_price != null ? `₹${Number(entry.special_price).toFixed(2)}` : (
                                <span className="text-gray-400 font-normal text-[10px]">Not set</span>
                              )}
                            </td>
                            <td className="p-2 border-r border-gray-200 text-right font-bold text-purple-700">
                              {entry.fk_price != null ? `₹${Number(entry.fk_price).toFixed(2)}` : (
                                <span className="text-gray-400 font-normal text-[10px]">Not set</span>
                              )}
                            </td>
                            <td className="p-2 border-r border-gray-200 text-center">
                              <span className={`px-2 py-0.5 text-[9px] font-black uppercase rounded-sm ${
                                entry.status === 'active'
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-gray-100 text-gray-500'
                              }`}>
                                {entry.status}
                              </span>
                            </td>
                            <td className="p-2 text-center">
                              <div className="flex gap-1 justify-center">
                                <button
                                  onClick={() => openEditCustForm(entry)}
                                  className="px-2 py-1 text-[10px] font-black bg-primary text-white uppercase hover:opacity-80"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleToggleCustStatus(entry)}
                                  className={`px-2 py-1 text-[10px] font-black uppercase hover:opacity-80 ${
                                    entry.status === 'active'
                                      ? 'bg-red-100 text-red-700'
                                      : 'bg-green-100 text-green-700'
                                  }`}
                                >
                                  {entry.status === 'active' ? 'Deactivate' : 'Activate'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right Form Panel for Customer Wise */}
            {custShowForm && (
              <div className="w-2/5 flex flex-col bg-white overflow-y-auto flex-shrink-0 border-l border-gray-300">
                <div className="bg-gray-800 text-white px-4 py-2 flex items-center justify-between flex-shrink-0">
                  <span className="text-[10px] font-black uppercase tracking-widest">
                    {custEditingEntry ? 'Edit Customer Price Entry' : 'New Customer Price Entry'}
                  </span>
                  <button
                    onClick={() => { setCustShowForm(false); resetCustForm(); }}
                    className="text-gray-400 hover:text-white text-lg leading-none"
                  >
                    ×
                  </button>
                </div>

                <div className="p-4 flex flex-col gap-4">
                  {/* Customer Selection */}
                  <div>
                    <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">
                      Customer <span className="text-red-500">*</span>
                    </label>
                    <select
                      className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                      value={custFormCustomerId}
                      onChange={e => setCustFormCustomerId(e.target.value)}
                      disabled={!!custEditingEntry}
                    >
                      <option value="">Select Customer...</option>
                      {customers.filter(c => c.is_active !== false && c.is_blocked !== true).map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Material Search */}
                  <div>
                    <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">
                      Material / Item <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                        placeholder="Search by name or code..."
                        value={custItemSearch}
                        onChange={e => {
                          setCustItemSearch(e.target.value);
                          setCustFormItemId('');
                          setCustShowItemDropdown(true);
                        }}
                        onFocus={() => setCustShowItemDropdown(true)}
                        disabled={!!custEditingEntry}
                      />
                      {custShowItemDropdown && custMatchingItems.length > 0 && (
                        <div className="absolute z-20 w-full max-h-40 overflow-y-auto bg-white border border-gray-300 shadow-lg">
                          {custMatchingItems.map(item => (
                            <button
                              key={item.id}
                              type="button"
                              className="w-full text-left px-2 py-1.5 text-xs hover:bg-yellow-50 border-b border-gray-100"
                              onClick={() => {
                                setCustFormItemId(item.id);
                                setCustItemSearch(item.name);
                                setCustShowItemDropdown(false);
                              }}
                            >
                              <span className="font-bold">{item.name}</span>
                              {item.code && <span className="text-gray-400 ml-1">({item.code})</span>}
                              <span className="text-gray-500 ml-2 text-[10px]">MRP: ₹{Number(item.mrp || 0).toFixed(2)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Default Rate Info */}
                  {custSelectedItem && (
                    <div className="bg-gray-50 border border-gray-200 p-3 rounded-sm">
                      <div className="text-[9px] font-black uppercase text-gray-500 mb-1">Default Batch Rate (Excl. GST)</div>
                      <div className="text-xl font-black text-gray-800">₹{custDefaultExGst.toFixed(2)}</div>
                      <div className="text-[9px] text-gray-400 mt-0.5">MRP: ₹{custDefaultMrp.toFixed(2)} (GST {custItemGst}%)</div>
                    </div>
                  )}

                  {/* Customer Actual Rate */}
                  <div>
                    <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">
                      Customer Selling Rate (Excl. GST)
                      <span className="ml-1 text-[9px] text-gray-400 normal-case font-normal">— Optional</span>
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                      placeholder="Leave blank to use Default/Material Rate"
                      value={custFormActualPrice}
                      onChange={e => setCustFormActualPrice(e.target.value)}
                    />
                    <div className="text-[9px] text-emerald-600 mt-0.5">
                      Customer-specific rate excluding GST. Adds {custItemGst}% GST on top for POS bill line item.
                    </div>
                  </div>

                  {/* FK Price */}
                  <div>
                    <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">
                      FK Rate (Excl. GST)
                      <span className="ml-1 text-[9px] text-gray-400 normal-case font-normal">— Optional</span>
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50 border-purple-300"
                      placeholder="Leave blank if not applicable"
                      value={custFormFkPrice}
                      onChange={e => setCustFormFkPrice(e.target.value)}
                    />
                    <div className="text-[9px] text-purple-600 mt-0.5">
                      ⚑ Special rate automatically used for printed bill summary total (+ GST calculated on top).
                    </div>
                  </div>

                  {/* Status */}
                  <div>
                    <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">Status</label>
                    <div className="flex gap-3">
                      {(['active', 'inactive'] as const).map(s => (
                        <label key={s} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="custStatus"
                            value={s}
                            checked={custFormStatus === s}
                            onChange={() => setCustFormStatus(s)}
                            className="accent-primary"
                          />
                          <span className="text-xs font-bold uppercase">{s}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Preview */}
                  {(custSelectedItem || custFormActualPrice || custFormFkPrice) && (
                    <div className="bg-emerald-50/70 border border-emerald-200 p-3 rounded-sm">
                      <div className="text-[9px] font-black uppercase text-emerald-800 mb-2">Pricing Preview (Qty = 1)</div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-[9px] text-gray-500 uppercase font-bold">POS Line Total (Incl. GST)</div>
                          <div className="font-black text-gray-800 text-lg">₹{round2(custPosLineTotal).toFixed(2)}</div>
                          <div className="text-[9px] text-gray-500">
                            Rate ₹{round2(custActiveExGst).toFixed(2)} + {custItemGst}% GST
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] text-gray-500 uppercase font-bold">Printed Invoice Total</div>
                          <div className={`font-black text-lg ${custFkNum != null ? 'text-purple-700' : 'text-gray-800'}`}>
                            ₹{round2(custPrintTotal).toFixed(2)}
                          </div>
                          <div className="text-[9px] text-gray-500">
                            {custFkNum != null
                              ? `⚑ FK Rate ₹${round2(custPrintRateExGst).toFixed(2)} + ${custItemGst}% GST`
                              : 'Same as line item'}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Form Actions */}
                  <div className="flex gap-2 pt-2 border-t border-gray-200">
                    <button
                      onClick={handleSaveCustEntry}
                      disabled={custSaving}
                      className="flex-1 h-9 bg-primary text-white text-xs font-black uppercase hover:opacity-90 disabled:opacity-50"
                    >
                      {custSaving ? 'Saving...' : custEditingEntry ? 'Update Entry' : 'Save Entry'}
                    </button>
                    <button
                      onClick={() => { setCustShowForm(false); resetCustForm(); }}
                      className="h-9 px-4 bg-gray-200 text-gray-700 text-xs font-black uppercase hover:bg-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 2: MATERIAL-WISE PRICE MASTER                                  */}
        {/* =================================================================== */}
        {activeTab === 'material_wise' && (
          <div className="flex w-full overflow-hidden">
            {/* Left Table Panel */}
            <div className={`flex flex-col ${matShowForm ? 'w-3/5' : 'w-full'} overflow-hidden border-r border-gray-300 transition-all`}>
              {/* Toolbar */}
              <div className="p-2 bg-white border-b border-gray-200 flex gap-2 flex-wrap items-end flex-shrink-0">
                <div className="flex-1 min-w-48">
                  <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5">Search Material / Item</label>
                  <input
                    className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                    placeholder="Type material name or code..."
                    value={matSearchText}
                    onChange={e => setMatSearchText(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5">Status</label>
                  <select
                    className="h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                    value={matFilterStatus}
                    onChange={e => setMatFilterStatus(e.target.value as 'all' | 'active' | 'inactive')}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="all">All</option>
                  </select>
                </div>
                <button
                  onClick={openNewMatForm}
                  className="h-8 px-4 bg-primary text-white text-xs font-black uppercase hover:opacity-90 transition-opacity"
                >
                  + New Material Price Entry
                </button>
              </div>

              {/* Table */}
              <div className="flex-1 overflow-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-gray-100 border-b border-gray-400 z-10">
                    <tr className="text-[10px] font-black uppercase text-gray-700 tracking-wide">
                      <th className="p-2 border-r border-gray-300 text-left">Material / Item</th>
                      <th className="p-2 border-r border-gray-300 text-right w-36">Default Inventory Rate (Excl. GST)</th>
                      <th className="p-2 border-r border-gray-300 text-right w-36">Material Selling Rate (Excl. GST)</th>
                      <th className="p-2 border-r border-gray-300 text-right w-32">POS Total (Incl. GST)</th>
                      <th className="p-2 border-r border-gray-300 text-center w-20">Status</th>
                      <th className="p-2 text-center w-28">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matLoading ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-xs text-gray-500 font-bold">
                          Loading material price entries...
                        </td>
                      </tr>
                    ) : filteredMatEntries.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-xs text-gray-500 font-bold">
                          No material price records found.{' '}
                          <button onClick={openNewMatForm} className="text-primary underline font-black">Add one now</button>
                        </td>
                      </tr>
                    ) : (
                      filteredMatEntries.map(entry => {
                        const item = inventory.find(i => i.id === entry.material_id);
                        const itemName = item?.name || entry.item_name || entry.material_id;
                        const itemGst = item ? Number(item.gstPercent || 0) : 0;
                        const matSellingRate = Number(entry.price || 0);
                        const matLineTotal = matSellingRate * (1 + itemGst / 100);

                        return (
                          <tr
                            key={entry.id}
                            className={`border-b border-gray-200 h-10 hover:bg-yellow-50 transition-colors group ${
                              entry.status === 'inactive' ? 'opacity-50' : ''
                            }`}
                          >
                            <td className="p-2 border-r border-gray-200 font-bold text-gray-800">
                              <div>{itemName}</div>
                              {item?.code && <div className="text-[9px] text-gray-400 font-normal">{item.code}</div>}
                            </td>
                            <td className="p-2 border-r border-gray-200 text-right text-gray-500">
                              {item ? (
                                <div>
                                  ₹{calculateRateExcludingGst(Number(item.mrp || 0), itemGst).toFixed(2)}
                                  <div className="text-[9px] text-gray-400">MRP: ₹{Number(item.mrp || 0).toFixed(2)}</div>
                                </div>
                              ) : '—'}
                            </td>
                            <td className="p-2 border-r border-gray-200 text-right font-black text-purple-700 text-sm">
                              ₹{matSellingRate.toFixed(2)}
                            </td>
                            <td className="p-2 border-r border-gray-200 text-right font-bold text-gray-800">
                              ₹{round2(matLineTotal).toFixed(2)}
                              <div className="text-[9px] text-gray-400">(GST {itemGst}%)</div>
                            </td>
                            <td className="p-2 border-r border-gray-200 text-center">
                              <span className={`px-2 py-0.5 text-[9px] font-black uppercase rounded-sm ${
                                entry.status === 'active'
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-gray-100 text-gray-500'
                              }`}>
                                {entry.status}
                              </span>
                            </td>
                            <td className="p-2 text-center">
                              <div className="flex gap-1 justify-center">
                                <button
                                  onClick={() => openEditMatForm(entry)}
                                  className="px-2 py-1 text-[10px] font-black bg-primary text-white uppercase hover:opacity-80"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleToggleMatStatus(entry)}
                                  className={`px-2 py-1 text-[10px] font-black uppercase hover:opacity-80 ${
                                    entry.status === 'active'
                                      ? 'bg-red-100 text-red-700'
                                      : 'bg-green-100 text-green-700'
                                  }`}
                                >
                                  {entry.status === 'active' ? 'Deactivate' : 'Activate'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right Form Panel for Material Wise */}
            {matShowForm && (
              <div className="w-2/5 flex flex-col bg-white overflow-y-auto flex-shrink-0 border-l border-gray-300">
                <div className="bg-gray-800 text-white px-4 py-2 flex items-center justify-between flex-shrink-0">
                  <span className="text-[10px] font-black uppercase tracking-widest">
                    {matEditingEntry ? 'Edit Material Price Entry' : 'New Material Price Entry'}
                  </span>
                  <button
                    onClick={() => { setMatShowForm(false); resetMatForm(); }}
                    className="text-gray-400 hover:text-white text-lg leading-none"
                  >
                    ×
                  </button>
                </div>

                <div className="p-4 flex flex-col gap-4">
                  {/* Material Search */}
                  <div>
                    <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">
                      Material / Inventory Item <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                        placeholder="Search material by name or code..."
                        value={matItemSearch}
                        onChange={e => {
                          setMatItemSearch(e.target.value);
                          setMatFormItemId('');
                          setMatShowItemDropdown(true);
                        }}
                        onFocus={() => setMatShowItemDropdown(true)}
                        disabled={!!matEditingEntry}
                      />
                      {matShowItemDropdown && matMatchingItems.length > 0 && (
                        <div className="absolute z-20 w-full max-h-40 overflow-y-auto bg-white border border-gray-300 shadow-lg">
                          {matMatchingItems.map(item => (
                            <button
                              key={item.id}
                              type="button"
                              className="w-full text-left px-2 py-1.5 text-xs hover:bg-yellow-50 border-b border-gray-100"
                              onClick={() => {
                                setMatFormItemId(item.id);
                                setMatItemSearch(item.name);
                                setMatShowItemDropdown(false);
                              }}
                            >
                              <span className="font-bold">{item.name}</span>
                              {item.code && <span className="text-gray-400 ml-1">({item.code})</span>}
                              <span className="text-gray-500 ml-2 text-[10px]">MRP: ₹{Number(item.mrp || 0).toFixed(2)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Default Rate Info */}
                  {matSelectedItem && (
                    <div className="bg-gray-50 border border-gray-200 p-3 rounded-sm">
                      <div className="text-[9px] font-black uppercase text-gray-500 mb-1">Default Batch Selling Rate (Excl. GST)</div>
                      <div className="text-xl font-black text-gray-800">₹{matDefaultExGst.toFixed(2)}</div>
                      <div className="text-[9px] text-gray-400 mt-0.5">MRP: ₹{matDefaultMrp.toFixed(2)} (GST {matItemGst}%)</div>
                    </div>
                  )}

                  {/* Fixed Material Selling Rate */}
                  <div>
                    <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">
                      Material Selling Rate (Excl. GST) <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50 border-purple-300"
                      placeholder="Enter fixed selling rate excluding GST"
                      value={matFormPrice}
                      onChange={e => setMatFormPrice(e.target.value)}
                    />
                    <div className="text-[9px] text-purple-600 mt-0.5">
                      This rate applies for <strong className="font-bold">walking customers & registered customers</strong> across all inventory batches when Material-Wise Price is prioritized.
                    </div>
                  </div>

                  {/* Status */}
                  <div>
                    <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">Status</label>
                    <div className="flex gap-3">
                      {(['active', 'inactive'] as const).map(s => (
                        <label key={s} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="matStatus"
                            value={s}
                            checked={matFormStatus === s}
                            onChange={() => setMatFormStatus(s)}
                            className="accent-primary"
                          />
                          <span className="text-xs font-bold uppercase">{s}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Pricing Preview */}
                  {(matSelectedItem || matFormPrice) && (
                    <div className="bg-purple-50 border border-purple-200 p-3 rounded-sm">
                      <div className="text-[9px] font-black uppercase text-purple-800 mb-2">Pricing Preview (Qty = 1)</div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-[9px] text-gray-500 uppercase font-bold">Base Selling Rate</div>
                          <div className="font-black text-purple-900 text-lg">₹{round2(matPriceNum).toFixed(2)}</div>
                          <div className="text-[9px] text-gray-500">Excluding GST</div>
                        </div>
                        <div>
                          <div className="text-[9px] text-gray-500 uppercase font-bold">Bill Total (Incl. GST)</div>
                          <div className="font-black text-gray-800 text-lg">₹{round2(matPosLineTotal).toFixed(2)}</div>
                          <div className="text-[9px] text-gray-500">
                            Includes {matItemGst}% GST (₹{round2(matPriceNum * matItemGst / 100).toFixed(2)})
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Form Actions */}
                  <div className="flex gap-2 pt-2 border-t border-gray-200">
                    <button
                      onClick={handleSaveMatEntry}
                      disabled={matSaving}
                      className="flex-1 h-9 bg-primary text-white text-xs font-black uppercase hover:opacity-90 disabled:opacity-50"
                    >
                      {matSaving ? 'Saving...' : matEditingEntry ? 'Update Material Entry' : 'Save Material Entry'}
                    </button>
                    <button
                      onClick={() => { setMatShowForm(false); resetMatForm(); }}
                      className="h-9 px-4 bg-gray-200 text-gray-700 text-xs font-black uppercase hover:bg-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* =================================================================== */}
      {/* MRP EXCEEDED CONFIRMATION WARNING MODAL                             */}
      {/* =================================================================== */}
      {mrpWarningModal?.isOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded shadow-2xl max-w-md w-full overflow-hidden border border-gray-400">
            {/* Header matching theme */}
            <div className="bg-primary text-white h-9 px-4 flex items-center justify-between border-b border-gray-600 shadow-sm">
              <div className="flex items-center gap-2 font-black uppercase text-xs tracking-wider">
                <span className="text-amber-300 text-sm">⚠️</span> {mrpWarningModal.title}
              </div>
              <button
                onClick={() => setMrpWarningModal(null)}
                className="text-white/80 hover:text-white font-bold text-sm leading-none"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="p-4 space-y-3 text-xs text-gray-700">
              <p className="font-bold text-gray-900 leading-relaxed text-xs">
                {mrpWarningModal.message}
              </p>

              <div className="bg-amber-50 border border-amber-300 rounded-sm p-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-[9px] uppercase font-black text-amber-800">Entered Price</div>
                  <div className="font-black text-amber-950 text-sm">{mrpWarningModal.enteredPriceText}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase font-black text-gray-600">Latest Batch MRP</div>
                  <div className="font-black text-gray-900 text-sm">{mrpWarningModal.latestMrpText}</div>
                </div>
              </div>

              <p className="text-[10px] text-gray-500 italic">
                You can proceed if this rate is intentional, or click <strong>Change Price</strong> to adjust your values.
              </p>
            </div>

            {/* Actions matching theme */}
            <div className="bg-gray-100 px-4 py-3 border-t border-gray-300 flex justify-end gap-2">
              <button
                onClick={() => setMrpWarningModal(null)}
                className="h-8 px-4 bg-gray-200 text-gray-700 text-xs font-black uppercase hover:bg-gray-300 transition-colors"
              >
                Change Price
              </button>
              <button
                onClick={() => {
                  const confirmAction = mrpWarningModal.onConfirm;
                  setMrpWarningModal(null);
                  confirmAction();
                }}
                className="h-8 px-4 bg-primary text-white text-xs font-black uppercase hover:opacity-90 transition-opacity"
              >
                Yes, Proceed & Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PriceMaster;
