
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Customer, RegisteredPharmacy } from '@core/types';
import { numberToWords } from '@core/utils/numberToWords';
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
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    try {
        await html2pdf().set(opt).from(element).save();
    } catch (e) {
        console.error(e);
    }
  };

  const balance = customer.ledger?.[customer.ledger.length - 1]?.balance || 0;

  return createPortal(
    <div className="fixed inset-0 bg-black/60 z-[1000] flex justify-center items-center backdrop-blur-sm print:bg-white print:p-0 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-5xl flex flex-col max-h-[95vh] print:max-h-none print:shadow-none print:rounded-none">
        <div className="flex justify-between items-center p-4 border-b no-print bg-white sticky top-0 z-10">
          <h3 className="text-lg font-bold text-gray-800 uppercase tracking-tighter">Customer Account Statement</h3>
          <div className="flex gap-2">
            <button onClick={handleDownloadPdf} className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-xs font-bold uppercase border border-gray-300">Save PDF</button>
            <button onClick={() => window.print()} className="px-4 py-2 bg-primary text-white rounded text-xs font-bold uppercase shadow-lg">Print</button>
            <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-50 p-8 print:p-0 print:bg-white">
          <div id="customer-ledger-print-area" className="bg-white p-8 shadow-sm mx-auto print:shadow-none min-h-[297mm] w-full max-w-[210mm] text-black font-sans">
            <div className="flex flex-col items-center border-b-2 border-black pb-4 mb-6 text-center">
                {logoUrl && (
                    <img src={logoUrl} alt="Logo" className="w-20 h-20 object-contain border border-gray-100 rounded bg-gray-50 p-1 mb-3" />
                )}
                <h1 className="text-2xl font-black uppercase text-black leading-none">{pharmacy.pharmacy_name}</h1>
                <p className="text-xs mt-2 opacity-80 max-w-lg">{pharmacy.address}</p>
                <div className="text-[10px] font-bold mt-2 flex gap-4 justify-center">
                    {pharmacy.gstin && <p>GSTIN: {pharmacy.gstin}</p>}
                    {pharmacy.mobile && <p>Phone: {pharmacy.mobile}</p>}
                </div>
                
                <div className="w-full flex justify-between items-center mt-4 pt-2 border-t border-dashed border-gray-300">
                    <h2 className="text-xs font-black uppercase tracking-widest bg-black text-white px-3 py-0.5">Account Statement</h2>
                    <p className="text-[10px] font-bold">Print Date: {new Date().toLocaleDateString('en-GB')}</p>
                </div>
            </div>

            <div className="bg-slate-50 p-4 border border-black mb-6">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest block mb-1">Customer Account:</span>
                        <p className="text-lg font-black uppercase text-black">{customer.name}</p>
                        {customer.address && <p className="text-[10px] mt-1 opacity-70">{customer.address}, {customer.area}</p>}
                        {customer.phone && <p className="text-[10px] font-bold mt-1">Phone: {customer.phone}</p>}
                        {customer.gstNumber && <p className="text-[10px] font-bold mt-0.5">GSTIN: {customer.gstNumber}</p>}
                    </div>
                    <div className="text-right">
                        <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest block mb-1">Current Outstanding:</span>
                        <p className={`text-2xl font-black ${balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>₹{balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                        <p className="text-[9px] font-bold uppercase mt-1 italic text-gray-500">
                            ({balance > 0 ? 'Debit Balance' : 'Clear/Advance'})
                        </p>
                    </div>
                </div>
            </div>

            <table className="w-full border-collapse border border-black text-xs mb-8">
                <thead>
                    <tr className="bg-gray-100 font-black uppercase border-b border-black">
                        <th className="p-2 border-r border-black text-left w-24">Date</th>
                        <th className="p-2 border-r border-black text-left">Particulars</th>
                        <th className="p-2 border-r border-black text-right w-32">Debit (+)</th>
                        <th className="p-2 border-r border-black text-right w-32">Credit (-)</th>
                        <th className="p-2 text-right w-32">Balance</th>
                    </tr>
                </thead>
                <tbody>
                    {(customer.ledger || []).map((entry, idx) => (
                        <tr key={entry.id} className="border-b border-gray-300 last:border-b-0">
                            <td className="p-2 border-r border-black align-top">{new Date(entry.date).toLocaleDateString('en-GB')}</td>
                            <td className="p-2 border-r border-black font-semibold uppercase">{entry.description}</td>
                            <td className="p-2 border-r border-black text-right font-bold text-red-700">{entry.debit > 0 ? entry.debit.toFixed(2) : '-'}</td>
                            <td className="p-2 border-r border-black text-right font-bold text-emerald-700">{entry.credit > 0 ? entry.credit.toFixed(2) : '-'}</td>
                            <td className="p-2 text-right font-black bg-gray-50">₹{entry.balance.toFixed(2)}</td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr className="border-t-2 border-black bg-gray-100 font-black">
                        <td colSpan={2} className="p-2 text-right">CLOSING BALANCE</td>
                        <td className="p-2 border-l border-black text-right text-red-700">₹{(customer.ledger?.reduce((s, e) => s + (e.debit || 0), 0) || 0).toFixed(2)}</td>
                        <td className="p-2 border-l border-black text-right text-emerald-700">₹{(customer.ledger?.reduce((s, e) => s + (e.credit || 0), 0) || 0).toFixed(2)}</td>
                        <td className="p-2 border-l border-black text-right">₹{balance.toFixed(2)}</td>
                    </tr>
                </tfoot>
            </table>

            <div className="mb-12 border-t border-dashed border-black pt-4">
                <p className="text-[10px] font-bold">Amount in Words:</p>
                <p className="text-[11px] font-black italic uppercase text-gray-800">{numberToWords(Math.abs(balance))}</p>
            </div>

            <div className="mt-24 flex justify-between items-end">
                <div className="text-[9px] text-gray-400 font-bold uppercase italic">
                    <p>This is system-generated; no signature is required.</p>
                    <p>E.&O.E.</p>
                </div>
                <div className="text-center w-64 border-t-2 border-black pt-2">
                    <p className="text-[10px] font-black uppercase mb-1">{pharmacy.full_name}</p>
                    <p className="text-[8px] font-bold text-gray-500 uppercase tracking-widest">Authorized Signatory</p>
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
          #customer-ledger-print-area { padding: 8mm 12mm !important; width: 100% !important; max-width: none !important; }
        }
      `}</style>
    </div>,
    document.body
  );
};

export default PrintCustomerLedgerModal;