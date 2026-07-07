import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { RegisteredPharmacy } from '@core/types';
import { numberToWords } from '@core/utils/numberToWords';
import { formatVoucherNo } from '@core/utils/helpers';

const formatDisplayDate = (value?: string): string => {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

interface PrintReturnModalProps {
    isOpen: boolean;
    onClose: () => void;
    returnVoucher: any | null;
    type: 'sales' | 'purchase';
    pharmacy: RegisteredPharmacy | null;
}

const PrintReturnModal: React.FC<PrintReturnModalProps> = ({
    isOpen,
    onClose,
    returnVoucher,
    type,
    pharmacy,
}) => {
    useEffect(() => {
        if (isOpen && returnVoucher) {
            const originalTitle = document.title;
            const voucherNumber = returnVoucher.id || 'Pending';
            const name = type === 'sales' ? returnVoucher.customerName : returnVoucher.supplier;
            document.title = `${type === 'sales' ? 'CreditNote' : 'DebitNote'}_${voucherNumber}_${(name || '').replace(/[^a-z0-9]/gi, '_')}`;
            
            const printTimeout = setTimeout(() => {
                window.print();
                setTimeout(() => { document.title = originalTitle; }, 1000);
            }, 300);

            return () => clearTimeout(printTimeout);
        }
    }, [isOpen, returnVoucher, type]);

    if (!isOpen || !returnVoucher || !pharmacy) return null;

    const isSales = type === 'sales';
    const title = isSales ? 'Credit Note (Sales Return)' : 'Debit Note (Purchase Return)';
    const partyLabel = isSales ? 'Customer Name' : 'Supplier Name';
    const partyName = isSales ? returnVoucher.customerName : returnVoucher.supplier;
    const sourceInvoiceLabel = isSales ? 'Original Invoice Ref' : 'Original Purchase Invoice';
    const sourceInvoiceId = isSales 
        ? (returnVoucher.originalInvoiceNumber || returnVoucher.originalInvoiceId || '-') 
        : (returnVoucher.originalPurchaseInvoiceId || '-');
    const totalAmount = Number(isSales ? returnVoucher.totalRefund : returnVoucher.totalValue || 0);
    const voucherNumber = returnVoucher.id || 'Pending';
    const voucherDate = formatDisplayDate(returnVoucher.date);
    const narration = returnVoucher.remarks || '-';

    const companyName = pharmacy.pharmacy_name || 'Pharmacy';
    const companyAddress = [pharmacy.address, pharmacy.address_line2, pharmacy.district, pharmacy.state, pharmacy.pincode].filter(Boolean).join(', ');
    const authorizedSignatory = pharmacy.authorized_signatory || pharmacy.manager_name || pharmacy.full_name || 'Authorized Signatory';

    return createPortal(
        <div id="print-return-modal-container" className="fixed inset-0 bg-black/60 z-[1000] flex justify-center items-center backdrop-blur-sm print:bg-white print:p-0 overflow-y-auto">
            <div className="bg-white rounded-lg shadow-2xl w-full max-w-4xl flex flex-col max-h-[95vh] print:max-h-none print:shadow-none print:rounded-none">
                <div className="flex justify-between items-center p-4 border-b no-print bg-white sticky top-0 z-10">
                    <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wider">Print Return Voucher</h3>
                    <div className="flex gap-2">
                        <button onClick={() => window.print()} className="px-4 py-2 bg-primary text-white rounded text-xs font-bold uppercase shadow-lg hover:bg-primary-dark">Print</button>
                        <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto bg-gray-50 p-8 print:p-0 print:bg-white">
                    <div id="return-print-area" className="relative bg-white p-8 border border-gray-200 shadow-sm mx-auto print:shadow-none print:border-none max-w-[210mm] text-black font-sans">
                        
                        <div className="flex justify-between items-start border-b border-gray-300 pb-4 mb-6">
                            <div>
                                <h1 className="text-xl font-bold uppercase leading-none tracking-tight text-gray-900">{title}</h1>
                                <h2 className="text-sm font-bold mt-2 text-gray-800">{companyName}</h2>
                                <p className="text-xs mt-1 text-gray-600 whitespace-pre-line max-w-sm">{companyAddress}</p>
                            </div>
                            <div className="text-right text-xs">
                                <div><strong>Voucher No.:</strong> <span className="font-bold">{voucherNumber}</span></div>
                                <div className="mt-1"><strong>Voucher Date:</strong> {voucherDate}</div>
                            </div>
                        </div>

                        {/* Top Metadata */}
                        <div className="grid grid-cols-2 gap-4 border border-gray-300 p-3 bg-gray-50 text-xs mb-6">
                            <div>
                                <p className="text-gray-500 font-bold uppercase text-[9px] mb-0.5">{partyLabel}</p>
                                <p className="font-black uppercase text-gray-900">{partyName}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 font-bold uppercase text-[9px] mb-0.5">{sourceInvoiceLabel}</p>
                                <p className="font-mono font-bold text-gray-900">{formatVoucherNo(sourceInvoiceId)}</p>
                            </div>
                        </div>

                        {/* Items Table */}
                        <table className="w-full border-collapse border border-gray-300 text-xs mb-6">
                            <thead>
                                <tr className="bg-gray-100 border-b border-gray-300 text-[10px] font-black uppercase text-gray-700">
                                    <th className="p-2 border-r border-gray-300 text-center w-10">#</th>
                                    <th className="p-2 border-r border-gray-300 text-left">Item Name / Brand</th>
                                    <th className="p-2 border-r border-gray-300 text-center w-24">Batch</th>
                                    <th className="p-2 border-r border-gray-300 text-center w-20">Expiry</th>
                                    <th className="p-2 border-r border-gray-300 text-right w-20">Price</th>
                                    <th className="p-2 border-r border-gray-300 text-center w-20">Return Qty</th>
                                    <th className="p-2 border-r border-gray-300 text-right w-24">Amount</th>
                                    <th className="p-2 text-left w-32">Reason</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(returnVoucher.items || []).map((item: any, idx: number) => {
                                    const price = Number(item.purchasePrice || item.rate || item.salesPrice || item.price || 0);
                                    const qty = Number(item.returnQuantity || 0);
                                    const lineAmt = price * qty;
                                    return (
                                        <tr key={item.id || idx} className="border-b border-gray-200">
                                            <td className="p-2 border-r border-gray-200 text-center">{idx + 1}</td>
                                            <td className="p-2 border-r border-gray-200 font-bold uppercase">
                                                {item.name}
                                                {item.brand && <span className="block text-[10px] text-gray-500 font-normal">Brand: {item.brand}</span>}
                                            </td>
                                            <td className="p-2 border-r border-gray-200 text-center font-mono">{item.batch || '-'}</td>
                                            <td className="p-2 border-r border-gray-200 text-center font-mono">{item.expiry || '-'}</td>
                                            <td className="p-2 border-r border-gray-200 text-right">₹{price.toFixed(2)}</td>
                                            <td className="p-2 border-r border-gray-200 text-center font-bold">{qty}</td>
                                            <td className="p-2 border-r border-gray-200 text-right font-bold">₹{lineAmt.toFixed(2)}</td>
                                            <td className="p-2 text-gray-600 italic">{item.reason || '-'}</td>
                                        </tr>
                                    );
                                })}
                                <tr className="bg-gray-50 font-bold border-t border-gray-300">
                                    <td colSpan={6} className="p-2.5 border-r border-gray-300 text-right text-gray-900 uppercase">Total Return Value</td>
                                    <td className="p-2.5 border-r border-gray-300 text-right text-gray-900 text-sm">₹{totalAmount.toFixed(2)}</td>
                                    <td className="p-2"></td>
                                </tr>
                            </tbody>
                        </table>

                        {/* Summary & Narration */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                            <div className="p-3 bg-gray-50 border border-gray-200 text-xs">
                                <span className="font-bold text-gray-500 block uppercase text-[9px] mb-0.5">Amount in Words:</span>
                                <span className="font-bold text-gray-900 uppercase italic mt-1 block">{numberToWords(totalAmount)}</span>
                            </div>
                            <div className="p-3 bg-gray-50 border border-gray-200 text-xs">
                                <span className="font-bold text-gray-500 block uppercase text-[9px] mb-0.5">Narration / Remarks:</span>
                                <span className="text-gray-700 italic block mt-1">{narration}</span>
                            </div>
                        </div>

                        <div className="mt-16 flex justify-between items-end">
                            <div className="text-[10px] text-gray-400 font-medium italic">
                                <p>This is a computer generated document.</p>
                                <p>E.&O.E.</p>
                            </div>
                            <div className="text-center w-64 border-t border-black pt-2 text-xs">
                                <div className="font-bold uppercase mb-1">{companyName}</div>
                                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{authorizedSignatory}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <style>{`
                @media print {
                    body { margin: 0; padding: 0; background: white; }
                    .no-print { display: none !important; }
                    #return-print-area { padding: 0 !important; border: none !important; width: 100% !important; max-width: none !important; }
                    body > *:not(#print-return-modal-container) {
                        display: none !important;
                    }
                }
            `}</style>
        </div>,
        document.body
    );
};

export default PrintReturnModal;
