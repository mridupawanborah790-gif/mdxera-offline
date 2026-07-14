import React, { useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { InventoryItem } from '@core/types';
import { formatExpiryToMMYY, normalizeImportDate } from '@core/utils/helpers';
import { buildTotalStockFromBreakup, getStockBreakup } from '@core/utils/stock';
import { isLiquidOrWeightPack, resolveUnitsPerStrip } from '@core/utils/pack';

interface InventoryBatchDetailModalProps {
    isOpen: boolean;
    itemName: string;
    rows: InventoryItem[];
    onClose: () => void;
    onSaveRow: (row: InventoryItem) => Promise<void>;
    allowBatchEdit?: boolean;
}

type EditableBatchFields = Pick<InventoryItem, 'batch' | 'expiry' | 'purchasePrice' | 'ptr' | 'mrp' | 'rateA' | 'rateB' | 'rateC' | 'minStockLimit'> & {
    packQty: number;
    looseQty: number;
};

const isValidExpiry = (expiry: string) => {
    const value = expiry.trim();
    if (!value) return true;
    const mmYY = /^(0[1-9]|1[0-2])\/(\d{2})$/;
    const yyyyMmDd = /^\d{4}-(0[1-9]|1[0-2])-([0][1-9]|[12]\d|3[01])$/;
    return mmYY.test(value) || yyyyMmDd.test(value);
};

const toNumber = (value: unknown, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};

const toNonNegativeInt = (value: unknown) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? Math.max(0, n) : 0;
};

