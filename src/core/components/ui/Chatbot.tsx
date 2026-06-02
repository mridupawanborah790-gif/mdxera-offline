import React, { useMemo, useState, useRef, useEffect } from 'react';
import type { ChatMessage, InventoryItem, Transaction, Purchase, Distributor, Customer, Medicine } from '@core/types';
import { askAiAssistant } from '@core/services/geminiService';

/**
 * Build a compact, AI-friendly summary of the pharmacy state.
 *
 * The old chatbot dumped every inventory/transaction/purchase/customer row
 * as one giant JSON blob into the prompt. For a real pharmacy that's tens
 * of MB of text — blows past every model's context window and the request
 * silently fails. This summary is bounded (~few KB) regardless of org size
 * and gives the AI enough signal to answer typical "what's low on stock?"
 * / "how were sales today?" / "show me top customers" questions.
 */
function summarizeAppData(d: AppData): string {
    const round2 = (n: number) => Number(n.toFixed(2));
    const safeNum = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const today = new Date().toISOString().slice(0, 10);

    // ── Inventory ──
    const lowStock = d.inventory
        .filter(i => safeNum(i.stock) > 0 && safeNum(i.stock) <= safeNum(i.minStockLimit))
        .sort((a, b) => safeNum(a.stock) - safeNum(b.stock))
        .slice(0, 20)
        .map(i => ({ name: i.name, batch: i.batch, stock: i.stock, min: i.minStockLimit }));

    const nearExpiry = d.inventory
        .filter(i => {
            if (!i.expiry) return false;
            const exp = new Date(i.expiry);
            if (Number.isNaN(exp.getTime())) return false;
            const days = (exp.getTime() - Date.now()) / 86400000;
            return days >= 0 && days <= 90 && safeNum(i.stock) > 0;
        })
        .sort((a, b) => new Date(a.expiry!).getTime() - new Date(b.expiry!).getTime())
        .slice(0, 20)
        .map(i => ({ name: i.name, batch: i.batch, expiry: i.expiry, stock: i.stock }));

    const stockValue = round2(
        d.inventory.reduce((s, i) => s + safeNum(i.stock) * safeNum(i.purchasePrice), 0),
    );

    // ── Sales ──
    const todaysSales = d.transactions.filter(
        t => String(t.date || '').startsWith(today) && t.status !== 'cancelled',
    );
    const todaysSalesTotal = round2(todaysSales.reduce((s, t) => s + safeNum(t.total), 0));

    const recentSales = d.transactions
        .filter(t => t.status !== 'cancelled')
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 15)
        .map(t => ({
            invoice: t.invoiceNumber,
            date: t.date,
            customer: t.customerName,
            total: t.total,
        }));

    // ── Purchases ──
    const recentPurchases = d.purchases
        .filter(p => p.status !== 'cancelled')
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 15)
        .map(p => ({
            invoice: p.invoiceNumber,
            date: p.date,
            supplier: p.supplier,
            total: p.totalAmount,
        }));

    const summary = {
        counts: {
            inventoryItems: d.inventory.length,
            medicines: d.medicines.length,
            customers: d.customers.length,
            suppliers: d.distributors.length,
            transactions: d.transactions.length,
            purchases: d.purchases.length,
        },
        today: { date: today, salesCount: todaysSales.length, salesTotal: todaysSalesTotal },
        stockValueTotal: stockValue,
        lowStock,
        nearExpiry,
        recentSales,
        recentPurchases,
    };

    return JSON.stringify(summary);
}

const AiIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M12 2.69l.346.666L19.5 15.3l-6.846 4.01L6.5 15.3l7.154-11.944z"/><path d="M12 22v-6"/><path d="M12 8V2"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m4.93 19.07 4.24-4.24"/></svg>
);

interface AppData {
    inventory: InventoryItem[];
    transactions: Transaction[];
    purchases: Purchase[];
    distributors: Distributor[];
    customers: Customer[];
    medicines: Medicine[];
}

interface ChatbotProps {
    appData: AppData;
}

