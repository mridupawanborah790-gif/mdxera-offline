import React, { useState, useEffect } from 'react';
import Modal from '@core/components/ui/Modal';

type MobileSyncStatus = 'pending' | 'syncing' | 'uploading' | 'synced' | 'imported' | 'failed';

interface MobileSyncModalProps {
    isOpen: boolean;
    onClose: () => void;
    sessionId: string | null;
    orgId: string;
    userId?: string;
    deviceId?: string;
    status?: MobileSyncStatus;
    errorMessage?: string | null;
    pageCount?: number;
    invoiceId?: string | null;
}

const getStatusLabel = (status: MobileSyncStatus) => {
    switch (status) {
        case 'pending': return 'Pending';
        case 'syncing': return 'Syncing…';
        case 'uploading': return 'Uploading';
        case 'synced': return 'Synced';
        case 'imported': return 'Imported Successfully';
        case 'failed': return 'Failed';
    }
};

const MobileSyncModal: React.FC<MobileSyncModalProps> = ({
    isOpen,
    onClose,
    sessionId,
    orgId,
    userId = '',
    deviceId = '',
    status = 'pending',
    errorMessage = null,
    pageCount = 0,
    invoiceId = null,
}) => {
    const [copied, setCopied] = useState(false);
    const [localIp, setLocalIp] = useState<string | null>(null);
    const [customBaseUrl, setCustomBaseUrl] = useState(() => {
        return localStorage.getItem('mdxera_mobile_sync_base_url') || '';
    });
    const [showSettings, setShowSettings] = useState(false);

    useEffect(() => {
        if (!isOpen) return;

        // Auto-detect computer's local IP address if running in Tauri environment
        const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
        if (isTauri) {
            import('@tauri-apps/api/core').then(({ invoke }) => {
                invoke<string | null>('get_local_ip').then(ip => {
                    if (ip) {
                        setLocalIp(ip);
                    }
                }).catch(err => {
                    console.error('Failed to get local IP', err);
                });
            });
        }
    }, [isOpen]);

    if (!isOpen || !sessionId) return null;

    const origin = window.location.origin;
    const pathname = window.location.pathname;

    // Detect local environment (localhost, loopback, or custom Tauri protocol)
    const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1') || origin.startsWith('tauri://');

    // Build the resolved base URL
    let resolvedBaseUrl = origin + pathname;
    if (customBaseUrl) {
        resolvedBaseUrl = customBaseUrl;
    } else if (isLocal) {
        // Fallback to the production web portal which is served over secure HTTPS
        // and connects to the same cloud Supabase instance.
        resolvedBaseUrl = 'https://mdxera.in';
    }

    const syncUrl = `${resolvedBaseUrl}${resolvedBaseUrl.includes('?') ? '&' : '?'}sync_session=${sessionId}&org_id=${orgId}&user_id=${encodeURIComponent(userId)}&device_id=${encodeURIComponent(deviceId)}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(syncUrl)}`;

    const handleCopyLink = () => {
        navigator.clipboard.writeText(syncUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleSaveCustomBaseUrl = (url: string) => {
        setCustomBaseUrl(url);
        if (url) {
            localStorage.setItem('mdxera_mobile_sync_base_url', url);
        } else {
            localStorage.removeItem('mdxera_mobile_sync_base_url');
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Magic Mobile Link" widthClass="max-w-md">
            <div className="p-8 flex flex-col items-center text-center rounded-none max-h-[85vh] overflow-y-auto">
                <div className="w-16 h-16 bg-primary/10 text-primary rounded-none flex items-center justify-center mb-6 ring-8 ring-primary/5 flex-shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg>
                </div>

                <h3 className="text-xl font-black text-gray-900 dark:text-white uppercase tracking-tight mb-2">Sync Your Phone</h3>
                <p className="text-sm text-gray-500 font-medium leading-relaxed mb-6 px-4">
                    Scan this QR code with your mobile camera to capture and transfer one or more purchase bill photos into a single draft voucher.
                </p>

                <div className="p-4 bg-white rounded-none border-4 border-primary/20 shadow-2xl relative group mb-4 flex-shrink-0">
                    <img src={qrUrl} alt="Sync QR" className="w-56 h-56 rendering-pixelated" />
                    <div className="absolute inset-0 border-2 border-primary/10 rounded-none animate-pulse pointer-events-none"></div>
                </div>

                <div className="flex gap-2 mb-6">
                    <button
                        onClick={handleCopyLink}
                        className={`px-4 py-2 text-[10px] font-black uppercase border-2 transition-all ${copied ? 'bg-emerald-50 border-emerald-500 text-emerald-700 dark:text-emerald-500' : 'bg-white dark:bg-zinc-900 border-gray-300 dark:border-zinc-700 text-gray-500 hover:border-primary hover:text-primary'}`}
                    >
                        {copied ? 'Link Copied!' : 'Copy Manual Link'}
                    </button>
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className={`px-3 py-2 text-[10px] font-black uppercase border-2 transition-all ${showSettings ? 'bg-primary border-primary text-white' : 'bg-white dark:bg-zinc-900 border-gray-300 dark:border-zinc-700 text-gray-500 hover:border-primary hover:text-primary'}`}
                    >
                        {showSettings ? 'Hide Settings' : 'Connection Settings'}
                    </button>
                </div>

                {showSettings && (
                    <div className="w-full bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 p-4 mb-6 text-left space-y-3 text-xs transition-all">
                        <div className="font-bold text-gray-700 dark:text-gray-300 uppercase text-[9px] tracking-wider flex items-center gap-1">
                            <span>⚙️</span> Sync URL Configurations
                        </div>
                        <p className="text-gray-500 text-[11px] leading-relaxed">
                            By default, local and Tauri installations route mobile capture requests through the secure public web app at <strong className="text-primary font-black">https://mdxera.in</strong>.
                        </p>
                        <p className="text-gray-500 text-[11px] leading-relaxed">
                            This guarantees instant camera access over HTTPS, and syncs data seamlessly via the cloud without requiring your devices to be on the same local network.
                        </p>

                        <div className="space-y-1">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Sync Host Override</label>
                            <input
                                type="text"
                                value={customBaseUrl}
                                onChange={(e) => handleSaveCustomBaseUrl(e.target.value)}
                                placeholder="e.g. https://staging.mdxera.in"
                                className="w-full px-2 py-1.5 bg-white dark:bg-zinc-950 border border-gray-300 dark:border-zinc-700 rounded-none text-xs font-mono text-gray-800 dark:text-white outline-none focus:border-primary"
                            />
                            <p className="text-[9px] text-gray-400">
                                If you are running a custom staging site or an independent local web server (like Vite or ngrok), you can override the base URL here. Leave blank to default to <code className="font-mono">https://mdxera.in</code>.
                            </p>
                        </div>
                    </div>
                )}

                <div className="w-full bg-slate-50 dark:bg-slate-800 px-4 py-3 rounded-none border border-app-border text-left space-y-1">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Sync Status</span>
                        <span className="text-[10px] font-black uppercase text-primary">{getStatusLabel(status)}</span>
                    </div>
                    {invoiceId && <p className="text-[10px] font-bold text-gray-500">Invoice ID: {invoiceId}</p>}
                    {pageCount > 0 && <p className="text-[10px] font-bold text-gray-500">Pages received: {pageCount}</p>}
                    {status === 'failed' && errorMessage && <p className="text-[10px] font-bold text-red-600">Error: {errorMessage}</p>}
                </div>

                <button
                    onClick={onClose}
                    className="mt-8 text-xs font-bold text-gray-400 hover:text-primary uppercase tracking-tighter transition-colors"
                >
                    Dismiss Link
                </button>
            </div>
        </Modal>
    );
};

export default MobileSyncModal;
