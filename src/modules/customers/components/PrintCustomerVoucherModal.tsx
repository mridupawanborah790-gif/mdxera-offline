import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Customer, RegisteredPharmacy, TransactionLedgerItem } from '@core/types';
import { numberToWords } from '@core/utils/numberToWords';
import { formatVoucherNo } from '@core/utils/helpers';
import { useOfflineAsset } from '@core/hooks/useOfflineAsset';

const formatDisplayDate = (value?: string): string => {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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

interface PrintCustomerVoucherModalProps {
    isOpen: boolean;
    onClose: () => void;
    voucher: TransactionLedgerItem | null;
    customer: Customer | null;
    pharmacy: RegisteredPharmacy | null;
    bankOptions: BankOption[];
    summary: VoucherAllocationSummary | null;
}

const PrintCustomerVoucherModal: React.FC<PrintCustomerVoucherModalProps> = ({
    isOpen,
    onClose,
    voucher,
    customer,
    pharmacy,
    bankOptions,
    summary,
}) => {
    const logoUrl = useOfflineAsset(pharmacy?.pharmacy_logo_url);

    useEffect(() => {
        if (isOpen && voucher && customer) {
            const originalTitle = document.title;
            const voucherNumber = voucher.journalEntryNumber || voucher.journalEntryId || 'Pending';
            document.title = `Voucher_${voucherNumber}_Customer_${customer.name.replace(/[^a-z0-9]/gi, '_')}`;
            
            const printTimeout = setTimeout(() => {
                window.print();
                setTimeout(() => { document.title = originalTitle; }, 1000);
            }, 300);

            return () => clearTimeout(printTimeout);
        }
    }, [isOpen, voucher, customer]);

    if (!isOpen || !voucher || !customer || !pharmacy || !summary) return null;

    const voucherType = voucher.entryCategory === 'down_payment'
        ? 'Down Payment Receipt'
        : voucher.entryCategory === 'down_payment_adjustment'
            ? 'Down Payment Adjustment'
            : voucher.entryCategory === 'invoice_payment_adjustment'
                ? 'Invoice Receipt Adjustment'
                : voucher.entryCategory === 'payment_cancellation' || voucher.entryCategory === 'down_payment_cancellation'
                    ? 'Receipt Cancellation'
                    : 'Receipt Voucher';

    const voucherNumber = voucher.journalEntryNumber || voucher.journalEntryId || 'Pending Voucher Number';
    const voucherDate = formatDisplayDate(voucher.date);
    const paymentModeText = voucher.paymentMode || 'Bank';
    const bankAccount = voucher.bankName || bankOptions.find(option => option.id === voucher.bankAccountId)?.bankName || 'N/A';
    const amountReceived = Number(voucher.credit || 0);
    const receiptAgainstInvoice = formatVoucherNo(voucher.referenceInvoiceNumber) || '-';
    const narration = (voucher.description || 'Payment Received')
        .replace(/\s*\[AUTO_LEDGER\]:[a-f0-9\-]+/gi, '')
        .trim() || 'Payment Received';
    const isAutoReceipt = voucher.id.startsWith('auto-') || /auto[-\s]?/i.test(voucher.description || '');
    const linkedDetails = formatVoucherNo(voucher.referenceInvoiceNumber) || '-';

    const companyName = pharmacy.pharmacy_name || 'Pharmacy';
    const companyAddress = [pharmacy.address, pharmacy.address_line2, pharmacy.district, pharmacy.state, pharmacy.pincode].filter(Boolean).join(', ');
    const authorizedSignatory = pharmacy.authorized_signatory || pharmacy.manager_name || pharmacy.full_name || 'Authorized Signatory';

    return createPortal(
        <div id="print-voucher-modal-container" className="fixed inset-0 bg-black/60 z-[1000] flex justify-center items-center backdrop-blur-sm print:bg-white print:p-0 overflow-y-auto">
            <div className="bg-white rounded-lg shadow-2xl w-full max-w-4xl flex flex-col max-h-[95vh] print:max-h-none print:shadow-none print:rounded-none">
                <div className="flex justify-between items-center p-4 border-b no-print bg-white sticky top-0 z-10">
                    <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wider">Print Voucher Receipt</h3>
                    <div className="flex gap-2">
                        <button onClick={() => window.print()} className="px-4 py-2 bg-primary text-white rounded text-xs font-bold uppercase shadow-lg hover:bg-primary-dark">Print</button>
                        <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto bg-gray-50 p-8 print:p-0 print:bg-white">
                    <div id="voucher-print-area" className="relative bg-white p-8 border border-gray-200 shadow-sm mx-auto print:shadow-none print:border-none max-w-[210mm] text-black font-sans">
                        
                        {voucher.status === 'cancelled' && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-50 overflow-hidden">
                                <div className="text-red-600/10 text-[96px] font-black uppercase tracking-[0.2em] transform -rotate-30 select-none">
                                    CANCELLED
                                </div>
                            </div>
                        )}

                        <div className="flex flex-col items-center border-b border-gray-300 pb-4 mb-6 text-center">
                            {logoUrl && (
                                <img src={logoUrl} alt="Logo" className="w-20 h-20 object-contain border border-gray-100 rounded bg-gray-50 p-1 mb-3" />
                            )}
                            <h1 className="text-xl font-bold uppercase leading-none tracking-tight text-gray-900 mb-1">{voucherType}</h1>
                            <h2 className="text-sm font-bold text-gray-800 uppercase">{companyName}</h2>
                            <p className="text-xs mt-1 text-gray-600 max-w-lg">{companyAddress}</p>
                            
                            <div className="w-full flex justify-between items-center mt-4 text-xs pt-2 border-t border-dashed border-gray-250">
                                <div><strong>Voucher No.:</strong> <span className="font-bold">{voucherNumber}</span></div>
                                <div><strong>Voucher Date:</strong> {voucherDate}</div>
                            </div>
                        </div>

                        <table className="w-full border-collapse border border-gray-300 text-xs mb-6">
                            <tbody>
                                <tr className="border-b border-gray-300">
                                    <td className="w-1/3 p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Customer Name</td>
                                    <td className="p-2.5 text-gray-900 font-medium">{customer.name}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Customer Address</td>
                                    <td className="p-2.5 text-gray-900 font-medium">
                                        {[customer.address || customer.address_line1, customer.address_line2, customer.area, customer.city, customer.district, customer.state, customer.pincode].filter(Boolean).join(', ') || '—'}
                                    </td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Receipt Against Invoice No.</td>
                                    <td className="p-2.5 text-gray-900 font-bold">{receiptAgainstInvoice}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Payment Mode</td>
                                    <td className="p-2.5 text-gray-900">{paymentModeText}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Bank / Cash Account</td>
                                    <td className="p-2.5 text-gray-800">{bankAccount}</td>
                                </tr>
                                <tr className="border-b border-gray-300 bg-gray-50 font-bold text-sm">
                                    <td className="p-2.5 border-r border-gray-300 text-gray-900">Amount Received</td>
                                    <td className="p-2.5 text-gray-900">₹{amountReceived.toFixed(2)}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Adjusted Amount</td>
                                    <td className="p-2.5 text-emerald-700 font-bold">₹{summary.adjustedAmount.toFixed(2)}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Unadjusted Amount</td>
                                    <td className="p-2.5 text-red-700 font-bold">₹{summary.remainingAmount.toFixed(2)}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Status</td>
                                    <td className="p-2.5"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${summary.status === 'Fully Adjusted' ? 'bg-emerald-100 text-emerald-800' : summary.status === 'Cancelled' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{summary.status}</span></td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Linked Invoice Details</td>
                                    <td className="p-2.5 text-gray-600">{linkedDetails}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Auto Receipt</td>
                                    <td className="p-2.5 text-gray-600">{isAutoReceipt ? 'Yes (System Generated)' : 'No (Manual)'}</td>
                                </tr>
                                <tr>
                                    <td className="p-2.5 font-bold bg-gray-50 border-r border-gray-300 text-gray-700">Narration / Remarks</td>
                                    <td className="p-2.5 text-gray-700 italic">{narration}</td>
                                </tr>
                            </tbody>
                        </table>

                        <div className="mb-8 p-3 bg-gray-50 border border-gray-200 text-xs">
                            <span className="font-bold text-gray-500 block uppercase text-[10px]">Amount in Words:</span>
                            <span className="font-bold text-gray-900 uppercase italic mt-1 block">{numberToWords(amountReceived)}</span>
                        </div>

                        <div className="mt-16 flex justify-between items-end">
                            <div className="text-[10px] text-gray-400 font-medium italic">
                                <p>This is a computer generated receipt voucher.</p>
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
                    @page {
                        margin: 10mm;
                    }
                    body { margin: 0; padding: 0; background: white; }
                    .no-print { display: none !important; }
                    #voucher-print-area { padding: 8mm 12mm !important; border: none !important; width: 100% !important; max-width: none !important; }
                    body > *:not(#print-voucher-modal-container) {
                        display: none !important;
                    }
                }
            `}</style>
        </div>,
        document.body
    );
};

export default PrintCustomerVoucherModal;
