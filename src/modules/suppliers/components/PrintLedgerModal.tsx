import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Distributor, RegisteredPharmacy } from '@core/types';
import { numberToWords } from '@core/utils/numberToWords';
import { formatVoucherNo } from '@core/utils/helpers';
import { useOfflineAsset } from '@core/hooks/useOfflineAsset';

declare const html2pdf: any;

interface PrintLedgerModalProps {
  isOpen: boolean;
  onClose: () => void;
  distributor: Distributor | null;
  pharmacy: RegisteredPharmacy | null;
}

const PrintLedgerModal: React.FC<PrintLedgerModalProps> = ({ isOpen, onClose, distributor, pharmacy }) => {
  const logoUrl = useOfflineAsset(pharmacy?.pharmacy_logo_url);
  const [pageSize, setPageSize] = useState<'a4' | 'a5'>('a4');

  useEffect(() => {
    if (isOpen && distributor) {
      const originalTitle = document.title;
      document.title = `Ledger_${distributor.name.replace(/[^a-z0-9]/gi, '_')}`;
      
      const printTimeout = setTimeout(() => {
        window.print();
        setTimeout(() => { document.title = originalTitle; }, 1000);
      }, 300);

      return () => clearTimeout(printTimeout);
    }
  }, [isOpen, distributor]);

  if (!isOpen || !distributor || !pharmacy) return null;

  const handleDownloadPdf = async () => {
    if (typeof html2pdf === 'undefined') {
        alert("PDF library not loaded.");
        return;
    }
    const element = document.getElementById('ledger-print-area');
    const opt = {
        margin: 10,
        filename: `Ledger_${distributor.name}.pdf`,
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

  const balance = distributor.ledger?.[distributor.ledger.length - 1]?.balance || 0;
  const isA5 = pageSize === 'a5';

  return createPortal(
    <div id="print-distributor-ledger-modal-container" className="fixed inset-0 bg-black/60 z-[1000] flex justify-center items-center backdrop-blur-sm print:bg-white print:p-0 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-5xl flex flex-col max-h-[95vh] print:max-h-none print:shadow-none print:rounded-none">
        <div className="flex justify-between items-center p-4 border-b no-print bg-white sticky top-0 z-10">
          <h3 className="text-lg font-bold text-gray-800 uppercase tracking-tighter">Supplier Ledger Statement</h3>
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
          <div id="ledger-print-area" className={`bg-white shadow-sm mx-auto print:shadow-none min-h-[297mm] w-full text-black font-sans ${isA5 ? 'p-6 max-w-[148mm] min-h-[210mm]' : 'p-12 max-w-[210mm] min-h-[297mm]'}`}>
            <div className="flex flex-col items-center border-b-2 border-black pb-4 mb-6 text-center">
                {logoUrl && (
                    <img src={logoUrl} alt="Logo" className={`${isA5 ? 'w-12 h-12 mb-2' : 'w-20 h-20 mb-3'} object-contain border border-gray-100 rounded bg-gray-50 p-1`} />
                )}
                <h1 className={`${isA5 ? 'text-lg' : 'text-2xl'} font-black uppercase text-black leading-none`}>{pharmacy.pharmacy_name}</h1>
                <p className={`${isA5 ? 'text-[9px] mt-1' : 'text-xs mt-2'} opacity-80 max-w-lg`}>{pharmacy.address}</p>
                <div className={`${isA5 ? 'text-[8px] mt-1' : 'text-[10px] mt-2'} font-bold flex gap-4 justify-center`}>
                    {pharmacy.gstin && <p>GSTIN: {pharmacy.gstin}</p>}
                    {pharmacy.mobile && <p>Phone: {pharmacy.mobile}</p>}
                </div>
                
                <div className="w-full flex justify-between items-center mt-4 pt-2 border-t border-dashed border-black">
                    <h2 className={`${isA5 ? 'text-[10px] px-2 py-0.5' : 'text-xs px-3 py-0.5'} font-black uppercase tracking-widest bg-black text-white`}>Ledger Statement</h2>
                    <p className={`${isA5 ? 'text-[8px]' : 'text-[10px]'} font-bold`}>Print Date: {new Date().toLocaleDateString('en-GB')}</p>
                </div>
            </div>

            <div className="bg-gray-100 p-4 border border-black mb-6">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <span className={`${isA5 ? 'text-[8px]' : 'text-[9px]'} font-black text-gray-500 uppercase tracking-widest block mb-1`}>Account Ledger of:</span>
                        <p className={`${isA5 ? 'text-sm' : 'text-lg'} font-black uppercase text-black`}>{distributor.name}</p>
                        {distributor.address && <p className={`${isA5 ? 'text-[8px] mt-0.5' : 'text-[10px] mt-1'} opacity-70`}>{distributor.address}</p>}
                        {distributor.gst_number && <p className={`${isA5 ? 'text-[8px] mt-0.5' : 'text-[10px] mt-1'} font-bold`}>GSTIN: {distributor.gst_number}</p>}
                    </div>
                    <div className="text-right">
                        <span className={`${isA5 ? 'text-[8px]' : 'text-[9px]'} font-black text-gray-500 uppercase tracking-widest block mb-1`}>Current Balance:</span>
                        <p className={`font-black ${isA5 ? 'text-lg' : 'text-2xl'} ${balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>₹{balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                        <p className={`${isA5 ? 'text-[8px]' : 'text-[9px]'} font-bold uppercase mt-1 italic text-gray-500`}>
                            ({balance > 0 ? 'Payable' : 'Advance/Cleared'})
                        </p>
                    </div>
                </div>
            </div>

            <table className={`w-full border-collapse border border-black mb-8 ${isA5 ? 'text-[9px]' : 'text-xs'}`}>
                <thead>
                    <tr className="bg-gray-200 font-black uppercase border-b border-black">
                        <th className={`${isA5 ? 'p-1 w-20' : 'p-2 w-24'} border-r border-black text-left`}>Date</th>
                        <th className={`${isA5 ? 'p-1' : 'p-2'} border-r border-black text-left`}>Particulars</th>
                        <th className={`${isA5 ? 'p-1 w-24' : 'p-2 w-32'} border-r border-black text-right`}>Billed (+)</th>
                        <th className={`${isA5 ? 'p-1 w-24' : 'p-2 w-32'} border-r border-black text-right`}>Paid (-)</th>
                        <th className={`${isA5 ? 'p-1 w-24' : 'p-2 w-32'} text-right`}>Balance</th>
                    </tr>
                </thead>
                <tbody>
                    {(distributor.ledger || []).map((entry, idx) => (
                        <tr key={entry.id} className="border-b border-gray-300 last:border-b-0">
                            <td className={`${isA5 ? 'p-1' : 'p-2'} border-r border-black align-top`}>{new Date(entry.date).toLocaleDateString('en-GB')}</td>
                            <td className={`${isA5 ? 'p-1' : 'p-2'} border-r border-black font-semibold uppercase`}>
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
                            <td className={`${isA5 ? 'p-1' : 'p-2'} border-r border-black text-right font-bold text-red-700`}>{entry.credit > 0 ? entry.credit.toFixed(2) : '-'}</td>
                            <td className={`${isA5 ? 'p-1' : 'p-2'} border-r border-black text-right font-bold text-emerald-700`}>{entry.debit > 0 ? entry.debit.toFixed(2) : '-'}</td>
                            <td className={`${isA5 ? 'p-1' : 'p-2'} text-right font-black bg-gray-50`}>₹{entry.balance.toFixed(2)}</td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr className="border-t-2 border-black bg-gray-100 font-black">
                        <td colSpan={2} className={`${isA5 ? 'p-1' : 'p-2'} text-right`}>CLOSING BALANCE</td>
                        <td className={`${isA5 ? 'p-1' : 'p-2'} border-l border-black text-right text-red-700`}>₹{(distributor.ledger?.reduce((s, e) => s + (e.credit || 0), 0) || 0).toFixed(2)}</td>
                        <td className={`${isA5 ? 'p-1' : 'p-2'} border-l border-black text-right text-emerald-700`}>₹{(distributor.ledger?.reduce((s, e) => s + (e.debit || 0), 0) || 0).toFixed(2)}</td>
                        <td className={`${isA5 ? 'p-1' : 'p-2'} border-l border-black text-right`}>₹{balance.toFixed(2)}</td>
                    </tr>
                </tfoot>
            </table>

            <div className={`${isA5 ? 'mb-6 pt-2' : 'mb-12 pt-4'} border-t border-dashed border-black`}>
                <p className={`${isA5 ? 'text-[8px]' : 'text-[10px]'} font-bold`}>Amount in Words:</p>
                <p className={`${isA5 ? 'text-[9px]' : 'text-[11px]'} font-black italic uppercase text-gray-800`}>{numberToWords(Math.abs(balance))}</p>
            </div>

            <div className={`${isA5 ? 'mt-12' : 'mt-24'} flex justify-between items-end`}>
                <div className={`${isA5 ? 'text-[7px]' : 'text-[9px]'} text-gray-400 font-bold uppercase italic`}>
                    <p>This is system-generated; no signature is required.</p>
                    <p>E.&O.E.</p>
                </div>
                <div className={`${isA5 ? 'w-48 pt-1' : 'w-64 pt-2'} text-center border-t-2 border-black`}>
                    <p className={`${isA5 ? 'text-[8px] mb-0.5' : 'text-[10px] mb-1'} font-black uppercase`}>{pharmacy.full_name}</p>
                    <p className={`${isA5 ? 'text-[7px]' : 'text-[8px]'} font-bold text-gray-500 uppercase tracking-widest`}>Authorized Signatory</p>
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
          #print-distributor-ledger-modal-container {
              position: absolute !important;
              left: 0 !important;
              top: 0 !important;
              width: 100% !important;
              height: auto !important;
              overflow: visible !important;
              display: block !important;
          }
          #print-distributor-ledger-modal-container > div {
              width: auto !important;
              max-width: none !important;
              max-height: none !important;
              height: auto !important;
              overflow: visible !important;
          }
          #print-distributor-ledger-modal-container * {
              overflow: visible !important;
          }
          #ledger-print-area { 
              padding: ${isA5 ? '8mm 10mm' : '15mm 20mm'} !important; 
              width: 100% !important; 
              max-width: none !important; 
          }
          .a5-container { padding: 0 !important; margin: 0 !important; }
          body > *:not(#print-distributor-ledger-modal-container) {
              display: none !important;
          }
        }
      `}</style>
    </div>,
    document.body
  );
};

export default PrintLedgerModal;
