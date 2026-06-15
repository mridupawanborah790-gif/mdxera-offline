import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import POS from '@modules/pos/components/POS';
import type { Transaction, RegisteredPharmacy, InventoryItem, SalesReturn, Customer, Medicine, Purchase, AppConfigurations } from '@core/types';
import { downloadCsv, arrayToCsvRow } from '@core/utils/csv';
import ConfirmModal from '@core/components/ui/ConfirmModal';
import JournalEntryViewerModal from '@modules/accounting/components/JournalEntryViewerModal';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';
import { formatVoucherNo } from '@core/utils/helpers';

type SortableKeys = 'invoiceNumber' | 'date' | 'customerName' | 'total' | 'status' | 'itemCount';

const SortIcon = ({ sortKey, sortConfig }: { sortKey: SortableKeys; sortConfig: { key: SortableKeys; direction: 'ascending' | 'descending' } }) => {
    if (sortConfig.key !== sortKey) return <span className="text-gray-400 opacity-30 ml-1">↕</span>;
    return <span className="text-primary ml-1">{sortConfig.direction === 'ascending' ? '▲' : '▼'}</span>;
};

interface SalesHistoryProps {
    transactions: Transaction[];
    inventory: InventoryItem[];
    customers: Customer[];
    onViewDetails: (transaction: Transaction) => void;
    onPrintBill: (transaction: Transaction) => void;
    onCancelTransaction: (transactionId: string) => void;
    initialFilters?: { startDate?: string; endDate?: string } | null;
    onFiltersChange?: () => void;
    currentUser: RegisteredPharmacy | null;
    onRefresh?: () => Promise<void>; 
    onViewSale: (transaction: Transaction) => void;
    onEditSale: (transaction: Transaction) => void;
    onCreateReturn: (transaction: Transaction) => void;
    salesReturns: SalesReturn[];
    configurations: any;
    onAddMedicineMaster: (med: Omit<Medicine, 'id'>) => Promise<Medicine>;
    purchases: Purchase[];
    medicines: Medicine[];
    onQuickAddCustomer: any;
    onGoToPOS?: () => void;
}

const RefreshIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
);

const POSIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
);

const ITEMS_PER_PAGE = 15;

/**
 * Older POS bills stored prescriptions as bare base64 (the `data:<mime>;base64,`
 * prefix was stripped before sending to Gemini and never re-added on save).
 * Sniff the base64 magic bytes and rebuild a proper data URI so <img src>
 * renders the document instead of showing a broken-image icon.
 */
const ensurePrescriptionDataUri = (raw: string): string => {
    if (typeof raw !== 'string' || raw.length === 0) return raw;
    if (raw.startsWith('data:')) return raw;
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('blob:')) return raw;
    // Trim whitespace/newlines that some uploads include.
    const b64 = raw.replace(/\s+/g, '');
    // Magic bytes via base64 prefix detection (more reliable than guessing).
    let mime = 'image/png'; // safe default; browsers ignore the label and use the bytes anyway
    if (b64.startsWith('JVBERi'))      mime = 'application/pdf';        // %PDF
    else if (b64.startsWith('/9j/'))   mime = 'image/jpeg';             // FFD8FF
    else if (b64.startsWith('iVBOR'))  mime = 'image/png';              // 89504E47
    else if (b64.startsWith('R0lGOD')) mime = 'image/gif';              // GIF87a/89a
    else if (b64.startsWith('UklGR'))  mime = 'image/webp';             // RIFF
    return `data:${mime};base64,${b64}`;
};

/** Collect all prescription URLs / data URIs attached to a transaction (legacy single + images array). */
const getPrescriptionsFor = (tx: Transaction | null | undefined): string[] => {
    if (!tx) return [];
    const single = (tx as any).prescriptionUrl ? [String((tx as any).prescriptionUrl)] : [];
    const raw = (tx as any).prescriptionImages;
    let images: string[] = [];
    if (Array.isArray(raw)) {
        images = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    } else if (typeof raw === 'string' && raw.trim()) {
        // Some legacy rows stored JSON-stringified array (SQLite TEXT column).
        try {
            const parsed = JSON.parse(raw);
            images = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0) : [raw];
        } catch {
            images = [raw];
        }
    }
    return [...single, ...images].map(ensurePrescriptionDataUri);
};

const RxIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M6 4h6a4 4 0 0 1 0 8H6"/><line x1="6" y1="4" x2="6" y2="20"/><line x1="10" y1="12" x2="18" y2="20"/><line x1="14" y1="14" x2="18" y2="10"/>
    </svg>
);

type RxAsset = {
    /** Original data:/http URI — used directly for <img src>; cheap and stable. */
    displaySrc: string;
    /** Blob URL — built once per modal open. Used for PDF <object> embed and for downloads. */
    blobSrc: string;
    mime: string;
    isPdf: boolean;
    ext: string;
};

/** Read the mime type out of a `data:<mime>;base64,...` URI, or null for http(s)/blob. */
const parseDataUriMime = (uri: string): string | null => {
    if (!uri.startsWith('data:')) return null;
    const match = uri.match(/^data:([^;,]+)[;,]/);
    return match ? match[1] : null;
};

const mimeToExt = (mime: string): string => {
    switch (mime) {
        case 'application/pdf': return 'pdf';
        case 'image/jpeg':
        case 'image/jpg':       return 'jpg';
        case 'image/png':       return 'png';
        case 'image/gif':       return 'gif';
        case 'image/webp':      return 'webp';
        default:                return 'bin';
    }
};

