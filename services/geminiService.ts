import type { ExtractedPurchaseBill, PurchaseItem, SubstituteResult, ExtractedSalesBill, FileInput } from "../types";
import { parseNetworkAndApiError } from '../utils/error';

interface GeminiOcrRequest {
    prompt: string;
    files?: FileInput[];
}

const cleanJsonString = (text: string): string => {
    if (!text) return '[]';
    return text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
};

const toNumeric = (value: any): number | undefined => {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    const cleaned = String(value).replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
};

// AI provider config. Defaults assume Groq via the `groq_ai` Edge Function
// (request/response contract is identical to the legacy `gemini-ocr-main`
// function — see supabase/functions/groq_ai/index.ts).
//
// Override via .env.local if you want to point at the old Gemini function:
//   VITE_AI_FUNCTION=gemini-ocr-main
//   VITE_AI_MODEL=gemini-2.5-flash
const getPreferredAiModel = (): string => {
    const env = (import.meta as any).env || {};
    return String(
        env.VITE_AI_MODEL ||
        env.VITE_GROQ_MODEL ||
        // legacy fallbacks (kept so existing .env entries don't break)
        env.VITE_GEMINI_MODEL ||
        env.VITE_GOOGLE_MODEL ||
        'meta-llama/llama-4-scout-17b-16e-instruct',
    ).trim();
};

const getAiFunctionName = (): string => {
    const env = (import.meta as any).env || {};
    return String(env.VITE_AI_FUNCTION || 'groq_ai').trim();
};

const SUPABASE_URL = (import.meta as any).env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = (import.meta as any).env.VITE_SUPABASE_ANON_KEY;

const callGeminiOcr = async (request: string | GeminiOcrRequest): Promise<any> => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error("Supabase configuration is missing in .env");
    }

    const model = getPreferredAiModel();
    const functionName = getAiFunctionName();
    const payload: GeminiOcrRequest = typeof request === 'string' ? { prompt: request } : request;

    const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
            prompt: payload.prompt,
            files: payload.files,
            model,
        }),
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`OCR function failed (${response.status}): ${details}`);
    }

    const result = await response.json();
    if (!result?.success) {
        throw new Error(result?.error || 'OCR function returned unsuccessful response');
    }

    return result;
};

const getTextFromResultData = (data: any): string => {
    const rawData = data?.data || data;
    if (!rawData) return '';
    
    // Handle the case where the API returns the result directly (direct call)
    // or wrapped in our success/data object
    const candidates = rawData.candidates || [];
    if (candidates.length === 0) return '';

    return candidates
        .flatMap((candidate: any) => candidate?.content?.parts || [])
        .map((part: any) => part?.text || '')
        .join('')
        .trim();
};

export const getAiInsights = async (summary: any): Promise<string[]> => {
    try {
        const userPrompt = `Analyze this pharmacy data and provide 3 brief actionable insights in a JSON array of strings: ${JSON.stringify(summary)}`;
        const data = await callGeminiOcr(userPrompt);
        return JSON.parse(cleanJsonString(getTextFromResultData(data) || '[]'));
    } catch (error) {
        console.error('AI insight error:', error);
        return ["AI analysis is currently unavailable. Please check your connection and try again."];
    }
};

export const askAiAssistant = async (userPrompt: string): Promise<string> => {
    const data = await callGeminiOcr(userPrompt);
    return getTextFromResultData(data);
};

