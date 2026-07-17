import React, { useState, useMemo, useEffect, useRef } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import SendReminderModal from '../components/SendReminderModal';
import CustomerImportPreviewModal from '@modules/customers/components/CustomerImportPreviewModal';
import PriceListManagementModal from '../components/PriceListManagementModal';
import PriceListImportModal from '../components/PriceListImportModal';
import AddCustomerModal from '@modules/customers/components/AddCustomerModal'; 
import { EditCustomerModal } from '../components/EditCustomerModal'; 
import ExportCustomersModal from '../components/ExportCustomersModal';
import type { Customer, RegisteredPharmacy, ModuleConfig, InventoryItem, CustomerPriceListEntry, OrganizationMember, PermissionSet, Medicine } from '@core/types';
import { downloadCsv, arrayToCsvRow } from '@core/utils/csv';
import { handleEnterToNextField } from '@core/utils/navigation';
import { fetchCustomerPriceList, saveCustomerPriceList, fetchInventory, getData } from '@core/services/storageService';
import { fuzzyMatch } from '@core/utils/search';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';
import { getOutstandingBalance } from '@core/utils/helpers';

const uniformTextStyle = "text-2xl font-normal tracking-tight uppercase leading-tight";

const addressFields: Array<{ label: string; key: 'address' | 'address_line2' | 'area' | 'city' | 'district' | 'state' | 'pincode' | 'country' }> = [
    { label: 'Address Line 1', key: 'address' },
    { label: 'Address Line 2', key: 'address_line2' },
    { label: 'Area / Locality', key: 'area' },
    { label: 'City', key: 'city' },
    { label: 'District', key: 'district' },
    { label: 'State', key: 'state' },
    { label: 'Pincode', key: 'pincode' },
    { label: 'Country', key: 'country' },
] as const;

interface CustomersProps {
    customers: Customer[];
    teamMembers?: OrganizationMember[]; 
    onAddCustomer: (data: Omit<Customer, 'id' | 'ledger' | 'organization_id'>, openingBalance: number, asOfDate: string) => void;
    onBulkAddCustomers: (customers: any[]) => void;
    onRecordPayment: (customerId: string, paymentAmount: number, paymentDate: string, description: string) => void;
    onUpdateCustomer: (customer: Customer) => void;
    onBlockCustomer: (customer: Customer) => Promise<void> | void;
    onUnblockCustomer: (customer: Customer) => Promise<void> | void;
    onDeleteCustomer: (customer: Customer) => Promise<{ success: boolean; message: string }>;
    currentUser: RegisteredPharmacy | null;
    config: ModuleConfig;
    medicines: Medicine[];
    defaultCustomerControlGlId?: string;
    permissions?: PermissionSet;
    customerPriceList?: CustomerPriceListEntry[];
    onSavePriceListEntries?: (entries: CustomerPriceListEntry[]) => Promise<void>;
}

