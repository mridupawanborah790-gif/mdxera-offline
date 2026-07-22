import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Customer, RegisteredPharmacy } from '@core/types';
import { numberToWords } from '@core/utils/numberToWords';
import { formatVoucherNo } from '@core/utils/helpers';
import { useOfflineAsset } from '@core/hooks/useOfflineAsset';

declare const html2pdf: any;

interface PrintCustomerLedgerModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer: Customer | null;
  pharmacy: RegisteredPharmacy | null;
}

const PrintCustomerLedgerModal: React.FC<PrintCustomerLedgerModalProps> = ({ isOpen, onClose, customer, pharmacy }) => {
  const logoUrl = useOfflineAsset(pharmacy?.pharmacy_logo_url);
  const [pageSize, setPageSize] = useState<'a4' | 'a5'>('a4');

  useEffect(() => {
    if (isOpen && customer) {
      const originalTitle = document.title;
      document.title = `Ledger_Customer_${customer.name.replace(/[^a-z0-9]/gi, '_')}`;
      
      const printTimeout = setTimeout(() => {
        window.print();
        setTimeout(() => { document.title = originalTitle; }, 1000);
      }, 300);

      return () => clearTimeout(printTimeout);
    }
  }, [isOpen, customer]);

  if (!isOpen || !customer || !pharmacy) return null;

  const handleDownloadPdf = async () => {
    if (typeof html2pdf === 'undefined') {
        alert("PDF library not loaded.");
        return;
    }
    const element = document.getElementById('customer-ledger-print-area');
    const opt = {
        margin: 10,
        filename: `Customer_Ledger_${customer.name}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: pageSize, orientation: 'portrait' }
    };
    try {
        await html2pdf().set(opt).from(element).save();
    } catch (e) {
        console.error(e);
    }
  };

  const balance = customer.ledger?.[customer.ledger.length - 1]?.balance || 0;
  const isA5 = pageSize === 'a5';

  return createPortal(
    <div id="print-customer-ledger-modal-container" className="fixed inset-0 bg-black/60 z-[1000] flex justify-center items-center backdrop-blur-sm print:bg-white print:p-0 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-5xl flex flex-col max-h-[95vh] print:max-h-none print:shadow-none print:rounded-none">
        <div className="flex justify-between items-center p-4 border-b no-print bg-white sticky top-0 z-10">
          <h3 className="text-lg font-bold text-gray-800 uppercase tracking-tighter">Customer Account Statement</h3>
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
              <button onClick={handleDownloadPdf} className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-xs font-bold uppercase border border-gray-300">Save PDF</button>
              <button onClick={() => window.print()} className="px-4 py-2 bg-primary text-white rounded text-xs font-bold uppercase shadow-lg">Print</button>
              <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-50 p-8 print:p-0 print:bg-white">
          <div id="customer-ledger-print-area" className={`bg-white shadow-sm mx-auto print:shadow-none min-h-[297mm] w-full text-black font-sans ${isA5 ? 'p-3 max-w-[148mm] min-h-[210mm]' : 'p-5 max-w-[210mm] min-h-[297mm]'}`}>
            <div className="flex flex-col items-center border-b-2 border-black pb-3 mb-4 text-center">
                {logoUrl && (
                    <img src={logoUrl} alt="Logo" className={`${isA5 ? 'w-10 h-10 mb-1' : 'w-16 h-16 mb-2'} object-contain border border-gray-100 rounded bg-gray-50 p-1`} />
                )}
                <h1 className={`${isA5 ? 'text-base' : 'text-xl'} font-black uppercase text-black leading-none`}>{pharmacy.pharmacy_name}</h1>
                <p className={`${isA5 ? 'text-[8px] mt-0.5' : 'text-xs mt-1'} opacity-80 max-w-lg`}>{pharmacy.address}</p>
                <div className={`${isA5 ? 'text-[8px] mt-0.5' : 'text-[10px] mt-1'} font-bold flex gap-4 justify-center`}>
                    {pharmacy.gstin && <p>GSTIN: {pharmacy.gstin}</p>}
                    {pharmacy.mobile && <p>Phone: {pharmacy.mobile}</p>}
                </div>
                
                <div className="w-full flex justify-between items-center mt-3 pt-1.5 border-t border-dashed border-gray-300">
                    <h2 className={`${isA5 ? 'text-[9px] px-1.5 py-0.5' : 'text-xs px-2.5 py-0.5'} font-black uppercase tracking-widest bg-black text-white`}>Account Statement</h2>
                    <p className={`${isA5 ? 'text-[8px]' : 'text-[10px]'} font-bold`}>Print Date: {new Date().toLocaleDateString('en-GB')}</p>
                </div>
            </div>

            <div className="bg-slate-50 p-3 border border-black mb-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <span className={`${isA5 ? 'text-[8px]' : 'text-[9px]'} font-black text-gray-500 uppercase tracking-widest block mb-0.5`}>Customer Account:</span>
                        <p className={`${isA5 ? 'text-xs' : 'text-base'} font-black uppercase text-black`}>{customer.name}</p>
                        {customer.address && <p className={`${isA5 ? 'text-[8px] mt-0.5' : 'text-[10px] mt-0.5'} opacity-70`}>{customer.address}, {customer.area}</p>}
                        {customer.phone && <p className={`${isA5 ? 'text-[8px] mt-0.5' : 'text-[10px] mt-0.5'} font-bold`}>Phone: {customer.phone}</p>}
                        {customer.gstNumber && <p className={`${isA5 ? 'text-[8px] mt-0.5' : 'text-[10px] mt-0.5'} font-bold`}>GSTIN: {customer.gstNumber}</p>}
                    </div>
                    <div className="text-right">
                        <span className={`${isA5 ? 'text-[8px]' : 'text-[9px]'} font-black text-gray-500 uppercase tracking-widest block mb-0.5`}>Current Outstanding:</span>
                        <p className={`font-black ${isA5 ? 'text-base' : 'text-xl'} ${balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>₹{balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                        <p className={`${isA5 ? 'text-[8px]' : 'text-[9px]'} font-bold uppercase mt-0.5 italic text-gray-500`}>
                            ({balance > 0 ? 'Debit Balance' : 'Clear/Advance'})
                        </p>
                    </div>
                </div>
            </div>

            <table className={`w-full border-collapse border border-black mb-6 ${isA5 ? 'text-[8px]' : 'text-[11px]'}`}>
                <thead>
                    <tr className="bg-gray-100 font-black uppercase border-b border-black">
                        <th className={`${isA5 ? 'py-1 px-1 w-16' : 'py-1.5 px-2 w-20'} border-r border-black text-left`}>Date</th>
                        <th className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} border-r border-black text-left`}>Particulars</th>
                        <th className={`${isA5 ? 'py-1 px-1 w-16' : 'py-1.5 px-2 w-24'} border-r border-black text-right`}>Debit (+)</th>
                        <th className={`${isA5 ? 'py-1 px-1 w-16' : 'py-1.5 px-2 w-24'} border-r border-black text-right`}>Credit (-)</th>
                        <th className={`${isA5 ? 'py-1 px-1 w-20' : 'py-1.5 px-2 w-24'} text-right`}>Balance</th>
                    </tr>
                </thead>
                <tbody>
                    {(customer.ledger || []).map((entry, idx) => (
                        <tr key={entry.id} className="border-b border-gray-300 last:border-b-0">
                            <td className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} border-r border-black align-top whitespace-nowrap`}>{new Date(entry.date).toLocaleDateString('en-GB')}</td>
                            <td className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} border-r border-black font-semibold uppercase leading-tight`}>
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
                            </td>
                            <td className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} border-r border-black text-right font-bold text-red-700 whitespace-nowrap`}>{entry.debit > 0 ? entry.debit.toFixed(2) : '-'}</td>
                            <td className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} border-r border-black text-right font-bold text-emerald-700 whitespace-nowrap`}>{entry.credit > 0 ? entry.credit.toFixed(2) : '-'}</td>
                            <td className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} text-right font-black bg-gray-50 whitespace-nowrap`}>₹{entry.balance.toFixed(2)}</td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr className="border-t-2 border-black bg-gray-100 font-black">
                        <td colSpan={2} className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} text-right`}>CLOSING BALANCE</td>
                        <td className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} border-l border-black text-right text-red-700`}>₹{(customer.ledger?.reduce((s, e) => s + (e.debit || 0), 0) || 0).toFixed(2)}</td>
                        <td className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} border-l border-black text-right text-emerald-700`}>₹{(customer.ledger?.reduce((s, e) => s + (e.credit || 0), 0) || 0).toFixed(2)}</td>
                        <td className={`${isA5 ? 'py-1 px-1' : 'py-1.5 px-2'} border-l border-black text-right`}>₹{balance.toFixed(2)}</td>
                    </tr>
                </tfoot>
            </table>

            <div className={`${isA5 ? 'mb-4 pt-1.5' : 'mb-8 pt-2'} border-t border-dashed border-black`}>
                <p className={`${isA5 ? 'text-[8px]' : 'text-[10px]'} font-bold`}>Amount in Words:</p>
                <p className={`${isA5 ? 'text-[8px]' : 'text-[10px]'} font-black italic uppercase text-gray-800`}>{numberToWords(Math.abs(balance))}</p>
            </div>

            <div className={`${isA5 ? 'mt-8' : 'mt-16'} flex justify-between items-end`}>
                <div className={`${isA5 ? 'text-[7px]' : 'text-[9px]'} text-gray-400 font-bold uppercase italic`}>
                    <p>This is system-generated; no signature is required.</p>
                    <p>E.&O.E.</p>
                </div>
                <div className={`${isA5 ? 'w-40 pt-1' : 'w-56 pt-1.5'} text-center border-t-2 border-black`}>
                    <p className={`${isA5 ? 'text-[8px] mb-0.5' : 'text-[10px] mb-0.5'} font-black uppercase`}>{pharmacy.full_name}</p>
                    <p className={`${isA5 ? 'text-[7px]' : 'text-[8px]'} font-bold text-gray-500 uppercase tracking-widest`}>Authorized Signatory</p>
                </div>
            </div>
          </div>
        </div>
      </div>
      <style>{`
        @media print {
          @page {
              margin: 3mm;
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
          #print-customer-ledger-modal-container {
              position: absolute !important;
              left: 0 !important;
              top: 0 !important;
              width: 100% !important;
              height: auto !important;
              overflow: visible !important;
              display: block !important;
          }
          #print-customer-ledger-modal-container > div {
              width: auto !important;
              max-width: none !important;
              max-height: none !important;
              height: auto !important;
              overflow: visible !important;
          }
          #print-customer-ledger-modal-container * {
              overflow: visible !important;
          }
          #customer-ledger-print-area { 
              padding: ${isA5 ? '3mm 4mm' : '5mm 6mm'} !important; 
              width: 100% !important; 
              max-width: none !important; 
              min-height: 0 !important; 
          }
          body > *:not(#print-customer-ledger-modal-container) {
              display: none !important;
          }
        }
      `}</style>
    </div>,
    document.body
  );
};

export default PrintCustomerLedgerModal;