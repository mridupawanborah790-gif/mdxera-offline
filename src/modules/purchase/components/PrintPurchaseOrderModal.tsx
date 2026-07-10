import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { PurchaseOrder, Distributor, RegisteredPharmacy, AppConfigurations } from '@core/types';
import PurchaseOrderTemplate from '@modules/pos/components/invoice-templates/PurchaseOrderTemplate';
import { sendWhatsappInvoiceViaAiSensy } from '../../../../services/whatsappService';
import { supabase } from '@core/db/supabaseClient';
import { cacheRemoteAsset } from '@core/utils/assetCache';

// Declare html2pdf for TypeScript since it's loaded via CDN
declare const html2pdf: any;

interface PrintPurchaseOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  purchaseOrder: (PurchaseOrder & { distributor: Distributor }) | null;
  pharmacy: RegisteredPharmacy | null;
  configurations?: AppConfigurations;
}

const PrintPurchaseOrderModal: React.FC<PrintPurchaseOrderModalProps> = ({ isOpen, onClose, purchaseOrder, pharmacy, configurations }) => {
  const [isSendingApi, setIsSendingApi] = useState(false);

  if (!isOpen || !purchaseOrder || !pharmacy) return null;

  const handlePrint = () => {
    window.print();
  };

  // data: URL to a base64 data URL. html2canvas cannot load tauri:// or any
  // non-HTTP(S) scheme, and may also fail on cross-origin HTTP images even
  // with useCORS:true. Converting to inline data: guarantees rendering.
  const resolveImagesInElement = async (el: HTMLElement): Promise<void> => {
    const imgs = Array.from(el.querySelectorAll<HTMLImageElement>('img[src]'));
    await Promise.allSettled(
      imgs.map(async (img) => {
        const src = img.getAttribute('src') || '';
        if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
        try {
          const base64 = await cacheRemoteAsset(src);
          img.setAttribute('src', base64);
        } catch {
          // If caching fails, remove the src so html2canvas doesn't choke on it
          img.removeAttribute('src');
        }
      })
    );
  };

  const handleWhatsAppApiSend = async () => {
    const apiKey = configurations?.displayOptions?.aisensyApiKey || "";
    const campaignName = configurations?.displayOptions?.aisensyCampaignName || "";
    const templateType = configurations?.displayOptions?.whatsappTemplateType || 'document';

    if (!apiKey) {
      alert("AiSensy API Key is not configured. Please set it in Configuration > WhatsApp API.");
      return;
    }
    if (!campaignName) {
      alert("AiSensy Campaign Name is not configured. Please set it in Configuration > WhatsApp API.");
      return;
    }

    setIsSendingApi(true);
    try {
      const mockBill = {
        customerPhone: purchaseOrder.distributor?.phone || purchaseOrder.distributor?.mobile || "",
        customerName: purchaseOrder.distributorName || purchaseOrder.distributor?.name || "Valued Partner",
        pharmacy: {
          pharmacy_name: pharmacy?.pharmacy_name || "Rx Medimart"
        },
        invoiceNumber: purchaseOrder.serialId || purchaseOrder.id,
        total: purchaseOrder.totalAmount || 0,
        date: purchaseOrder.date,
        createdAt: purchaseOrder.date
      } as any;

      if (templateType === 'text') {
        // Send via AiSensy Campaign API without PDF
        const result = await sendWhatsappInvoiceViaAiSensy(apiKey, campaignName, mockBill, undefined, 'text');
        if (result.success) {
          alert("WhatsApp message sent successfully!");
        } else {
          alert(`Failed to send WhatsApp: ${result.message || 'Unknown error'}`);
        }
      } else {
        // Document template flow
        if (typeof html2pdf === 'undefined') {
          alert("PDF generation library is not loaded. Please try printing to PDF instead.");
          return;
        }

        const invoiceNo = purchaseOrder.serialId || purchaseOrder.id;
        const element = document.getElementById('print-area');

        const opt = {
            margin: 0,
            filename: `PO_${invoiceNo}.pdf`,
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
            jsPDF: {
              unit: 'mm',
              format: 'a4',
              orientation: 'portrait'
            }
        };

        const orgId = purchaseOrder.organization_id || 'default_org';
        // Use template and timestamp in the storage path to avoid CDN/provider caching of overwritten PDFs
        const storagePath = `${orgId}/PO_${invoiceNo}_${Date.now()}.pdf`;
        console.debug('[WhatsApp PDF Flow] Starting PDF generation...', { invoiceNo, orgId, storagePath });

        // Convert images to base64 for html2canvas
        if (element) await resolveImagesInElement(element);
        
        const worker = html2pdf().set(opt).from(element).toPdf();
        const pdfBlob = await worker.output('blob').then((blob: Blob) => blob);
        console.debug('[WhatsApp PDF Flow] PDF Blob generated successfully.', { size: pdfBlob.size });

        // Upload to Supabase Storage Bucket 'invoices'
        console.debug('[WhatsApp PDF Flow] Uploading to Supabase bucket "invoices"...');
        const { error: uploadError } = await supabase.storage
          .from('invoices')
          .upload(storagePath, pdfBlob, {
            contentType: 'application/pdf',
            upsert: true
          });

        if (uploadError) {
          console.error('[WhatsApp PDF Flow] Supabase upload failed:', uploadError);
          throw new Error(`Upload to Supabase Storage failed: ${uploadError.message}`);
        }
        console.debug('[WhatsApp PDF Flow] PDF uploaded successfully to Supabase.');

        // Get Public URL
        const { data: publicUrlData } = supabase.storage
          .from('invoices')
          .getPublicUrl(storagePath);
        
        const pdfUrl = publicUrlData?.publicUrl;
        if (!pdfUrl) {
          throw new Error('Failed to generate public URL for PO PDF.');
        }
        console.debug('[WhatsApp PDF Flow] PDF Public URL:', pdfUrl);

        // Send via AiSensy Campaign API
        console.debug('[WhatsApp PDF Flow] Dispatching AiSensy campaign...', { campaignName });
        const result = await sendWhatsappInvoiceViaAiSensy(apiKey, campaignName, mockBill, pdfUrl, 'document');
        console.debug('[WhatsApp PDF Flow] AiSensy response:', result);
        if (result.success) {
          alert("WhatsApp message with PDF purchase order sent successfully!");
        } else {
          alert(`Failed to send WhatsApp: ${result.message || 'Unknown error'}`);
        }
      }
    } catch (err: any) {
      alert(`Error sending WhatsApp: ${err.message || err}`);
    } finally {
      setIsSendingApi(false);
    }
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
            {configurations?.displayOptions?.whatsappEnabled && (purchaseOrder.distributor?.phone || purchaseOrder.distributor?.mobile) && (
                <button onClick={handleWhatsAppApiSend} disabled={isSendingApi} className="px-5 py-2 text-sm font-semibold text-white bg-green-600 border border-green-700 rounded-lg shadow-sm hover:bg-green-700 flex items-center disabled:opacity-50">
                    {isSendingApi ? 'Sending ...' : 'Send through WhatsApp'}
                </button>
            )}
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
