
import React, { useState, useMemo, useEffect, useRef } from 'react';
import Modal from '@core/components/ui/Modal';
import AddMedicineModal from '@modules/inventory/components/AddMedicineModal';
import type { Medicine, Supplier, SupplierProductMap, PurchaseItem } from '@core/types';
import { fuzzyMatch } from '@core/utils/search';

interface LinkToMasterModalProps {
    isOpen: boolean;
    onClose: () => void;
    supplier: Supplier;
    medicines?: Medicine[];
    mappings?: SupplierProductMap[];
    onLink: (map: SupplierProductMap) => Promise<void>;
    onUnlink?: (mappingId: string) => Promise<void>;
    scannedItems: PurchaseItem[];
    onFinalize: (reconciledItems: PurchaseItem[]) => void;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    organizationId: string;
}

const uniformTextStyle = "text-base font-medium tracking-tight uppercase";
const isUnresolved = (item: PurchaseItem) => item.matchStatus !== 'matched';

const cleanItemName = (name: string): string => {
    return name
        .replace(/₹?(\d+\.\d{2})|(\d+\/-)/g, '')
        .replace(/\b\d{2}[\/-]\d{2}[\/-]\d{4}\b/g, '')
        .replace(/\b\d{2}[\/-]\d{2}[\/-]\d{2}\b/g, '')
        .replace(/[(){}[\]]/g, ' ')
        .replace(/[*#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
};

const LinkToMasterModal: React.FC<LinkToMasterModalProps> = ({
    isOpen,
    onClose,
    supplier,
    medicines = [],
    mappings = [],
    onLink,
    onUnlink,
    scannedItems,
    onFinalize,
    onAddMedicineMaster,
    organizationId,
}) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [masterSelectedIndex, setMasterSelectedIndex] = useState(0);
    const [activeScannedIndex, setActiveScannedIndex] = useState(0);
    const [reconciledItems, setReconciledItems] = useState<PurchaseItem[]>([]);
    const [isAddMedicineSubModalOpen, setIsAddMedicineSubModalOpen] = useState(false);
    const [statusToast, setStatusToast] = useState<string | null>(null);
    const [closeWarning, setCloseWarning] = useState<string | null>(null);
    const [worksheetItems, setWorksheetItems] = useState<PurchaseItem[]>([]);

    const searchInputRef = useRef<HTMLInputElement>(null);
    const scannedListRef = useRef<HTMLDivElement>(null);
    const finalizeBtnRef = useRef<HTMLButtonElement>(null);
    const autoResolvedRef = useRef(false);

    const isComplete = useMemo(() =>
        reconciledItems.length > 0 && reconciledItems.every(i => i.matchStatus === 'matched'),
        [reconciledItems]);

    const unresolvedItems = useMemo(() => reconciledItems.filter(i => isUnresolved(i)), [reconciledItems]);

    useEffect(() => {
        setWorksheetItems(reconciledItems);
    }, [reconciledItems]);

    const suggestions = useMemo(() => {
        const map: Record<string, Medicine | null> = {};
        scannedItems.forEach(item => {
            const normalizedItemName = item.name.toLowerCase().trim();
            const itemBarcode = String((item as any).barcode || '').trim();
            const itemCode = String((item as any).itemCode || (item as any).materialCode || '').trim().toLowerCase();

            const mapping = (mappings || []).find(m =>
                m.supplier_id === supplier.id &&
                m.supplier_product_name.toLowerCase().trim() === normalizedItemName
            );

            if (mapping) {
                const matchedMed = medicines.find(med => med.id === mapping.master_medicine_id);
                if (matchedMed) {
                    map[item.id] = matchedMed;
                    return;
                }
            }

            let best = medicines.find(m => itemBarcode && (m.barcode || '').trim() === itemBarcode);
            if (!best && itemCode) {
                best = medicines.find(m => (m.materialCode || '').trim().toLowerCase() === itemCode);
            }

            if (!best) {
                const cleaned = cleanItemName(item.name);
                const normalizedCleaned = cleaned.toLowerCase().trim();
                best = medicines.find(m => {
                    const normalizedMedName = (m.name || '').toLowerCase().trim();
                    const hsnMatch = !!item.hsnCode && !!m.hsnCode && item.hsnCode.trim() === m.hsnCode.trim();
                    const nameMatch = normalizedMedName === normalizedCleaned || (cleaned.length > 3 && fuzzyMatch(m.name, cleaned));
                    return (hsnMatch && nameMatch) || nameMatch;
                });
            }

            map[item.id] = best || null;
        });
        return map;
    }, [scannedItems, medicines, mappings, supplier.id]);

    const prevIsOpenRef = useRef(false);
    useEffect(() => {
        if (isOpen && !prevIsOpenRef.current) {
            setReconciledItems(scannedItems.filter(i => (i.name || "").trim()).map(i => ({ 
                ...i, 
                extractedName: (i as any).extractedName || i.name 
            } as any)));
            
            const firstPending = scannedItems.findIndex(i => isUnresolved(i));
            const initialIdx = firstPending !== -1 ? firstPending : 0;
            setActiveScannedIndex(initialIdx);
            autoResolvedRef.current = false;
            setSearchTerm('');
            setStatusToast(null);
            setCloseWarning(null);
            setTimeout(() => searchInputRef.current?.focus(), 150);
        }
        prevIsOpenRef.current = isOpen;
    }, [isOpen, scannedItems]);

    useEffect(() => {
        if (!statusToast) return;
        const timer = window.setTimeout(() => setStatusToast(null), 2200);
        return () => window.clearTimeout(timer);
    }, [statusToast]);

    useEffect(() => {
        const activeItem = scannedListRef.current?.querySelector(`[data-scanned-idx="${activeScannedIndex}"]`);
        if (activeItem) {
            activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }, [activeScannedIndex]);

    useEffect(() => {
        const handleGlobalShortcut = (e: KeyboardEvent) => {
            if (isOpen) {
                if ((e.ctrlKey && (e.key === '+' || e.key === '=')) || (e.ctrlKey && e.key === 'Enter')) {
                    e.preventDefault();
                    setIsAddMedicineSubModalOpen(true);
                }
            }
        };
        window.addEventListener('keydown', handleGlobalShortcut);
        return () => window.removeEventListener('keydown', handleGlobalShortcut);
    }, [isOpen]);

    const masterResults = useMemo(() => {
        const query = (searchTerm || '').trim();
        const activeItem = reconciledItems[activeScannedIndex];
        const suggestion = activeItem ? suggestions[activeItem.id] : null;

        let filtered = [...medicines];
        if (query) {
            filtered = filtered.filter(m =>
                fuzzyMatch(String(m.name || ''), query) ||
                fuzzyMatch(String(m.composition || ''), query) ||
                fuzzyMatch(String(m.brand || ''), query)
            );
        }

        return filtered.sort((a, b) => {
            if (suggestion) {
                if (a.id === suggestion.id) return -1;
                if (b.id === suggestion.id) return 1;
            }
            const aExact = query && a.name.toLowerCase().includes(query.toLowerCase()) ? 0 : 1;
            const bExact = query && b.name.toLowerCase().includes(query.toLowerCase()) ? 0 : 1;
            if (aExact !== bExact) return aExact - bExact;
            return a.name.localeCompare(b.name);
        }).slice(0, 50);
    }, [searchTerm, medicines, activeScannedIndex, reconciledItems, suggestions]);


    const handleMapItem = async (masterMed: Medicine) => {
        const activeItem = reconciledItems[activeScannedIndex];
        if (!activeItem) return;

        const rawNomenclatureName = (activeItem as any).extractedName || activeItem.name;

        // Create mapping in DB (handled in background)
        if (supplier.id && supplier.id !== 'temp') {
            const existingMap = (mappings || []).find(m =>
                m.supplier_id === supplier.id &&
                m.supplier_product_name.toLowerCase().trim() === rawNomenclatureName.toLowerCase().trim()
            );

            onLink({
                id: existingMap ? existingMap.id : crypto.randomUUID(),
                organization_id: organizationId,
                supplier_id: supplier.id,
                supplier_product_name: rawNomenclatureName,
                master_medicine_id: masterMed.id,
                auto_apply: false
            }).catch(err => console.error("Link saving failed", err));
        }

        // Update current session's reconciledItems for ALL instances of this raw nomenclature
        const updatedItems = reconciledItems.map((item) => {
            const itemOriginalName = (item as any).extractedName || item.name;
            if (itemOriginalName.toLowerCase().trim() === rawNomenclatureName.toLowerCase().trim()) {
                const unitsMatch = masterMed.pack?.match(/\d+/);
                const units = unitsMatch ? parseInt(unitsMatch[0], 10) : 10;

                return {
                    ...item,
                    name: masterMed.name,
                    brand: masterMed.brand || masterMed.manufacturer || '',
                    hsnCode: masterMed.hsnCode || item.hsnCode,
                    gstPercent: masterMed.gstRate || item.gstPercent,
                    mrp: Number(masterMed.mrp || item.mrp),
                    inventoryItemId: masterMed.id,
                    unitsPerPack: units,
                    packType: masterMed.pack || item.packType,
                    matchStatus: 'matched' as const
                };
            }
            return item;
        });

        setReconciledItems(updatedItems);
        setCloseWarning(null);
        setStatusToast(`Mapped successfully: ${rawNomenclatureName} → ${masterMed.name}`);

        // Find next pending item
        const nextPendingIdx = updatedItems.findIndex((item, idx) => idx > activeScannedIndex && isUnresolved(item));
        const wrapPendingIdx = nextPendingIdx === -1 ? updatedItems.findIndex(item => isUnresolved(item)) : nextPendingIdx;

        if (wrapPendingIdx !== -1) {
            setActiveScannedIndex(wrapPendingIdx);
            setSearchTerm('');
            setMasterSelectedIndex(0);
            setTimeout(() => {
                searchInputRef.current?.focus();
                if (searchInputRef.current) searchInputRef.current.select();
            }, 10);
        } else {
            setStatusToast('Reconciliation completed. Items added to Purchase Voucher.');
            onFinalize(updatedItems);
        }
    };

    const handleUnlinkItem = async (item: PurchaseItem) => {
        const rawNomenclatureName = (item as any).extractedName || item.name;
        
        const existingMap = (mappings || []).find(m =>
            m.supplier_id === supplier.id &&
            m.supplier_product_name.toLowerCase().trim() === rawNomenclatureName.toLowerCase().trim()
        );

        if (existingMap && onUnlink) {
            try {
                await onUnlink(existingMap.id);
            } catch (err) {
                console.error("Failed to delete mapping", err);
            }
        }

        const updatedItems = reconciledItems.map((i) => {
            const itemOriginalName = (i as any).extractedName || i.name;
            if (itemOriginalName.toLowerCase().trim() === rawNomenclatureName.toLowerCase().trim()) {
                const orig = scannedItems.find(o => o.id === i.id) || i;
                return {
                    ...i,
                    name: (orig as any).extractedName || orig.name,
                    brand: orig.brand || '',
                    hsnCode: orig.hsnCode || '',
                    gstPercent: orig.gstPercent || 0,
                    mrp: orig.mrp || 0,
                    inventoryItemId: undefined,
                    unitsPerPack: orig.unitsPerPack || 1,
                    packType: orig.packType || '',
                    matchStatus: 'pending' as const
                };
            }
            return i;
        });

        setReconciledItems(updatedItems);
        setStatusToast(`Unlinked mapping for: ${rawNomenclatureName}`);
    };

    const handleFinalize = (e?: React.MouseEvent | React.KeyboardEvent) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (!isComplete) {
            const pendingCount = reconciledItems.filter(i => isUnresolved(i)).length;
            alert(`Confirm Import blocked: ${pendingCount} extracted item(s) require action (Map/Create).`);
            return;
        }
        const extractedTotal = scannedItems.filter(i => (i.name || '').trim()).reduce((sum, i) => sum + ((i.quantity || 0) * (i.purchasePrice || 0)), 0);
        const reconciledTotal = reconciledItems.reduce((sum, i) => sum + ((i.quantity || 0) * (i.purchasePrice || 0)), 0);
        if (Math.abs(extractedTotal - reconciledTotal) > 1) {
            alert(`Confirm Import blocked: extracted total ₹${extractedTotal.toFixed(2)} must match reconciled total ₹${reconciledTotal.toFixed(2)} (±₹1 allowed).`);
            return;
        }
        onFinalize(reconciledItems);
    };

    const closeBlockedMessage = 'Please map or create all remaining items before closing.';
    const selectSkuWarningMessage = 'Select a SKU or create a new material first.';

    const handleLeftListKeyDown = (e: React.KeyboardEvent) => {
        if (isAddMedicineSubModalOpen) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveScannedIndex(prev => (prev + 1) % reconciledItems.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveScannedIndex(prev => (prev - 1 + reconciledItems.length) % reconciledItems.length);
        } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const currentItem = reconciledItems[activeScannedIndex];
            if (isComplete) {
                handleFinalize();
            } else if (currentItem && currentItem.matchStatus === 'matched') {
                const nextPending = reconciledItems.findIndex((item, idx) => idx > activeScannedIndex && isUnresolved(item));
                const wrappedPending = nextPending === -1 ? reconciledItems.findIndex(i => isUnresolved(i)) : nextPending;
                if (wrappedPending !== -1) {
                    setActiveScannedIndex(wrappedPending);
                } else {
                    finalizeBtnRef.current?.focus();
                }
            } else {
                const selectedMaster = masterResults[masterSelectedIndex];
                if (selectedMaster) {
                    handleMapItem(selectedMaster);
                } else {
                    setStatusToast(selectSkuWarningMessage);
                    const nextPending = reconciledItems.findIndex((item, idx) => idx > activeScannedIndex && isUnresolved(item));
                    const wrappedPending = nextPending === -1 ? reconciledItems.findIndex(item => isUnresolved(item)) : nextPending;
                    if (wrappedPending !== -1) {
                        setActiveScannedIndex(wrappedPending);
                    }
                    searchInputRef.current?.focus();
                    if (searchInputRef.current) searchInputRef.current.select();
                }
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    };

    const handleSearchKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setMasterSelectedIndex(prev => (prev + 1) % Math.max(1, masterResults.length));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setMasterSelectedIndex(prev => (prev - 1 + masterResults.length) % Math.max(1, masterResults.length));
        } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const selectedMaster = masterResults[masterSelectedIndex];
            if (selectedMaster) {
                handleMapItem(selectedMaster);
            } else {
                setStatusToast(selectSkuWarningMessage);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            scannedListRef.current?.focus();
        }
    };

    const handleSmartMatchAll = async () => {
        let updated = [...reconciledItems];
        for (let i = 0; i < updated.length; i++) {
            const item = updated[i];
            if (isUnresolved(item) && suggestions[item.id]) {
                const match = suggestions[item.id]!;

                const itemOriginalName = (item as any).extractedName || item.name;
                const existingMap = (mappings || []).find(m =>
                    m.supplier_id === supplier.id &&
                    m.supplier_product_name.toLowerCase().trim() === itemOriginalName.toLowerCase().trim()
                );

                const unitsMatch = match.pack?.match(/\d+/);
                const units = unitsMatch ? parseInt(unitsMatch[0], 10) : 10;

                updated[i] = {
                    ...item,
                    name: match.name,
                    brand: match.brand || match.manufacturer || '',
                    hsnCode: match.hsnCode || item.hsnCode,
                    gstPercent: match.gstRate || item.gstPercent,
                    mrp: Number(match.mrp || item.mrp),
                    inventoryItemId: match.id,
                    unitsPerPack: units,
                    packType: match.pack || item.packType,
                    matchStatus: 'matched' as const
                };

                if (supplier.id && supplier.id !== 'temp') {
                    onLink({
                        id: existingMap ? existingMap.id : crypto.randomUUID(),
                        organization_id: organizationId,
                        supplier_id: supplier.id,
                        supplier_product_name: itemOriginalName,
                        master_medicine_id: match.id,
                        auto_apply: true
                    }).catch(console.error);
                }
            }
        }
        setReconciledItems(updated);
        setCloseWarning(null);

        const nextPending = updated.findIndex(i => isUnresolved(i));
        if (nextPending !== -1) {
            setActiveScannedIndex(nextPending);
            setTimeout(() => {
                searchInputRef.current?.focus();
                if (searchInputRef.current) searchInputRef.current.select();
            }, 10);
        } else {
            setStatusToast('Reconciliation completed. Items added to Purchase Voucher.');
            onFinalize(updated);
        }
    };

    useEffect(() => {
        if (!isOpen || autoResolvedRef.current) return;
        autoResolvedRef.current = true;
    }, [isOpen]);

    const handleAddMedicineSuccess = async (newMedData: Omit<Medicine, 'id' | 'created_at' | 'updated_at'>) => {
        setIsAddMedicineSubModalOpen(false);
        try {
            const newMed = await onAddMedicineMaster(newMedData);
            if (newMed) {
                handleMapItem(newMed);
                return newMed;
            }
        } catch (error) { 
            console.error("Failed to create master SKU", error); 
        }
    };

    if (!isOpen) return null;

    const unmappedCount = unresolvedItems.length;

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title="Scanned Bill Reconciliation Worksheet" widthClass="max-w-[95vw]" heightClass="h-[90vh]">
                <div className="flex flex-col h-full bg-slate-100 dark:bg-zinc-950 overflow-hidden">
                    <div className="bg-primary text-white p-3 flex justify-between items-center flex-shrink-0 shadow-lg z-20">
                        <div className="flex items-center gap-4">
                            <span className="text-xs font-black uppercase tracking-widest bg-white/20 px-3 py-1 border border-white/30 truncate max-w-[300px]">Supplier: {supplier.name}</span>
                            <span className="text-xs font-black uppercase tracking-widest">{reconciledItems.length} Extracted Items</span>
                            {unmappedCount > 0 && (
                                <span className="bg-red-600 text-white px-3 py-1 rounded-none text-[10px] font-black animate-pulse uppercase border-2 border-white/50 shadow-lg">
                                    {unmappedCount} REMAINING FOR MAPPING
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                ref={finalizeBtnRef}
                                onClick={handleFinalize}
                                disabled={!isComplete}
                                onKeyDown={(e) => e.key === 'Enter' && handleFinalize(e)}
                                className={`px-8 py-2 font-black text-xs uppercase tracking-widest shadow-xl transition-all ml-2 border-2 ${isComplete ? 'bg-accent text-black border-black hover:scale-105 active:translate-y-1 focus:ring-4 focus:ring-accent/40' : 'bg-gray-400 text-gray-200 border-gray-500 cursor-not-allowed opacity-40'}`}
                                title={isComplete ? "Transfer to Purchase Form" : "All items must be matched before proceeding"}
                            >
                                {isComplete ? 'Transfer Reconciled Data (Enter)' : 'Reconciliation Pending'}
                            </button>
                        </div>
                    </div>
                    {closeWarning && (
                        <div className="px-4 py-2 bg-red-700 text-white text-[10px] font-black uppercase tracking-wider border-b-2 border-red-900">
                            {closeWarning}
                        </div>
                    )}
                    {statusToast && (
                        <div className="px-4 py-2 bg-emerald-700 text-white text-[10px] font-black uppercase tracking-wider border-b-2 border-emerald-900">
                            {statusToast}
                        </div>
                    )}

                    <div className="flex flex-1 min-h-0 overflow-hidden">
                        <div ref={scannedListRef} tabIndex={0} onKeyDown={handleLeftListKeyDown} className="w-[35%] min-h-0 border-r-4 border-primary/10 flex flex-col bg-white overflow-hidden shadow-2xl z-10 outline-none focus:ring-4 focus:ring-primary/20">
                            <div className="p-4 bg-gray-50 border-b border-app-border flex justify-between items-center">
                                <h3 className="text-[11px] font-black uppercase text-primary tracking-widest">Unmatched / New Invoice Items</h3>
                                {isComplete && <span className="text-[10px] font-black text-emerald-600 uppercase flex items-center gap-1"><svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" /></svg> 100% RECONCILED</span>}
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-50">
                                {worksheetItems.map((item) => {
                                    const sourceIndex = reconciledItems.findIndex(r => r.id === item.id);
                                    const isActive = sourceIndex === activeScannedIndex;
                                    const isResolved = item.matchStatus === 'matched';
                                    const hasAutoMatch = !!suggestions[item.id];
                                    return (
                                        <div
                                            key={item.id}
                                            data-scanned-idx={sourceIndex}
                                            onClick={() => { setActiveScannedIndex(sourceIndex); scannedListRef.current?.focus(); }}
                                            className={`w-full py-2.5 px-4 border-b border-gray-200 text-left transition-all flex items-center gap-4 cursor-pointer ${isActive ? 'bg-blue-600 text-white z-10 shadow-lg' : isResolved ? 'bg-emerald-100 hover:bg-emerald-200' : 'bg-white hover:bg-gray-50'}`}
                                        >
                                            <div className={`w-8 h-8 rounded-none flex items-center justify-center font-black text-sm flex-shrink-0 ${isActive ? 'bg-white/20' : isResolved ? 'bg-emerald-600 text-white' : (hasAutoMatch ? 'bg-amber-100 text-amber-700 animate-pulse' : 'bg-red-50 text-red-600 border border-red-200')}`}>
                                                {isResolved ? '✓' : hasAutoMatch ? '✨' : '!'}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className={`truncate leading-none ${uniformTextStyle} ${isActive ? 'text-white' : isResolved ? 'text-emerald-900' : 'text-gray-950'}`}>{item.name}</p>
                                            </div>
                                            {isResolved && (
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleUnlinkItem(item);
                                                    }}
                                                    className={`px-2 py-1 text-[9px] font-black uppercase tracking-wider rounded border-2 shadow-sm shrink-0 ${isActive ? 'bg-red-500 hover:bg-red-600 text-white border-red-400' : 'bg-red-50 text-red-700 hover:bg-red-100 border-red-200'}`}
                                                >
                                                    Unlink
                                                </button>
                                            )}
                                            <span className={`text-[9px] font-black uppercase tracking-widest shrink-0 ${isActive ? 'text-white/90' : isResolved ? 'text-emerald-700' : 'text-red-600'}`}>{isResolved ? 'Matched' : 'Unmatched'}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="flex-1 min-h-0 flex flex-col bg-[#fffde7]/20 overflow-hidden">
                            <div className="p-4 bg-white dark:bg-zinc-900 border-b-2 border-primary/10 flex-shrink-0">
                                <div className="flex justify-between items-center mb-3">
                                    <div className="flex items-center gap-2">
                                        <span className="w-5 h-5 rounded-none bg-emerald-600 text-white flex items-center justify-center font-black text-[10px]">SKU</span>
                                        <h3 className="text-[11px] font-black uppercase tracking-widest text-emerald-700">Database Reconciliation Engine</h3>
                                    </div>
                                </div>
                                <div className="relative">
                                    <input ref={searchInputRef} type="text" value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setMasterSelectedIndex(0); }} onKeyDown={handleSearchKeyDown} placeholder="Search catalog manually... (Ctrl + Enter / Ctrl + + to create new)" className={`w-full h-11 p-2.5 pl-10 border-2 border-gray-400 bg-white focus:border-primary focus:bg-[#fffde7] outline-none shadow-sm ${uniformTextStyle}`} />
                                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto p-0 bg-white">
                                {masterResults.length > 0 ? (
                                    <table className="min-w-full border-collapse">
                                        <thead className="sticky top-0 z-20 bg-gray-50 border-b border-gray-400 shadow-sm">
                                            <tr className="text-[10px] font-black uppercase text-gray-500 tracking-wider h-10">
                                                <th className="p-2 px-4 text-left">SKU Description</th>
                                                <th className="p-2 px-4 text-left">MFR</th>
                                                <th className="p-2 px-4 text-right">MRP</th>
                                                <th className="p-2 px-4 w-20">Action</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                            {masterResults.map((med, mIdx) => {
                                                const isSelected = mIdx === masterSelectedIndex;
                                                const isRecommendation = suggestions[reconciledItems[activeScannedIndex]?.id]?.id === med.id;
                                                return (
                                                    <tr key={med.id} onClick={() => handleMapItem(med)} onMouseEnter={() => setMasterSelectedIndex(mIdx)} className={`cursor-pointer transition-all ${isSelected ? 'bg-primary text-white' : isRecommendation ? 'bg-emerald-50 border-l-4 border-emerald-500' : 'hover:bg-yellow-50'} h-12`}>
                                                        <td className="p-2 px-4">
                                                            <p className={`leading-tight ${uniformTextStyle} ${isSelected ? 'text-white' : 'text-gray-950'}`}>{med.name}</p>
                                                            <p className="text-[10px] italic font-bold mt-1 line-clamp-1 opacity-70">{med.composition}</p>
                                                        </td>
                                                        <td className={`p-2 px-4 opacity-80 ${uniformTextStyle}`}>{med.brand || med.manufacturer || '—'}</td>
                                                        <td className={`p-2 px-4 text-right font-black ${uniformTextStyle}`}>₹{parseFloat(med.mrp || '0').toFixed(2)}</td>
                                                        <td className="p-2 px-4 text-right"><div className={`w-8 h-8 rounded-none border-2 flex items-center justify-center font-black text-lg ${isSelected ? 'border-white' : 'border-emerald-100 text-emerald-600'}`}>↵</div></td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div className="h-full flex flex-col items-center justify-center opacity-30 p-20 text-center">
                                        <p className="text-xl font-black uppercase tracking-widest">No Database Match Found</p>
                                        <p className="text-xs font-bold uppercase mt-2">Try a different search or create a new SKU record</p>
                                    </div>
                                )}
                            </div>

                            <div className="p-3 bg-slate-900 text-white/50 border-t border-white/10 flex justify-center items-center gap-10 flex-shrink-0">
                                <span className="text-[9px] font-black uppercase tracking-tighter"><span className="px-1.5 py-0.5 bg-white/10 border border-white/20 mr-1">↑/↓</span> Navigate Results</span>
                                <span className="text-[9px] font-black uppercase tracking-tighter"><span className="px-1.5 py-0.5 bg-white/10 border border-white/20 mr-1">ENTER</span> Map SKU</span>
                            </div>
                        </div>
                    </div>

                    <div className="p-3 bg-white border-t border-app-border flex-shrink-0">
                        <button
                            onClick={() => setIsAddMedicineSubModalOpen(true)}
                            className="w-full px-4 py-2 bg-emerald-50 text-emerald-700 border-2 border-emerald-200 text-[10px] font-black uppercase tracking-widest hover:bg-emerald-100"
                        >
                            + Register Missing SKU
                        </button>
                    </div>
                </div>
            </Modal>

            <AddMedicineModal
                isOpen={isAddMedicineSubModalOpen}
                onClose={() => setIsAddMedicineSubModalOpen(false)}
                onAddMedicine={handleAddMedicineSuccess}
                initialName={cleanItemName(reconciledItems[activeScannedIndex]?.name || '')}
                organizationId={organizationId}
            />
        </>
    );
};

export default LinkToMasterModal;