/**
 * Convert a `data:` URI to a Blob URL. This unblocks two things:
 *   1. `<iframe src>` PDF preview is fast & reliable (data: URIs of 1–5 MB
 *      stall the parser and sometimes never load).
 *   2. `<a download>` actually downloads — Chromium/Safari/Tauri webviews
 *      drop the `download` attribute on large data URIs, but it's respected
 *      on blob URLs.
 * Returns the original string unchanged for non-data sources (http, blob).
 */
const dataUriToBlobUrl = (uri: string): { url: string; revoke: () => void } => {
    if (!uri.startsWith('data:')) return { url: uri, revoke: () => {} };
    try {
        const commaIdx = uri.indexOf(',');
        const meta = uri.substring(5, commaIdx); // e.g. image/png;base64
        const data = uri.substring(commaIdx + 1);
        const isBase64 = /;base64$/i.test(meta);
        const mime = meta.replace(/;base64$/i, '') || 'application/octet-stream';
        let bytes: Uint8Array;
        if (isBase64) {
            const binary = atob(data);
            bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        } else {
            bytes = new TextEncoder().encode(decodeURIComponent(data));
        }
        // Pass the underlying buffer — Blob accepts ArrayBuffer directly, and
        // this sidesteps the strict-mode Uint8Array<ArrayBufferLike> mismatch.
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
        const url = URL.createObjectURL(blob);
        return { url, revoke: () => { try { URL.revokeObjectURL(url); } catch {} } };
    } catch (err) {
        console.warn('[rx] failed to convert data URI to blob URL — falling back to raw URI', err);
        return { url: uri, revoke: () => {} };
    }
};

interface PrescriptionPreviewModalProps {
    transaction: Transaction;
    urls: string[]; // already normalized via getPrescriptionsFor (full data URIs or http URLs)
    onClose: () => void;
}

