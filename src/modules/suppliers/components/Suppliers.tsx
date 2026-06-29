import React, { useState, useMemo, useEffect } from 'react';
import Card from '@core/components/ui/Card';
import type { Supplier, RegisteredPharmacy, PermissionSet } from '@core/types';
import type { SupplierQuickResult } from '@core/services/supplierService';
import { AddSupplierModal, EditSupplierModal } from '@modules/suppliers/components/AddSupplierModal';
import ExportSuppliersModal from '../components/ExportSuppliersModal';
import { fuzzyMatch } from '@core/utils/search';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';

const uniformTextStyle = 'text-2xl font-normal tracking-tight uppercase leading-tight';

const displayValue = (value: unknown, fallback = 'N/A'): string => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : fallback;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) {
        const normalized = value.map(item => displayValue(item, '')).filter(Boolean).join(', ');
        return normalized || fallback;
    }

    return fallback;
};

const addressFields: Array<{ label: string; key: 'address_line1' | 'address_line2' | 'area' | 'city' | 'district' | 'state' | 'pincode' | 'country' }> = [
    { label: 'Address Line 1', key: 'address_line1' },
    { label: 'Address Line 2', key: 'address_line2' },
    { label: 'Area / Locality', key: 'area' },
    { label: 'City', key: 'city' },
    { label: 'District', key: 'district' },
    { label: 'State', key: 'state' },
    { label: 'Pincode', key: 'pincode' },
    { label: 'Country', key: 'country' },
] as const;

interface SuppliersProps {
    suppliers: Supplier[];
    onAddSupplier: (data: Omit<Supplier, 'ledger' | 'organization_id'>, balance: number, date: string) => Promise<SupplierQuickResult>;
    onBulkAddSuppliers: (suppliers: any[]) => void;
    onRecordPayment: (supplierId: string, paymentAmount: number, paymentDate: string, description: string) => void;
    onUpdateSupplier: (supplier: Supplier) => Promise<any>;
    onBlockSupplier: (supplier: Supplier) => Promise<void> | void;
    onUnblockSupplier: (supplier: Supplier) => Promise<void> | void;
    onDeleteSupplier: (supplier: Supplier) => Promise<{ success: boolean; message: string }>;
    config: any;
    currentUser: RegisteredPharmacy | null;
    defaultSupplierControlGlId?: string;
    permissions?: PermissionSet;
}

