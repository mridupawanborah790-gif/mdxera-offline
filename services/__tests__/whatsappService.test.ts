import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendWhatsappInvoiceViaAiSensy } from '../whatsappService';

describe('whatsappService.sendWhatsappInvoiceViaAiSensy', () => {
    const mockBill = {
        id: 'invoice-123',
        customerName: 'Alice Tester',
        customerPhone: '9876543210',
        total: 154.50,
        createdAt: '2026-06-23T10:00:00.000Z',
        pharmacy: {
            pharmacy_name: 'Test Pharmacy'
        }
    } as any;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('should fail if apiKey is missing', async () => {
        const result = await sendWhatsappInvoiceViaAiSensy('', 'campaign_1', mockBill);
        expect(result.success).toBe(false);
        expect(result.message).toContain('API Key is not configured');
    });

    it('should fail if campaignName is missing', async () => {
        const result = await sendWhatsappInvoiceViaAiSensy('api_key_123', '', mockBill);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Campaign Name is not configured');
    });

    it('should format destination number correctly (add +91 for 10 digits)', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true })
        } as Response);
        globalThis.fetch = fetchSpy;

        const result = await sendWhatsappInvoiceViaAiSensy('api_key_123', 'campaign_123', mockBill);
        expect(result.success).toBe(true);

        const lastCallArgs = fetchSpy.mock.calls[0];
        const body = JSON.parse(lastCallArgs[1].body);
        expect(body.destination).toBe('+919876543210');
    });

    it('should pass templateParams in correct order', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true })
        } as Response);
        globalThis.fetch = fetchSpy;

        await sendWhatsappInvoiceViaAiSensy('api_key_123', 'campaign_123', mockBill);

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.templateParams).toEqual([
            'Alice Tester',
            'Test Pharmacy',
            'invoice-123',
            '₹154.50'
        ]);
    });

    it('should append media object if pdfUrl is provided', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true })
        } as Response);
        globalThis.fetch = fetchSpy;

        const testPdfUrl = 'https://supabase.com/storage/v1/object/public/invoices/org/invoice.pdf';
        await sendWhatsappInvoiceViaAiSensy('api_key_123', 'campaign_123', mockBill, testPdfUrl);

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.media).toEqual({
            url: testPdfUrl,
            filename: 'Invoice_invoice-123.pdf'
        });
    });

    it('should pass 5 templateParams in correct order for text templateType', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true })
        } as Response);
        globalThis.fetch = fetchSpy;

        await sendWhatsappInvoiceViaAiSensy('api_key_123', 'campaign_123', mockBill, undefined, 'text');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.templateParams).toEqual([
            'Alice Tester',
            'Test Pharmacy',
            'invoice-123',
            '₹154.50',
            '23-06-2026'
        ]);
        expect(body.media).toBeUndefined();
    });

    it('should not attach media object in text templateType even if pdfUrl is provided', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true })
        } as Response);
        globalThis.fetch = fetchSpy;

        const testPdfUrl = 'https://supabase.com/storage/v1/object/public/invoices/org/invoice.pdf';
        await sendWhatsappInvoiceViaAiSensy('api_key_123', 'campaign_123', mockBill, testPdfUrl, 'text');

        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.media).toBeUndefined();
    });

    it('should handle API failure response states gracefully', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => 'Bad Request'
        } as Response);

        const result = await sendWhatsappInvoiceViaAiSensy('api_key_123', 'campaign_123', mockBill);
        expect(result.success).toBe(false);
        expect(result.message).toContain('AiSensy API returned error status (400)');
    });
});
