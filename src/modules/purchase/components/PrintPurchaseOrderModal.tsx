import React from 'react';
import { createPortal } from 'react-dom';
import type { PurchaseOrder, Distributor, RegisteredPharmacy } from '@core/types';
import PurchaseOrderTemplate from '@modules/pos/components/invoice-templates/PurchaseOrderTemplate';

interface PrintPurchaseOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  purchaseOrder: (PurchaseOrder & { distributor: Distributor }) | null;
  pharmacy: RegisteredPharmacy | null;
}

const PrintPurchaseOrderModal: React.FC<PrintPurchaseOrderModalProps> = ({ isOpen, onClose, purchaseOrder, pharmacy }) => {
  if (!isOpen || !purchaseOrder || !pharmacy) return null;

  const handlePrint = () => {
    window.print();
  };

  return createPortal(
    <div id="print-po-modal-container" className="fixed inset-0 bg-black bg-opacity-60 z-[999] flex justify-center items-center backdrop-blur-sm print:bg-white print:backdrop-blur-none">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl transform transition-all flex flex-col max-h-[95vh] overflow-hidden print:max-h-none print:overflow-visible print:shadow-none print:rounded-none">
        <div className="flex justify-between items-center p-4 border-b no-print">
          <h3 className="text-lg font-semibold text-gray-800">Purchase Order Preview</h3>
          <button onClick={onClose} className="p-1 text-gray-500 rounded-full hover:bg-gray-200 hover:text-gray-800">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-100 p-4 print:p-0 print:bg-white print:overflow-visible">
          <div id="print-area" className="w-[210mm] mx-auto bg-white text-black shadow-lg print:shadow-none print:mx-0 print:w-[210mm]">
            <PurchaseOrderTemplate purchaseOrder={purchaseOrder} pharmacy={pharmacy} />
          </div>
        </div>

        <div className="flex justify-end items-center p-4 bg-gray-50 border-t no-print space-x-3">
            <button onClick={onClose} className="px-5 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50">
                Close
            </button>
            <button onClick={handlePrint} className="px-5 py-2 text-sm font-semibold text-white bg-[#35C48D] rounded-lg shadow-sm hover:bg-[#11A66C]">
                Print / Save PDF
            </button>
        </div>
      </div>

      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 0 !important;
          }

          html, body {
            margin: 0 !important;
            padding: 0 !important;
            width: 100% !important;
            height: auto !important;
            overflow: visible !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }

          #root,
          #chatbot-container,
          .notification-container {
            display: none !important;
          }

          #print-po-modal-container {
            position: static !important;
            inset: auto !important;
            display: block !important;
            width: auto !important;
            height: auto !important;
            overflow: visible !important;
            background: white !important;
          }

          #print-po-modal-container > div {
            width: auto !important;
            max-width: none !important;
            max-height: none !important;
            height: auto !important;
            margin: 0 !important;
            padding: 0 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            overflow: visible !important;
            background: white !important;
          }

          #print-area {
            width: 210mm !important;
            min-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            box-shadow: none !important;
            overflow: visible !important;
          }

          #print-po-modal-container .no-print {
            display: none !important;
          }

          #print-po-modal-container,
          #print-po-modal-container * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>
    </div>
    ,
    document.body
  );
};

export default PrintPurchaseOrderModal;