const Suppliers: React.FC<SuppliersProps> = ({ suppliers, onAddSupplier, onBulkAddSuppliers, onRecordPayment, onUpdateSupplier, onBlockSupplier, onUnblockSupplier, onDeleteSupplier, config, currentUser, defaultSupplierControlGlId, permissions }) => {
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
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isExportModalOpen, setIsExportModalOpen] = useState(false);
    const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'blocked'>('all');

    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = 10;

    const selectedSupplier = useMemo(() => {
        if (!selectedSupplierId || !Array.isArray(suppliers)) return null;
        return suppliers.find(s => s.id === selectedSupplierId) || null;
    }, [suppliers, selectedSupplierId]);

    const filteredSuppliers = useMemo(() => {
        if (!Array.isArray(suppliers)) return [];
        return suppliers
            .filter(s => {
                if (!s) return false;
                const blocked = s.is_blocked === true || s.is_active === false;
                if (statusFilter === 'active') return !blocked;
                if (statusFilter === 'blocked') return blocked;
                return true;
            })
            .filter(s => fuzzyMatch(s.name || '', searchTerm) || fuzzyMatch(s.phone || '', searchTerm) || fuzzyMatch(s.mobile || '', searchTerm))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [suppliers, searchTerm, statusFilter]);

    useEffect(() => {
        setCurrentPage(1);
    }, [searchTerm, statusFilter]);

    const totalPages = Math.ceil(filteredSuppliers.length / pageSize);
    const paginatedSuppliers = useMemo(() => {
        const start = (currentPage - 1) * pageSize;
        return filteredSuppliers.slice(start, start + pageSize);
    }, [filteredSuppliers, currentPage, pageSize]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, 'suppliers')) return;
            if (e.key === 'F2' && perms.entry) {
                e.preventDefault();
                setIsAddModalOpen(true);
            } else if (e.key === 'F3' && perms.export) {
                e.preventDefault();
                if (Array.isArray(filteredSuppliers) && filteredSuppliers.length > 0) {
                    setIsExportModalOpen(true);
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [filteredSuppliers, perms.entry, perms.export]);

    const handleExportClick = () => {
        if (!Array.isArray(filteredSuppliers) || filteredSuppliers.length === 0) return;
        setIsExportModalOpen(true);
    };

    const handleDuplicateSupplier = (supplier: Supplier) => {
        if (!supplier) return;
        setSelectedSupplierId(supplier.id);
        setIsEditModalOpen(true);
    };

    const handleAdd = async (data: any, balance: number, date: string) => {
        const result = await onAddSupplier(data, balance, date);
        if (result && result.supplier) {
            setSelectedSupplierId(result.supplier.id);
        }
        return result;
    };

    const handleUpdate = async (supplier: Supplier) => {
        const result = await onUpdateSupplier(supplier);
        if (result && result.supplier) {
            setSelectedSupplierId(result.supplier.id);
        }
        return result;
    };

    const selectedSupplierExtra = selectedSupplier as (Supplier & Record<string, any>) | null;

    const safeToNumber = (val: any) => {
        const n = Number(val);
        return isFinite(n) ? n : 0;
    };

    return (
        <main className="flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Supplier Master (Accounts Payable)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total: {suppliers.length}</span>
            </div>

            <div className="p-4 flex-1 flex gap-4 min-h-0 overflow-hidden">
                <Card className="w-1/3 h-full flex flex-col p-0 tally-border overflow-hidden bg-white">
                    <div className="p-3 border-b border-gray-400 bg-gray-50 flex flex-col gap-2 flex-shrink-0">
                        <div className="flex gap-2">
                            {perms.entry && <button onClick={() => setIsAddModalOpen(true)} className="flex-1 py-2 tally-button-primary text-[10px] uppercase">F2: Create</button>}
                            {perms.export && <button onClick={handleExportClick} className="flex-1 py-2 tally-border bg-white font-bold uppercase text-[10px]">F3: Export</button>}
                        </div>
                        <input type="text" placeholder="Find Supplier..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold focus:bg-yellow-50 outline-none shadow-sm" />
                        <div className="flex justify-between items-center">
                            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} className="text-[10px] font-black uppercase text-primary border-none bg-transparent outline-none">
                                <option value="all">All Status</option>
                                <option value="active">Active</option>
                                <option value="blocked">Blocked</option>
                            </select>
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto divide-y divide-gray-200">
                        {paginatedSuppliers.map(s => (
                            <button 
                                key={s.id} 
                                type="button" 
                                onClick={() => setSelectedSupplierId(s.id)} 
                                className={`w-full text-left p-3 transition-all border-l-[6px] ${selectedSupplierId === s.id ? 'bg-primary text-white border-primary shadow-lg' : 'border-transparent hover:bg-primary hover:text-white group'}`}
                            >
                                <p className={`${uniformTextStyle} !text-xl truncate ${selectedSupplierId === s.id ? 'text-white' : 'group-hover:text-white'}`}>{s.name}</p>
                                <p className={`text-xs font-bold uppercase truncate ${selectedSupplierId === s.id ? 'text-white/70' : 'text-gray-500 group-hover:text-white/70'}`}>GST: {s.gst_number || 'N/A'}</p>
                                {(s.is_blocked || s.is_active === false) && <p className={`text-[9px] font-black uppercase mt-1 ${selectedSupplierId === s.id ? 'text-white' : 'text-red-600 group-hover:text-white'}`}>Blocked</p>}
                            </button>
                        ))}
                    </div>
                    <div className="p-3 border-t border-gray-400 bg-gray-50 flex items-center justify-between flex-shrink-0 text-xs font-bold uppercase">
                        <button 
                            type="button"
                            disabled={currentPage === 1} 
                            onClick={() => setCurrentPage(p => Math.max(p - 1, 1))}
                            className="px-3 py-1 border border-gray-300 bg-white disabled:opacity-50 text-[10px]"
                        >
                            Prev
                        </button>
                        <span>Page {currentPage} of {Math.max(totalPages, 1)}</span>
                        <button 
                            type="button"
                            disabled={currentPage === totalPages || totalPages === 0} 
                            onClick={() => setCurrentPage(p => Math.min(p + 1, totalPages))}
                            className="px-3 py-1 border border-gray-300 bg-white disabled:opacity-50 text-[10px]"
                        >
                            Next
                        </button>
                    </div>
                </Card>

                <Card className="flex-1 h-full p-0 tally-border bg-white overflow-hidden flex flex-col shadow-inner">
                    {(() => {
                        if (!selectedSupplier) {
                            return (
                                <div className="h-full flex items-center justify-center text-gray-300">
                                    <p className="text-xl font-black uppercase tracking-[0.2em]">Select Supplier</p>
                                </div>
                            );
                        }

                        try {
                            const openingBalance = safeToNumber(selectedSupplier.opening_balance);
                            
                            return (
                                <div className="flex flex-col h-full overflow-hidden">
                                    <div className="p-6 bg-gray-100 border-b border-gray-400 flex justify-between items-start flex-shrink-0">
                                        <div className="flex-1">
                                            <h3 className={`${uniformTextStyle} !text-4xl text-primary`}>{selectedSupplier.name || '—'}</h3>
                                            <div className="flex flex-wrap gap-x-8 gap-y-2 mt-3 text-sm font-bold text-gray-500 uppercase">
                                                <span>GSTIN: <span className="text-gray-900 tally-font-data-mono">{selectedSupplier.gst_number || 'N/A'}</span></span>
                                                <span>PH: <span className="text-gray-900 tally-font-data-mono">{selectedSupplier.mobile || selectedSupplier.phone || 'N/A'}</span></span>
                                                <span>Opening: <span className="text-gray-900 tally-font-data-mono">₹{openingBalance.toFixed(2)}</span></span>
                                                <span>Status: <span className={(selectedSupplier.is_blocked || selectedSupplier.is_active === false) ? 'text-red-600' : 'text-emerald-700'}>{(selectedSupplier.is_blocked || selectedSupplier.is_active === false) ? 'Blocked' : 'Active'}</span></span>
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={() => setIsEditModalOpen(true)} className="px-6 py-2 tally-border bg-white font-black text-[10px] uppercase shadow-sm">{perms.edit ? 'Alter' : 'View'}</button>
                                            {perms.edit && (
                                                (selectedSupplier.is_blocked || selectedSupplier.is_active === false) ? (
                                                    <button onClick={() => { if (window.confirm('Unblock this supplier?')) void onUnblockSupplier(selectedSupplier); }} className="px-4 py-2 border border-emerald-700 bg-emerald-50 text-emerald-700 font-black text-[10px] uppercase shadow-sm">Unblock Supplier</button>
                                                ) : (
                                                    <button onClick={() => { if (window.confirm('Block this supplier?')) void onBlockSupplier(selectedSupplier); }} className="px-4 py-2 border border-amber-700 bg-amber-50 text-amber-700 font-black text-[10px] uppercase shadow-sm">Block Supplier</button>
                                                )
                                            )}
                                            {perms.edit && (
                                                <button
                                                    onClick={async () => {
                                                        if (!window.confirm('Delete this supplier?')) return;
                                                        const result = await onDeleteSupplier(selectedSupplier);
                                                        alert(result.message);
                                                        if (result.success) setSelectedSupplierId(null);
                                                    }}
                                                    className="px-4 py-2 border border-red-700 bg-red-50 text-red-700 font-black text-[10px] uppercase shadow-sm"
                                                >
                                                    Delete Supplier
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="p-4 border-b border-gray-300 bg-white">
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500 mb-3">Address Details</p>
                                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                                            {addressFields.map(({ label, key }) => (
                                                <div key={key} className="min-w-0 border border-gray-200 p-3">
                                                    <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">{label}</p>
                                                    <p className="text-sm font-bold text-gray-900 break-words">{displayValue(selectedSupplier[key as keyof Supplier])}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="flex-1 overflow-auto p-4">
                                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                            <div className="p-3 border border-gray-200">
                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Supplier Group</p>
                                                <p className="text-sm font-bold text-gray-900">{displayValue(selectedSupplier.supplier_group)}</p>
                                            </div>
                                            <div className="p-3 border border-gray-200">
                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Supplier Category</p>
                                                <p className="text-sm font-bold text-gray-900">{displayValue(selectedSupplierExtra?.category)}</p>
                                            </div>
                                            <div className="p-3 border border-gray-200">
                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Supplier Control GL</p>
                                                <p className="text-sm font-bold text-gray-900">{displayValue(selectedSupplier.control_gl_id)}</p>
                                            </div>
                                            <div className="p-3 border border-gray-200">
                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Email</p>
                                                <p className="text-sm font-bold text-gray-900 break-all">{displayValue(selectedSupplier.email)}</p>
                                            </div>
                                            <div className="p-3 border border-gray-200">
                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">GSTIN</p>
                                                <p className="text-sm font-bold text-gray-900">{displayValue(selectedSupplier.gst_number)}</p>
                                            </div>
                                            <div className="p-3 border border-gray-200">
                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Opening Balance</p>
                                                <p className="text-sm font-bold text-gray-900">₹{openingBalance.toFixed(2)}</p>
                                            </div>
                                            <div className="p-3 border border-gray-200">
                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">PAN</p>
                                                <p className="text-sm font-bold text-gray-900">{displayValue(selectedSupplier.pan_number)}</p>
                                            </div>
                                            <div className="p-3 border border-gray-200">
                                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Drug License</p>
                                                <p className="text-sm font-bold text-gray-900">{displayValue(selectedSupplier.drug_license)}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        } catch (e) {
                            console.error('Render Error in Supplier Detail Pane:', e);
                            return (
                                <div className="h-full flex flex-col items-center justify-center text-red-500 p-10 text-center">
                                    <p className="text-xl font-black uppercase mb-2">Render Error</p>
                                    <p className="text-sm font-bold opacity-70">The system encountered an error while rendering this supplier's details. Please contact support.</p>
                                </div>
                            );
                        }
                    })()}
                </Card>
            </div>

            {isAddModalOpen && (
                <AddSupplierModal
                    isOpen={isAddModalOpen}
                    onClose={() => setIsAddModalOpen(false)}
                    onAdd={handleAdd}
                    onDuplicate={handleDuplicateSupplier}
                    defaultControlGlId={defaultSupplierControlGlId}
                    organizationId={currentUser?.organization_id || ''}
                />
            )}

            {selectedSupplier && (
                <EditSupplierModal
                    isOpen={isEditModalOpen}
                    onClose={() => setIsEditModalOpen(false)}
                    onSave={handleUpdate}
                    supplier={selectedSupplier}
                    defaultControlGlId={defaultSupplierControlGlId}
                    isReadOnly={!perms.edit}
                />
            )}

            {isExportModalOpen && (
                <ExportSuppliersModal
                    isOpen={isExportModalOpen}
                    onClose={() => setIsExportModalOpen(false)}
                    data={filteredSuppliers}
                    pharmacyName={currentUser?.pharmacy_name || 'MDXERA ERP'}
                />
            )}
        </main>
    );
};

export default Suppliers;
