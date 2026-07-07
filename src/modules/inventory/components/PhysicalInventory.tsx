
import React, { useState, useMemo, useEffect, useRef } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import BarcodeScannerModal from '../components/BarcodeScannerModal';
import type { InventoryItem, Medicine, PhysicalInventorySession, PhysicalInventoryCountItem } from '@core/types';
import { PhysicalInventoryStatus } from '@core/types';
import { fuzzyMatch } from '@core/utils/search';
import { getInventoryPolicy, getResolvedMedicinePolicy } from '@core/utils/materialType';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';
import TallyPrompt from '@core/components/ui/TallyPrompt';

const uniformTextStyle = "text-2xl font-normal tracking-tight uppercase leading-tight";

// Fix: Added missing PHYSICAL_COUNT_REASONS constant for the audit goal dropdown
const PHYSICAL_COUNT_REASONS = [
    "Monthly Audit",
    "Damaged/Leakage Check",
    "Expiry Review",
    "Staff Handover",
    "Discrepancy Investigation",
    "Yearly Closing",
    "Other"
];

const formatStockDisplay = (totalUnits: number, unitsPerPack: number) => {
    const isNegative = totalUnits < 0;
    const absUnits = Math.abs(totalUnits);
    const packs = Math.floor(absUnits / unitsPerPack);
    const loose = absUnits % unitsPerPack;
    
    const sign = totalUnits === 0 ? '' : (isNegative ? '-' : '+');
    const mainPart = `${packs}:${String(loose).padStart(2, '0')}`;
    return `${sign}${mainPart} (${totalUnits})`;
};

const debounce = (func: Function, waitFor: number) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return (...args: any[]) => {
      if (timeout !== null) clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), waitFor);
    };
};

interface PhysicalInventoryPageProps {
    inventory: InventoryItem[];
    medicines: Medicine[];
    physicalInventorySessions: PhysicalInventorySession[];
    onStartNewCount: () => void;
    onUpdateCount: (session: PhysicalInventorySession) => void;
    onFinalizeCount: (session: PhysicalInventorySession) => void;
    onCancelCount: (session: PhysicalInventorySession) => void;
}

const PhysicalInventoryPage: React.FC<PhysicalInventoryPageProps> = ({ inventory, medicines, physicalInventorySessions, onStartNewCount, onUpdateCount, onFinalizeCount, onCancelCount }) => {
    const [selectedSessionForView, setSelectedSessionForView] = useState<PhysicalInventorySession | null>(null);
    const sessions = useMemo(() => Array.isArray(physicalInventorySessions) ? physicalInventorySessions : [], [physicalInventorySessions]);
    const activeSession = useMemo(() => sessions.find(s => s.status === PhysicalInventoryStatus.IN_PROGRESS), [sessions]);

    if (activeSession) {
        return <CountingView key={activeSession.id} session={activeSession} inventory={inventory} medicines={medicines} onUpdate={onUpdateCount} onFinalize={onFinalizeCount} onCancel={onCancelCount} />;
    }

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Stock Audit Journal</span>
                <span className="text-[10px] font-black uppercase text-accent">Sessions: {sessions.length}</span>
            </div>

            <HistoryView 
                sessions={sessions} 
                onStartNew={onStartNewCount} 
                onViewSession={setSelectedSessionForView}
            />
            {selectedSessionForView && (
                <PhysicalInventoryDetailModal 
                    isOpen={true} 
                    onClose={() => setSelectedSessionForView(null)} 
                    session={selectedSessionForView} 
                    inventory={inventory}
                />
            )}
        </div>
    );
};