const PrescriptionPreviewModal: React.FC<PrescriptionPreviewModalProps> = ({ transaction: tx, urls, onClose }) => {
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
    const [assets, setAssets] = useState<RxAsset[]>([]);

    // Build the asset list (with blob URLs) ONCE per transaction. Earlier this
    // was a useMemo keyed on the `urls` array reference — because the parent
    // rebuilds that array every render, blob URLs were thrashed mid-fetch and
    // images broke. Pinning to `tx.id` makes lifetimes stable for the whole
    // time the modal is open.
    useEffect(() => {
        const created: string[] = [];
        const built: RxAsset[] = urls.map(raw => {
            const mime = parseDataUriMime(raw) || (raw.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png');
            const { url } = dataUriToBlobUrl(raw);
            if (url !== raw && url.startsWith('blob:')) created.push(url);
            return {
                displaySrc: raw,         // raw data:/http URI — what <img src> uses
                blobSrc: url,            // blob: URL (or the raw URI if conversion failed) — for downloads + PDF embed
                mime,
                isPdf: mime === 'application/pdf',
                ext: mimeToExt(mime),
            };
        });
        setAssets(built);
        return () => {
            for (const u of created) {
                try { URL.revokeObjectURL(u); } catch { /* no-op */ }
            }
        };
        // urls is intentionally excluded — we only want to rebuild when the
        // user opens a different transaction, not on every parent re-render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tx.id]);

    const downloadOne = (asset: RxAsset, idx: number) => {
        const link = document.createElement('a');
        // Always download via the blob URL — Chromium/Tauri webviews ignore the
        // `download` attribute on large data: URIs, so the click would open the
        // file inline instead of saving it.
        link.href = asset.blobSrc;
        link.download = `Rx_${formatVoucherNo(tx.invoiceNumber || tx.id)}_${idx + 1}.${asset.ext}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const lightboxAsset = lightboxIndex !== null ? assets[lightboxIndex] : null;

    return (
        <Modal
            isOpen={true}
            onClose={onClose}
            title={`Prescription Preview — ${formatVoucherNo(tx.invoiceNumber || tx.id)}`}
            widthClass="max-w-5xl"
            heightClass="h-[85vh]"
        >
            <div className="px-5 pt-4 pb-3 border-b border-gray-200 bg-white flex-shrink-0 flex flex-wrap items-baseline justify-between gap-3">
                <div>
                    <div className="text-sm font-bold uppercase tracking-wide text-gray-900">{tx.customerName || 'Walk-in Customer'}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                        {new Date(tx.date).toLocaleDateString('en-IN')} · {assets.length} document{assets.length === 1 ? '' : 's'} attached
                    </div>
                </div>
                {assets.length > 1 && (
                    <button
                        onClick={() => assets.forEach((a, idx) => downloadOne(a, idx))}
                        className="px-3 py-1.5 border border-gray-300 bg-white text-xs hover:bg-gray-50 flex items-center gap-2"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        Download All
                    </button>
                )}
            </div>

            <div className="p-5 flex-1 overflow-auto bg-gray-50">
                {assets.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-gray-400 italic">No prescription attached.</div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                        {assets.map((asset, index) => (
                            <div key={index} className="bg-white border border-gray-300 flex flex-col shadow-sm">
                                <div
                                    className="relative aspect-[4/5] w-full bg-gray-100 overflow-hidden flex items-center justify-center cursor-pointer"
                                    onClick={() => setLightboxIndex(index)}
                                    title={asset.isPdf ? 'Click to enlarge PDF' : 'Click to enlarge image'}
                                >
                                    {asset.isPdf ? (
                                        // A grid of <iframe> PDFs is slow and many webviews refuse
                                        // to embed `data:` PDFs at all (Chrome has blocked that
                                        // since v60). Show a static PDF card here; the lightbox
                                        // below renders the real embed when the user clicks in.
                                        <div className="flex flex-col items-center justify-center text-gray-500 p-4">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" className="mb-3 text-red-500"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                                            <span className="text-xs font-bold uppercase tracking-widest text-gray-700">PDF Document</span>
                                            <span className="text-[10px] text-gray-400 mt-1">Click to preview</span>
                                        </div>
                                    ) : (
                                        <img src={asset.displaySrc} alt={`Prescription ${index + 1}`} className="w-full h-full object-contain" />
                                    )}
                                    <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] font-black uppercase tracking-wider px-2 py-0.5">
                                        Rx #{index + 1}{asset.isPdf ? ' · PDF' : ''}
                                    </div>
                                </div>
                                <div className="flex border-t border-gray-200 text-xs">
                                    <button
                                        type="button"
                                        onClick={() => setLightboxIndex(index)}
                                        className="flex-1 py-2 hover:bg-gray-50 border-r border-gray-200 flex items-center justify-center gap-1.5"
                                    >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                        View
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => downloadOne(asset, index)}
                                        className="flex-1 py-2 hover:bg-gray-50 flex items-center justify-center gap-1.5"
                                    >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                        Download
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="flex justify-end items-center gap-2 px-5 py-3 border-t border-gray-200 bg-white flex-shrink-0">
                <button
                    onClick={onClose}
                    className="px-4 py-2 border border-gray-300 bg-white text-xs hover:bg-gray-50"
                >
                    Close
                </button>
            </div>

            {lightboxAsset && (
                <div
                    className="fixed inset-0 z-[300] bg-black/85 flex items-center justify-center p-6"
                    onClick={() => setLightboxIndex(null)}
                >
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setLightboxIndex(null); }}
                        className="absolute top-5 right-5 text-white p-2 hover:bg-white/10 rounded z-10"
                        aria-label="Close lightbox"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                    {assets.length > 1 && (
                        <>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setLightboxIndex((idx) => (idx === null ? 0 : (idx - 1 + assets.length) % assets.length)); }}
                                className="absolute left-5 text-white p-3 hover:bg-white/10 rounded-full z-10"
                                aria-label="Previous"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                            </button>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setLightboxIndex((idx) => (idx === null ? 0 : (idx + 1) % assets.length)); }}
                                className="absolute right-5 text-white p-3 hover:bg-white/10 rounded-full z-10"
                                aria-label="Next"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                            </button>
                        </>
                    )}
                    <div
                        className="w-full h-full max-w-6xl max-h-full flex items-center justify-center"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {lightboxAsset.isPdf ? (
                            // <object> is the most reliable inline-PDF embed across browsers
                            // and webviews; <iframe> with data: URIs is blocked in Chromium
                            // and blob: URIs are spotty in some WKWebView builds. We pass the
                            // blob URL (built once in the useEffect above) and provide an
                            // in-place fallback if the embed can't render.
                            <object
                                data={lightboxAsset.blobSrc}
                                type="application/pdf"
                                className="w-full h-full bg-white rounded"
                            >
                                <div className="w-full h-full flex flex-col items-center justify-center bg-white rounded gap-4 p-8 text-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-500"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                                    <div className="text-sm text-gray-700">This browser can't render the PDF inline.</div>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => window.open(lightboxAsset.blobSrc, '_blank')}
                                            className="px-4 py-2 border border-gray-300 bg-white text-xs hover:bg-gray-50"
                                        >
                                            Open in new tab
                                        </button>
                                        <button
                                            onClick={() => downloadOne(lightboxAsset, lightboxIndex!)}
                                            className="px-4 py-2 border border-primary bg-primary text-white text-xs"
                                        >
                                            Download PDF
                                        </button>
                                    </div>
                                </div>
                            </object>
                        ) : (
                            <img
                                src={lightboxAsset.displaySrc}
                                alt={`Prescription ${lightboxIndex! + 1}`}
                                className="max-h-full max-w-full object-contain"
                            />
                        )}
                    </div>
                    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 text-white text-xs font-bold uppercase tracking-widest z-10">
                        Rx #{lightboxIndex! + 1} of {assets.length}{lightboxAsset.isPdf ? ' · PDF' : ''}
                    </div>
                </div>
            )}
        </Modal>
    );
};

const getInvoiceSequenceNumber = (transaction: Transaction): number => {
    const invoiceRef = String(transaction.invoiceNumber || transaction.id || '');
    
    // Legacy offline bills have UUIDs. If we parse the first chunk of digits from a UUID 
    // (e.g. '12602748-87c3...'), we get massive sequence numbers (12,602,748) which breaks 
    // sorting and pushes them above the current INV sequence.
    // Check if it looks like a UUID (36 chars, 4 hyphens) and return 0 so it falls back to date sorting.
    if (invoiceRef.length === 36 && invoiceRef.split('-').length === 5) {
        return 0;
    }

    const firstNumericChunk = invoiceRef.match(/\d+/)?.[0];
    if (!firstNumericChunk) return 0;
    const parsed = Number.parseInt(firstNumericChunk, 10);
    return Number.isFinite(parsed) ? parsed : 0;
};

const SalesHistory: React.FC<SalesHistoryProps> = ({ 
    transactions, inventory, customers, onViewDetails, onPrintBill, onCancelTransaction, initialFilters, 
    onFiltersChange, currentUser, onRefresh, onViewSale, onEditSale, onCreateReturn, salesReturns, 
    configurations, onAddMedicineMaster, purchases, medicines, onQuickAddCustomer, onGoToPOS
}) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [rmpFilter, setRmpFilter] = useState('all');
    const [paymentModeFilter, setPaymentModeFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'cancelled'>('all');
    const [sortConfig, setSortConfig] = useState<{ key: SortableKeys; direction: 'ascending' | 'descending' }>({ key: 'invoiceNumber', direction: 'descending' });
    const [currentPage, setCurrentPage] = useState(1);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [transactionToCancel, setTransactionToCancel] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [journalTransaction, setJournalTransaction] = useState<Transaction | null>(null);
    const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
    const [actionWarning, setActionWarning] = useState<string>('');
    const [viewingTransaction, setViewingTransaction] = useState<Transaction | null>(null);
    const [rxViewingTransaction, setRxViewingTransaction] = useState<Transaction | null>(null);

    const requestSort = (key: SortableKeys) => {
        let direction: 'ascending' | 'descending' = 'ascending';
        if (sortConfig.key === key && sortConfig.direction === 'ascending') {
            direction = 'descending';
        }
        setSortConfig({ key, direction });
    };

    const filteredAndSortedTransactions = useMemo(() => {
        let filtered = (transactions || []).filter(Boolean);

        if (startDate) {
            const start = new Date(startDate); start.setHours(0, 0, 0, 0);
            filtered = filtered.filter(t => new Date(t.date) >= start);
        }
        if (endDate) {
            const end = new Date(endDate); end.setHours(23, 59, 59, 999);
            filtered = filtered.filter(t => new Date(t.date) <= end);
        }
        if (rmpFilter !== 'all') filtered = filtered.filter(t => t.referredBy === rmpFilter);
        if (paymentModeFilter !== 'all') filtered = filtered.filter(t => (t.paymentMode || 'Cash') === paymentModeFilter);
        if (statusFilter !== 'all') filtered = filtered.filter(t => (statusFilter === 'cancelled' ? t.status === 'cancelled' : t.status !== 'cancelled'));
        
        if (searchTerm) {
            const lowercasedFilter = searchTerm.toLowerCase();
            filtered = filtered.filter(t =>
                (t.invoiceNumber || t.id || '').toLowerCase().includes(lowercasedFilter) ||
                (t.customerName || '').toLowerCase().includes(lowercasedFilter) ||
                (t.customerPhone || '').toLowerCase().includes(lowercasedFilter)
            );
        }

        return filtered.sort((a, b) => {
            let comparison = 0;
            switch (sortConfig.key) {
                case 'invoiceNumber':
                    comparison = getInvoiceSequenceNumber(a) - getInvoiceSequenceNumber(b);
                    if (comparison === 0) {
                        comparison = String(a.invoiceNumber || a.id || '').localeCompare(String(b.invoiceNumber || b.id || ''));
                    }
                    break;
                case 'date':
                    comparison = new Date(a.date).getTime() - new Date(b.date).getTime();
                    break;
                case 'customerName':
                    comparison = (a.customerName || '').localeCompare(b.customerName || '');
                    break;
                case 'total':
                    comparison = (a.total || 0) - (b.total || 0);
                    break;
                case 'status':
                    comparison = (a.status || 'completed').localeCompare(b.status || 'completed');
                    break;
                case 'itemCount':
                    comparison = (a.items?.length || 0) - (b.items?.length || 0);
                    break;
                default:
                    comparison = 0;
            }

            if (comparison !== 0) {
                return sortConfig.direction === 'ascending' ? comparison : -comparison;
            }

            // Fallback for stable sort: Invoice number descending, then Date descending
            const fallbackSeq = getInvoiceSequenceNumber(b) - getInvoiceSequenceNumber(a);
            if (fallbackSeq !== 0) return fallbackSeq;
            
            return new Date(b.date).getTime() - new Date(a.date).getTime();
        });
    }, [transactions, searchTerm, startDate, endDate, rmpFilter, paymentModeFilter, statusFilter, sortConfig]);

    const totalPages = Math.ceil(filteredAndSortedTransactions.length / ITEMS_PER_PAGE);

    const paginatedTransactions = useMemo(() => {
        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        return filteredAndSortedTransactions.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    }, [filteredAndSortedTransactions, currentPage]);

    const selectedTransaction = useMemo(
        () => filteredAndSortedTransactions.find(tx => tx.id === selectedTransactionId) || null,
        [filteredAndSortedTransactions, selectedTransactionId]
    );

    // Reset to page 1 when filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [searchTerm, startDate, endDate, rmpFilter, paymentModeFilter, statusFilter]);

    useEffect(() => {
        if (selectedTransactionId && !selectedTransaction) {
            setSelectedTransactionId(null);
        }
    }, [selectedTransactionId, selectedTransaction]);

    const requireSelectedTransaction = useCallback(() => {
        if (!selectedTransaction) {
            setActionWarning('Please select an Invoice first.');
            return null;
        }
        setActionWarning('');
        return selectedTransaction;
    }, [selectedTransaction]);

    const handleSelectRow = (transactionId: string) => {
        setSelectedTransactionId(transactionId);
        setActionWarning('');
    };

    const handleViewSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;
        setViewingTransaction(tx);
    }, [requireSelectedTransaction]);

    const checkLinkedPayments = useCallback((tx: Transaction) => {
        const customer = customers.find(c => 
            c.id === tx.customerId || 
            (c.name || '').trim().toLowerCase() === (tx.customerName || '').trim().toLowerCase()
        );
        
        if (!customer || !Array.isArray(customer.ledger)) return false;

        // Check if there are any non-cancelled payment entries linked to this invoice
        return customer.ledger.some(entry => 
            entry.type === 'payment' && 
            entry.status !== 'cancelled' &&
            (entry.referenceInvoiceId === tx.id || (entry.referenceInvoiceNumber === tx.invoiceNumber && tx.invoiceNumber)) &&
            ['invoice_payment', 'invoice_payment_adjustment', 'down_payment_adjustment'].includes(entry.entryCategory || '') &&
            ((entry.adjustedAmount || 0) > 0 || (entry.credit || 0) > 0)
        );
    }, [customers]);

    const handleEditSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;

        const canEdit = tx.status === 'completed' || tx.status === 'hold' || tx.status === 'draft';
        if (!canEdit) {
            setActionWarning('Selected invoice cannot be modified.');
            return;
        }

        if (checkLinkedPayments(tx)) {
            setActionWarning('Cannot edit bill: A payment has been received against this invoice. Cancel the payment voucher first.');
            return;
        }

        setActionWarning('');
        onEditSale(tx);
    }, [requireSelectedTransaction, onEditSale, checkLinkedPayments]);

    const handleReturnOrderSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;

        if (tx.status !== 'completed') {
            setActionWarning('Selected invoice is not eligible for return.');
            return;
        }

        const totalReturnedQty = (salesReturns || [])
            .filter(ret => ret.originalInvoiceId === tx.id)
            .flatMap(ret => ret.items || [])
            .reduce((sum, item) => sum + Number(item.returnQuantity || 0), 0);

        const totalSoldQty = (tx.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        if (totalSoldQty > 0 && totalReturnedQty >= totalSoldQty) {
            setActionWarning('Return already completed for this invoice.');
            return;
        }

        setActionWarning('');
        onCreateReturn(tx);
    }, [requireSelectedTransaction, onCreateReturn, salesReturns]);

    const handleViewJournalSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;
        setJournalTransaction(tx);
    }, [requireSelectedTransaction]);

    const handlePrintSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;
        onPrintBill(tx);
    }, [onPrintBill, requireSelectedTransaction]);

    const handleCancelSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;

        if (tx.status === 'cancelled') {
            setActionWarning('Selected invoice is already cancelled.');
            return;
        }

        if (checkLinkedPayments(tx)) {
            setActionWarning('Cannot cancel bill: A payment has been received against this invoice. Cancel the payment voucher first.');
            return;
        }

        handleCancelClick(tx.id);
    }, [requireSelectedTransaction, checkLinkedPayments]);

    const handleExportSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;

        const headers = ['Invoice ID', 'Date', 'Customer Name', 'Items', 'Amount', 'Status'];
        const row = [
            tx.id,
            new Date(tx.date).toLocaleDateString('en-IN'),
            tx.customerName,
            String((tx.items || []).length),
            (tx.total || 0).toFixed(2),
            tx.status || 'completed',
        ];

        const csvContent = [arrayToCsvRow(headers), arrayToCsvRow(row)].join('\n');
        downloadCsv(`invoice-${tx.id}.csv`, csvContent);
    }, [requireSelectedTransaction]);

    const handleViewRxSelected = useCallback(() => {
        const tx = requireSelectedTransaction();
        if (!tx) return;
        if (getPrescriptionsFor(tx).length === 0) {
            setActionWarning('No prescription attached to this bill.');
            return;
        }
        setRxViewingTransaction(tx);
    }, [requireSelectedTransaction]);

    const handleViewRxFor = useCallback((tx: Transaction) => {
        if (getPrescriptionsFor(tx).length === 0) return;
        setSelectedTransactionId(tx.id);
        setRxViewingTransaction(tx);
    }, []);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, 'salesHistory', { allowedKeysWhenInputFocused: ['F5'] })) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (paginatedTransactions.length === 0) return;

                const currentIndex = selectedTransaction
                    ? paginatedTransactions.findIndex(tx => tx.id === selectedTransaction.id)
                    : -1;
                const nextIndex = e.key === 'ArrowDown'
                    ? Math.min(currentIndex + 1, paginatedTransactions.length - 1)
                    : Math.max(currentIndex - 1, 0);
                const nextTransaction = paginatedTransactions[nextIndex];
                if (nextTransaction) {
                    handleSelectRow(nextTransaction.id);
                }
            } else if (e.key === 'ArrowRight' && currentPage < totalPages) {
                e.preventDefault();
                setCurrentPage(p => p + 1);
            } else if (e.key === 'ArrowLeft' && currentPage > 1) {
                e.preventDefault();
                setCurrentPage(p => p - 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                handleViewSelected();
            } else if (e.key === 'F1') {
                e.preventDefault();
                if (onGoToPOS) onGoToPOS();
            } else if (e.key === 'F4') {
                e.preventDefault();
                handleEditSelected();
            } else if (e.key === 'F6') {
                e.preventDefault();
                handleReturnOrderSelected();
            } else if (e.key === 'F7') {
                e.preventDefault();
                handleViewJournalSelected();
            } else if (e.key === 'F8') {
                e.preventDefault();
                handlePrintSelected();
            } else if (e.key === 'F9') {
                e.preventDefault();
                handleViewRxSelected();
            } else if (e.key === 'Delete') {
                e.preventDefault();
                handleCancelSelected();
            } else if (e.key === 'F3') {
                e.preventDefault();
                handleExportSelected();
            } else if (e.key === 'F5') {
                e.preventDefault();
                handleRefresh();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [paginatedTransactions, selectedTransaction, handleViewSelected, handleEditSelected, handleReturnOrderSelected, handleViewJournalSelected, handlePrintSelected, handleCancelSelected, handleExportSelected, handleViewRxSelected, currentPage, totalPages]);

    const renderPageNumbers = () => {
        const delta = 2;
        const range = [];
        const rangeWithDots = [];
        let l;

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
                range.push(i);
            }
        }

        for (const i of range) {
            if (l) {
                if (i - l === 2) {
                    rangeWithDots.push(l + 1);
                } else if (i - l !== 1) {
                    rangeWithDots.push('...');
                }
            }
            rangeWithDots.push(i);
            l = i;
        }

        return rangeWithDots.map((p, idx) => (
            <button
                key={idx}
                disabled={p === '...'}
                onClick={() => typeof p === 'number' && setCurrentPage(p)}
                className={`min-w-[32px] h-8 px-2 border border-gray-400 text-[10px] font-black uppercase transition-all ${
                    p === currentPage 
                    ? 'bg-primary text-white border-primary shadow-inner' 
                    : p === '...' 
                    ? 'bg-white text-gray-400 cursor-default border-dashed' 
                    : 'bg-white text-gray-700 hover:bg-gray-50'
                }`}
            >
                {p}
            </button>
        ));
    };

    const handleCancelClick = (id: string) => {
        setTransactionToCancel(id);
        setIsConfirmOpen(true);
    };

    const handleConfirmCancel = () => {
        if (transactionToCancel) {
            onCancelTransaction(transactionToCancel);
            setTransactionToCancel(null);
        }
        setIsConfirmOpen(false);
    };

    const handleRefresh = async () => {
        if (onRefresh) {
            setIsSyncing(true);
            try {
                await onRefresh();
            } finally {
                setIsSyncing(false);
            }
        }
    };

    const totalRevenue = useMemo(() => filteredAndSortedTransactions.reduce((sum, t) => sum + (t.status !== 'cancelled' ? t.total : 0), 0), [filteredAndSortedTransactions]);

    const applySearch = useCallback(() => {
        setSearchTerm(searchInput.trim());
    }, [searchInput]);

    return (
        <main className="flex-1 page-fade-in flex flex-col overflow-hidden bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Sales Register (Accounting)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Revenue: ₹{totalRevenue.toLocaleString()}</span>
            </div>

            <div className="p-4 flex-1 flex flex-col gap-4 overflow-hidden">
                <Card className="sticky top-0 z-20 px-2 py-1.5 tally-border !rounded-none bg-white">
                    <div className="flex items-center gap-2 whitespace-nowrap overflow-x-auto">
                        <div className="flex items-center gap-1.5 min-w-[340px]">
                            <label className="text-[11px] font-semibold text-gray-600">Search:</label>
                            <input
                                type="text"
                                placeholder="Bill ID / Customer"
                                value={searchInput}
                                onChange={e => setSearchInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        applySearch();
                                    }
                                }}
                                className="h-8 w-[300px] border border-gray-400 px-2 text-[13px] font-semibold focus:bg-yellow-50 outline-none"
                            />
                        </div>

                        <div className="flex items-center gap-1.5 min-w-[180px]">
                            <label className="text-[11px] font-semibold text-gray-600">From:</label>
                            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-8 w-[150px] border border-gray-400 px-2 text-[12px] font-semibold outline-none" />
                        </div>

                        <div className="flex items-center gap-1.5 min-w-[170px]">
                            <label className="text-[11px] font-semibold text-gray-600">To:</label>
                            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="h-8 w-[150px] border border-gray-400 px-2 text-[12px] font-semibold outline-none" />
                        </div>

                        <div className="flex items-center gap-1.5 min-w-[205px]">
                            <label className="text-[11px] font-semibold text-gray-600">Status:</label>
                            <select
                                value={statusFilter}
                                onChange={e => setStatusFilter(e.target.value as any)}
                                className="h-8 w-[165px] border border-gray-400 px-2 text-[12px] font-semibold outline-none bg-white"
                            >
                                <option value="all">All Orders</option>
                                <option value="completed">Completed Orders</option>
                                <option value="cancelled">Cancelled Orders</option>
                            </select>
                        </div>

                        <button
                            onClick={handleRefresh}
                            disabled={isSyncing}
                            className="h-8 min-w-[150px] px-3 tally-button-primary text-[11px] font-black uppercase flex items-center justify-center gap-2 disabled:opacity-60"
                        >
                            <RefreshIcon className={isSyncing ? 'animate-spin' : ''} />
                            {isSyncing ? 'Syncing...' : 'F5: Refresh'}
                        </button>
                    </div>
                </Card>

                <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white">
                    <div className="border-b border-gray-300 p-3 bg-gray-50 space-y-3">
                        <div className="text-[11px] font-bold text-gray-700">
                            Selected Invoice: <span className="font-mono text-primary">{formatVoucherNo(selectedTransaction?.invoiceNumber || selectedTransaction?.id) || 'None'}</span>
                            {' '}| Customer: <span className="uppercase">{selectedTransaction?.customerName || '-'}</span>
                            {' '}| Voucher ID: <span className="font-mono">{formatVoucherNo(selectedTransaction?.invoiceNumber || selectedTransaction?.id) || '-'}</span>
                            {' '}| Amount: <span className="font-black">₹{(selectedTransaction?.total || 0).toFixed(2)}</span>
                            {selectedTransaction?.narration && (
                                <> | Narration: <span className="text-indigo-600 italic font-medium">{selectedTransaction.narration}</span></>
                            )}
                        </div>
                        {actionWarning && <div className="text-[11px] font-bold text-red-700 bg-red-100 border border-red-200 px-2 py-1">{actionWarning}</div>}
                        <div className="flex flex-wrap gap-2">
                            <button onClick={() => onGoToPOS?.()} className="px-3 py-1.5 tally-border bg-primary text-white text-[10px] font-black uppercase flex items-center gap-2 hover:bg-primary-dark transition-colors shadow-md">
                                <POSIcon className="w-3 h-3" />
                                F1: POS Sales
                            </button>
                            <button disabled={!selectedTransaction} onClick={handleViewSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">Enter: View</button>
                            <button disabled={!selectedTransaction} onClick={handleEditSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F4: Edit / Modify Bill</button>
                            <button disabled={!selectedTransaction} onClick={handleReturnOrderSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F6: Return Order</button>
                            <button disabled={!selectedTransaction} onClick={handleViewJournalSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F7: View Journal Entry</button>
                            <button disabled={!selectedTransaction} onClick={handlePrintSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F8: Print</button>
                            <button
                                disabled={!selectedTransaction || getPrescriptionsFor(selectedTransaction).length === 0}
                                onClick={handleViewRxSelected}
                                className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50 flex items-center gap-1.5"
                                title={selectedTransaction && getPrescriptionsFor(selectedTransaction).length > 0
                                    ? `View ${getPrescriptionsFor(selectedTransaction).length} prescription(s)`
                                    : 'No prescription attached'}
                            >
                                <RxIcon className="w-3 h-3" />
                                F9: View Rx
                            </button>
                            <button disabled={!selectedTransaction} onClick={handleCancelSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase text-red-700 disabled:opacity-50">Delete: Cancel</button>
                            <button disabled={!selectedTransaction} onClick={handleExportSelected} className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50">F3: Export</button>
                            <button onClick={handleRefresh} disabled={isSyncing} className="px-3 py-1.5 tally-button-primary text-[10px] font-black uppercase disabled:opacity-60">F5: Refresh</button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-auto">
                        <table className="min-w-full border-collapse text-sm">
                            <thead className="sticky top-0 bg-gray-100 border-b border-gray-400">
                                <tr className="text-[10px] font-black uppercase text-gray-600 select-none">
                                    <th className="p-2 border-r border-gray-400 text-left w-10">Sl.</th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('invoiceNumber')}>
                                        <div className="flex items-center">Invoice ID <SortIcon sortKey="invoiceNumber" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('date')}>
                                        <div className="flex items-center">Date <SortIcon sortKey="date" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-left cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('customerName')}>
                                        <div className="flex items-center">Customer Name <SortIcon sortKey="customerName" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-center w-24 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('itemCount')}>
                                        <div className="flex items-center justify-center">Items <SortIcon sortKey="itemCount" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-right w-32 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('total')}>
                                        <div className="flex items-center justify-end">Amount <SortIcon sortKey="total" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 border-r border-gray-400 text-center w-28 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => requestSort('status')}>
                                        <div className="flex items-center justify-center">Status <SortIcon sortKey="status" sortConfig={sortConfig} /></div>
                                    </th>
                                    <th className="p-2 text-center w-16">Rx</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {paginatedTransactions.map((tx, idx) => {
                                    const status = tx.status || 'completed';
                                    return (
                                    <tr
                                        key={tx.id}
                                        onClick={() => handleSelectRow(tx.id)}
                                        className={`cursor-pointer transition-colors group ${selectedTransactionId === tx.id ? 'bg-primary text-white shadow-md' : 'hover:bg-primary hover:text-white'} ${status === 'cancelled' ? (selectedTransactionId === tx.id ? 'line-through text-white/50 bg-primary' : 'line-through text-red-500 bg-red-50/50') : ''}`}
                                    >
                                        <td className={`p-2 border-r border-gray-200 font-bold text-center ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white text-gray-400'}`}>{((currentPage - 1) * ITEMS_PER_PAGE) + idx + 1}</td>
                                        <td className={`p-2 border-r border-gray-200 font-mono font-bold ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white text-primary'}`}>{formatVoucherNo(tx.invoiceNumber || tx.id)}</td>
                                        <td className={`p-2 border-r border-gray-200 ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>{new Date(tx.date).toLocaleDateString('en-IN')}</td>
                                        <td className={`p-2 border-r border-gray-200 font-bold uppercase ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>{tx.customerName}</td>
                                        <td className={`p-2 border-r border-gray-200 text-center font-bold ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>
                                            {(() => {
                                                const originalCount = (tx.items || []).length;
                                                const returnedItemIds = new Set(
                                                    (salesReturns || [])
                                                        .filter(ret => ret.originalInvoiceId === tx.id)
                                                        .flatMap(ret => (ret.items || []).map(item => item.inventoryItemId || item.id || item.name))
                                                );
                                                const netCount = Math.max(0, originalCount - returnedItemIds.size);
                                                
                                                if (returnedItemIds.size > 0) {
                                                    return (
                                                        <div className="flex flex-col items-center leading-none">
                                                            <span className={`text-xs ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>{netCount}</span>
                                                            <span className={`text-[8px] font-black mt-0.5 uppercase ${selectedTransactionId === tx.id ? 'text-white/70' : 'text-red-500 group-hover:text-white/70'}`}>({returnedItemIds.size} Ret)</span>
                                                        </div>
                                                    );
                                                }
                                                return originalCount;
                                            })()}
                                        </td>
                                        <td className={`p-2 border-r border-gray-400 text-right font-black ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>₹{(tx.total || 0).toFixed(2)}</td>
                                        <td className={`p-2 border-r border-gray-200 text-center ${selectedTransactionId === tx.id ? 'text-white' : 'group-hover:text-white'}`}>
                                            <div className="flex flex-col gap-1 items-center">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${
                                                    selectedTransactionId === tx.id 
                                                    ? 'bg-white/20 text-white border-white/30' 
                                                    : (status === 'cancelled' 
                                                        ? 'bg-red-100 text-red-700 border-red-200' 
                                                        : 'bg-emerald-100 text-emerald-700 border-emerald-200')
                                                }`}>
                                                    {status === 'cancelled' ? 'Cancelled' : 'Completed'}
                                                </span>
                                                {tx.sync_status === 'pending' && (
                                                    <span className={`text-[8px] font-black px-1 border uppercase animate-pulse ${selectedTransactionId === tx.id ? 'text-white border-white/40 bg-white/10' : 'text-amber-600 bg-amber-50 border-amber-200'}`}>
                                                        Sync Pending
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-2 text-center" onClick={(e) => e.stopPropagation()}>
                                            {(() => {
                                                const rxList = getPrescriptionsFor(tx);
                                                if (rxList.length === 0) {
                                                    return <span className={`text-[10px] font-bold ${selectedTransactionId === tx.id ? 'text-white/40' : 'text-gray-300 group-hover:text-white/40'}`}>—</span>;
                                                }
                                                return (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleViewRxFor(tx)}
                                                        title={`View ${rxList.length} prescription${rxList.length === 1 ? '' : 's'}`}
                                                        className={`inline-flex items-center gap-1 px-2 py-1 border text-[10px] font-black uppercase transition-colors ${
                                                            selectedTransactionId === tx.id
                                                                ? 'bg-white/10 border-white/40 text-white hover:bg-white/20'
                                                                : 'bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100 group-hover:bg-white/10 group-hover:border-white/40 group-hover:text-white'
                                                        }`}
                                                    >
                                                        <RxIcon className="w-3 h-3" />
                                                        {rxList.length > 1 ? `Rx · ${rxList.length}` : 'Rx'}
                                                    </button>
                                                );
                                            })()}
                                        </td>
                                    </tr>
                                )})}
                            </tbody>
                        </table>
                    </div>
                    {/* Pagination Footer */}
                    {totalPages > 1 && (
                        <div className="p-2 bg-gray-100 border-t border-gray-400 flex justify-between items-center flex-shrink-0">
                            <div className="text-[10px] font-black uppercase text-gray-500 tracking-widest ml-2">
                                Showing {paginatedTransactions.length} of {filteredAndSortedTransactions.length} items
                            </div>
                            <div className="flex items-center gap-1">
                                <button 
                                    disabled={currentPage === 1}
                                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                                    className="px-4 h-8 border border-gray-400 bg-white text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-50 transition-colors shadow-sm"
                                >
                                    Prev
                                </button>
                                
                                <div className="flex items-center gap-1 mx-2">
                                    {renderPageNumbers()}
                                </div>

                                <button 
                                    disabled={currentPage === totalPages}
                                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                                    className="px-4 h-8 border border-gray-400 bg-white text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-50 transition-colors shadow-sm"
                                >
                                    Next
                                </button>
                            </div>
                            <div className="text-[9px] font-bold text-gray-400 uppercase mr-2 italic">
                                Use ← → keys to flip pages
                            </div>
                        </div>
                    )}
                </Card>
            </div>
            <ConfirmModal isOpen={isConfirmOpen} onClose={() => setIsConfirmOpen(false)} onConfirm={handleConfirmCancel} title="Cancel Invoice" message="Are you sure you want to cancel this invoice? Inventory will be reversed." />
            
            <JournalEntryViewerModal
                isOpen={!!journalTransaction}
                onClose={() => setJournalTransaction(null)}
                invoiceId={journalTransaction?.id}
                invoiceNumber={journalTransaction?.invoiceNumber || journalTransaction?.id}
                documentType="SALES"
                currentUser={currentUser}
                isPosted={(journalTransaction?.status || '') === 'completed'}
            />

            {viewingTransaction && (
                <Modal
                    isOpen={!!viewingTransaction}
                    onClose={() => setViewingTransaction(null)}
                    title={`View Sales Invoice: ${formatVoucherNo(viewingTransaction.invoiceNumber || viewingTransaction.id)}`}
                >
                    <div className="h-[90vh] overflow-hidden flex flex-col">
                        <POS
                            inventory={inventory}
                            purchases={purchases}
                            medicines={medicines}
                            customers={customers}
                            transactions={transactions}
                            onSaveOrUpdateTransaction={() => Promise.resolve()}
                            onPrintBill={onPrintBill}
                            currentUser={currentUser}
                            config={{}}
                            configurations={configurations}
                            transactionToEdit={viewingTransaction}
                            isReadOnly={true}
                            onCancel={() => setViewingTransaction(null)}
                            onAddMedicineMaster={onAddMedicineMaster}
                            onQuickAddCustomer={onQuickAddCustomer}
                            addNotification={() => {}}
                        />
                    </div>
                </Modal>
            )}

            {rxViewingTransaction && (
                <PrescriptionPreviewModal
                    transaction={rxViewingTransaction}
                    urls={getPrescriptionsFor(rxViewingTransaction)}
                    onClose={() => setRxViewingTransaction(null)}
                />
            )}
        </main>
    );
};

export default SalesHistory;
