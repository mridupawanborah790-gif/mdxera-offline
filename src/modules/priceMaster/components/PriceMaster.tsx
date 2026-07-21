import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Card from '@core/components/ui/Card';
import type { RegisteredPharmacy, Customer, InventoryItem, CustomerPriceMasterEntry } from '@core/types';
import {
  fetchPriceMaster,
  savePriceMasterEntry,
  updatePriceMasterStatus,
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
  const [entries, setEntries] = useState<CustomerPriceMasterEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<CustomerPriceMasterEntry | null>(null);
  const [searchText, setSearchText] = useState('');
  const [filterCustomerId, setFilterCustomerId] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('active');

  // Form state
  const [formCustomerId, setFormCustomerId] = useState('');
  const [formItemId, setFormItemId] = useState('');
  const [formActualPrice, setFormActualPrice] = useState('');
  const [formFkPrice, setFormFkPrice] = useState('');
  const [formStatus, setFormStatus] = useState<'active' | 'inactive'>('active');
  const [itemSearch, setItemSearch] = useState('');
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadEntries = useCallback(async () => {
    if (!currentUser) return;
    setLoading(true);
    try {
      const data = await fetchPriceMaster(currentUser);
      setEntries(data);
    } catch (e: any) {
      addNotification(e?.message || 'Failed to load Price Master', 'error');
    } finally {
      setLoading(false);
    }
  }, [currentUser, addNotification]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  // Inventory search for form
  const matchingItems = useMemo(() => {
    if (!itemSearch.trim()) return [];
    return inventory
      .filter(i => i.is_active !== false && String(i.is_active) !== '0')
      .filter(i => fuzzyMatch(i.name, itemSearch) || fuzzyMatch(i.code || '', itemSearch))
      .slice(0, 10);
  }, [inventory, itemSearch]);

  const selectedItem = useMemo(
    () => inventory.find(i => i.id === formItemId),
    [inventory, formItemId]
  );

  const selectedCustomerName = useMemo(
    () => customers.find(c => c.id === formCustomerId)?.name || '',
    [customers, formCustomerId]
  );

  // Filtered entries for display
  const filteredEntries = useMemo(() => {
    return entries.filter(e => {
      if (filterStatus !== 'all' && e.status !== filterStatus) return false;
      if (filterCustomerId && e.customer_id !== filterCustomerId) return false;
      if (searchText.trim()) {
        const term = searchText.trim().toLowerCase();
        const itemName = e.item_name || inventory.find(i => i.id === e.material_id)?.name || '';
        const custName = e.customer_name || customers.find(c => c.id === e.customer_id)?.name || '';
        if (!itemName.toLowerCase().includes(term) && !custName.toLowerCase().includes(term)) return false;
      }
      return true;
    });
  }, [entries, filterStatus, filterCustomerId, searchText, inventory, customers]);

  const resetForm = () => {
    setFormCustomerId('');
    setFormItemId('');
    setFormActualPrice('');
    setFormFkPrice('');
    setFormStatus('active');
    setItemSearch('');
    setEditingEntry(null);
  };

  const openNewForm = () => {
    resetForm();
    setShowForm(true);
  };

  const openEditForm = (entry: CustomerPriceMasterEntry) => {
    setEditingEntry(entry);
    setFormCustomerId(entry.customer_id);
    setFormItemId(entry.material_id);
    const item = inventory.find(i => i.id === entry.material_id);
    setItemSearch(item?.name || entry.item_name || '');
    setFormActualPrice(entry.special_price != null ? String(entry.special_price) : '');
    setFormFkPrice(entry.fk_price != null ? String(entry.fk_price) : '');
    setFormStatus(entry.status || 'active');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!currentUser) return;
    if (!formCustomerId) return addNotification('Please select a customer', 'error');
    if (!formItemId) return addNotification('Please select an inventory item', 'error');
    if (!formActualPrice && !formFkPrice)
      return addNotification('At least one price (Actual Price or FK Price) must be provided', 'error');

    const actualPrice = formActualPrice ? parseFloat(formActualPrice) : undefined;
    const fkPrice = formFkPrice ? parseFloat(formFkPrice) : undefined;

    if (actualPrice !== undefined && actualPrice < 0)
      return addNotification('Actual price cannot be negative', 'error');
    if (fkPrice !== undefined && fkPrice < 0)
      return addNotification('FK price cannot be negative', 'error');

    const item = inventory.find(i => i.id === formItemId);
    const customer = customers.find(c => c.id === formCustomerId);

    const entry: CustomerPriceMasterEntry = {
      id: editingEntry?.id || crypto.randomUUID(),
      organization_id: currentUser.organization_id,
      customer_id: formCustomerId,
      material_id: formItemId,
      special_price: actualPrice,
      fk_price: fkPrice,
      discount_percent: 0,
      status: formStatus,
      item_name: item?.name || '',
      customer_name: customer?.name || '',
      created_at: editingEntry?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: editingEntry?.created_by || currentUser.full_name,
      modified_by: currentUser.full_name,
      modified_at: new Date().toISOString(),
    };

    setSaving(true);
    try {
      await savePriceMasterEntry(entry, currentUser);
      addNotification(editingEntry ? 'Price Master updated' : 'Price Master entry saved', 'success');
      setShowForm(false);
      resetForm();
      await loadEntries();
    } catch (e: any) {
      addNotification(e?.message || 'Failed to save entry', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (entry: CustomerPriceMasterEntry) => {
    if (!currentUser) return;
    const newStatus = entry.status === 'active' ? 'inactive' : 'active';
    try {
      await updatePriceMasterStatus(entry.id, newStatus, currentUser);
      addNotification(`Entry marked ${newStatus}`, 'success');
      await loadEntries();
    } catch (e: any) {
      addNotification(e?.message || 'Failed to update status', 'error');
    }
  };

  const calculateRateExcludingGst = (mrp: number, gstPercent: number): number => {
    const safeMrp = Number(mrp) || 0;
    const safeGst = Number(gstPercent) || 0;
    if (safeMrp <= 0) return 0;
    if (safeGst <= 0) return safeMrp;
    return round2(safeMrp / (1 + safeGst / 100));
  };

  // Pricing preview for the form
  const itemGstPercent = selectedItem ? Number(selectedItem.gstPercent || 0) : 0;
  const defaultMrp = selectedItem ? Number(selectedItem.mrp || 0) : 0;
  const defaultExGstRate = selectedItem
    ? (Number(selectedItem.rateA || selectedItem.ptr || 0) > 0
        ? Number(selectedItem.rateA || selectedItem.ptr)
        : calculateRateExcludingGst(defaultMrp, itemGstPercent))
    : 0;

  const actualPriceNum = formActualPrice ? parseFloat(formActualPrice) : undefined;
  const fkPriceNum = formFkPrice ? parseFloat(formFkPrice) : undefined;

  const activeExGstRate = actualPriceNum ?? defaultExGstRate;
  const posLineTotalInclGst = activeExGstRate * (1 + itemGstPercent / 100);
  const printRateExGst = fkPriceNum ?? activeExGstRate;
  const printTotalInclGst = printRateExGst * (1 + itemGstPercent / 100);

  return (
    <div className="flex flex-col h-full bg-app-bg overflow-hidden">
      {/* Header */}
      <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
        <span className="text-[10px] font-black uppercase tracking-widest">Customer Price Master</span>
        <span className="text-[10px] text-accent font-bold uppercase">
          {filteredEntries.length} Record{filteredEntries.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: Table */}
        <div className={`flex flex-col ${showForm ? 'w-3/5' : 'w-full'} overflow-hidden border-r border-gray-300 transition-all`}>
          {/* Toolbar */}
          <div className="p-2 bg-white border-b border-gray-200 flex gap-2 flex-wrap items-end flex-shrink-0">
            <div className="flex-1 min-w-48">
              <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5">Search Material / Customer</label>
              <input
                className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                placeholder="Type to search..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
              />
            </div>
            <div>
              <label className="text-[9px] font-bold text-gray-500 uppercase block mb-0.5">Filter Customer</label>
              <select
                className="h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                value={filterCustomerId}
                onChange={e => setFilterCustomerId(e.target.value)}
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
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value as 'all' | 'active' | 'inactive')}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="all">All</option>
              </select>
            </div>
            <button
              onClick={openNewForm}
              className="h-8 px-4 bg-primary text-white text-xs font-black uppercase hover:opacity-90 transition-opacity"
            >
              + New Entry
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
                {loading ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-xs text-gray-500 font-bold">
                      Loading...
                    </td>
                  </tr>
                ) : filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-xs text-gray-500 font-bold">
                      No price master records found.{' '}
                      <button onClick={openNewForm} className="text-primary underline">Add one now</button>
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map(entry => {
                    const item = inventory.find(i => i.id === entry.material_id);
                    const customer = customers.find(c => c.id === entry.customer_id);
                    const itemName = item?.name || entry.item_name || entry.material_id;
                    const custName = customer?.name || entry.customer_name || entry.customer_id;
                    const defaultMrp = item ? Number(item.mrp || 0) : null;
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
                        <td className="p-2 border-r border-gray-200 text-gray-700">{custName}</td>
                        <td className="p-2 border-r border-gray-200 text-right text-gray-500">
                          {item ? (
                            <div>
                              ₹{calculateRateExcludingGst(Number(item.mrp || 0), Number(item.gstPercent || 0)).toFixed(2)}
                              <div className="text-[9px] text-gray-400">MRP: ₹{Number(item.mrp || 0).toFixed(2)}</div>
                            </div>
                          ) : '—'}
                        </td>
                        <td className="p-2 border-r border-gray-200 text-right font-bold text-blue-700">
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
                          <div className="flex gap-1 justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => openEditForm(entry)}
                              className="px-2 py-1 text-[10px] font-black bg-primary text-white uppercase hover:opacity-80"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleToggleStatus(entry)}
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

        {/* Right: Form Panel */}
        {showForm && (
          <div className="w-2/5 flex flex-col bg-white overflow-y-auto flex-shrink-0">
            {/* Form Header */}
            <div className="bg-gray-800 text-white px-4 py-2 flex items-center justify-between flex-shrink-0">
              <span className="text-[10px] font-black uppercase tracking-widest">
                {editingEntry ? 'Edit Price Entry' : 'New Price Entry'}
              </span>
              <button
                onClick={() => { setShowForm(false); resetForm(); }}
                className="text-gray-400 hover:text-white text-lg leading-none"
              >
                ×
              </button>
            </div>

            <div className="p-4 flex flex-col gap-4">
              {/* Customer */}
              <div>
                <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">
                  Customer <span className="text-red-500">*</span>
                </label>
                <select
                  className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                  value={formCustomerId}
                  onChange={e => setFormCustomerId(e.target.value)}
                  disabled={!!editingEntry}
                >
                  <option value="">Select Customer...</option>
                  {customers.filter(c => c.is_active !== false && c.is_blocked !== true).map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {/* Material / Item Search */}
              <div>
                <label className="text-[9px] font-black uppercase text-gray-600 block mb-1">
                  Material / Item <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <input
                    className="w-full h-8 border border-gray-400 px-2 text-xs font-bold outline-none focus:bg-yellow-50"
                    placeholder="Search by name or code..."
                    value={itemSearch}
                    onChange={e => {
                      setItemSearch(e.target.value);
                      setFormItemId('');
                      setShowItemDropdown(true);
                    }}
                    onFocus={() => setShowItemDropdown(true)}
                    disabled={!!editingEntry}
                  />
                  {showItemDropdown && matchingItems.length > 0 && (
                    <div className="absolute z-20 w-full max-h-40 overflow-y-auto bg-white border border-gray-300 shadow-lg">
                      {matchingItems.map(item => (
                        <button
                          key={item.id}
                          type="button"
                          className="w-full text-left px-2 py-1.5 text-xs hover:bg-yellow-50 border-b border-gray-100"
                          onClick={() => {
                            setFormItemId(item.id);
                            setItemSearch(item.name);
                            setShowItemDropdown(false);
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

              {/* Default Price Display */}
              {selectedItem && (
                <div className="bg-gray-50 border border-gray-200 p-3 rounded-sm">
                  <div className="text-[9px] font-black uppercase text-gray-500 mb-1">Default Rate (Excl. GST)</div>
                  <div className="text-xl font-black text-gray-800">₹{defaultExGstRate.toFixed(2)}</div>
                  <div className="text-[9px] text-gray-400 mt-0.5">MRP: ₹{defaultMrp.toFixed(2)} (GST {itemGstPercent}%)</div>
                </div>
              )}

              {/* Customer Actual Price */}
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
                  placeholder="Leave blank to use Default Rate"
                  value={formActualPrice}
                  onChange={e => setFormActualPrice(e.target.value)}
                />
                <div className="text-[9px] text-blue-600 mt-0.5">
                  Base rate excluding GST. System adds {itemGstPercent}% GST on top.
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
                  value={formFkPrice}
                  onChange={e => setFormFkPrice(e.target.value)}
                />
                <div className="text-[9px] text-purple-600 mt-0.5">
                  ⚑ Special rate used for printed invoice grand total (+ GST calculated on top).
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
                        name="status"
                        value={s}
                        checked={formStatus === s}
                        onChange={() => setFormStatus(s)}
                        className="accent-primary"
                      />
                      <span className="text-xs font-bold uppercase">{s}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Pricing Preview */}
              {(selectedItem || formActualPrice || formFkPrice) && (
                <div className="bg-blue-50 border border-blue-200 p-3">
                  <div className="text-[9px] font-black uppercase text-blue-700 mb-2">Pricing Preview (Qty = 1)</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-[9px] text-gray-500 uppercase font-bold">POS Bill Total (Incl. GST)</div>
                      <div className="font-black text-gray-800 text-lg">₹{round2(posLineTotalInclGst).toFixed(2)}</div>
                      <div className="text-[9px] text-gray-400">
                        Rate ₹{round2(activeExGstRate).toFixed(2)} + {itemGstPercent}% GST (₹{round2(activeExGstRate * itemGstPercent / 100).toFixed(2)})
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] text-gray-500 uppercase font-bold">Printed Invoice Total</div>
                      <div className={`font-black text-lg ${fkPriceNum != null ? 'text-purple-700' : 'text-gray-800'}`}>
                        ₹{round2(printTotalInclGst).toFixed(2)}
                      </div>
                      <div className="text-[9px] text-gray-400">
                        {fkPriceNum != null
                          ? `⚑ FK Rate ₹${round2(printRateExGst).toFixed(2)} + ${itemGstPercent}% GST`
                          : 'Same as line item'}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2 border-t border-gray-200">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 h-9 bg-primary text-white text-xs font-black uppercase hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : editingEntry ? 'Update Entry' : 'Save Entry'}
                </button>
                <button
                  onClick={() => { setShowForm(false); resetForm(); }}
                  className="h-9 px-4 bg-gray-200 text-gray-700 text-xs font-black uppercase hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PriceMaster;
