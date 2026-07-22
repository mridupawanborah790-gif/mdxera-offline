import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Distributor, RegisteredPharmacy, TransactionLedgerItem, Purchase } from '@core/types';
import { numberToWords } from '@core/utils/numberToWords';
import { formatVoucherNo } from '@core/utils/helpers';
import { useOfflineAsset } from '@core/hooks/useOfflineAsset';

const formatDisplayDate = (value?: string): string => {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const getPaymentAmount = (entry: TransactionLedgerItem): number => {
    const creditAmount = Number(entry.credit || 0);
    if (creditAmount > 0) return creditAmount;
    return Number(entry.debit || 0);
};

interface VoucherAllocationSummary {
    adjustedAmount: number;
    remainingAmount: number;
    status: 'Open / Unadjusted' | 'Partially Adjusted' | 'Fully Adjusted' | 'Cancelled';
}

interface BankOption {
    id: string;
    bankName: string;
    accountName: string;
    accountNumber: string;
    isDefault: boolean;
    accountType?: string;
}

interface PrintSupplierVoucherModalProps {
    isOpen: boolean;
    onClose: () => void;
    voucher: TransactionLedgerItem | null;
    distributor: Distributor | null;
    pharmacy: RegisteredPharmacy | null;
    bankOptions: BankOption[];
    summary: VoucherAllocationSummary | null;
    purchases?: Purchase[];
}

const PrintSupplierVoucherModal: React.FC<PrintSupplierVoucherModalProps> = ({
    isOpen,
    onClose,
    voucher,
    distributor,
    pharmacy,
    bankOptions,
    summary,
    purchases = [],
}) => {
    const logoUrl = useOfflineAsset(pharmacy?.pharmacy_logo_url);
    const [pageSize, setPageSize] = useState<'a4' | 'a5'>('a4');

    useEffect(() => {
        if (isOpen && voucher && distributor) {
            const originalTitle = document.title;
            const voucherNumber = formatVoucherNo(voucher.journalEntryNumber || voucher.journalEntryId) || 'Pending';
            document.title = `Voucher_${voucherNumber}_Supplier_${distributor.name.replace(/[^a-z0-9]/gi, '_')}`;
            
            const printTimeout = setTimeout(() => {
                window.print();
                setTimeout(() => { document.title = originalTitle; }, 1000);
            }, 300);

            return () => clearTimeout(printTimeout);
        }
    }, [isOpen, voucher, distributor]);

    if (!isOpen || !voucher || !distributor || !pharmacy || !summary) return null;

    const voucherType = voucher.entryCategory === 'down_payment'
        ? 'Down Payment Voucher'
        : voucher.entryCategory === 'down_payment_adjustment'
            ? 'Down Payment Adjustment'
            : voucher.entryCategory === 'invoice_payment_adjustment'
                ? 'Invoice Payment Adjustment'
                : voucher.entryCategory === 'payment_cancellation' || voucher.entryCategory === 'down_payment_cancellation'
                    ? 'Payment Cancellation'
                    : 'Payment Voucher';

    const voucherNumber = formatVoucherNo(voucher.journalEntryNumber || voucher.journalEntryId) || 'Pending Voucher Number';
    const voucherDate = formatDisplayDate(voucher.date);
    const paymentModeText = voucher.paymentMode || 'Bank';
    const bankAccount = voucher.bankName || bankOptions.find(option => option.id === voucher.bankAccountId)?.bankName || 'N/A';
    const amountPaid = getPaymentAmount(voucher);
    const narration = (voucher.description || 'Supplier payment posted')
        .replace(/\s*\[AUTO_LEDGER\]:[a-z0-9\-]+/gi, '')
        .trim() || 'Supplier payment posted';

    const resolvedInvoiceNo = (() => {
        const refNo = voucher.referenceInvoiceNumber;
        if (refNo && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(refNo)) {
            return refNo;
        }
        const refId = voucher.referenceInvoiceId || refNo;
        if (refId && purchases.length > 0) {
            const found = purchases.find(p => p.id === refId);
            if (found) return found.invoiceNumber;
        }
        return formatVoucherNo(refNo) || '-';
    })();

    const paymentAgainstInvoice = resolvedInvoiceNo;
    const linkedDetails = resolvedInvoiceNo;
    const isAutoPayment = voucher.id.startsWith('auto-') || /auto[-\s]?/i.test(voucher.description || '');

    const companyName = pharmacy.pharmacy_name || 'Pharmacy';
    const companyAddress = [pharmacy.address, pharmacy.district, pharmacy.state, pharmacy.pincode].filter(Boolean).join(', ');
    const authorizedSignatory = pharmacy.manager_name || pharmacy.full_name || 'Authorized Signatory';
    const isA5 = pageSize === 'a5';

    return createPortal(
        <div id="print-voucher-modal-container" className="fixed inset-0 bg-black/60 z-[1000] flex justify-center items-center backdrop-blur-sm print:bg-white print:p-0 overflow-y-auto">
            <div className="bg-white rounded-lg shadow-2xl w-full max-w-4xl flex flex-col max-h-[95vh] print:max-h-none print:shadow-none print:rounded-none">
                <div className="flex justify-between items-center p-4 border-b no-print bg-white sticky top-0 z-10">
                    <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wider">Print Payment Voucher</h3>
                    <div className="flex gap-4 items-center">
                        <div className="flex items-center gap-1.5 bg-gray-100 p-0.5 rounded border border-gray-300">
                            <button 
                                onClick={() => setPageSize('a4')} 
                                className={`px-2.5 py-1 text-[10px] font-black uppercase rounded ${pageSize === 'a4' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}
                            >
                                A4 Size
                            </button>
                            <button 
                                onClick={() => setPageSize('a5')} 
                                className={`px-2.5 py-1 text-[10px] font-black uppercase rounded ${pageSize === 'a5' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}
                            >
                                A5 Size
                            </button>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => window.print()} className="px-4 py-2 bg-primary text-white rounded text-xs font-bold uppercase shadow-lg hover:bg-primary-dark">Print</button>
                            <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        </div>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto bg-gray-50 p-8 print:p-0 print:bg-white">
                    <div id="voucher-print-area" className={`relative bg-white shadow-sm mx-auto print:shadow-none print:border-none text-black font-sans ${isA5 ? 'p-3 max-w-[148mm] min-h-[210mm]' : 'p-5 max-w-[210mm] min-h-[297mm] border border-gray-200 shadow-sm'}`}>
                        
                        {voucher.status === 'cancelled' && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-50 overflow-hidden">
                                <div className="text-red-600/10 text-[96px] font-black uppercase tracking-[0.2em] transform -rotate-30 select-none">
                                    CANCELLED
                                </div>
                            </div>
                        )}

                        <div className="flex flex-col items-center border-b border-gray-300 pb-4 mb-6 text-center">
                            {logoUrl && (
                                <img src={logoUrl} alt="Logo" className={`${isA5 ? 'w-12 h-12 mb-2' : 'w-20 h-20 mb-3'} object-contain border border-gray-100 rounded bg-gray-50 p-1`} />
                            )}
                            <h1 className={`${isA5 ? 'text-lg' : 'text-xl'} font-bold uppercase leading-none tracking-tight text-gray-900 mb-1`}>{voucherType}</h1>
                            <h2 className={`${isA5 ? 'text-xs' : 'text-sm'} font-bold text-gray-800 uppercase`}>{companyName}</h2>
                            <p className={`${isA5 ? 'text-[9px] mt-1' : 'text-xs mt-1'} text-gray-600 max-w-lg`}>{companyAddress}</p>
                            
                            <div className={`w-full flex justify-between items-center mt-4 pt-2 border-t border-dashed border-gray-255 ${isA5 ? 'text-[9px]' : 'text-xs'}`}>
                                <div><strong>Voucher No.:</strong> <span className="font-bold">{voucherNumber}</span></div>
                                <div><strong>Voucher Date:</strong> {voucherDate}</div>
                            </div>
                        </div>

                        <table className={`w-full border-collapse border border-gray-300 mb-6 ${isA5 ? 'text-[9px]' : 'text-xs'}`}>
                            <tbody>
                                <tr className="border-b border-gray-300">
                                    <td className={`w-1/3 font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Supplier Name</td>
                                    <td className={`text-gray-900 font-medium ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{distributor.name}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Supplier Address</td>
                                    <td className={`text-gray-900 font-medium ${isA5 ? 'p-1.5' : 'p-2.5'}`}>
                                        {[distributor.address || distributor.address_line1, distributor.address_line2, distributor.area, distributor.city, distributor.district, distributor.state, distributor.pincode].filter(Boolean).join(', ') || '—'}
                                    </td>
                                </tr>
                                {distributor.gst_number && (
                                    <tr className="border-b border-gray-300">
                                        <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Supplier GSTIN</td>
                                        <td className={`text-gray-900 font-medium ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{distributor.gst_number}</td>
                                    </tr>
                                )}
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Payment Against Invoice No.</td>
                                    <td className={`text-gray-900 font-bold ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{paymentAgainstInvoice}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Payment Mode</td>
                                    <td className={`text-gray-900 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{paymentModeText}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Bank / Cash Account</td>
                                    <td className={`text-gray-800 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{bankAccount}</td>
                                </tr>
                                <tr className={`border-b border-gray-300 bg-gray-50 font-bold ${isA5 ? 'text-xs' : 'text-sm'}`}>
                                    <td className={`border-r border-gray-300 text-gray-900 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Amount Paid</td>
                                    <td className={`text-gray-900 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>₹{amountPaid.toFixed(2)}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Adjusted Amount</td>
                                    <td className={`text-emerald-700 font-bold ${isA5 ? 'p-1.5' : 'p-2.5'}`}>₹{summary.adjustedAmount.toFixed(2)}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Unadjusted Amount</td>
                                    <td className={`text-red-700 font-bold ${isA5 ? 'p-1.5' : 'p-2.5'}`}>₹{summary.remainingAmount.toFixed(2)}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Status</td>
                                    <td className={`${isA5 ? 'p-1.5' : 'p-2.5'}`}><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${summary.status === 'Fully Adjusted' ? 'bg-emerald-100 text-emerald-800' : summary.status === 'Cancelled' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{summary.status}</span></td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Linked Invoice Details</td>
                                    <td className={`text-gray-600 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{linkedDetails}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Auto Payment</td>
                                    <td className={`text-gray-600 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{isAutoPayment ? 'Yes (System Generated)' : 'No (Manual)'}</td>
                                </tr>
                                <tr>
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Narration / Remarks</td>
                                    <td className={`text-gray-700 italic ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{narration}</td>
                                </tr>
                            </tbody>
                        </table>

                        <div className={`mb-8 bg-gray-50 border border-gray-200 ${isA5 ? 'p-2 text-[10px]' : 'p-3 text-xs'}`}>
                            <span className="font-bold text-gray-500 block uppercase text-[9px]">Amount in Words:</span>
                            <span className="font-bold text-gray-900 uppercase italic mt-1 block">{numberToWords(amountPaid)}</span>
                        </div>

                        <div className={`${isA5 ? 'mt-8' : 'mt-16'} flex justify-between items-end`}>
                            <div className={`${isA5 ? 'text-[8px]' : 'text-[10px]'} text-gray-400 font-medium italic`}>
                                <p>This is a computer generated payment voucher.</p>
                                <p>E.&O.E.</p>
                            </div>
                            <div className={`text-center border-t border-black pt-2 text-xs ${isA5 ? 'w-48' : 'w-64'}`}>
                                <div className="font-bold uppercase mb-1">{companyName}</div>
                                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{authorizedSignatory}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <style>{`
                @media print {
                    @page {
                        margin: 5mm;
                        size: ${pageSize.toUpperCase()};
                    }
                    html, body {
                        margin: 0 !important;
                        padding: 0 !important;
                        background: white !important;
                        overflow: visible !important;
                        height: auto !important;
                    }
                    ::-webkit-scrollbar {
                        display: none !important;
                    }
                    .no-print { display: none !important; }
                    #print-voucher-modal-container {
                        position: absolute !important;
                        left: 0 !important;
                        top: 0 !important;
                        width: 100% !important;
                        height: auto !important;
                        overflow: visible !important;
                        display: block !important;
                    }
                    #print-voucher-modal-container > div {
                        width: auto !important;
                        max-width: none !important;
                        max-height: none !important;
                        height: auto !important;
                        overflow: visible !important;
                    }
                    #print-voucher-modal-container * {
                        overflow: visible !important;
                    }
                    #voucher-print-area { 
                        padding: ${isA5 ? '3mm 4mm' : '5mm 6mm'} !important; 
                        border: none !important; 
                        width: 100% !important; 
                        max-width: none !important; 
                    }
                    body > *:not(#print-voucher-modal-container) {
                        display: none !important;
                    }
                }
            `}</style>
        </div>,
        document.body
    );
};

export default PrintSupplierVoucherModal;
