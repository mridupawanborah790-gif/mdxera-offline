import React, { useEffect, useMemo, useState } from 'react';
import Modal from '@core/components/ui/Modal';
import type { InventoryItem, Medicine, RegisteredPharmacy } from '@core/types';
import {
  groupInventoryByMaterial,
  bulkCreateFromInventory,
  type MaterialGroupStatus,
} from '../services/materialMasterSync';

interface SyncMaterialMasterModalProps {
  isOpen: boolean;
  onClose: () => void;
  inventory: InventoryItem[];
  medicines: Medicine[];
  currentUser: RegisteredPharmacy | null;
  addNotification: (message: string, type: 'success' | 'error' | 'warning') => void;
  /** Refresh React state after writes (loadData(user,'background') in App.tsx). */
  onRefresh: () => Promise<void> | void;
}

type FilterMode = 'missing' | 'inMaster' | 'all';

const SyncMaterialMasterModal: React.FC<SyncMaterialMasterModalProps> = ({
  isOpen,
  onClose,
  inventory,
  medicines,
  currentUser,
  addNotification,
  onRefresh,
}) => {
  const [filter, setFilter] = useState<FilterMode>('missing');
  const [search, setSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>({ done: 0, total: 0, current: '' });

  const groups = useMemo(
    () => groupInventoryByMaterial(inventory, medicines),
    [inventory, medicines],
  );

  const stats = useMemo(() => {
    const missing = groups.filter(g => !g.inMaster).length;
    return { total: groups.length, missing, inMaster: groups.length - missing };
  }, [groups]);

  const filteredGroups = useMemo(() => {
    const term = search.trim().toLowerCase();
    return groups.filter(g => {
      if (filter === 'missing' && g.inMaster) return false;
      if (filter === 'inMaster' && !g.inMaster) return false;
      if (term && !g.name.toLowerCase().includes(term) && !g.brand.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [groups, filter, search]);

  // Reset selection + filter every time the modal opens. Otherwise stale state
  // from a previous run shows up.
  useEffect(() => {
    if (isOpen) {
      setFilter('missing');
      setSearch('');
      setSelectedKeys(new Set());
      setProgress({ done: 0, total: 0, current: '' });
      setBusy(false);
    }
  }, [isOpen]);

  const toggleOne = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectableGroups = filteredGroups.filter(g => !g.inMaster);
  const allFilteredSelectable = selectableGroups.length > 0 &&
    selectableGroups.every(g => selectedKeys.has(g.key));

  const toggleAllFiltered = () => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (allFilteredSelectable) {
        for (const g of selectableGroups) next.delete(g.key);
      } else {
        for (const g of selectableGroups) next.add(g.key);
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!currentUser) {
      addNotification('Sign in required.', 'error');
      return;
    }
    const chosen = groups.filter(g => selectedKeys.has(g.key) && !g.inMaster);
    if (chosen.length === 0) {
      addNotification('No materials selected.', 'warning');
      return;
    }
    setBusy(true);
    setProgress({ done: 0, total: chosen.length, current: chosen[0].name });
    try {
      const result = await bulkCreateFromInventory(chosen, currentUser, (done, total, current) => {
        setProgress({ done, total, current });
      });
      await onRefresh();
      const msg =
        `Created ${result.created} material${result.created === 1 ? '' : 's'} · ` +
        `Linked ${result.updatedBatches} inventory row${result.updatedBatches === 1 ? '' : 's'}` +
        (result.failed.length ? ` · ${result.failed.length} failed` : '');
      addNotification(msg, result.failed.length ? 'warning' : 'success');
      if (result.failed.length) {
        console.warn('[SyncMaterialMaster] failures:', result.failed);
      }
      setSelectedKeys(new Set());
    } catch (err: any) {
      addNotification(err?.message || 'Bulk create failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const selectedCount = useMemo(
    () => groups.filter(g => selectedKeys.has(g.key) && !g.inMaster).length,
    [groups, selectedKeys],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => { /* block close during work */ } : onClose}
      title="Sync Inventory with Material Master"
      widthClass="max-w-6xl"
      heightClass="h-[85vh]"
      disableClose={busy}
    >
      <div className="flex flex-col flex-1 min-h-0">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {(['missing', 'inMaster', 'all'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setFilter(mode)}
                disabled={busy}
                className={`px-3 py-1 text-[11px] font-black uppercase tracking-wider border ${filter === mode ? 'bg-primary text-white border-primary' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}
              >
                {mode === 'missing' ? `Missing (${stats.missing})` : mode === 'inMaster' ? `In Master (${stats.inMaster})` : `All (${stats.total})`}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or brand…"
            disabled={busy}
            className="flex-1 min-w-[200px] max-w-md px-2 py-1 border border-gray-300 text-[12px] focus:border-primary focus:outline-none"
          />
          <div className="ml-auto text-[11px] font-bold text-gray-600">
            Selected: <span className="text-primary">{selectedCount}</span>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {filteredGroups.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-500 italic">
              {filter === 'missing' ? 'All inventory materials are present in Material Master.' : 'No materials match.'}
            </div>
          ) : (
            <table className="w-full text-[11px] border-collapse">
              <thead className="sticky top-0 bg-gray-100 z-10 border-b border-gray-300">
                <tr>
                  <th className="px-2 py-1.5 text-left w-10">
                    <input
                      type="checkbox"
                      checked={allFilteredSelectable}
                      onChange={toggleAllFiltered}
                      disabled={busy || selectableGroups.length === 0}
                      title="Select all missing in this view"
                    />
                  </th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  <th className="px-2 py-1.5 text-left">Name</th>
                  <th className="px-2 py-1.5 text-left">Brand</th>
                  <th className="px-2 py-1.5 text-left">Pack</th>
                  <th className="px-2 py-1.5 text-right">Batches</th>
                  <th className="px-2 py-1.5 text-right">Total Stock</th>
                  <th className="px-2 py-1.5 text-left">Linked Code</th>
                </tr>
              </thead>
              <tbody>
                {filteredGroups.map((g) => {
                  const checked = selectedKeys.has(g.key);
                  const isMissing = !g.inMaster;
                  return (
                    <tr
                      key={g.key}
                      className={`border-b border-gray-100 ${isMissing ? '' : 'opacity-60'} ${checked ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                      onClick={() => isMissing && !busy && toggleOne(g.key)}
                      style={{ cursor: isMissing && !busy ? 'pointer' : 'default' }}
                    >
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOne(g.key)}
                          disabled={busy || !isMissing}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2 py-1">
                        {isMissing ? (
                          <span className="px-1.5 py-0.5 text-[10px] font-black uppercase bg-amber-100 text-amber-800 border border-amber-300">Missing</span>
                        ) : (
                          <span className="px-1.5 py-0.5 text-[10px] font-black uppercase bg-emerald-100 text-emerald-800 border border-emerald-300">In Master</span>
                        )}
                      </td>
                      <td className="px-2 py-1 font-semibold">{g.name || <em className="text-gray-400">(unnamed)</em>}</td>
                      <td className="px-2 py-1 text-gray-600">{g.brand || '—'}</td>
                      <td className="px-2 py-1 text-gray-600">{g.representative.packType || '—'}</td>
                      <td className="px-2 py-1 text-right">{g.batchCount}</td>
                      <td className="px-2 py-1 text-right">{g.totalStock}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-primary">{g.master?.materialCode || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-gray-200 bg-gray-50 flex items-center gap-3">
          {busy && (
            <div className="flex-1 flex items-center gap-3 text-[11px] font-bold text-gray-700">
              <div className="flex-1 max-w-md">
                <div className="h-2 bg-gray-200 overflow-hidden border border-gray-300">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                  />
                </div>
                <div className="text-[10px] text-gray-500 mt-1 truncate">
                  {progress.done}/{progress.total} — {progress.current}
                </div>
              </div>
            </div>
          )}
          {!busy && (
            <div className="text-[10px] font-bold text-gray-500 italic">
              Selected materials will be created in Material Master, and all matching inventory batches linked by code.
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="ml-auto px-4 py-1.5 border border-gray-400 bg-white text-gray-700 text-[11px] font-black uppercase tracking-wider disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Close'}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy || selectedCount === 0}
            className="px-5 py-1.5 bg-primary text-white text-[11px] font-black uppercase tracking-wider disabled:opacity-40"
          >
            Create {selectedCount > 0 ? `${selectedCount} ` : ''}Material{selectedCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default SyncMaterialMasterModal;
