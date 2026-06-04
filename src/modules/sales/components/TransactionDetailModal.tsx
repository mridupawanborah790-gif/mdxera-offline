
import React, { useMemo } from 'react';
import Modal from '@core/components/ui/Modal';
import JournalEntryViewerModal from '@modules/accounting/components/JournalEntryViewerModal';
import type { Transaction, BillItem, Customer, RegisteredPharmacy, SalesReturn, AppConfigurations } from '@core/types';
import { formatPackLooseQuantity } from '@core/utils/quantity';

interface TransactionDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    transaction: Transaction | null;
    customer?: Customer | null;
    onPrintBill: (transaction: Transaction) => void;
    onProcessReturn: (invoiceId: string) => void;
    pharmacyName?: string;
    currentUser?: RegisteredPharmacy | null;
    salesReturns?: SalesReturn[];
    configurations?: AppConfigurations;
}

const TransactionDetailModal: React.FC<TransactionDetailModalProps> = ({ 
    isOpen, 
    onClose, 
    transaction, 
    customer, 
    onPrintBill, 
    onProcessReturn, 
    pharmacyName, 
    currentUser,
    salesReturns = [],
    configurations
}) => {
    const [isJournalOpen, setIsJournalOpen] = React.useState(false);

    // Calculate returned quantities per item
    const returnedQtyMap = useMemo(() => {
        const map = new Map<string, number>();
        if (!transaction) return map;

        const relevantReturns = salesReturns.filter(r => 
            r.originalInvoiceId === transaction.id
        );

        relevantReturns.forEach(ret => {
            (ret.items || []).forEach(item => {
                const key = item.inventoryItemId || item.id || item.name;
                const current = map.get(key) || 0;
                map.set(key, current + (item.returnQuantity || 0));
            });
        });
        return map;
    }, [transaction, salesReturns]);

    if (!isOpen || !transaction) return null;

    const getItemDisplayName = (item: BillItem) => {
        const pack = item.packType?.trim();
        return pack ? `${item.name} (${pack})` : item.name;
    };
    const posLineAmountMode = configurations?.displayOptions?.posLineAmountCalculationMode || 'excluding_discount';

    const { 
        total, 
        subtotal, 
        totalItemDiscount, 
        totalGst, 
        schemeDiscount, 
        adjustment,
        narration,
        roundOff,
        prescriptionUrl, 
        prescriptionImages 
    } = transaction;

    const items = Array.isArray(transaction.items) ? transaction.items : [];

    const totalReturnRefund = useMemo(() => {
        return salesReturns
            .filter(r => r.originalInvoiceId === transaction.id)
            .reduce((sum, ret) => sum + (ret.totalRefund || 0), 0);
    }, [transaction, salesReturns]);

    // Legacy bills (and SQLite-mirrored rows) may store the JSON-stringified
    // array or bare base64 without the `data:<mime>;base64,` prefix. Normalize
    // both forms so the <img> tags below actually render.
    const ensurePrescriptionDataUri = (raw: string): string => {
        if (typeof raw !== 'string' || raw.length === 0) return raw;
        if (raw.startsWith('data:') || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('blob:')) return raw;
        const b64 = raw.replace(/\s+/g, '');
        let mime = 'image/png';
        if (b64.startsWith('JVBERi'))      mime = 'application/pdf';
        else if (b64.startsWith('/9j/'))   mime = 'image/jpeg';
        else if (b64.startsWith('iVBOR'))  mime = 'image/png';
        else if (b64.startsWith('R0lGOD')) mime = 'image/gif';
        else if (b64.startsWith('UklGR'))  mime = 'image/webp';
        return `data:${mime};base64,${b64}`;
    };

    let imagesArr: string[] = [];
    if (Array.isArray(prescriptionImages)) {
        imagesArr = prescriptionImages.filter((v): v is string => typeof v === 'string' && v.length > 0);
    } else if (typeof prescriptionImages === 'string' && (prescriptionImages as string).trim()) {
        try {
            const parsed = JSON.parse(prescriptionImages as string);
            imagesArr = Array.isArray(parsed)
                ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
                : [prescriptionImages as string];
        } catch {
            imagesArr = [prescriptionImages as string];
        }
    }

    const allPrescriptions = [
        ...(prescriptionUrl ? [prescriptionUrl] : []),
        ...imagesArr,
    ].map(ensurePrescriptionDataUri);

    const displaySubtotal = subtotal ?? items.reduce((sum, item) => {
        const uPP = item.unitsPerPack || 1;
        const tU = (item.quantity * uPP) + (item.looseQuantity || 0);
        const uR = item.mrp / uPP;
        const linePriceAfterDiscount = (uR * tU) * (1 - (item.discountPercent || 0) / 100);
        return sum + (linePriceAfterDiscount / (1 + (item.gstPercent || 0) / 100));
    }, 0);
    
    const displayItemDiscount = totalItemDiscount ?? items.reduce((sum, item) => {
        const uPP = item.unitsPerPack || 1;
        const tU = (item.quantity * uPP) + (item.looseQuantity || 0);
        const uR = item.mrp / uPP;
        return sum + (uR * tU * ((item.discountPercent || 0) / 100));
    }, 0);
    
    const displayGst = totalGst ?? ((total || 0) - displaySubtotal);

    const handleDownloadPrescription = (url: string, index: number) => {
        if (!url) return;
        const isPdf = url.startsWith('data:application/pdf');
        const link = document.createElement('a');
        link.href = url;
        link.download = `Prescription_${transaction.id}_${index + 1}${isPdf ? '.pdf' : '.png'}`; 
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleWhatsAppShare = () => {
        if (!transaction.customerPhone) {
            alert("Customer phone number is missing for this transaction.");
            return;
        }
        const phone = transaction.customerPhone.replace(/[^0-9]/g, '');
        const pName = pharmacyName || "[Pharmacy Name]";
        const message = `We appreciate your visit to ${pName}. Thank you for shopping with us.\n\nInvoice: ${transaction.id}\nDate: ${new Date(transaction.date).toLocaleDateString('en-IN')}\nTotal: ₹${(transaction.total || 0).toFixed(2)}\n\n(Please find the bill attached)`;
        const whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
        window.open(whatsappUrl, '_blank');
    };

    const customerAddress = customer ? [customer.address, customer.area, customer.district, customer.state, customer.pincode].filter(Boolean).join(', ') : '';

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Review Invoice #${transaction.id}`}>
            <div className="flex-1 flex flex-col bg-[var(--modal-content-bg-light)] dark:bg-[var(--modal-content-bg-dark)] overflow-hidden font-normal">
                {transaction.status === 'cancelled' && (
                    <div className="bg-red-600 text-white p-2 font-normal text-center text-xs uppercase tracking-widest shadow-inner">
                        DOCUMENT STATUS: CANCELLED / VOID
                    </div>
                )}
                {totalReturnRefund > 0 && (
                    <div className="bg-amber-500 text-black p-2 font-black text-center text-[10px] uppercase tracking-widest shadow-inner flex items-center justify-center gap-4">
                        <span>CREDIT NOTE ISSUED: ₹{totalReturnRefund.toFixed(2)}</span>
                        <div className="h-3 w-[1px] bg-black/20" />
                        <span>ADJUSTED TOTAL: ₹{(total - totalReturnRefund).toFixed(2)}</span>
                    </div>
                )}
                
                <div className="p-6 overflow-y-auto flex-1">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                        <div className="space-y-3">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-[var(--modal-header-bg-light)] dark:bg-[var(--modal-header-bg-dark)]"></span>
                                <h4 className="text-[11px] font-normal uppercase tracking-widest text-gray-400">Invoice Information</h4>
                            </div>
                            <div className="grid grid-cols-2 gap-4 text-sm bg-[var(--modal-bg-light)] dark:bg-[var(--modal-bg-dark)] p-4 rounded-xl border border-app-border shadow-sm font-normal text-app-text-primary">
                                <div><span className="block text-[10px] font-normal text-gray-500 uppercase">Invoice ID</span> <span className="font-mono">{transaction.id}</span></div>
                                <div><span className="block text-[10px] font-normal text-gray-500 uppercase">Date</span> <span>{new Date(transaction.date).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
                                {transaction.paymentMode && <div><span className="block text-[10px] font-normal text-gray-500 uppercase">Pay Mode</span> <span className="text-[var(--modal-header-bg-light)] dark:text-[var(--modal-header-bg-dark)]">{transaction.paymentMode}</span></div>}
                                {transaction.referredBy && <div><span className="block text-[10px] font-normal text-gray-500 uppercase">Referred By</span> <span className="truncate" title={transaction.referredBy}>{transaction.referredBy}</span></div>}
                                {narration && <div className="col-span-2 mt-2 pt-2 border-t border-gray-100 dark:border-gray-800"><span className="block text-[10px] font-normal text-gray-500 uppercase">Narration / Notes</span> <p className="text-xs italic text-gray-600 dark:text-gray-400 mt-1 whitespace-pre-wrap">{narration}</p></div>}
                            </div>
                        </div>

                        <div className="space-y-3">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                                <h4 className="text-[11px] font-normal uppercase tracking-widest text-gray-400">Customer Details</h4>
                            </div>
                            <div className="text-sm bg-blue-50/50 dark:bg-blue-900/10 p-4 rounded-xl border border-blue-100 dark:border-blue-800 shadow-sm font-normal text-app-text-primary">
                                <div className="flex justify-between items-start mb-3">
                                    <div>
                                        <p className="text-gray-950 dark:text-white text-lg leading-none uppercase tracking-tighter">{transaction.customerName}</p>
                                        <p className="text-xs font-normal text-blue-600 dark:text-blue-400 mt-1.5 flex items-center">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                                            {transaction.customerPhone || 'WALK-IN CUSTOMER'}
                                        </p>
                                    </div>
                                    {customer?.customerType === 'retail' && (
                                        <span className="px-2 py-0.5 bg-blue-100 text-blue-800 text-[10px] font-normal rounded-lg border border-blue-200 uppercase tracking-widest">Retailer</span>
                                    )}
                                </div>
                                
                                {customer && (
                                    <div className="mt-2 pt-3 border-t border-blue-100/50 grid grid-cols-1 md:grid-cols-2 gap-3">
                                        {customerAddress && (
                                            <div className="col-span-1 md:col-span-2">
                                                <p className="text-[10px] font-normal text-gray-500 uppercase tracking-widest mb-0.5 opacity-60">Location Details</p>
                                                <p className="text-[11px] text-gray-700 dark:text-gray-300 leading-snug">
                                                    {customerAddress}
                                                </p>
                                            </div>
                                        )}
                                        {customer.gstNumber ? (
                                            <div>
                                                <p className="text-[10px] font-normal text-gray-500 uppercase tracking-widest mb-0.5 opacity-60">GSTIN</p>
                                                <p className="text-xs font-mono text-emerald-600">{customer.gstNumber}</p>
                                            </div>
                                        ) : customer.panNumber ? (
                                            <div>
                                                <p className="text-[10px] font-normal text-gray-500 uppercase tracking-widest mb-0.5 opacity-60">PAN</p>
                                                <p className="text-xs font-mono text-emerald-600">{customer.panNumber}</p>
                                            </div>
                                        ) : null}
                                        {customer.drugLicense && (
                                            <div>
                                                <p className="text-[10px] font-normal text-gray-500 uppercase tracking-widest mb-0.5 opacity-60">Drug License</p>
                                                <p className="text-xs font-mono text-indigo-600">{customer.drugLicense}</p>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="overflow-hidden border border-app-border rounded-2xl mb-6 shadow-md bg-white">
                      <table className="min-w-full divide-y divide-gray-200 text-sm">
                          <thead className="bg-slate-50 sticky top-0"><tr>
                              <th className="py-4 px-6 text-left font-normal uppercase text-[10px] tracking-[0.2em] text-gray-400">Product Item Description</th>
                              <th className="py-4 px-2 text-center font-normal uppercase text-[10px] tracking-[0.2em] text-gray-400 w-40">Qty</th>
                              <th className="py-4 px-2 text-right font-normal uppercase text-[10px] tracking-[0.2em] text-gray-400 w-28">Line Rate</th>
                              <th className="py-4 px-2 text-center font-normal uppercase text-[10px] tracking-[0.2em] text-gray-400 w-20">Disc%</th>
                              <th className="py-4 px-6 text-right font-normal uppercase text-[10px] tracking-[0.2em] text-gray-900 w-40">Amount</th>
                          </tr></thead>
                          <tbody className="divide-y divide-gray-200 bg-white">
                              {items.map(item => {
                                  const key = item.inventoryItemId || item.id || item.name;
                                  const returnedQty = returnedQtyMap.get(key) || 0;
                                  const originalQty = item.quantity;
                                  const netQty = Math.max(0, originalQty - returnedQty);

                                  return (
                                    <tr key={item.id} className="hover:bg-[var(--modal-content-bg-light)]/[var(--modal-opacity-low)] transition-colors font-normal">
                                        <td className="p-6">
                                            <span className="text-gray-950 block text-base leading-none mb-1">{getItemDisplayName(item)}</span>
                                            <div className="text-[11px] text-gray-400 font-normal uppercase tracking-widest flex items-center gap-2">
                                                <span className="px-1.5 py-0.5 bg-slate-100 rounded border border-slate-200 text-slate-500 font-mono">BATCH: {item.batch}</span>
                                                <span className="px-1.5 py-0.5 bg-blue-50 rounded border border-blue-100 text-blue-500">EXP: {item.expiry}</span>
                                            </div>
                                        </td>
                                        <td className="p-2 text-center">
                                            <div className="flex flex-col items-center">
                                                <span className="text-base text-gray-900">{formatPackLooseQuantity(item.quantity, item.looseQuantity || 0, item.freeQuantity)}</span>
                                                {returnedQty > 0 && (
                                                    <span className="text-[9px] font-black text-red-500 uppercase">
                                                        ({originalQty} - {returnedQty} Ret)
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-2 text-right text-gray-600 text-base">₹{(item.taxBasis === 'I-Incl.MRP' ? (item.mrp || 0) : (item.rate || item.mrp || 0)).toFixed(2)}</td>
                                        <td className="p-2 text-center text-blue-600 text-sm">{(item.discountPercent || 0)}%</td>
                                        <td className="p-6 text-right text-lg text-gray-950">
                                            ₹{(() => {
                                                const uPP = item.unitsPerPack || 1;
                                                const tU = (netQty * uPP) + (item.looseQuantity || 0);
                                                const uR = (item.taxBasis === 'I-Incl.MRP' ? (item.mrp || 0) : (item.rate || item.mrp || 0)) / uPP;
                                                const gross = (uR * tU);
                                                if (posLineAmountMode === 'excluding_discount') return gross;
                                                return gross * (1 - (item.discountPercent || 0) / 100);
                                            })().toFixed(2)}
                                        </td>
                                    </tr>
                                  );
                              })}
                              {items.length === 0 && (
                                  <tr>
                                      <td colSpan={5} className="p-12 text-center text-gray-400 font-normal uppercase tracking-widest">No items found in this invoice</td>
                                  </tr>
                              )}
                          </tbody>
                      </table>
                    </div>

                    {allPrescriptions.length > 0 && (
                        <div className="mt-8 pt-6 border-t border-app-border">
                            <div className="flex items-center gap-2 mb-6">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
                                <h4 className="text-xs font-normal uppercase tracking-[0.25em] text-gray-400">Supporting Documents / Rx ({allPrescriptions.length})</h4>
                            </div>
                            <div className="flex gap-6 overflow-x-auto pb-6 custom-scrollbar">
                                {allPrescriptions.map((url, index) => {
                                    const isPdf = url.startsWith('data:application/pdf');
                                    return (
                                        <div key={index} className="flex-shrink-0 flex flex-col items-center">
                                            <div className="bg-white dark:bg-gray-800 border-2 border-app-border rounded-2xl p-2 w-48 h-48 flex items-center justify-center overflow-hidden shadow-sm hover:shadow-xl transition-all cursor-pointer group relative">
                                                {isPdf ? (
                                                    <div className="flex flex-col items-center justify-center text-gray-500">
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-2 text-red-500"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                                                        <span className="text-xs font-normal uppercase tracking-widest">Patient PDF</span>
                                                    </div>
                                                ) : (
                                                    <img src={url} alt={`Prescription ${index + 1}`} className="w-full h-full object-cover rounded-xl group-hover:scale-110 transition-transform duration-500" />
                                                )}
                                                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity rounded-xl backdrop-blur-sm">
                                                    <button onClick={() => window.open(url, '_blank')} className="bg-white p-3 rounded-full shadow-2xl text-[var(--modal-header-bg-light)] dark:text-[var(--modal-header-bg-dark)] transform active:scale-90 transition-transform">
                                                        <EyeIcon className="w-6 h-6" />
                                                    </button>
                                                </div>
                                            </div>
                                            <button onClick={() => handleDownloadPrescription(url, index)} className="mt-3 text-xs font-normal text-gray-500 hover:text-[var(--modal-header-bg-light)] dark:hover:text-[var(--modal-header-bg-dark)] flex items-center gap-2 uppercase tracking-widest transition-colors"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Download Copy</button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex flex-col md:flex-row justify-between items-center p-8 bg-[var(--modal-footer-bg-light)] dark:bg-[var(--modal-footer-bg-dark)] border-t border-[var(--modal-footer-border-light)] dark:border-[var(--modal-footer-border-dark)] gap-8 flex-shrink-0 z-20 shadow-[0_-10px_40px_-20px_rgba(0,0,0,0.1)]">
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-y-2 gap-x-12 w-full md:w-auto">
                        <div><span className="block text-[10px] font-normal text-gray-400 uppercase tracking-widest leading-none mb-1.5 opacity-60">Base Value</span><span className="text-gray-900 dark:text-white text-lg">₹{(displaySubtotal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
                        <div><span className="block text-[10px] font-normal text-gray-400 uppercase tracking-widest leading-none mb-1.5 opacity-60">GST (Tax)</span><span className="text-gray-900 dark:text-white text-lg">₹{(displayGst || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
                        <div><span className="block text-[10px] font-normal text-gray-400 uppercase tracking-widest leading-none mb-1.5 opacity-60">Savings</span><span className="text-emerald-600 text-lg">₹{(displayItemDiscount + (schemeDiscount || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
                        <div><span className="block text-[10px] font-normal text-gray-400 uppercase tracking-widest leading-none mb-1.5 opacity-60">Adjustment</span><span className="text-indigo-600 text-lg">₹{(adjustment || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
                        <div className="flex items-baseline gap-4 md:col-span-1 pt-0"><span className="text-[10px] font-normal text-gray-400 uppercase tracking-widest opacity-60">Net Payable</span><span className="text-4xl font-normal text-[var(--modal-header-bg-light)] dark:text-[var(--modal-header-bg-dark)] leading-none tracking-tighter">₹{(total - totalReturnRefund || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
                    </div>
                    <div className="flex items-center space-x-3 w-full md:w-auto flex-shrink-0">
                        {transaction.customerPhone && (
                            <button onClick={handleWhatsAppShare} className="flex-1 md:flex-none px-6 py-4 text-xs font-normal uppercase tracking-[0.2em] text-green-700 bg-green-50 border-2 border-green-200 rounded-2xl shadow-sm hover:bg-green-100 flex items-center justify-center transition-all active:scale-95"><svg viewBox="0 0 24 24" width="18" height="18" className="mr-3 fill-current"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.711 2.592 2.654-.696c1.001.572 1.973.911 3.03.911h.001c3.187 0 5.767-2.586 5.768-5.766.001-3.187-2.575-5.77-5.993-5.794zm-5.444 7.371l-.148-.235c-.715-1.132-.952-2.09-.952-3.233 0-4.914 6.353-7.796 9.641-4.509 1.637 1.636 2.538 3.813 2.537 6.129 0 4.771-5.83 7.208-9.049 4.316l-.23-.207-2.008.526.746-2.608zm10.296 2.367c-.289-.145-1.711-.845-1.975-.941-.266-.097-.459-.145-.651.145-.193.29-.748.941-.917 1.135-.169.193-.337.217-.626.072-1.427-.714-2.365-1.554-3.322-3.205-.121-.208-.013-.319.13-.464.13-.132.289-.338.434-.507.145-.169.193-.29.289-.483.096-.193.048-.362-.024-.507-.072-.145-.651-1.569-.892-2.15-.233-.563-.473-.486-.651-.496-.168-.009-.361-.009-.554-.009-.193 0-.506.072-.771.362-.265.29-1.011.99-1.011 2.415 0 1.425 1.036 2.799 1.181 3.016.145.217 2.016 3.106 4.931 4.329 1.976.83 2.76.897 3.73.837.781-.048 1.711-.7 1.952-1.375.241-.676.241-1.255.169-1.375-.072-.121-.265-.193-.554-.338z"/></svg>WhatsApp</button>
                        )}
                        <button onClick={() => onProcessReturn(transaction.id)} disabled={transaction.status === 'cancelled'} className="flex-1 md:flex-none px-8 py-4 text-xs font-normal uppercase tracking-[0.2em] text-gray-700 bg-white border-2 border-gray-200 rounded-2xl shadow-sm hover:bg-gray-50 disabled:opacity-50 transition-all active:scale-95">Initiate Return</button>
                        <button onClick={() => setIsJournalOpen(true)} className="flex-1 md:flex-none px-8 py-4 text-xs font-normal uppercase tracking-[0.2em] text-indigo-700 bg-indigo-50 border-2 border-indigo-200 rounded-2xl shadow-sm hover:bg-indigo-100 transition-all active:scale-95">View Journal Entry</button>
                        <button onClick={() => onPrintBill(transaction)} disabled={transaction.status === 'cancelled'} className="flex-1 md:flex-none px-12 py-4 text-sm font-normal uppercase tracking-[0.2em] text-white bg-[var(--modal-header-bg-light)] dark:bg-[var(--modal-header-bg-dark)] rounded-2xl shadow-xl shadow-primary/30 hover:bg-primary-dark transition-all transform active:scale-95">Print Bill</button>
                    </div>
                </div>

                <JournalEntryViewerModal
                    isOpen={isJournalOpen}
                    onClose={() => setIsJournalOpen(false)}
                    invoiceId={transaction.id}
                    invoiceNumber={transaction.id}
                    documentType="SALES"
                    currentUser={currentUser || null}
                    isPosted={transaction.status === 'completed'}
                />
            </div>
        </Modal>
    );
};

const EyeIcon = (props: any) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
);

export default TransactionDetailModal;
