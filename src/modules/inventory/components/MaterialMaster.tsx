import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import Card from '@core/components/ui/Card';
import EditMedicineModal from '@modules/inventory/components/EditMedicineModal';
import AddMedicineModal from '@modules/inventory/components/AddMedicineModal';
import SupplierSyncView from '@modules/suppliers/components/SupplierSyncView';
import type { Medicine, RegisteredPharmacy, Supplier, Purchase, SupplierProductMap, InventoryItem, PermissionSet } from '@core/types';
import { fuzzyMatch } from '@core/utils/search';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';

const uniformTextStyle = "text-2xl font-normal tracking-tight uppercase leading-tight";
const FALLBACK_ROW_HEIGHT_PX = 56;
const MIN_ITEMS_PER_PAGE = 10;

type MedicineSortableKeys = keyof Medicine;

const MedicineSortableHeader: React.FC<{
  label: string; sortKey: MedicineSortableKeys; sortConfig: { key: MedicineSortableKeys; direction: 'ascending' | 'descending' }; requestSort: (key: MedicineSortableKeys) => void;
}> = ({ label, sortKey, sortConfig, requestSort }) => {
  const isSorted = sortConfig?.key === sortKey;
  const directionIcon = isSorted ? (sortConfig.direction === 'ascending' ? '▲' : '▼') : '';
  return (
    <th 
      scope="col" 
      className={`py-1.5 px-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors ${uniformTextStyle}`} 
      onClick={() => requestSort(sortKey)}
    >
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="text-[10px] font-black text-primary">{directionIcon}</span>
      </div>
    </th>
  );
};

interface MaterialMasterProps {
    medicines: Medicine[];
    inventory: InventoryItem[];
    onAddMedicine: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    onUpdateMedicine: (updated: Medicine) => void;
    currentUser: RegisteredPharmacy | null;
    suppliers: Supplier[];
    onAddPurchase: (purchase: Omit<Purchase, 'id' | 'purchaseSerialId'>, supplierGstNumber?: string) => Promise<void>;
    onBulkAddMedicines: (medicines: Omit<Medicine, 'id'>[]) => void;
    onSearchMedicines: (searchTerm: string) => void;
    onMassUpdateClick: (selectedIds: string[]) => void;
    onSaveMapping: (map: SupplierProductMap) => Promise<void>;
    onDeleteMapping: (id: string) => Promise<void>;
    mappings: SupplierProductMap[];
    initialSubModule?: SubModule;
    addNotification?: (message: string, type?: 'success' | 'error' | 'warning') => void;
    permissions?: PermissionSet;
}

type SubModule = 'master' | 'sync' | 'bulk' | 'pricing';