export const extractPurchaseDetailsFromBill = async (
    inputFiles: FileInput[],
    pharmacyName: string
): Promise<ExtractedPurchaseBill> => {
    try {
        const prompt = `Analyze purchase invoice images for \"${pharmacyName}\". Extract supplier, GSTIN, PAN, supplier phone, supplier address, invoice number, date and items. Return JSON only with fields: supplier, supplierGstNumber, supplierPanNumber, supplierPhone, supplierAddress, invoiceNumber, date, items: [{name, batch, packType, expiry, quantity, purchasePrice, mrp, gstPercent, discountPercent}].`;

        const responseData = await callGeminiOcr({
            prompt,
            files: inputFiles,
        });

        // Extract text and parse JSON
        const jsonText = getTextFromResultData(responseData);
        const root = JSON.parse(cleanJsonString(jsonText) || '{}');
        
        const rawItems = Array.isArray(root?.items) ? root.items : [];

        const normalizedItems = rawItems
            .map((item: any) => ({
                name: String(item?.name || item?.product || item?.extracted_item_name || '').trim(),
                manufacturer: String(item?.manufacturer || item?.mfr || item?.brand || item?.extracted_manufacturer || '').trim(),
                batch: String(item?.batch || item?.batchNo || item?.extracted_batch || '').trim(),
                packType: String(item?.packType || item?.pack || item?.extracted_pack || '').trim(),
                expiry: String(item?.expiry || item?.exp || item?.extracted_expiry || '').trim(),
                quantity: toNumeric(item?.quantity ?? item?.extracted_quantity) ?? 0,
                freeQuantity: toNumeric(item?.freeQuantity ?? item?.free ?? item?.extracted_free) ?? 0,
                purchasePrice: toNumeric(item?.purchasePrice ?? item?.rate ?? item?.extracted_rate) ?? 0,
                mrp: toNumeric(item?.mrp ?? item?.extracted_mrp) ?? 0,
                gstPercent: toNumeric(item?.gstPercent ?? item?.gst) ?? undefined,
                discountPercent: toNumeric(item?.discountPercent ?? item?.discount ?? item?.extracted_discount) ?? undefined,
                schemeDiscountPercent: toNumeric(item?.schemeDiscountPercent ?? item?.scheme ?? item?.extracted_scheme) ?? undefined,
            }))
            .filter((item: any) => item.name && (item.quantity > 0 || item.purchasePrice > 0 || item.mrp > 0));

        const supplier = String(root?.supplier || root?.vendor || '').trim();

        return {
            importStatus: 'success',
            supplierDetected: Boolean(supplier),
            extractedItemsCount: normalizedItems.length,
            supplier,
            supplierGstNumber: String(root?.supplierGstNumber || root?.supplierGst || root?.gst || '').trim(),
            invoiceNumber: String(root?.invoiceNumber || root?.billNumber || '').trim(),
            date: String(root?.date || root?.invoiceDate || '').trim(),
            supplierPanNumber: String(root?.supplierPanNumber || root?.supplierPan || root?.pan || '').trim(),
            supplierPhone: String(root?.supplierPhone || root?.phone || root?.mobile || '').trim(),
            supplierAddress: String(root?.supplierAddress || root?.address || '').trim(),
            items: normalizedItems,
            ...(normalizedItems.length === 0 ? { error: 'AI could not detect line items from this image. Try a full-page, well-lit photo with item rows clearly visible.' } : {}),
        };
    } catch (error: any) {
        console.error('OCR Extraction Error:', error);
        return { importStatus: 'failed', extractedItemsCount: 0, supplier: '', invoiceNumber: '', date: '', items: [], error: `AI Extraction failed. ${parseNetworkAndApiError(error)}` };
    }
};

export const extractPrescription = async (file: FileInput, pharmacyName: string): Promise<ExtractedSalesBill> => {
    try {
        const prompt = `Analyze this prescription for ${pharmacyName}. Return valid JSON with customerName and items (name, quantity).`;
        const responseData = await callGeminiOcr({
            prompt,
            files: [file],
        });
        return JSON.parse(cleanJsonString(getTextFromResultData(responseData) || '{}'));
    } catch (error) {
        console.error('Prescription AI Error:', error);
        return { items: [], error: 'Prescription analysis failed. Please ensure the image is clear.' };
    }
};

export const generatePromotionalImage = async (prompt: string, logoUrl?: string): Promise<string> => {
    try {
        const userPrompt = `Create a social media promotional image for: ${prompt}. Optional logo: ${logoUrl || 'none'}. Return image data.`;
        const result = await callGeminiOcr(userPrompt);
        const rawData = result?.data || result;
        const inlineData = rawData?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData || p.inline_data);
        const media = inlineData?.inlineData || inlineData?.inline_data;
        if (!media) throw new Error('No image data returned.');
        return `data:${media.mimeType || media.mime_type};base64,${media.data}`;
    } catch (error) {
        throw new Error(parseNetworkAndApiError(error));
    }
};

export const generateCaptionsForImage = async (prompt: string): Promise<string[]> => {
    try {
        const data = await callGeminiOcr(`Write 3 professional social media captions as JSON array for: ${prompt}`);
        return JSON.parse(cleanJsonString(getTextFromResultData(data) || '[]'));
    } catch {
        return ["Your health is our priority.", "Genuine medicines at competitive rates.", "Professional care for the community."];
    }
};

export const findSubstitutes = async (text?: string, imageBase64?: string, mimeType?: string): Promise<SubstituteResult> => {
    const prompt = `Find medicine substitutes in India for: ${text || 'the provided image'}. Return structured JSON.`;
    try {
        const responseData = await callGeminiOcr({
            prompt,
            files: imageBase64 && mimeType ? [{ data: imageBase64, mimeType }] : undefined
        });
        return JSON.parse(cleanJsonString(getTextFromResultData(responseData) || '{}'));
    } catch (error: any) {
        throw new Error(parseNetworkAndApiError(error));
    }
};