const HistoryView: React.FC<{ 
    sessions: PhysicalInventorySession[]; 
    onStartNew: () => void; 
    onViewSession: (s: PhysicalInventorySession) => void;
}> = ({ sessions, onStartNew, onViewSession }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, 'physicalInventory')) return;
            if (e.key === 'F2') {
                e.preventDefault();
                onStartNew();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onStartNew]);

    const completedSessions = useMemo(() => {
        let filtered = sessions.filter(s => s.status === PhysicalInventoryStatus.COMPLETED);

        if (searchTerm) {
            filtered = filtered.filter(s => 
                (s.id || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                (s.reason || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                (s.performedByName || '').toLowerCase().includes(searchTerm.toLowerCase())
            );
        }

        if (startDate) {
            const start = new Date(startDate).getTime();
            filtered = filtered.filter(s => new Date(s.startDate).getTime() >= start);
        }

        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            filtered = filtered.filter(s => new Date(s.endDate || s.startDate).getTime() <= end.getTime());
        }

        return filtered.sort((a, b) => {
            const dateB = new Date(b.startDate || b.endDate || 0).getTime();
            const dateA = new Date(a.startDate || a.endDate || 0).getTime();
            return (isNaN(dateB) ? 0 : dateB) - (isNaN(dateA) ? 0 : dateA);
        });
    }, [sessions, searchTerm, startDate, endDate]);

    return (
        <div className="flex-1 p-4 overflow-y-auto bg-app-bg">
            <div className="flex justify-end mb-4">
                <button onClick={onStartNew} className="px-6 py-2 tally-button-primary text-[10px] shadow-lg flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="mr-2"><line x1="12" cy="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    F2: Create Audit
                </button>
            </div>

            <Card className="p-3 tally-border !rounded-none grid grid-cols-1 md:grid-cols-4 gap-4 items-end bg-white">
                <div className="md:col-span-2">
                    <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Search Audits</label>
                    <input type="text" placeholder="Session ID, Reason..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold focus:bg-primary/5 outline-none" />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">From Date</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none" />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">To Date</label>
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold outline-none" />
                </div>
            </Card>

            <Card className="mt-4 p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white">
                <div className="overflow-x-auto">
                    <table className="min-w-full border-collapse text-sm">
                        <thead className="bg-gray-100 sticky top-0 border-b border-gray-400">
                            <tr className="text-[10px] font-black uppercase text-gray-600">
                                <th className="p-2 border-r border-gray-400 text-left w-10">Sl.</th>
                                <th className="p-2 border-r border-gray-400 text-left">Session ID</th>
                                <th className="p-2 border-r border-gray-400 text-left">Reason</th>
                                <th className="p-2 border-r border-gray-400 text-left">Staff</th>
                                <th className="p-2 border-r border-gray-400 text-right">Variance Impact</th>
                                <th className="p-2 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {completedSessions.map((s, idx) => (
                                <tr key={s.id} className="hover:bg-primary hover:text-white group transition-colors cursor-pointer" onClick={() => onViewSession(s)}>
                                    <td className="p-2 border-r border-gray-200 text-center text-gray-400 group-hover:text-white/70 font-bold">{idx + 1}</td>
                                    <td className="p-2 border-r border-gray-200 font-mono font-bold text-primary group-hover:text-white uppercase">{s.id}</td>
                                    <td className="p-2 border-r border-gray-200 uppercase font-bold text-gray-700 group-hover:text-white">{s.reason || 'Manual Audit'}</td>
                                    <td className="p-2 border-r border-gray-200 uppercase text-[10px] font-black group-hover:text-white">{s.performedByName}</td>
                                    <td className={`p-2 border-r border-gray-200 text-right font-black ${s.totalVarianceValue > 0 ? 'text-green-700 group-hover:text-white' : s.totalVarianceValue < 0 ? 'text-red-700 group-hover:text-red-200' : 'group-hover:text-white'}`}>
                                        ₹{(s.totalVarianceValue || 0).toFixed(2)}
                                    </td>
                                    <td className="p-2 text-right">
                                        <button className="text-primary font-black uppercase text-[10px] group-hover:text-white hover:underline">View Log</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
};

const CountingView: React.FC<{ 
    session: PhysicalInventorySession; 
    inventory: InventoryItem[]; 
    medicines: Medicine[];
    onUpdate: (s: PhysicalInventorySession) => void; 
    onFinalize: (s: PhysicalInventorySession) => void; 
    onCancel: (s: PhysicalInventorySession) => void;
}> = ({ session, inventory, medicines, onUpdate, onFinalize, onCancel }) => {
    const [countedItems, setCountedItems] = useState<PhysicalInventoryCountItem[]>(session.items || []);
    const [reason, setReason] = useState(session.reason || '');
    const [isDiscoveryModalOpen, setIsDiscoveryModalOpen] = useState(false);
    const [modalSearchTerm, setModalSearchTerm] = useState('');
    const [selectedDiscoveryIndex, setSelectedDiscoveryIndex] = useState(0);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [isReviewOpen, setIsReviewOpen] = useState(false);
    const [addProductQuery, setAddProductQuery] = useState('');
    const [showDiscardPrompt, setShowDiscardPrompt] = useState(false);
    const isEndingRef = useRef(false);
    const discoveryListRef = useRef<HTMLDivElement>(null);
    const discoverySearchInputRef = useRef<HTMLInputElement>(null);
    const addProductInputRef = useRef<HTMLInputElement>(null);

    const totalVarianceValue = useMemo(() => {
        return countedItems.reduce((sum, item) => sum + (item.variance * item.cost), 0);
    }, [countedItems]);

    const debouncedUpdate = useMemo(() => debounce((updatedSession: PhysicalInventorySession) => {
        if (!isEndingRef.current) {
            onUpdate(updatedSession);
        }
    }, 2000), [onUpdate]);

    useEffect(() => {
        if (!isEndingRef.current) {
            debouncedUpdate({ 
                ...session, 
                items: countedItems, 
                reason: reason,
                totalVarianceValue: totalVarianceValue
            });
        }
    }, [countedItems, reason, session, debouncedUpdate, totalVarianceValue]);

    const discoveryResults = useMemo(() => {
        const term = modalSearchTerm.trim();

        const grouped = new Map<string, InventoryItem>();

        inventory.forEach(i => {
            const invPolicy = getInventoryPolicy(i, medicines);
            if (!invPolicy.inventorised) return;
            if (
                !term ||
                fuzzyMatch(i.name, term) ||
                (i.barcode && fuzzyMatch(i.barcode, term)) ||
                (i.code && fuzzyMatch(i.code, term))
            ) {
                grouped.set(`${i.name.toLowerCase()}|${(i.brand || '').toLowerCase()}`, i);
            }
        });

        medicines.forEach(m => {
            const medPolicy = getResolvedMedicinePolicy(m);
            if (!medPolicy.inventorised) return;
            if (
                !term ||
                fuzzyMatch(m.name, term) ||
                (m.barcode && fuzzyMatch(m.barcode, term)) ||
                (m.materialCode && fuzzyMatch(m.materialCode, term))
            ) {
                const key = `${m.name.toLowerCase()}|${(m.brand || '').toLowerCase()}`;
                if (!grouped.has(key)) {
                    grouped.set(key, {
                        id: `mm-${m.id}`,
                        organization_id: m.organization_id || '',
                        name: m.name,
                        code: m.materialCode,
                        brand: m.brand || '',
                        category: 'Medicine',
                        manufacturer: m.manufacturer || '',
                        stock: 0,
                        unitsPerPack: parseInt(m.pack?.match(/\d+/)?.[0] || '1', 10),
                        minStockLimit: 0,
                        batch: medPolicy.inventorised ? 'UNTRACKED' : '',
                        expiry: medPolicy.inventorised ? 'N/A' : '',
                        purchasePrice: 0,
                        mrp: parseFloat(m.mrp || '0'),
                        gstPercent: m.gstRate || 0,
                        hsnCode: m.hsnCode || '',
                        composition: m.composition || '',
                        barcode: m.barcode || '',
                        is_active: true,
                    });
                }
            }
        });

        return Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [modalSearchTerm, inventory, medicines]);

    useEffect(() => {
        if (!isDiscoveryModalOpen) return;
        setTimeout(() => discoverySearchInputRef.current?.focus(), 50);
    }, [isDiscoveryModalOpen]);

    useEffect(() => {
        const activeRow = discoveryListRef.current?.querySelector(`[data-index="${selectedDiscoveryIndex}"]`);
        if (activeRow) {
            activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }, [selectedDiscoveryIndex]);

    const addItemToCount = (item: InventoryItem, increment = false) => {
        setCountedItems(prev => {
            const existingIndex = prev.findIndex(ci => ci.inventoryItemId === item.id);
            if (existingIndex >= 0) {
                const existing = prev[existingIndex];
                if (increment) {
                    const newPhysicalCount = existing.physicalCount + 1;
                    const updatedItems = [...prev];
                    updatedItems[existingIndex] = {
                        ...existing,
                        physicalCount: newPhysicalCount,
                        variance: newPhysicalCount - existing.systemStock
                    };
                    return updatedItems;
                }
                setTimeout(() => {
                    const input = document.getElementById(`count-packs-${item.id}`) as HTMLInputElement;
                    input?.focus();
                    input?.select();
                }, 50);
                return prev;
            }
            
            const newItem: PhysicalInventoryCountItem = {
                inventoryItemId: item.id,
                name: item.name,
                brand: item.brand,
                batch: item.batch,
                expiry: item.expiry,
                systemStock: item.stock,
                physicalCount: increment ? 1 : 0, 
                variance: (increment ? 1 : 0) - item.stock, 
                cost: item.cost || (item.purchasePrice / (item.unitsPerPack || 1)),
                unitsPerPack: item.unitsPerPack || 1,
            };
            
            setTimeout(() => {
                const input = document.getElementById(`count-packs-${item.id}`) as HTMLInputElement;
                input?.focus();
                input?.select();
            }, 50);

            return [newItem, ...prev];
        });
    };

    const addItemFromDiscovery = (item: InventoryItem) => {
        addItemToCount(item);
        setAddProductQuery('');
        setIsDiscoveryModalOpen(false);
    };

    const openDiscoveryModal = (initialSearchTerm = '') => {
        setModalSearchTerm(initialSearchTerm);
        setSelectedDiscoveryIndex(0);
        setIsDiscoveryModalOpen(true);
    };

    const moveToNextRowAndOpenDiscovery = () => {
        setAddProductQuery('');
        setTimeout(() => {
            addProductInputRef.current?.focus();
            openDiscoveryModal('');
        }, 0);
    };

    const handleAddProductRowKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            openDiscoveryModal(addProductQuery.trim());
        }
    };

    const handleActualCountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, itemId: string, field: 'packs' | 'loose') => {
        if (e.key !== 'Enter') return;

        e.preventDefault();

        if (field === 'packs') {
            const looseInput = document.getElementById(`count-loose-${itemId}`) as HTMLInputElement | null;
            looseInput?.focus();
            looseInput?.select();
            return;
        }

        moveToNextRowAndOpenDiscovery();
    };

    const handleDiscoveryKeyDown = (e: React.KeyboardEvent) => {
        if (!isDiscoveryModalOpen) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedDiscoveryIndex(prev => Math.min(prev + 1, Math.max(discoveryResults.length - 1, 0)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedDiscoveryIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const target = discoveryResults[selectedDiscoveryIndex] || discoveryResults[0];
            if (target) {
                addItemFromDiscovery(target);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setIsDiscoveryModalOpen(false);
        }
    };

    useEffect(() => {
        setSelectedDiscoveryIndex(0);
    }, [modalSearchTerm]);

    useEffect(() => {
        if (!isDiscoveryModalOpen) {
            setModalSearchTerm('');
        }
    }, [isDiscoveryModalOpen]);
    
    const handleCountChange = (itemId: string, packs: number, loose: number) => {
        const existingItem = countedItems.find(i => i.inventoryItemId === itemId);
        const inventoryItem = inventory.find(i => i.id === itemId);
        const unitsPerPack = existingItem?.unitsPerPack || inventoryItem?.unitsPerPack || 1;
        const totalPhysical = (packs * unitsPerPack) + loose;

        setCountedItems(prev => prev.map(item => {
            if (item.inventoryItemId === itemId) {
                return {
                    ...item,
                    physicalCount: totalPhysical,
                    variance: totalPhysical - item.systemStock,
                };
            }
            return item;
        }));
    };

    const handleRemoveItem = (itemId: string) => {
        setCountedItems(prev => prev.filter(item => item.inventoryItemId !== itemId));
    };
    
    const handleScanSuccess = (decodedText: string) => {
        setIsScannerOpen(false);
        const foundItem = inventory.find(item => item.barcode === decodedText.trim());
        if (foundItem) {
            addItemToCount(foundItem, true);
        } else {
            alert(`Product with barcode "${decodedText}" not found.`);
        }
    };

    const handleCancelClick = () => {
        setShowDiscardPrompt(true);
    };

    const handleConfirmDiscard = () => {
        setShowDiscardPrompt(false);
        isEndingRef.current = true;
        onCancel(session);
    };

    const handleFinalizeClick = () => {
        // Set ending flag before firing callback
        isEndingRef.current = true;
        onFinalize({...session, items: countedItems, reason: reason, totalVarianceValue});
    };

    return (
        <div className="flex flex-col h-full overflow-hidden bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Physical Count In Progress</span>
                <span className="text-[10px] font-black uppercase text-accent">Session: {session.id}</span>
            </div>

            <div className="p-4 flex-1 flex flex-col gap-4 overflow-hidden">
                <div className="flex justify-between items-end gap-4 px-2">
                    <div className="flex gap-4 items-end flex-1">
                        <div className="w-48">
                            <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Audit Goal</label>
                            <select 
                                value={reason} 
                                onChange={e => setReason(e.target.value)}
                                className="w-full border border-gray-400 p-2 text-sm font-bold outline-none"
                            >
                                <option value="">Select reason...</option>
                                {PHYSICAL_COUNT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                        </div>
                        <div className="px-6 py-2 bg-slate-100 border border-gray-300">
                             <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">Live Variance Impact</p>
                             <p className={`text-sm font-black ${totalVarianceValue >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>₹{Math.abs(totalVarianceValue).toFixed(2)}</p>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <button onClick={handleCancelClick} className="px-6 py-2 tally-border bg-white text-red-600 font-bold uppercase text-[10px]">Discard</button>
                        <button onClick={() => setIsReviewOpen(true)} className="px-8 py-2 tally-button-primary shadow-lg uppercase text-[10px]">Post Adjustments</button>
                    </div>
                </div>

                <Card className="flex-1 p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white">
                    <div className="overflow-auto h-full">
                        <table className="min-w-full border-collapse text-sm">
                            <thead className="bg-gray-100 sticky top-0 z-10 border-b border-gray-400">
                                <tr className={`${uniformTextStyle} text-gray-600`}>
                                    <th className="p-2 border-r border-gray-400 text-left">Particulars</th>
                                    <th className="p-2 border-r border-gray-400 text-center w-24">System</th>
                                    <th className="p-2 border-r border-gray-400 text-center w-48">Actual Count</th>
                                    <th className="p-2 border-r border-gray-400 text-right w-32">Variance</th>
                                    <th className="p-2 w-10"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {countedItems.map(item => {
                                    const invItem = inventory.find(i => i.id === item.inventoryItemId);
                                    const uPP = item.unitsPerPack || invItem?.unitsPerPack || 1;
                                    const phyPacks = Math.floor(item.physicalCount / uPP);
                                    const phyLoose = item.physicalCount % uPP;
                                    return (
                                        <tr key={item.inventoryItemId} className="hover:bg-green-100 transition-colors">
                                            <td className="p-2 border-r border-gray-200">
                                                <p className="font-bold text-gray-900 uppercase">{item.name}</p>
                                                <p className="text-[9px] text-gray-400 font-bold uppercase">Batch: {item.batch}</p>
                                            </td>
                                            <td className="p-2 border-r border-gray-200 text-center font-bold text-gray-500">{formatStockDisplay(item.systemStock, uPP)}</td>
                                            <td className="p-2 border-r border-gray-200 text-center">
                                                <div className="flex items-center justify-center gap-2">
                                                    <input 
                                                        id={`count-packs-${item.inventoryItemId}`}
                                                        type="number" 
                                                        value={phyPacks} 
                                                        onChange={e => handleCountChange(item.inventoryItemId, parseInt(e.target.value) || 0, phyLoose)} 
                                                        onKeyDown={e => handleActualCountKeyDown(e, item.inventoryItemId, 'packs')}
                                                        className="w-16 p-1 border border-gray-400 text-center font-black no-spinner outline-none focus:bg-green-100" 
                                                        placeholder="Pkts"
                                                    />
                                                    <span className="font-black">:</span>
                                                    <input 
                                                        id={`count-loose-${item.inventoryItemId}`}
                                                        type="number" 
                                                        value={phyLoose} 
                                                        onChange={e => handleCountChange(item.inventoryItemId, phyPacks, parseInt(e.target.value) || 0)} 
                                                        onKeyDown={e => handleActualCountKeyDown(e, item.inventoryItemId, 'loose')}
                                                        className="w-12 p-1 border border-gray-400 text-center font-bold no-spinner outline-none focus:bg-green-100" 
                                                        placeholder="Lse"
                                                    />
                                                </div>
                                            </td>
                                            <td className={`p-2 border-r border-gray-200 text-right font-black ${item.variance > 0 ? 'text-green-700' : item.variance < 0 ? 'text-red-700' : ''}`}>
                                                {formatStockDisplay(item.variance, uPP)}
                                            </td>
                                            <td className="p-2 text-center">
                                                <button onClick={() => handleRemoveItem(item.inventoryItemId)} className="text-red-300 hover:text-red-600 transition-colors">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                                <tr className="bg-primary/5 hover:bg-primary/10 transition-colors">
                                    <td className="p-2 border-r border-gray-200 align-top">
                                        <div className="grid grid-cols-[52px_minmax(0,1fr)] border border-gray-300 bg-white">
                                            <div className="border-r border-gray-300 p-2">
                                                <p className="text-[9px] font-black uppercase tracking-wide text-gray-500">Sl.</p>
                                                <p className="text-sm font-black text-primary leading-none">{countedItems.length + 1}</p>
                                            </div>
                                            <div className="p-2">
                                                <p className="text-[9px] font-black uppercase tracking-wide text-gray-500 mb-1">Name of Item</p>
                                                <input
                                                    ref={addProductInputRef}
                                                    type="text"
                                                    value={addProductQuery}
                                                    onChange={(e) => setAddProductQuery(e.target.value)}
                                                    onKeyDown={handleAddProductRowKeyDown}
                                                    onFocus={() => setSelectedDiscoveryIndex(0)}
                                                    placeholder="Type item name or code..."
                                                    className="w-full border border-gray-400 px-2 py-1 text-[11px] font-black uppercase tracking-wide outline-none focus:border-primary focus:bg-green-100"
                                                />
                                            </div>
                                        </div>
                                    </td>
                                    <td className="p-2 border-r border-gray-200 text-center text-gray-400 font-bold">--</td>
                                    <td className="p-2 border-r border-gray-200 text-center text-gray-400 font-bold">Press Enter to open matrix</td>
                                    <td className="p-2 border-r border-gray-200 text-right text-gray-400 font-bold">--</td>
                                    <td className="p-2"></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </Card>
            </div>
            <BarcodeScannerModal isOpen={isScannerOpen} onClose={() => setIsScannerOpen(false)} onScanSuccess={handleScanSuccess} />
            <ReviewModal isOpen={isReviewOpen} onClose={() => setIsReviewOpen(false)} session={{...session, items: countedItems, reason: reason, totalVarianceValue}} onConfirm={handleFinalizeClick} />
            <Modal
                isOpen={isDiscoveryModalOpen}
                onClose={() => setIsDiscoveryModalOpen(false)}
                title="Product Selection Matrix"
            >
                <div className="flex flex-col h-full bg-[#fffde7] font-normal outline-none" onKeyDown={handleDiscoveryKeyDown}>
                    <div className="py-1.5 px-4 bg-primary text-white flex-shrink-0 flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                            <span className="text-xs font-black uppercase tracking-[0.2em]">Material Discovery Engine</span>
                        </div>
                        <span className="text-[10px] font-bold uppercase opacity-70">↑/↓ Navigate | Enter Select</span>
                    </div>

                    <div className="p-2 bg-white border-b-2 border-primary/10">
                        <input
                            ref={discoverySearchInputRef}
                            type="text"
                            value={modalSearchTerm}
                            onChange={e => setModalSearchTerm(e.target.value)}
                            placeholder="Type medicine name or code..."
                            className="w-full p-2 border-2 border-primary/20 bg-white text-base font-black focus:border-primary outline-none shadow-inner uppercase tracking-tighter"
                        />
                    </div>

                    <div className="flex-1 overflow-auto bg-white" ref={discoveryListRef}>
                        {discoveryResults.length > 0 ? (
                            <table className="min-w-full border-collapse">
                                <thead className="sticky top-0 z-10 bg-gray-100 border-b border-gray-400 shadow-sm">
                                    <tr className="text-[10px] font-black uppercase text-gray-500 tracking-widest">
                                        <th className="p-1.5 px-3 text-left border-r border-gray-200">Description of Medicine</th>
                                        <th className="p-1.5 px-3 text-left border-r border-gray-200 w-32 text-center">Code</th>
                                        <th className="p-1.5 px-3 text-left border-r border-gray-200">MFR / Brand</th>
                                        <th className="p-1.5 px-3 text-center border-r border-gray-200">Stock</th>
                                        <th className="p-1.5 px-3 text-right">MRP</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {discoveryResults.map((item, idx) => {
                                        const isSelected = idx === selectedDiscoveryIndex;
                                        return (
                                            <tr
                                                key={item.id}
                                                data-index={idx}
                                                onMouseEnter={() => setSelectedDiscoveryIndex(idx)}
                                                onClick={() => addItemFromDiscovery(item)}
                                                className={`cursor-pointer transition-all border-b border-gray-100 ${isSelected ? 'bg-primary text-white scale-[1.01] z-10 shadow-xl' : 'hover:bg-green-100'}`}
                                            >
                                                <td className="p-1.5 px-3 border-r border-gray-200">
                                                    <p className={`leading-none ${uniformTextStyle} ${isSelected ? 'text-white' : 'text-gray-950'}`}>{item.name}</p>
                                                </td>
                                                <td className={`p-1.5 px-3 border-r border-gray-200 text-center font-mono ${uniformTextStyle} ${isSelected ? 'text-white' : 'text-primary'}`}>
                                                    {item.code || '--'}
                                                </td>
                                                <td className={`p-1.5 px-3 border-r border-gray-200 ${uniformTextStyle} ${isSelected ? 'text-white/80' : 'text-gray-500'}`}>{item.manufacturer || item.brand}</td>
                                                <td className={`p-1.5 px-3 border-r border-gray-200 text-center ${uniformTextStyle} ${isSelected ? 'text-white' : (item.stock <= 0 ? 'text-red-500' : 'text-emerald-700')}`}>{formatStockDisplay(item.stock, item.unitsPerPack || 1)}</td>
                                                <td className={`p-1.5 px-3 text-right ${uniformTextStyle} ${isSelected ? 'text-white' : 'text-gray-900'}`}>₹{(item.mrp || 0).toFixed(2)}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        ) : (
                            <div className="h-full flex flex-col items-center justify-center opacity-20 p-20 text-center">
                                <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mb-6"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                                <p className="text-4xl font-black uppercase tracking-widest">No Matches</p>
                            </div>
                        )}
                    </div>
                </div>
            </Modal>
            {showDiscardPrompt && (
                <TallyPrompt
                    isOpen={showDiscardPrompt}
                    title="Discard Audit"
                    message="Discard audit session? Stock levels will not be changed."
                    onAccept={handleConfirmDiscard}
                    onDiscard={() => setShowDiscardPrompt(false)}
                    onCancel={() => setShowDiscardPrompt(false)}
                />
            )}
        </div>
    );
};

const ReviewModal = ({ isOpen, onClose, session, onConfirm }: any) => {
    if (!isOpen) return null;
    const totalVarianceValue = session.totalVarianceValue || 0;
    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Adjustment Confirmation" widthClass="max-w-2xl">
            <div className="p-6 space-y-4">
                <div className="bg-[var(--modal-header-bg-light)] dark:bg-[var(--modal-header-bg-dark)] p-4 text-white text-center rounded-none shadow-lg">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-60">Net Valuation Impact</p>
                    <p className="text-3xl font-black tracking-tighter">₹{totalVarianceValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                </div>
                <div className="tally-border max-h-60 overflow-auto">
                    <table className="min-w-full text-xs border-collapse">
                        <thead className="bg-gray-100 sticky top-0 border-b border-gray-400">
                            <tr className="uppercase font-bold">
                                <th className="p-2 text-left">Item</th>
                                <th className="p-2 text-center">Variance</th>
                                <th className="p-2 text-right">Value</th>
                            </tr>
                        </thead>
                        <tbody>
                            {session.items.map((item: any) => (
                                <tr key={item.inventoryItemId} className="border-b border-gray-100">
                                    <td className="p-2 font-bold uppercase truncate max-w-[150px]">{item.name}</td>
                                    <td className={`p-2 text-center font-black ${item.variance > 0 ? 'text-green-600' : 'text-red-600'}`}>{item.variance > 0 ? '+' : ''}{item.variance}</td>
                                    <td className="p-2 text-right font-bold">₹{(item.variance * item.cost).toFixed(2)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <div className="flex justify-end gap-3 pt-4">
                    <button onClick={onClose} className="px-6 py-2 tally-border bg-white font-bold uppercase text-[10px]">Back</button>
                    <button onClick={() => onConfirm(session)} className="px-8 py-2 tally-button-primary shadow-lg uppercase text-[10px]">Accept Changes</button>
                </div>
            </div>
        </Modal>
    );
};

const PhysicalInventoryDetailModal: React.FC<{ isOpen: boolean; onClose: () => void; session: PhysicalInventorySession; inventory: InventoryItem[]; }> = ({ isOpen, onClose, session, inventory }) => (
    <Modal isOpen={isOpen} onClose={onClose} title={`Audit Details: ${session.id}`} widthClass="max-w-4xl">
        <div className="p-6 overflow-y-auto max-h-[80vh]">
            <table className="min-w-full erp-table border-collapse text-xs">
                <thead>
                    <tr className="bg-gray-100 font-bold uppercase border-b border-black">
                        <th className="p-2 text-left">Particulars</th>
                        <th className="p-2 text-center">System Qty</th>
                        <th className="p-2 text-center">Actual Qty</th>
                        <th className="p-2 text-right">Variance</th>
                    </tr>
                </thead>
                <tbody>
                    {session.items.map(item => (
                        <tr key={item.inventoryItemId} className="border-b border-gray-100">
                            <td className="p-2 font-bold uppercase">{item.name} <span className="block text-[9px] text-gray-400">Batch: {item.batch}</span></td>
                            <td className="p-2 text-center font-bold text-gray-500">{formatStockDisplay(item.systemStock, item.unitsPerPack || 1)}</td>
                            <td className="p-2 text-center font-black text-primary">{item.physicalCount}</td>
                            <td className={`p-2 text-right font-black ${item.variance > 0 ? 'text-green-700' : item.variance < 0 ? 'text-red-700' : ''}`}>{item.variance > 0 ? '+' : ''}{item.variance}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    </Modal>
);

export default PhysicalInventoryPage;
