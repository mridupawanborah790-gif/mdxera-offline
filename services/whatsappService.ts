import type { DetailedBill } from '@core/types';

/**
 * Sends a WhatsApp invoice message using the AiSensy API Campaign.
 * 
 * Target Endpoint: https://backend.aisensy.com/campaign/t1/api/v2
 * Method: POST
 * 
 * Payload structure:
 * {
 *   apiKey: string,
 *   campaignName: string,
 *   destination: string,
 *   userName: string,
 *   templateParams: string[]
 * }
 */
export const sendWhatsappInvoiceViaAiSensy = async (
    apiKey: string,
    campaignName: string,
    bill: DetailedBill & { pharmacy?: { pharmacy_name?: string } },
    pdfUrl?: string,
    templateType: 'text' | 'document' = 'document'
): Promise<{ success: boolean; message?: string }> => {
    if (!apiKey) {
        return { success: false, message: "AiSensy API Key is not configured." };
    }
    if (!campaignName) {
        return { success: false, message: "Campaign Name is not configured." };
    }

    // Format destination number: must start with country code (e.g. +91)
    const rawPhone = bill.customerDetails?.phone || bill.customerPhone || "";
    const cleanPhone = rawPhone.replace(/[^0-9]/g, '');
    
    if (!cleanPhone) {
        return { success: false, message: "Customer phone number is missing." };
    }

    // Default to +91 (India) if no country code prefix exists, or if length is exactly 10 digits
    const destination = cleanPhone.length === 10 ? `+91${cleanPhone}` : `+${cleanPhone}`;

    // Get customer name, fallback to 'Valued Customer'
    const userName = (bill.customerName || bill.customerDetails?.name || "Valued Customer").trim();

    // Get pharmacy name, fallback to a standard name
    const pharmacyName = (bill.pharmacy?.pharmacy_name || "Rx Medimart").trim();

    // Format invoice number
    const invoiceNo = bill.invoiceNumber || bill.id;

    // Format total amount
    const totalAmount = `₹${(bill.total || 0).toFixed(2)}`;

    // Format bill date (needed only for text template)
    let formattedDate = '';
    if (templateType === 'text') {
        try {
            const dateObj = new Date(bill.createdAt || bill.date || Date.now());
            if (!isNaN(dateObj.getTime())) {
                const day = String(dateObj.getDate()).padStart(2, '0');
                const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                const year = dateObj.getFullYear();
                formattedDate = `${day}-${month}-${year}`;
            } else {
                formattedDate = String(bill.createdAt || bill.date || '');
            }
        } catch {
            formattedDate = String(bill.createdAt || bill.date || '');
        }
    }

    let templateParams: string[] = [];
    if (templateType === 'text') {
        // Text template: {{1}} Customer, {{2}} Pharmacy, {{3}} Invoice, {{4}} Total, {{5}} Date
        templateParams = [
            userName,
            pharmacyName,
            invoiceNo,
            totalAmount,
            formattedDate
        ];
    } else {
        // Document template: {{1}} Customer, {{2}} Pharmacy, {{3}} Invoice, {{4}} Total
        templateParams = [
            userName,
            pharmacyName,
            invoiceNo,
            totalAmount
        ];
    }

    const payload: Record<string, any> = {
        apiKey,
        campaignName,
        destination,
        userName,
        templateParams,
    };

    if (templateType === 'document' && pdfUrl) {
        payload.media = {
            url: pdfUrl,
            filename: `Invoice_${invoiceNo}.pdf`
        };
    }

    try {
        const response = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            console.error('[WhatsApp Service Error]', response.status, errorDetails);
            return { 
                success: false, 
                message: `AiSensy API returned error status (${response.status}): ${errorDetails || 'Unknown error'}` 
            };
        }

        const data = await response.json();
        // AiSensy standard response format includes a success boolean or messageId
        if (data.success || data.message === "Campaign Sent Successfully" || data.messageId) {
            return { success: true };
        }

        return { 
            success: false, 
            message: data.message || data.error || 'Failed to trigger campaign.' 
        };
    } catch (error: any) {
        console.error('[WhatsApp Service Network Error]', error);
        return { 
            success: false, 
            message: error.message || 'Network request failed. Check your internet connection.' 
        };
    }
};