const InventoryBatchDetailModal: React.FC<InventoryBatchDetailModalProps> = ({
    isOpen,
    itemName,
    rows,
    onClose,
    onSaveRow,
    allowBatchEdit = true,
}) => {
    const [editingRowId, setEditingRowId] = useState<string | null>(null);
    const [draft, setDraft] = useState<EditableBatchFields | null>(null);
    const [expiryDisplay, setExpiryDisplay] = useState('');
    const [error, setError] = useState<string>('');
    const [savingRowId, setSavingRowId] = useState<string | null>(null);
    const [recentlyUpdatedId, setRecentlyUpdatedId] = useState<string | null>(null);
    const modalRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) {
            setEditingRowId(null);
            setDraft(null);
            setExpiryDisplay('');
            setError('');
            setSavingRowId(null);
            setRecentlyUpdatedId(null);
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (editingRowId) {
                    setEditingRowId(null);
                    setDraft(null);
                    setExpiryDisplay('');
                    setError('');
                } else {
                    onClose();
                }
            }
            if (event.key === 'Enter' && editingRowId) {
                const row = rows.find(r => r.id === editingRowId);
                if (row) {
                    event.preventDefault();
                    void saveEdit(row);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [editingRowId, isOpen, onClose, rows, draft]);

    const sortedRows = useMemo(
        () => [...rows].sort((a, b) => (a.batch || '').localeCompare(b.batch || '')),
        [rows],
    );

    const totals = useMemo(() => {
        return sortedRows.reduce(
            (acc, row) => {
                const stock = toNumber(row.stock);
                const purchaseRate = toNumber(row.purchasePrice);
                const value = toNumber(row.value ?? (stock * purchaseRate));
                return { stock: acc.stock + stock, value: acc.value + value };
            },
            { stock: 0, value: 0 },
        );
    }, [sortedRows]);

    useEffect(() => {
        if (isOpen) {
            // Short delay to ensure DOM is ready
            const timer = setTimeout(() => {
                modalRef.current?.focus();
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const beginEdit = (row: InventoryItem) => {
        const unitsPerPack = Math.max(1, resolveUnitsPerStrip(toNumber(row.unitsPerPack, 1), row.packType));
        const stockBreakup = getStockBreakup(toNumber(row.stock), unitsPerPack, row.packType);
        setEditingRowId(row.id);
        setDraft({
            batch: row.batch || '',
            expiry: row.expiry || '',
            packQty: stockBreakup.pack,
            looseQty: stockBreakup.loose,
            purchasePrice: toNumber(row.purchasePrice),
            minStockLimit: toNumber(row.minStockLimit),
            ptr: toNumber(row.ptr),
            mrp: toNumber(row.mrp),
            rateA: toNumber(row.rateA),
            rateB: toNumber(row.rateB),
            rateC: toNumber(row.rateC),
        });
        setExpiryDisplay(formatExpiryToMMYY(row.expiry));
        setError('');
    };

    const cancelEdit = () => {
        setEditingRowId(null);
        setDraft(null);
        setExpiryDisplay('');
        setError('');
    };

    const saveEdit = async (row: InventoryItem) => {
        if (!draft) return;

        const packQty = toNonNegativeInt(draft.packQty);
        const looseQty = toNonNegativeInt(draft.looseQty);
        const normalizedExpiry = normalizeImportDate(expiryDisplay || draft.expiry || '') || (draft.expiry || '').trim();

        if (!isValidExpiry(expiryDisplay || normalizedExpiry || '')) {
            setError('Expiry must be in MM/YY or YYYY-MM-DD format.');
            return;
        }

        const numericFields = [draft.purchasePrice, draft.ptr, draft.mrp, draft.rateA, draft.rateB, draft.rateC, draft.minStockLimit];
        if (numericFields.some(value => !Number.isFinite(Number(value)))) {
            setError('All numeric fields must contain valid numbers.');
            return;
        }

        const unitsPerPack = Math.max(1, resolveUnitsPerStrip(toNumber(row.unitsPerPack, 1), row.packType));
        const isLiquidOrWeight = isLiquidOrWeightPack(row.packType);
        const nextStock = buildTotalStockFromBreakup(packQty, looseQty, unitsPerPack, !isLiquidOrWeight, row.packType);
        if (nextStock < 0) {
            setError('Quantity cannot be negative.');
            return;
        }

        const nextPtr = toNumber(draft.ptr);
        const nextPurchaseRate = toNumber(draft.purchasePrice);
        const updatedRow: InventoryItem = {
            ...row,
            batch: allowBatchEdit ? (draft.batch || '').trim() : row.batch,
            expiry: normalizedExpiry,
            stock: nextStock,
            purchasePrice: nextPurchaseRate,
            minStockLimit: toNonNegativeInt(draft.minStockLimit),
            ptr: nextPtr,
            mrp: toNumber(draft.mrp),
            rateA: toNumber(draft.rateA),
            rateB: toNumber(draft.rateB),
            rateC: toNumber(draft.rateC),
            value: nextStock * nextPurchaseRate,
        };

        setSavingRowId(row.id);
        setError('');

        try {
            await onSaveRow(updatedRow);
            setRecentlyUpdatedId(row.id);
            setTimeout(() => setRecentlyUpdatedId(prev => (prev === row.id ? null : prev)), 1400);
            cancelEdit();
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Unable to save batch changes.';
            setError(message);
        } finally {
            setSavingRowId(null);
        }
    };

    const editingRow = editingRowId ? sortedRows.find(row => row.id === editingRowId) || null : null;

    const renderBreakdownTable = () => (
        <>
            <div className="flex-1 overflow-hidden">
                <div className="h-full overflow-x-auto overflow-y-auto">
                    <table className="w-full border-collapse whitespace-nowrap text-xs sm:text-sm">
                        <thead className="bg-gray-100 sticky top-0 z-10">
                            <tr className="font-black uppercase text-gray-700 border-b border-gray-400">
                                <th className="px-2 py-2 border-r border-gray-300 text-center">#</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-left">Batch</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-center">Expiry</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">Pack Qty</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">Loose Qty</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">Total Stock</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">PTR</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">Purchase Rate</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">MRP</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">Rate A</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">Rate B</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">Rate C</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-right">Stock Value</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-left">Barcode</th>
                                <th className="px-2 py-2 border-r border-gray-300 text-center">Action</th>
                                <th className="px-2 py-2 text-left">Purchase Rate Source</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {sortedRows.map((row, index) => {
                                const unitsPerPack = Math.max(1, resolveUnitsPerStrip(Number(row.unitsPerPack) || 1, row.packType));
                                const rowStock = Number(row.stock) || 0;
                                const packQty = Math.floor(rowStock / unitsPerPack);
                                const looseQty = rowStock % unitsPerPack;
                                const ptr = toNumber(row.ptr);
                                const purchaseRate = toNumber(row.purchasePrice);
                                const mrp = toNumber(row.mrp);
                                const rateA = toNumber(row.rateA);
                                const rateB = toNumber(row.rateB);
                                const rateC = toNumber(row.rateC);
                                const stockValue = rowStock * purchaseRate;

                                return (
                                    <tr
                                        key={row.id}
                                        className={`${recentlyUpdatedId === row.id ? 'bg-yellow-100' : 'hover:bg-yellow-50'} transition-colors`}
                                        onDoubleClick={() => beginEdit(row)}
                                    >
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-center">{index + 1}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 font-mono text-primary">{row.batch || '-'}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-center">{formatExpiryToMMYY(row.expiry) || '-'}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right">{packQty}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right">{looseQty}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right font-semibold">{rowStock}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right">₹{ptr.toFixed(2)}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right">₹{purchaseRate.toFixed(2)}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right">₹{mrp.toFixed(2)}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right">₹{rateA.toFixed(2)}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right">₹{rateB.toFixed(2)}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right">₹{rateC.toFixed(2)}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-right font-semibold">₹{stockValue.toFixed(2)}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200">{row.barcode || '-'}</td>
                                        <td className="px-2 py-1.5 border-r border-gray-200 text-center">
                                            <button
                                                onClick={() => beginEdit(row)}
                                                className="px-2 py-1 border border-primary text-primary text-[10px] font-black uppercase hover:bg-primary hover:text-white"
                                            >
                                                Edit
                                            </button>
                                        </td>
                                        <td className="px-2 py-1.5 text-[10px] text-gray-600">Inventory inward batch record</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                        <tfoot className="sticky bottom-0 bg-blue-50 border-t-2 border-primary">
                            <tr className="text-xs font-black uppercase text-primary">
                                <td colSpan={5} className="px-2 py-2 border-r border-blue-200 text-right">Total</td>
                                <td className="px-2 py-2 border-r border-blue-200 text-right">{totals.stock}</td>
                                <td colSpan={6} className="px-2 py-2 border-r border-blue-200 text-right">Batch Stock Value Total</td>
                                <td className="px-2 py-2 border-r border-blue-200 text-right">₹{totals.value.toFixed(2)}</td>
                                <td colSpan={3} className="px-2 py-2 text-center text-[10px]">Double-click or click Edit to alter selected batch</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>
            <div className="px-3 py-2 border-t border-gray-300 bg-white flex justify-between items-center shrink-0">
                <p className="text-[10px] font-bold uppercase text-gray-500 tracking-wide">Enter = Save • Esc = Cancel / Close</p>
                <button onClick={onClose} className="px-3 py-1 border border-gray-400 text-[10px] font-black uppercase text-gray-700 hover:bg-gray-100">Close</button>
            </div>
        </>
    );

    const renderAlterView = (row: InventoryItem) => {
        if (!draft) return null;
        const unitsPerPack = Math.max(1, resolveUnitsPerStrip(toNumber(row.unitsPerPack, 1), row.packType));
        const isLiquidOrWeight = isLiquidOrWeightPack(row.packType);
        const looseValue = isLiquidOrWeight ? 0 : draft.looseQty;
        const totalStock = buildTotalStockFromBreakup(draft.packQty, looseValue, unitsPerPack, !isLiquidOrWeight, row.packType);

        const inputCls = 'w-full border border-gray-300 px-2 py-1.5 font-semibold focus:outline-none focus:border-primary focus:bg-yellow-50';

        return (
            <>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    <div className="bg-gray-50 border border-gray-200 p-3">
                        <p className="text-[10px] font-black uppercase text-gray-500 tracking-widest">Alter Inventory</p>
                        <h3 className="text-lg font-black uppercase text-primary">{itemName}</h3>
                        <p className="text-xs font-black text-gray-600 mt-1">Batch: <span className="font-mono text-primary">{row.batch || 'N/A'}</span></p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Batch Number</label>
                            <input className={`${inputCls} uppercase`} value={draft.batch} disabled={!allowBatchEdit} onChange={e => setDraft(prev => (prev ? { ...prev, batch: e.target.value } : prev))} />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Expiry (MM/YY)</label>
                            <input className={inputCls} value={expiryDisplay} maxLength={5} placeholder="MM/YY" onChange={e => {
                                const cleaned = e.target.value.replace(/\D/g, '');
                                let formatted = cleaned;
                                if (cleaned.length > 2) formatted = `${cleaned.slice(0, 2)}/${cleaned.slice(2, 4)}`;
                                setExpiryDisplay(formatted.slice(0, 5));
                                setDraft(prev => (prev ? { ...prev, expiry: formatted } : prev));
                            }} />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Minimum Limit</label>
                            <input type="number" min={0} className={inputCls} value={draft.minStockLimit} onChange={e => setDraft(prev => (prev ? { ...prev, minStockLimit: toNonNegativeInt(e.target.value) } : prev))} />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Pack Qty</label>
                            <input type="number" min={0} className={inputCls} value={draft.packQty} onChange={e => setDraft(prev => (prev ? { ...prev, packQty: toNonNegativeInt(e.target.value) } : prev))} />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Loose Qty</label>
                            <input type="number" min={0} disabled={isLiquidOrWeight} className={`${inputCls} disabled:opacity-50`} value={looseValue} onChange={e => setDraft(prev => (prev ? { ...prev, looseQty: toNonNegativeInt(e.target.value) } : prev))} />
                        </div>
                        <div className="bg-emerald-50 border border-emerald-100 px-3 py-2">
                            <p className="text-[9px] font-black uppercase text-emerald-700">Total Stock (Units)</p>
                            <p className="text-xl font-black text-emerald-800">{totalStock}</p>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Purchase Rate</label>
                            <input type="number" step="0.01" className={`${inputCls} bg-gray-100`} value={draft.purchasePrice} readOnly />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">PTR</label>
                            <input type="number" step="0.01" className={inputCls} value={draft.ptr} onChange={e => setDraft(prev => (prev ? { ...prev, ptr: toNumber(e.target.value) } : prev))} />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">MRP</label>
                            <input type="number" step="0.01" className={inputCls} value={draft.mrp} onChange={e => setDraft(prev => (prev ? { ...prev, mrp: toNumber(e.target.value) } : prev))} />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Rate A</label>
                            <input type="number" step="0.01" className={inputCls} value={draft.rateA} onChange={e => setDraft(prev => (prev ? { ...prev, rateA: toNumber(e.target.value) } : prev))} />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Rate B</label>
                            <input type="number" step="0.01" className={inputCls} value={draft.rateB} onChange={e => setDraft(prev => (prev ? { ...prev, rateB: toNumber(e.target.value) } : prev))} />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase text-gray-500">Rate C</label>
                            <input type="number" step="0.01" className={inputCls} value={draft.rateC} onChange={e => setDraft(prev => (prev ? { ...prev, rateC: toNumber(e.target.value) } : prev))} />
                        </div>
                    </div>
                </div>

                <div className="px-3 py-2 border-t border-gray-300 bg-white flex justify-between items-center shrink-0 gap-2">
                    <button onClick={cancelEdit} disabled={savingRowId === row.id} className="px-3 py-1 border border-gray-400 text-[10px] font-black uppercase text-gray-700 hover:bg-gray-100 disabled:opacity-50">Back to Batch Breakdown</button>
                    <div className="flex items-center gap-2">
                        <button onClick={cancelEdit} disabled={savingRowId === row.id} className="px-3 py-1 border border-gray-400 text-[10px] font-black uppercase text-gray-700 hover:bg-gray-100 disabled:opacity-50">Cancel</button>
                        <button onClick={() => void saveEdit(row)} disabled={savingRowId === row.id} className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest disabled:opacity-50">Accept Alteration</button>
                    </div>
                </div>
            </>
        );
    };

    return createPortal(
        <div className="fixed inset-0 z-[220] bg-black/60 flex items-center justify-center p-2">
            <div
                ref={modalRef}
                className="w-[74vw] min-w-[320px] max-w-[1400px] max-h-[70vh] bg-white border-2 border-primary shadow-2xl flex flex-col overflow-hidden outline-none"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                tabIndex={-1}
            >
                <div className="px-3 py-2 bg-primary text-white flex justify-between items-center shrink-0">
                    <div>
                        {!editingRow ? (
                            <>
                                <p className="text-[10px] font-black uppercase tracking-widest">Batch-wise Stock Breakdown</p>
                                <h2 className="text-lg font-black uppercase">{itemName}</h2>
                            </>
                        ) : (
                            <>
                                <p className="text-[10px] font-black uppercase tracking-widest">ALTER INVENTORY: {itemName}</p>
                                <h2 className="text-lg font-black uppercase">Batch: {editingRow.batch || '-'}</h2>
                            </>
                        )}
                    </div>
                    <button onClick={editingRow ? cancelEdit : onClose} className="px-3 py-1 border border-white text-xs font-black uppercase">Esc / {editingRow ? 'Back' : 'Close'}</button>
                </div>

                {error && (
                    <div className="px-4 py-2 text-xs font-bold uppercase bg-red-50 text-red-700 border-b border-red-200">{error}</div>
                )}

                {!editingRow ? renderBreakdownTable() : renderAlterView(editingRow)}
            </div>
        </div>,
        document.body,
    );
};

export default InventoryBatchDetailModal;