const MaterialMaster: React.FC<MaterialMasterProps> = ({ 
    medicines, inventory, onAddMedicine, onUpdateMedicine, currentUser, 
    suppliers, onAddPurchase, onBulkAddMedicines, onSearchMedicines, 
    onMassUpdateClick, onSaveMapping, onDeleteMapping, mappings,
    initialSubModule = 'master', permissions
}) => {
    const defaultPermissions: PermissionSet = {
        view: true,
        entry: true,
        edit: true,
        delete: true,
        approve: true,
        print: true,
        export: true,
        full: true,
    };
    const perms = permissions || defaultPermissions;

    const [activeSubModule, setActiveSubModule] = useState<SubModule>(initialSubModule);
    const [medSearchTerm, setMedSearchTerm] = useState('');
    const [medSortConfig, setMedSortConfig] = useState<{ key: MedicineSortableKeys; direction: 'ascending' | 'descending' }>({ key: 'name', direction: 'ascending' });
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage, setItemsPerPage] = useState(MIN_ITEMS_PER_PAGE);
    const tableScrollRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (activeSubModule !== 'master') return;
        const recompute = () => {
            const el = tableScrollRef.current;
            if (!el) return;
            const thead = el.querySelector('thead');
            const firstRow = el.querySelector('tbody tr');
            const headerHeight = thead ? thead.getBoundingClientRect().height : 0;
            const rowHeight = firstRow ? firstRow.getBoundingClientRect().height : FALLBACK_ROW_HEIGHT_PX;
            const available = el.clientHeight - headerHeight;
            if (available <= 0 || rowHeight <= 0) return;
            const fit = Math.floor(available / rowHeight);
            setItemsPerPage(prev => {
                const next = Math.max(MIN_ITEMS_PER_PAGE, fit);
                return next === prev ? prev : next;
            });
        };
        const raf = requestAnimationFrame(recompute);
        const el = tableScrollRef.current;
        const ro = el ? new ResizeObserver(recompute) : null;
        if (el && ro) ro.observe(el);
        return () => {
            cancelAnimationFrame(raf);
            ro?.disconnect();
        };
    }, [activeSubModule]);
    
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [medicineToEdit, setMedicineToEdit] = useState<Medicine | null>(null);

    useEffect(() => {
        setActiveSubModule(initialSubModule);
    }, [initialSubModule]);

    // Reset page when search term, sorting, or page size changes
    useEffect(() => {
        setCurrentPage(1);
    }, [medSearchTerm, medSortConfig, itemsPerPage]);

    const handleOpenEditModal = (med: Medicine) => {
        setMedicineToEdit(med);
        setIsEditModalOpen(true);
    };

    const handleAddMedicineSuccess = async (medData: Omit<Medicine, 'id'>) => {
        await onAddMedicine(medData);
        setIsAddModalOpen(false);
    };

    const filteredAndSortedMedicines = useMemo(() => {
        let filtered = [...medicines];
        if (medSearchTerm) {
            filtered = filtered.filter(m => 
                fuzzyMatch(m.name, medSearchTerm) || 
                fuzzyMatch(m.composition, medSearchTerm) || 
                fuzzyMatch(m.brand, medSearchTerm) ||
                fuzzyMatch(m.materialCode, medSearchTerm)
            );
        }
        filtered.sort((a: any, b: any) => {
            let aVal = a[medSortConfig.key] ?? '';
            let bVal = b[medSortConfig.key] ?? '';
            
            if (medSortConfig.key === 'mrp') {
                aVal = parseFloat(aVal) || 0;
                bVal = parseFloat(bVal) || 0;
            }

            if (aVal < bVal) return medSortConfig.direction === 'ascending' ? -1 : 1;
            if (aVal > bVal) return medSortConfig.direction === 'ascending' ? 1 : -1;
            return 0;
        });
        return filtered;
    }, [medSortConfig, medicines, medSearchTerm]);

    const totalPages = Math.ceil(filteredAndSortedMedicines.length / itemsPerPage);
    
    const paginatedMedicines = useMemo(() => {
        const startIndex = (currentPage - 1) * itemsPerPage;
        return filteredAndSortedMedicines.slice(startIndex, startIndex + itemsPerPage);
    }, [filteredAndSortedMedicines, currentPage]);

    const moduleTitles: Record<SubModule, string> = {
        master: 'Material Master Data',
        sync: 'Vendor Nomenclature',
        bulk: 'Bulk Utility',
        pricing: 'Master Price Maintain'
    };

    // Keyboard navigation for pagination
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, 'materialMaster')) return;
            if (activeSubModule !== 'master') return;
            const isModalOpen = !!medicineToEdit || isAddModalOpen;
            if (isModalOpen) return;

            if (e.key === 'ArrowRight' && currentPage < totalPages) {
                e.preventDefault();
                setCurrentPage(p => p + 1);
            } else if (e.key === 'ArrowLeft' && currentPage > 1) {
                e.preventDefault();
                setCurrentPage(p => p - 1);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeSubModule, currentPage, totalPages, medicineToEdit, isAddModalOpen]);

    const renderPageNumbers = () => {
        const delta = 2;
        const range = [];
        const rangeWithDots = [];
        let l;

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
                range.push(i);
            }
        }

        for (const i of range) {
            if (l) {
                if (i - l === 2) {
                    rangeWithDots.push(l + 1);
                } else if (i - l !== 1) {
                    rangeWithDots.push('...');
                }
            }
            rangeWithDots.push(i);
            l = i;
        }

        return rangeWithDots.map((p, idx) => (
            <button
                key={idx}
                disabled={p === '...'}
                onClick={() => typeof p === 'number' && setCurrentPage(p)}
                className={`min-w-[32px] h-8 px-2 border border-gray-400 text-[10px] font-black uppercase transition-all ${
                    p === currentPage 
                    ? 'bg-primary text-white border-primary shadow-inner' 
                    : p === '...' 
                    ? 'bg-white text-gray-400 cursor-default border-dashed' 
                    : 'bg-white text-gray-700 hover:bg-gray-50'
                }`}
            >
                {p}
            </button>
        ));
    };

    return (
        <main className="h-full flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">{moduleTitles[activeSubModule]}</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Items: {medicines.length}</span>
            </div>

            <div className="p-2 flex-1 flex flex-col gap-2 overflow-hidden">
                <div className="px-1">
                    {activeSubModule === 'bulk' && (
                        <div className="flex flex-col">
                             <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter">{moduleTitles[activeSubModule]}</h2>
                             <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                                Batch migration and utility tools
                             </p>
                        </div>
                    )}
                </div>

                <div className="flex-1 overflow-hidden flex flex-col min-h-0">
                    {activeSubModule === 'master' && (
                        <Card className="flex-1 min-h-0 flex flex-col p-0 tally-border !rounded-none overflow-hidden bg-white shadow-inner">
                            <div className="p-2 border-b border-gray-400 bg-gray-50 flex-shrink-0 flex gap-4 items-center justify-between">
                                <div className="relative flex-1 max-w-lg">
                                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                                    <input type="text" placeholder="Search by SKU Name, Code, Brand..." value={medSearchTerm} onChange={e => setMedSearchTerm(e.target.value)} className="w-full pl-10 pr-4 py-2 border border-gray-400 text-sm font-bold focus:bg-yellow-50 outline-none shadow-sm" />
                                </div>
                                {perms.entry && (
                                    <div className="flex items-center gap-3">
                                        <button onClick={() => setIsAddModalOpen(true)} className="px-6 py-2 tally-button-primary text-[10px] shadow-md flex items-center gap-2 flex-shrink-0">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                            Create Material (F2)
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div className="overflow-auto flex-1" ref={tableScrollRef}>
                                <table className="min-w-full border-collapse">
                                    <thead className="bg-[#e1e1e1] sticky top-0 z-10 border-b border-gray-400">
                                        <tr className={`${uniformTextStyle} text-gray-700`}>
                                            <th className="py-1.5 px-2 border-r border-gray-400 w-8 text-center">#</th>
                                            <MedicineSortableHeader label="Item Description" sortKey="name" sortConfig={medSortConfig} requestSort={(k) => setMedSortConfig({key: k, direction: medSortConfig.direction === 'ascending' ? 'descending' : 'ascending'})} />
                                            <th className="py-1.5 px-2 border-r border-gray-400 text-left w-20">Material Code</th>
                                            <th className="py-1.5 px-2 border-r border-gray-400 text-center w-12">Pack</th>
                                            <th className="py-1.5 px-2 border-r border-gray-400 text-center w-12">GST%</th>
                                            <th className="py-1.5 px-2 border-r border-gray-400 text-center w-8">Rx</th>
                                            <th className="py-1.5 px-2 text-right w-16">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-200">
                                        {paginatedMedicines.map((med, idx) => (
                                            <tr 
                                                key={med.id} 
                                                className="hover:bg-primary hover:text-white transition-colors cursor-pointer group" 
                                            >
                                                <td className={`py-1.5 px-2 border-r border-gray-200 text-center group-hover:text-white text-gray-400 ${uniformTextStyle}`}>{((currentPage - 1) * itemsPerPage) + idx + 1}</td>
                                                <td className="py-1.5 px-2 border-r border-gray-200">
                                                    <div className="flex flex-col">
                                                        <span className={`leading-none group-hover:text-white text-gray-900 ${uniformTextStyle}`}>{med.name}</span>
                                                        <span className="text-[11px] group-hover:text-white/70 text-gray-400 normal-case italic font-bold mt-1 line-clamp-1 leading-none">{med.composition}</span>
                                                    </div>
                                                </td>
                                                <td className={`py-1.5 px-2 border-r border-gray-200 font-mono font-bold group-hover:text-white text-gray-700 ${uniformTextStyle}`}>
                                                    {med.materialCode}
                                                </td>
                                                <td className={`py-1.5 px-2 border-r border-gray-200 text-center group-hover:text-white ${uniformTextStyle}`}>{med.pack || '—'}</td>
                                                <td className={`py-1.5 px-2 border-r border-gray-200 text-center group-hover:text-white text-gray-600 ${uniformTextStyle}`}>{med.gstRate}%</td>
                                                <td className="py-1.5 px-2 border-r border-gray-400 text-center group-hover:text-white">
                                                    {med.isPrescriptionRequired && <span className="text-red-600 font-black text-[10px] px-1.5 py-0.5 bg-red-50 border border-red-100 rounded group-hover:bg-red-600 group-hover:text-white group-hover:border-red-700">H</span>}
                                                </td>
                                                <td className="py-1.5 px-2 text-right">
                                                    <button 
                                                        onClick={() => handleOpenEditModal(med)}
                                                        className="text-primary font-black uppercase text-[10px] px-2 py-0.5 bg-primary/5 border border-primary/20 hover:bg-white hover:text-primary transition-all group-hover:bg-white group-hover:text-primary"
                                                    >
                                                        {perms.edit ? 'Alter' : 'View'}
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                        {paginatedMedicines.length === 0 && (
                                            <tr>
                                                <td colSpan={8} className="p-20 text-center text-gray-300 font-black uppercase tracking-[0.4em] italic text-sm">
                                                    No master records found
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                            
                            {/* Pagination Footer */}
                            {totalPages > 1 && (
                                <div className="p-2 bg-gray-100 border-t border-gray-400 flex justify-between items-center flex-shrink-0">
                                    <div className="text-[10px] font-black uppercase text-gray-500 tracking-widest ml-2">
                                        Showing {paginatedMedicines.length} of {filteredAndSortedMedicines.length} items
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button 
                                            disabled={currentPage === 1}
                                            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                                            className="px-4 h-8 border border-gray-400 bg-white text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-50 transition-colors shadow-sm"
                                        >
                                            Prev
                                        </button>
                                        
                                        <div className="flex items-center gap-1 mx-2">
                                            {renderPageNumbers()}
                                        </div>

                                        <button 
                                            disabled={currentPage === totalPages}
                                            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                                            className="px-4 h-8 border border-gray-400 bg-white text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-50 transition-colors shadow-sm"
                                        >
                                            Next
                                        </button>
                                    </div>
                                    <div className="text-[9px] font-bold text-gray-400 uppercase mr-2 italic">
                                        Use ← → keys to flip pages
                                    </div>
                                </div>
                            )}
                        </Card>
                    )}

                    {activeSubModule === 'sync' && (
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                            <SupplierSyncView 
                                suppliers={suppliers}
                                medicines={medicines}
                                mappings={mappings}
                                onSaveMapping={onSaveMapping}
                                onDeleteMapping={onDeleteMapping}
                            />
                        </div>
                    )}

                    {activeSubModule === 'bulk' && (
                        <Card className="p-16 tally-border bg-white text-center flex flex-col items-center justify-center flex-1 min-h-0">
                             <p className="font-black uppercase tracking-[0.4em] text-gray-900 text-2xl">Central Data Migration</p>
                             <p className="text-base mt-4 text-gray-500 max-w-md">Batch migration and utility tools for system maintenance.</p>
                             <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-config', { detail: 'dataManagement' }))} className="mt-10 px-12 py-4 tally-button-primary text-xs shadow-2xl tracking-[0.2em]">Open Data Management</button>
                        </Card>
                    )}
                </div>
            </div>
            
            {isAddModalOpen && (
                <AddMedicineModal
                    isOpen={isAddModalOpen}
                    onClose={() => setIsAddModalOpen(false)}
                    onAddMedicine={handleAddMedicineSuccess}
                    organizationId={currentUser?.organization_id || ''}
                    organizationType={currentUser?.organization_type || null}
                    existingMedicines={medicines}
                />
            )}

            {medicineToEdit && (
                <EditMedicineModal 
                    isOpen={isEditModalOpen}
                    onClose={() => { setIsEditModalOpen(false); setMedicineToEdit(null); }}
                    medicine={medicineToEdit}
                    onSave={onUpdateMedicine}
                    organizationType={currentUser?.organization_type || null}
                    existingMedicines={medicines}
                    inventoryItems={inventory}
                    isReadOnly={!perms.edit}
                />
            )}
        </main>
    );
};

export default MaterialMaster;
