
import React, { useState, useMemo, useEffect, useRef } from 'react';
import Modal from '@core/components/ui/Modal';
import { Customer, Transaction } from '@core/types';
import { fuzzyMatch } from '@core/utils/search';
import { buildCustomerInvoiceOutstandingMap, calculateCustomerReceivableBreakdown, getOutstandingBalance } from '@core/utils/helpers';

interface CustomerSearchModalProps {
    isOpen: boolean;
    onClose: () => void;
    customers: Customer[];
    transactions?: Transaction[];
    onSelect: (customer: Customer) => void;
    initialSearch?: string;
}

const uniformTextStyle = "text-2xl font-normal tracking-tight uppercase leading-tight";

const CustomerSearchModal: React.FC<CustomerSearchModalProps> = ({ isOpen, onClose, customers, transactions = [], onSelect, initialSearch = '' }) => {
    const [searchTerm, setSearchTerm] = useState(initialSearch);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const resultsContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isOpen) {
            setSearchTerm(initialSearch);
            setSelectedIndex(0);
            setTimeout(() => searchInputRef.current?.focus(), 150);
        }
    }, [isOpen, initialSearch]);

    const filtered = useMemo(() => {
        const active = customers.filter(c => c.is_blocked !== true && c.is_active !== false);
        if (!searchTerm.trim()) return active;
        return active.filter(c => 
            fuzzyMatch(c.name, searchTerm) || 
            fuzzyMatch(c.phone, searchTerm)
        );
    }, [customers, searchTerm]);

    const customerInvoiceOutstandingMap = useMemo(
        () => buildCustomerInvoiceOutstandingMap(customers, transactions),
        [customers, transactions]
    );

    const resolveCustomerBalance = (customer: Customer): number => {
        if (!transactions.length) return getOutstandingBalance(customer);
        return calculateCustomerReceivableBreakdown(customer, customerInvoiceOutstandingMap[customer.id] || 0).netOutstanding;
    };

    useEffect(() => {
        if (selectedIndex >= filtered.length) {
            setSelectedIndex(0);
        }
    }, [filtered.length, selectedIndex]);

    const selectedCustomer = filtered[selectedIndex] || filtered[0] || null;

    useEffect(() => {
        if (resultsContainerRef.current) {
            const activeRow = resultsContainerRef.current.querySelector(`[data-index="${selectedIndex}"]`);
            if (activeRow) {
                activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
    }, [selectedIndex]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => (prev + 1) % Math.max(1, filtered.length));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (filtered[selectedIndex]) {
                onSelect(filtered[selectedIndex]);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Master Customer Directory">
            <div className="flex flex-col h-full bg-[#fffde7] dark:bg-zinc-950 outline-none" onKeyDown={handleKeyDown}>
                <div className="py-2 px-4 bg-primary text-white flex-shrink-0 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                        <span className="text-xs font-black uppercase tracking-[0.2em]">Customer Selection Matrix</span>
                    </div>
                    <span className="text-[10px] font-bold uppercase opacity-70">↑/↓ Navigate | Enter Select | Esc Close</span>
                </div>

                <div className="p-2 bg-white dark:bg-zinc-900 border-b-2 border-primary/10">
                    <input 
                        ref={searchInputRef}
                        type="text" 
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        placeholder="Search Customer Name or Phone..."
                        className="w-full p-2 border-2 border-primary/20 bg-white text-base font-black focus:border-primary outline-none shadow-inner uppercase tracking-tighter"
                    />
                </div>

                <div className="flex-1 overflow-auto bg-white" ref={resultsContainerRef}>
                    {filtered.length > 0 ? (
                        <table className="min-w-full border-collapse">
                            <thead className="sticky top-0 z-10 bg-gray-100 border-b border-gray-400 shadow-sm">
                                <tr className="text-[10px] font-black uppercase text-gray-500 tracking-widest h-10">
                                    <th className="p-2 px-4 text-left border-r border-gray-200 w-[32%]">Customer Name / Ledger</th>
                                    <th className="p-2 px-4 text-left border-r border-gray-200 w-[34%]">Address Line 1</th>
                                    <th className="p-2 px-4 text-center border-r border-gray-200 w-[18%]">Phone</th>
                                    <th className="p-2 px-4 text-right w-[16%]">Balance</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((cust, idx) => {
                                    const isSelected = idx === selectedIndex;
                                    const balance = resolveCustomerBalance(cust);
                                    const addressLine1 = cust.address_line1 || cust.address || '—';
                                    return (
                                        <tr 
                                            key={cust.id} 
                                            data-index={idx}
                                            onClick={() => onSelect(cust)}
                                            onMouseEnter={() => setSelectedIndex(idx)}
                                            className={`cursor-pointer transition-all border-b border-gray-100 h-12 ${isSelected ? 'bg-primary text-white z-10 shadow-xl scale-[1.01]' : 'hover:bg-yellow-50'}`}
                                        >
                                            <td className="p-2 px-4 border-r border-gray-200">
                                                <p className={`leading-none ${uniformTextStyle} ${isSelected ? 'text-white' : 'text-gray-950'}`}>{cust.name}</p>
                                            </td>
                                            <td className={`p-2 px-4 border-r border-gray-200 ${uniformTextStyle} ${isSelected ? 'text-white' : 'text-gray-700'}`}>
                                                {addressLine1}
                                            </td>
                                            <td className={`p-2 px-4 border-r border-gray-200 text-center font-mono ${uniformTextStyle} ${isSelected ? 'text-white' : 'text-primary'}`}>
                                                {cust.phone || 'N/A'}
                                            </td>
                                            <td className={`p-2 px-4 text-right ${uniformTextStyle} ${isSelected ? 'text-white' : (balance > 0 ? 'text-red-600' : 'text-emerald-700')}`}>
                                                ₹{balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center opacity-20 p-20 text-center">
                            <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-4"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                            <p className="text-2xl font-black uppercase tracking-widest">No Customer Found</p>
                        </div>
                    )}
                </div>

                {selectedCustomer && (
                    <div className="p-4 border-t border-primary/20 bg-[#fffef5]">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500 mb-3">Customer Details</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                            <p><span className="font-black uppercase text-gray-500 mr-2">Name:</span>{selectedCustomer.name}</p>
                            <p><span className="font-black uppercase text-gray-500 mr-2">Phone:</span>{selectedCustomer.phone || '—'}</p>
                            <p className="md:col-span-2"><span className="font-black uppercase text-gray-500 mr-2">Address Line 1:</span>{selectedCustomer.address_line1 || selectedCustomer.address || '—'}</p>
                            <p className="md:col-span-2"><span className="font-black uppercase text-gray-500 mr-2">Address Line 2:</span>{selectedCustomer.address_line2 || '—'}</p>
                            <p><span className="font-black uppercase text-gray-500 mr-2">Area / Locality:</span>{selectedCustomer.area || '—'}</p>
                            <p><span className="font-black uppercase text-gray-500 mr-2">City / District:</span>{selectedCustomer.city || selectedCustomer.district || '—'}</p>
                            <p><span className="font-black uppercase text-gray-500 mr-2">State:</span>{selectedCustomer.state || '—'}</p>
                            <p><span className="font-black uppercase text-gray-500 mr-2">Pincode:</span>{selectedCustomer.pincode || '—'}</p>
                            <p className="md:col-span-2"><span className="font-black uppercase text-gray-500 mr-2">Balance:</span>₹{resolveCustomerBalance(selectedCustomer).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                        </div>
                    </div>
                )}

                <div className="p-4 bg-slate-100 border-t border-app-border flex justify-end gap-3 flex-shrink-0">
                     <button onClick={onClose} className="px-8 py-3 text-[11px] font-black uppercase tracking-widest text-gray-500 hover:text-black">Cancel (Esc)</button>
                     <button 
                        onClick={() => filtered[selectedIndex] && onSelect(filtered[selectedIndex])}
                        className="px-16 py-4 bg-primary text-white text-[12px] font-black uppercase tracking-[0.3em] shadow-2xl active:translate-y-1 transform transition-all"
                     >
                        Select Customer (Enter)
                     </button>
                </div>
            </div>
        </Modal>
    );
};

export default CustomerSearchModal;
