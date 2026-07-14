import React from 'react';
import Modal from '@core/components/ui/Modal';
import { Supplier } from '@core/types';
import { getOutstandingBalance, formatVoucherNo } from '@core/utils/helpers';

interface SupplierLedgerModalProps {
    isOpen: boolean;
    onClose: () => void;
    supplier: Supplier | null;
}

const SupplierLedgerModal: React.FC<SupplierLedgerModalProps> = ({ isOpen, onClose, supplier }) => {
    if (!isOpen || !supplier) return null;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={`Ledger: ${supplier.name}`}
            widthClass="max-w-4xl"
        >
            <div className="flex flex-col h-[75vh] bg-slate-50 dark:bg-slate-950">
                {/* Header Branding Section */}
                <div className="bg-primary p-6 text-white flex justify-between items-center flex-shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center">
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z" /><path d="m3 9 2.45-4.9A2 2 0 0 1 7.24 3h9.52a2 2 0 0 1 1.8 1.1L21 9" /><path d="M12 3v6" /></svg>
                        </div>
                        <div>
                            <h3 className="text-2xl font-black uppercase tracking-tight leading-none">{supplier.name}</h3>
                            <p className="text-[10px] font-bold uppercase tracking-[0.3em] opacity-70 mt-1">Transaction Ledger & Recent Purchases</p>
                        </div>
                    </div>
                    <div className="text-right">
                        <p className="text-[10px] font-black uppercase opacity-60">Current Outstanding</p>
                        <p className="text-3xl font-black tracking-tighter">₹{getOutstandingBalance(supplier).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                    </div>
                </div>

                {/* Ledger Content */}
                <div className="flex-1 overflow-auto p-4">
                    <div className="bg-white dark:bg-gray-900 border border-app-border rounded-2xl shadow-sm overflow-hidden">
                        <table className="min-w-full text-xs border-collapse">
                            <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-gray-800 border-b border-app-border">
                                <tr>
                                    <th className="px-4 py-3 text-left font-black uppercase tracking-widest text-gray-400 text-[10px]">Date</th>
                                    <th className="px-4 py-3 text-left font-black uppercase tracking-widest text-gray-400 text-[10px]">Description</th>
                                    <th className="px-4 py-3 text-right font-black uppercase tracking-widest text-gray-400 text-[10px]">Billed (+)</th>
                                    <th className="px-4 py-3 text-right font-black uppercase tracking-widest text-gray-400 text-[10px]">Paid (-)</th>
                                    <th className="px-4 py-3 text-right font-black uppercase tracking-widest text-gray-400 text-[10px]">Running Balance</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-app-border">
                                {supplier.ledger && supplier.ledger.length > 0 ? (
                                    supplier.ledger.map((entry) => (
                                        <tr key={entry.id} className="hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-colors">
                                            <td className="px-4 py-3 font-bold text-app-text-secondary whitespace-nowrap">
                                                {new Date(entry.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                                            </td>
                                            <td className="px-4 py-3 font-semibold text-app-text-primary uppercase truncate max-w-xs">
                                                {(() => {
                                                    let desc = (entry.description || '').replace(/\s*\[AUTO_LEDGER\]:[a-z0-9\-]+/gi, '').trim() || entry.description;
                                                    if (entry.referenceInvoiceNumber && !desc.toLowerCase().includes(entry.referenceInvoiceNumber.toLowerCase())) {
                                                        const formattedRef = formatVoucherNo(entry.referenceInvoiceNumber);
                                                        if (formattedRef && !desc.toLowerCase().includes(formattedRef.toLowerCase())) {
                                                            desc = `${desc} (${formattedRef})`;
                                                        }
                                                    }
                                                    return desc;
                                                })()}
                                                {entry.type === 'openingBalance' && <span className="ml-2 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-[8px] rounded uppercase font-black">Opening</span>}
                                            </td>
                                            <td className="px-4 py-3 text-right font-black text-red-600">
                                                {entry.credit > 0 ? `₹${entry.credit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                                            </td>
                                            <td className="px-4 py-3 text-right font-black text-emerald-600">
                                                {entry.debit > 0 ? `₹${entry.debit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                                            </td>
                                            <td className={`px-4 py-3 text-right font-black ${entry.balance > 0 ? 'text-red-600' : 'text-emerald-600'} bg-slate-50 dark:bg-slate-900/50`}>
                                                ₹{entry.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td colSpan={5} className="py-20 text-center">
                                            <div className="flex flex-col items-center opacity-30">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-4"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" /></svg>
                                                <p className="font-black uppercase text-sm tracking-widest">No Transactions Recorded</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="p-4 bg-gray-100 dark:bg-gray-800 border-t border-app-border flex justify-between items-center px-8 flex-shrink-0">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest italic">Medimart Retail Intel Engine v2.5</span>
                    <button
                        onClick={onClose}
                        className="px-8 py-2.5 bg-gray-900 text-white font-black rounded-xl uppercase tracking-widest text-xs hover:bg-black transition-all active:scale-95"
                    >
                        Close [ESC]
                    </button>
                </div>
            </div>
        </Modal>
    );
};

export default SupplierLedgerModal;