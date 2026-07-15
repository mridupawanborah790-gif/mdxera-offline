import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RegisteredPharmacy } from '@core/types';
import { numberToWords } from '@core/utils/numberToWords';
import { formatVoucherNo } from '@core/utils/helpers';
import { db } from '@core/db/client';
import { getData } from '@core/services/storageService';
import { useOfflineAsset } from '@core/hooks/useOfflineAsset';

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
    const [configs, setConfigs] = useState<any>(null);
    const [pageSize, setPageSize] = useState<'a4' | 'a5'>('a4');
    const [customers, setCustomers] = useState<any[]>([]);
    const [suppliers, setSuppliers] = useState<any[]>([]);
    
    const logoUrl = useOfflineAsset(configs?.pharmacy_logo_url || pharmacy?.pharmacy_logo_url);

    useEffect(() => {
        if (!isOpen || !pharmacy) return;
        const loadConfigs = async () => {
            try {
                const rows = await db.select<any>(
                    `SELECT display_options FROM configurations WHERE organization_id = ? LIMIT 1`,
                    [pharmacy.organization_id]
                );
                if (rows && rows.length > 0) {
                    const row = rows[0];
                    let displayOpts = row.display_options;
                    if (typeof displayOpts === 'string') {
                        try { displayOpts = JSON.parse(displayOpts); } catch (e) {}
                    }
                    setConfigs(displayOpts);
                }
            } catch (err) {
                console.warn('[PrintReturnModal] Failed to load configurations:', err);
            }
        };
        loadConfigs();
        getData('customers', [], pharmacy).then(data => setCustomers(data || []));
        getData('suppliers', [], pharmacy).then(data => setSuppliers(data || []));
    }, [isOpen, pharmacy]);

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

    const isA5 = pageSize === 'a5';

    // Look up Address & GST Details dynamically
    const partyDetails = (() => {
        if (isSales) {
            const customer = customers.find(c => String(c.id) === String(returnVoucher.customerId));
            if (customer) {
                return {
                    address: [customer.address || customer.address_line1, customer.address_line2, customer.area, customer.city, customer.district, customer.state, customer.pincode].filter(Boolean).join(', ') || '—',
                    gstin: customer.gstNumber || 'N/A'
                };
            }
        } else {
            const supplier = suppliers.find(s => String(s.name).trim().toLowerCase() === String(returnVoucher.supplier).trim().toLowerCase());
            if (supplier) {
                return {
                    address: [supplier.address || supplier.address_line1, supplier.address_line2, supplier.area, supplier.city, supplier.district, supplier.state, supplier.pincode].filter(Boolean).join(', ') || '—',
                    gstin: supplier.gst_number || supplier.gstNumber || 'N/A'
                };
            }
        }
        return { address: '—', gstin: 'N/A' };
    })();

    return createPortal(
        <div id="print-return-modal-container" className="fixed inset-0 bg-black/60 z-[1000] flex justify-center items-center backdrop-blur-sm print:bg-white print:p-0 overflow-y-auto">
            <div className="bg-white rounded-lg shadow-2xl w-full max-w-4xl flex flex-col max-h-[95vh] print:max-h-none print:shadow-none print:rounded-none">
                <div className="flex justify-between items-center p-4 border-b no-print bg-white sticky top-0 z-10">
                    <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wider">Print Return Voucher</h3>
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
                    <div id="return-print-area" className={`relative bg-white shadow-sm mx-auto print:shadow-none print:border-none text-black font-sans ${isA5 ? 'p-6 max-w-[148mm] min-h-[210mm]' : 'p-12 max-w-[210mm] min-h-[297mm] border border-gray-200 shadow-sm'}`}>
                        
                        <div className="flex flex-col items-center border-b border-gray-300 pb-4 mb-6 text-center">
                            {logoUrl && (
                                <img src={logoUrl} alt="Logo" className={`${isA5 ? 'w-12 h-12 mb-2' : 'w-20 h-20 mb-3'} object-contain border border-gray-100 rounded bg-gray-50 p-1`} />
                            )}
                            <h1 className={`${isA5 ? 'text-lg' : 'text-xl'} font-bold uppercase leading-none tracking-tight text-gray-900 mb-1`}>{title}</h1>
                            <h2 className={`${isA5 ? 'text-xs' : 'text-sm'} font-bold text-gray-800 uppercase`}>{companyName}</h2>
                            <p className={`${isA5 ? 'text-[9px] mt-1' : 'text-xs mt-1'} text-gray-600 max-w-lg`}>{companyAddress}</p>
                            
                            <div className={`w-full flex justify-between items-center mt-4 pt-2 border-t border-dashed border-gray-255 ${isA5 ? 'text-[9px]' : 'text-xs'}`}>
                                <div><strong>Voucher No.:</strong> <span className="font-bold">{voucherNumber}</span></div>
                                <div><strong>Voucher Date:</strong> {voucherDate}</div>
                            </div>
                        </div>

                        {/* Top Metadata */}
                        <table className={`w-full border-collapse border border-gray-300 mb-6 ${isA5 ? 'text-[9px]' : 'text-xs'}`}>
                            <tbody>
                                <tr className="border-b border-gray-300">
                                    <td className={`w-1/3 font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{partyLabel}</td>
                                    <td className={`text-gray-900 font-bold ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{partyName}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Address</td>
                                    <td className={`text-gray-900 font-medium ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{partyDetails.address}</td>
                                </tr>
                                <tr className="border-b border-gray-300">
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>GSTIN</td>
                                    <td className={`text-gray-900 font-medium ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{partyDetails.gstin}</td>
                                </tr>
                                <tr>
                                    <td className={`font-bold bg-gray-50 border-r border-gray-300 text-gray-700 ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{sourceInvoiceLabel}</td>
                                    <td className={`text-gray-900 font-bold font-mono ${isA5 ? 'p-1.5' : 'p-2.5'}`}>{formatVoucherNo(sourceInvoiceId)}</td>
                                </tr>
                            </tbody>
                        </table>

                        {/* Items Table */}
                        <table className={`w-full border-collapse border border-gray-300 mb-6 ${isA5 ? 'text-[9px]' : 'text-xs'}`}>
                            <thead>
                                <tr className="bg-gray-100 border-b border-gray-300 text-[10px] font-black uppercase text-gray-700">
                                    <th className={`border-r border-gray-300 text-center w-10 ${isA5 ? 'p-1' : 'p-2'}`}>#</th>
                                    <th className={`border-r border-gray-300 text-left ${isA5 ? 'p-1' : 'p-2'}`}>Item Name / Brand</th>
                                    <th className={`border-r border-gray-300 text-center w-24 ${isA5 ? 'p-1' : 'p-2'}`}>Batch</th>
                                    <th className={`border-r border-gray-300 text-center w-20 ${isA5 ? 'p-1' : 'p-2'}`}>Expiry</th>
                                    <th className={`border-r border-gray-300 text-right w-20 ${isA5 ? 'p-1' : 'p-2'}`}>Price</th>
                                    <th className={`border-r border-gray-300 text-center w-20 ${isA5 ? 'p-1' : 'p-2'}`}>Return Qty</th>
                                    <th className={`border-r border-gray-300 text-right w-24 ${isA5 ? 'p-1' : 'p-2'}`}>Amount</th>
                                    <th className={`${isA5 ? 'p-1 w-24' : 'p-2 w-32'} text-left`}>Reason</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(returnVoucher.items || []).map((item: any, idx: number) => {
                                    const price = Number(item.purchasePrice || item.rate || item.salesPrice || item.price || 0);
                                    const qty = Number(item.returnQuantity || 0);
                                    const lineAmt = price * qty;
                                    return (
                                        <tr key={item.id || idx} className="border-b border-gray-200">
                                            <td className={`border-r border-gray-200 text-center ${isA5 ? 'p-1.5' : 'p-2'}`}>{idx + 1}</td>
                                            <td className={`border-r border-gray-200 font-bold uppercase ${isA5 ? 'p-1.5' : 'p-2'}`}>
                                                {item.name}
                                                {item.brand && <span className="block text-[10px] text-gray-500 font-normal">Brand: {item.brand}</span>}
                                            </td>
                                            <td className={`border-r border-gray-200 text-center font-mono ${isA5 ? 'p-1.5' : 'p-2'}`}>{item.batch || '-'}</td>
                                            <td className={`border-r border-gray-200 text-center font-mono ${isA5 ? 'p-1.5' : 'p-2'}`}>{item.expiry || '-'}</td>
                                            <td className={`border-r border-gray-200 text-right ${isA5 ? 'p-1.5' : 'p-2'}`}>₹{price.toFixed(2)}</td>
                                            <td className={`border-r border-gray-200 text-center font-bold ${isA5 ? 'p-1.5' : 'p-2'}`}>{qty}</td>
                                            <td className={`border-r border-gray-200 text-right font-bold ${isA5 ? 'p-1.5' : 'p-2'}`}>₹{lineAmt.toFixed(2)}</td>
                                            <td className={`text-gray-600 italic ${isA5 ? 'p-1.5' : 'p-2'}`}>{item.reason || '-'}</td>
                                        </tr>
                                    );
                                })}
                                <tr className="bg-gray-50 font-bold border-t border-gray-300">
                                    <td colSpan={6} className={`border-r border-gray-300 text-right text-gray-900 uppercase ${isA5 ? 'p-1.5' : 'p-2.5'}`}>Total Return Value</td>
                                    <td className={`border-r border-gray-300 text-right text-gray-900 text-sm ${isA5 ? 'p-1.5' : 'p-2.5'}`}>₹{totalAmount.toFixed(2)}</td>
                                    <td className={`${isA5 ? 'p-1.5' : 'p-2.5'}`}></td>
                                </tr>
                            </tbody>
                        </table>

                        {/* Summary & Narration */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                            <div className={`bg-gray-50 border border-gray-200 ${isA5 ? 'p-2 text-[10px]' : 'p-3 text-xs'}`}>
                                <span className="font-bold text-gray-500 block uppercase text-[9px] mb-0.5">Amount in Words:</span>
                                <span className="font-bold text-gray-900 uppercase italic mt-1 block">{numberToWords(totalAmount)}</span>
                            </div>
                            <div className={`bg-gray-50 border border-gray-200 ${isA5 ? 'p-2 text-[10px]' : 'p-3 text-xs'}`}>
                                <span className="font-bold text-gray-500 block uppercase text-[9px] mb-0.5">Narration / Remarks:</span>
                                <span className="text-gray-700 italic block mt-1">{narration}</span>
                            </div>
                        </div>

                        <div className={`${isA5 ? 'mt-8' : 'mt-16'} flex justify-between items-end`}>
                            <div className={`${isA5 ? 'text-[8px]' : 'text-[10px]'} text-gray-400 font-medium italic`}>
                                <p>This is a computer generated document.</p>
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
                    #print-return-modal-container {
                        position: absolute !important;
                        left: 0 !important;
                        top: 0 !important;
                        width: 100% !important;
                        height: auto !important;
                        overflow: visible !important;
                        display: block !important;
                    }
                    #print-return-modal-container > div {
                        width: auto !important;
                        max-width: none !important;
                        max-height: none !important;
                        height: auto !important;
                        overflow: visible !important;
                    }
                    #print-return-modal-container * {
                        overflow: visible !important;
                    }
                    #return-print-area { 
                        padding: ${isA5 ? '8mm 10mm' : '15mm 20mm'} !important; 
                        border: none !important; 
                        width: 100% !important; 
                        max-width: none !important; 
                        min-height: 0 !important; 
                    }
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