const CustomersPage: React.FC<CustomersProps> = ({ customers, teamMembers = [], onAddCustomer, onBulkAddCustomers, onRecordPayment, onUpdateCustomer, onBlockCustomer, onUnblockCustomer, onDeleteCustomer, currentUser, config, medicines, defaultCustomerControlGlId, permissions, customerPriceList = [], onSavePriceListEntries = async () => {} }) => {
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
    const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'blocked'>('all');
    const [isPriceListModalOpen, setIsPriceListModalOpen] = useState(false);
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);

    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = 10;

    const [glMasters, setGlMasters] = useState<any[]>([]);

    useEffect(() => {
        if (!currentUser) return;
        getData('gl_master', [], currentUser).then((data) => {
            setGlMasters(data || []);
        });
    }, [currentUser]);

    const getGlLabel = (id?: string) => {
        if (!id) return '';
        const found = glMasters.find((g) => g.id === id);
        return found ? `${found.glName}${found.glCode ? ` (${found.glCode})` : ''}` : id;
    };

    const selectedCustomer = useMemo(() => {
        if (!selectedCustomerId || !Array.isArray(customers)) return null;
        return customers.find(c => c.id === selectedCustomerId) || null;
    }, [customers, selectedCustomerId]);

    const filteredCustomers = useMemo(() => {
        return customers
            .filter(c => {
                const blocked = c.is_blocked === true || c.is_active === false;
                if (statusFilter === 'active') return !blocked;
                if (statusFilter === 'blocked') return blocked;
                return true;
            })
            .filter(c => fuzzyMatch(c.name, searchTerm) || fuzzyMatch(c.phone, searchTerm))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [customers, searchTerm, statusFilter]);

    useEffect(() => {
        setCurrentPage(1);
    }, [searchTerm, statusFilter]);

    const totalPages = Math.ceil(filteredCustomers.length / pageSize);
    const paginatedCustomers = useMemo(() => {
        const start = (currentPage - 1) * pageSize;
        return filteredCustomers.slice(start, start + pageSize);
    }, [filteredCustomers, currentPage, pageSize]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, 'customers')) return;
            if (e.key === 'F2' && perms.entry) {
                e.preventDefault();
                setIsAddModalOpen(true);
            } else if (e.key === 'F3' && perms.export) {
                e.preventDefault();
                if (filteredCustomers.length > 0) {
                    setIsExportModalOpen(true);
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [filteredCustomers]);

    const handleExportClick = () => {
        if (filteredCustomers.length === 0) return;
        setIsExportModalOpen(true);
    };

    const selectedCustomerExtra = selectedCustomer as (Customer & Record<string, unknown>) | null;

    return (
        <main className="flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Customer Master (Accounts Receivable)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total: {customers.length}</span>
            </div>

            <div className="p-4 flex-1 flex gap-4 min-h-0 overflow-hidden">
                <Card className="w-1/3 h-full flex flex-col p-0 tally-border overflow-hidden bg-white">
                    <div className="p-3 border-b border-gray-400 bg-gray-50 flex flex-col gap-2 flex-shrink-0">
                        <div className="flex gap-2">
                            {perms.entry && <button onClick={() => setIsAddModalOpen(true)} className="flex-1 py-2 tally-button-primary text-[10px] uppercase">F2: Create</button>}
                            {perms.export && <button onClick={handleExportClick} className="flex-1 py-2 tally-border bg-white font-bold uppercase text-[10px]">F3: Export</button>}
                        </div>
                        <input type="text" placeholder="Find Customer..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-full border border-gray-400 p-2 text-sm font-bold focus:bg-yellow-50 outline-none shadow-sm" />
                        <div className="flex justify-between items-center">
                            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} className="text-[10px] font-black uppercase text-primary border-none bg-transparent outline-none">
                                <option value="all">All Status</option>
                                <option value="active">Active</option>
                                <option value="blocked">Blocked</option>
                            </select>
                            <button onClick={() => setIsPriceListModalOpen(true)} className="px-3 py-1 border border-primary text-primary hover:bg-primary hover:text-white rounded font-black text-[10px] uppercase tracking-wider shadow-sm transition-all duration-200">FK Price</button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto divide-y divide-gray-200">
                        {paginatedCustomers.map(cust => (
                            <button
                                key={cust.id}
                                type="button"
                                onClick={() => setSelectedCustomerId(cust.id)}
                                className={`w-full text-left p-3 transition-all border-l-[6px] ${selectedCustomer?.id === cust.id ? 'bg-primary text-white border-primary shadow-lg' : 'border-transparent hover:bg-primary hover:text-white group'}`}
                            >
                                <p className={`${uniformTextStyle} !text-xl truncate ${selectedCustomer?.id === cust.id ? 'text-white' : 'group-hover:text-white'}`}>{cust.name}</p>
                                <p className={`text-xs font-bold uppercase truncate ${selectedCustomer?.id === cust.id ? 'text-white/70' : 'text-gray-500 group-hover:text-white/70'}`}>{cust.phone || 'N/A'}</p>
                                {(cust.is_blocked || cust.is_active === false) && (
                                    <p className={`text-[9px] font-black uppercase mt-1 ${selectedCustomer?.id === cust.id ? 'text-white' : 'text-red-600 group-hover:text-white'}`}>Blocked</p>
                                )}
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
                    {selectedCustomer ? (
                        <div className="flex flex-col h-full overflow-hidden">
                            <div className="p-6 bg-gray-100 border-b border-gray-400 flex justify-between items-start flex-shrink-0">
                                <div className="flex-1 min-w-0">
                                    <h3 className={`${uniformTextStyle} !text-4xl text-primary truncate`}>{selectedCustomer.name}</h3>
                                    <div className="flex flex-wrap gap-x-8 gap-y-2 mt-3 text-sm font-bold text-gray-500 uppercase">
                                        <span>Contact: <span className="text-gray-900 tally-font-data-mono">{selectedCustomer.phone || 'N/A'}</span></span>
                                        <span>Area: <span className="text-gray-900 tally-font-data-mono">{selectedCustomer.area || 'N/A'}</span></span>
                                        <span>Status: <span className={(selectedCustomer.is_blocked || selectedCustomer.is_active === false) ? 'text-red-600' : 'text-emerald-700'}>{(selectedCustomer.is_blocked || selectedCustomer.is_active === false) ? 'Blocked' : 'Active'}</span></span>
                                    </div>
                                </div>
                                <div className="flex gap-2 ml-4 flex-shrink-0">
                                    <button onClick={() => setIsEditModalOpen(true)} className="px-4 py-2 tally-border bg-white font-black text-[10px] uppercase shadow-sm">{perms.edit ? 'Alter' : 'View'}</button>
                                    {perms.edit && (
                                        <>
                                            {(selectedCustomer.is_blocked || selectedCustomer.is_active === false) ? (
                                                <button onClick={() => { if (window.confirm('Unblock this customer?')) void onUnblockCustomer(selectedCustomer); }} className="px-4 py-2 border border-emerald-700 bg-emerald-50 text-emerald-700 font-black text-[10px] uppercase shadow-sm">Unblock Customer</button>
                                            ) : (
                                                <button onClick={() => { if (window.confirm('Block this customer?')) void onBlockCustomer(selectedCustomer); }} className="px-4 py-2 border border-amber-700 bg-amber-50 text-amber-700 font-black text-[10px] uppercase shadow-sm">Block Customer</button>
                                            )}
                                            <button
                                                onClick={async () => {
                                                    if (!window.confirm('Delete this customer?')) return;
                                                    const result = await onDeleteCustomer(selectedCustomer);
                                                    alert(result.message);
                                                    if (result.success) setSelectedCustomerId(null);
                                                }}
                                                className="px-4 py-2 border border-red-700 bg-red-50 text-red-700 font-black text-[10px] uppercase shadow-sm"
                                            >
                                                Delete Customer
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="p-4 border-b border-gray-300 bg-white flex-shrink-0">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500 mb-3">Address Details</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                                    {addressFields.map(({ label, key }) => (
                                        <div key={key} className="min-w-0 border border-gray-200 p-3">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">{label}</p>
                                            <p className="text-sm font-bold text-gray-900 break-words">{selectedCustomer[key] || '—'}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            
                            <div className="flex-1 overflow-auto p-4">
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Customer Group</p>
                                        <p className="text-sm font-bold text-gray-900">{selectedCustomer.customerGroup || 'N/A'}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Customer Category</p>
                                        <p className="text-sm font-bold text-gray-900">{String(selectedCustomerExtra?.category || 'N/A')}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Customer Control GL</p>
                                        <p className="text-sm font-bold text-gray-900">
                                            {(() => {
                                                const id = selectedCustomer.controlGlId || (selectedCustomer as any).control_gl_id || defaultCustomerControlGlId;
                                                return getGlLabel(id) || 'N/A';
                                            })()}
                                        </p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Email</p>
                                        <p className="text-sm font-bold text-gray-900 break-all">{selectedCustomer.email || 'N/A'}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">GSTIN</p>
                                        <p className="text-sm font-bold text-gray-900">{selectedCustomer.gstNumber || 'N/A'}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Opening Balance</p>
                                        <p className="text-sm font-bold text-gray-900">₹{Number(selectedCustomer.opening_balance || 0).toFixed(2)}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Credit Limit</p>
                                        <p className="text-sm font-bold text-gray-900">₹{Number(selectedCustomer.creditLimit || 0).toFixed(2)}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Current Outstanding</p>
                                        <p className="text-sm font-bold text-gray-900">₹{getOutstandingBalance(selectedCustomer).toFixed(2)}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Available Credit</p>
                                        <p className="text-sm font-bold text-gray-900">₹{(Number(selectedCustomer.creditLimit || 0) - getOutstandingBalance(selectedCustomer)).toFixed(2)}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Credit Status</p>
                                        <p className="text-sm font-bold text-gray-900 uppercase">{selectedCustomer.creditStatus || 'ACTIVE'}</p>
                                    </div>
                                    <div className="p-3 border border-gray-200">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Credit Days</p>
                                        <p className="text-sm font-bold text-gray-900">{selectedCustomer.creditDays || 0}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="h-full flex items-center justify-center text-gray-300">
                            <p className="text-xl font-black uppercase tracking-[0.2em]">Select Customer</p>
                        </div>
                    )}
                </Card>
            </div>
            
            {isAddModalOpen && (
                <AddCustomerModal 
                    isOpen={isAddModalOpen} 
                    onClose={() => setIsAddModalOpen(false)} 
                    onAdd={onAddCustomer} 
                    defaultControlGlId={defaultCustomerControlGlId}
                    teamMembers={teamMembers}
                    organizationId={currentUser?.organization_id || ''} 
                    getGlLabel={getGlLabel}
                />
            )}

            {selectedCustomer && (
                <>
                    <EditCustomerModal 
                        isOpen={isEditModalOpen} 
                        onClose={() => setIsEditModalOpen(false)} 
                        onSave={onUpdateCustomer} 
                        customer={selectedCustomer} 
                        config={config}
                        teamMembers={teamMembers}
                        defaultControlGlId={defaultCustomerControlGlId}
                        isReadOnly={!perms.edit}
                        getGlLabel={getGlLabel}
                    />
                    <PriceListManagementModal 
                        isOpen={isPriceListModalOpen}
                        onClose={() => setIsPriceListModalOpen(false)}
                        customers={customers}
                        medicines={medicines}
                        priceListEntries={customerPriceList} 
                        onSaveEntries={onSavePriceListEntries}
                        onImportClick={() => setIsImportModalOpen(true)}
                        currentUser={currentUser}
                    />
                    <PriceListImportModal 
                        isOpen={isImportModalOpen}
                        onClose={() => setIsImportModalOpen(false)}
                        customers={customers}
                        medicines={medicines}
                        onSaveEntries={onSavePriceListEntries}
                        organizationId={currentUser?.organization_id || ''}
                    />
                </>
            )}

            {isExportModalOpen && (
                <ExportCustomersModal
                    isOpen={isExportModalOpen}
                    onClose={() => setIsExportModalOpen(false)}
                    data={filteredCustomers}
                    pharmacyName={currentUser?.pharmacy_name || 'MDXERA ERP'}
                />
            )}
        </main>
    );
};

export default CustomersPage;