const Chatbot: React.FC<ChatbotProps> = ({ appData }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Memoize the summary so we don't rebuild it on every keystroke.
    const dataSummary = useMemo(() => summarizeAppData(appData), [appData]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        setMessages([{ role: 'model', parts: [{ text: 'Hello! Welcome to MDXERA ERP! How can I help you today?' }] }]);
    }, []);

    const handleSendMessage = async (textOverride?: string) => {
        const text = textOverride || inputValue;
        if (!text.trim() || isLoading) return;

        if (!textOverride) setInputValue('');
        const userMessage: ChatMessage = { role: 'user', parts: [{ text }] };
        const updatedMessages = [...messages, userMessage];
        setMessages(updatedMessages);
        setIsLoading(true);

        try {
            const dataContext = `Pharmacy state summary (compact JSON): ${dataSummary}`;
            const history = updatedMessages.slice(-10).map(m => `${m.role}: ${m.parts[0]?.text || ''}`).join('\n');
            const userPrompt =
                `You are the MDXERA ERP assistant. Answer concisely using ONLY the provided summary.\n` +
                `If the answer needs detail that isn't in the summary, say so and suggest which screen to open.\n` +
                `${dataContext}\n\nConversation:\n${history}\nassistant:`;
            const answer = await askAiAssistant(userPrompt);
            setMessages(prev => [...prev, { role: 'model', parts: [{ text: answer || 'I could not generate a response right now.' }] }]);
        } catch (err: any) {
            // Surface the real error so it's debuggable. The chat bubble still
            // stays friendly but includes a short hint of what went wrong.
            // eslint-disable-next-line no-console
            console.error('[Chatbot] askAiAssistant failed:', err);
            const hint = (err?.message || '').toString().slice(0, 180);
            setMessages(prev => [
                ...prev,
                {
                    role: 'model',
                    parts: [{
                        text: `Sorry, I hit an error contacting the AI service.\n${hint ? `Details: ${hint}` : 'Check the browser console for details.'}`,
                    }],
                },
            ]);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        const handleAiTrigger = (e: any) => {
            if (e.detail && e.detail.prompt) {
                setIsOpen(true);
                handleSendMessage(e.detail.prompt);
            }
        };
        window.addEventListener('trigger-ai-assistant', handleAiTrigger);
        return () => window.removeEventListener('trigger-ai-assistant', handleAiTrigger);
    }, [messages, isLoading]);

    return (
        <>
            <div className={`fixed bottom-6 right-6 z-40 transition-transform duration-300 print:hidden ${isOpen ? 'translate-y-24 opacity-0' : 'translate-y-0 opacity-100'}`}>
                <button onClick={() => setIsOpen(true)} className="bg-primary text-white rounded-none p-4 shadow-lg hover:bg-primary-dark ring-4 ring-primary/20 font-normal">
                    <AiIcon className="w-8 h-8"/>
                </button>
            </div>

            <div className={`fixed bottom-6 right-6 z-50 w-96 bg-[var(--modal-bg-light)] dark:bg-[var(--modal-bg-dark)] rounded-none shadow-2xl flex flex-col transition-all duration-300 print:hidden border border border-[var(--modal-border-color-light)] dark:border-[var(--modal-border-color-dark)] ${isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-16 pointer-events-none'}`} style={{ height: '70vh' }}>
                <div className="flex items-center justify-between p-4 border-b border-[var(--modal-footer-border-light)] dark:border-[var(--modal-footer-border-dark)] bg-primary text-white rounded-none">
                    <div className="flex items-center space-x-2">
                        <AiIcon className="w-5 h-5 text-accent"/>
                        <h3 className="font-black text-xs uppercase tracking-widest">Assistant</h3>
                    </div>
                    <button onClick={() => setIsOpen(false)} className="text-white hover:text-accent">✕</button>
                </div>

                <div className="flex-1 p-4 overflow-y-auto space-y-4 bg-app-bg font-normal text-app-text-primary">
                    {messages.map((msg, index) => (
                        <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[85%] px-4 py-2 rounded-none shadow-sm ${msg.role === 'user' ? 'bg-primary text-white' : 'bg-white dark:bg-zinc-800 border border-app-border text-app-text-primary font-bold uppercase text-[12px]'}`}>
                                <p className="whitespace-pre-wrap">{msg.parts[0].text}</p>
                            </div>
                        </div>
                    ))}
                    {isLoading && <div className="flex justify-start"><div className="animate-bounce text-primary font-black uppercase text-[10px]">Processing...</div></div>}
                    <div ref={messagesEndRef} />
                </div>

                <div className="p-4 border-t border-app-border bg-white dark:bg-zinc-900 rounded-none">
                    <div className="flex items-center space-x-2">
                        <input
                            type="text"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                            placeholder="Ask about stock, sales or analysis..."
                            className="flex-1 px-4 py-2 border border-app-border rounded-none bg-input-bg text-sm focus:ring-2 focus:ring-primary/20 outline-none font-bold uppercase"
                            disabled={isLoading}
                        />
                        <button onClick={() => handleSendMessage()} disabled={isLoading || !inputValue.trim()} className="p-2 text-white bg-primary rounded-none hover:bg-primary-dark shadow-md transition-all">➤</button>
                    </div>
                </div>
            </div>
        </>
    );
};

export default Chatbot;
