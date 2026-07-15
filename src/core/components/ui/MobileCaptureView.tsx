import React, { useRef, useState, useEffect } from 'react';
import { broadcastSyncMessage, createMobileSyncedBill, getOrCreateMobileDeviceId } from '@core/services/storageService';

interface MobileCaptureViewProps {
    sessionId: string;
    orgId: string;
}

type UploadState = 'pending' | 'uploading' | 'synced' | 'failed';

interface CapturedPage {
    id: string;
    image: string;
    mimeType: string;
    pageNumber: number;
    capturedAt: string;
}

const safeRandomUUID = (): string => {
    if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
};

const MobileCaptureView: React.FC<MobileCaptureViewProps> = ({ sessionId, orgId }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [capturedPages, setCapturedPages] = useState<CapturedPage[]>([]);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [uploadState, setUploadState] = useState<UploadState>('pending');
    const [error, setError] = useState<string | null>(null);
    const [invoiceId, setInvoiceId] = useState<string>(() => safeRandomUUID());

    const queryParams = new URLSearchParams(window.location.search);
    const userId = queryParams.get('user_id') || '';
    const deviceId = queryParams.get('device_id') || '';

    useEffect(() => {
        startCamera();
        return () => stopCamera();
    }, []);

    const startCamera = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                }
            });
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                setIsStreaming(true);
            }
        } catch (err) {
            setError('Camera access required. Please enable permission and use HTTPS.');
        }
    };

    const stopCamera = () => {
        const stream = videoRef.current?.srcObject as MediaStream;
        stream?.getTracks().forEach((t) => t.stop());
    };
const handleCapture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    // Downscale to max side of 1800 to prevent large payloads
    const MAX_SIDE = 1800;
    let width = video.videoWidth;
    let height = video.videoHeight;

    if (width > MAX_SIDE || height > MAX_SIDE) {
        if (width > height) {
            height = Math.round((height * MAX_SIDE) / width);
            width = MAX_SIDE;
        } else {
            width = Math.round((width * MAX_SIDE) / height);
            height = MAX_SIDE;
        }
    }

    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const base64 = dataUrl.split(',')[1];
    const nextPage = capturedPages.length + 1;

    setCapturedPages(prev => ([...prev, {
        id: safeRandomUUID(),
        image: base64,
        mimeType: 'image/jpeg',
        pageNumber: nextPage,
        capturedAt: new Date().toISOString(),
    }]));
    setPreviewUrl(dataUrl);
    setUploadState('pending');
    setError(null);
};

    const handleRemovePage = (id: string) => {
        setCapturedPages(prev => prev.filter(p => p.id !== id).map((p, index) => ({ ...p, pageNumber: index + 1 })));
    };

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setError(null);
        setUploadState('pending');

        const newPages: CapturedPage[] = [];
        let pageNumOffset = capturedPages.length;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file.type.startsWith('image/')) {
                setError('Only image files are supported.');
                continue;
            }

            try {
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = () => reject(new Error('Failed to read file.'));
                    reader.readAsDataURL(file);
                });

                const base64 = await new Promise<string>((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = canvasRef.current;
                        if (!canvas) {
                            reject(new Error('Canvas not found'));
                            return;
                        }
                        const context = canvas.getContext('2d');
                        if (!context) {
                            reject(new Error('Canvas context not found'));
                            return;
                        }

                        const MAX_SIDE = 1800;
                        let width = img.width;
                        let height = img.height;

                        if (width > MAX_SIDE || height > MAX_SIDE) {
                            if (width > height) {
                                height = Math.round((height * MAX_SIDE) / width);
                                width = MAX_SIDE;
                            } else {
                                width = Math.round((width * MAX_SIDE) / height);
                                height = MAX_SIDE;
                            }
                        }

                        canvas.width = width;
                        canvas.height = height;
                        context.fillStyle = '#fff';
                        context.fillRect(0, 0, width, height);
                        context.drawImage(img, 0, 0, width, height);
                        const outputDataUrl = canvas.toDataURL('image/jpeg', 0.8);
                        resolve(outputDataUrl.split(',')[1]);
                    };
                    img.onerror = () => reject(new Error('Failed to load image.'));
                    img.src = dataUrl;
                });

                pageNumOffset++;
                newPages.push({
                    id: safeRandomUUID(),
                    image: base64,
                    mimeType: 'image/jpeg',
                    pageNumber: pageNumOffset,
                    capturedAt: new Date().toISOString(),
                });
            } catch (err: any) {
                console.error(err);
                setError(`Failed to process: ${file.name}`);
            }
        }

        if (newPages.length > 0) {
            setCapturedPages(prev => [...prev, ...newPages]);
            const lastPage = newPages[newPages.length - 1];
            setPreviewUrl(`data:${lastPage.mimeType};base64,${lastPage.image}`);
        }

        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleSendAll = async () => {
        if (capturedPages.length === 0) return;
        setUploadState('uploading');
        setError(null);

        try {
            // Priority: Query params (from QR) > localStorage > random
            const effectiveDeviceId = deviceId || getOrCreateMobileDeviceId();
            const effectiveUserId = userId || sessionId; 

            const syncPayload = {
                type: 'invoice-upload',
                invoiceId,
                pages: capturedPages.map((page, index) => ({
                    image: page.image,
                    mimeType: page.mimeType,
                    pageNumber: index + 1,
                    capturedAt: page.capturedAt,
                })),
                metadata: {
                    organizationId: orgId,
                    userId: effectiveUserId,
                    deviceId: effectiveDeviceId,
                    sessionId,
                },
            };

            await createMobileSyncedBill({
                session_id: sessionId,
                organization_id: orgId,
                user_id: effectiveUserId,
                device_id: effectiveDeviceId,
                invoice_id: invoiceId,
                payload: syncPayload,
            });
            await broadcastSyncMessage(sessionId, syncPayload);
            setUploadState('synced');
        } catch (err: any) {
            console.error('Upload error details:', err);
            setUploadState('failed');
            
            let detailedError = 'Upload failed. Please check network and retry.';
            if (err && typeof err === 'object') {
                detailedError = err.message || err.details || err.hint || JSON.stringify(err);
            } else if (typeof err === 'string') {
                detailedError = err;
            }
            
            setError(detailedError);
        }
    };

    const resetInvoice = () => {
        setCapturedPages([]);
        setPreviewUrl(null);
        setUploadState('pending');
        setError(null);
        setInvoiceId(safeRandomUUID());
    };

    return (
        <div className="fixed inset-0 bg-black flex flex-col items-center justify-center text-white p-6 font-sans">
            <div className="w-full max-w-md flex flex-col h-full">
                <div className="text-center py-6">
                    <h1 className="text-xl font-black uppercase tracking-tight">Medimart Sync</h1>
                    <p className="text-xs text-white/50 uppercase tracking-widest mt-1">Capture Multi-Page Purchase Bill</p>
                </div>

                <div className="flex-1 relative bg-white/5 rounded-[2rem] overflow-hidden border border-white/10 shadow-2xl">
                    <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                    {previewUrl && (
                        <div className="absolute bottom-3 right-3 w-20 h-28 border border-white/60 bg-black/50">
                            <img src={previewUrl} alt="Latest capture" className="w-full h-full object-cover" />
                        </div>
                    )}
                    {error && <div className="absolute inset-x-2 bottom-2 text-[11px] bg-red-600/80 p-2 rounded">{error}</div>}
                </div>

                <input
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                />
                <canvas ref={canvasRef} className="hidden" />

                <div className="py-4 space-y-3">
                    <div className="flex justify-between text-[10px] uppercase font-black">
                        <span>Invoice: {invoiceId.slice(0, 8)}</span>
                        <span>Pages: {capturedPages.length}</span>
                    </div>

                    {capturedPages.length > 0 && (
                        <div className="max-h-24 overflow-auto bg-white/10 p-2 rounded flex gap-2">
                            {capturedPages.map(page => (
                                <div key={page.id} className="relative w-14 h-20 border border-white/40 shrink-0">
                                    <img src={`data:${page.mimeType};base64,${page.image}`} className="w-full h-full object-cover" alt={`Page ${page.pageNumber}`} />
                                    <button onClick={() => handleRemovePage(page.id)} className="absolute -top-2 -right-2 w-4 h-4 bg-red-500 text-[9px]">×</button>
                                    <span className="absolute bottom-0 left-0 right-0 text-center text-[8px] bg-black/70">{page.pageNumber}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        <button onClick={handleCapture} disabled={!isStreaming} className="py-3 bg-white text-black rounded font-black text-xs uppercase hover:bg-white/90 active:scale-95 transition-all shadow-md">Capture Photo</button>
                        <button onClick={() => fileInputRef.current?.click()} className="py-3 bg-zinc-800 text-white rounded font-black text-xs uppercase border border-white/20 hover:bg-zinc-700 active:scale-95 transition-all shadow-md">Choose Images</button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <button onClick={handleSendAll} disabled={capturedPages.length === 0 || uploadState === 'uploading'} className="py-3 bg-primary rounded font-black text-xs uppercase disabled:opacity-40 hover:bg-primary/95 active:scale-95 transition-all shadow-lg col-span-1">
                            {uploadState === 'uploading' ? 'Uploading...' : 'Sync All'}
                        </button>
                        <button onClick={resetInvoice} className="py-3 bg-white/10 rounded font-black text-xs uppercase hover:bg-white/25 active:scale-95 transition-all shadow-md col-span-1">New Bill</button>
                    </div>

                    <div className="text-[10px] uppercase font-black tracking-widest text-center">
                        Status: {uploadState === 'pending' ? 'Pending' : uploadState === 'uploading' ? 'Uploading' : uploadState === 'synced' ? 'Synced' : 'Failed'}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MobileCaptureView;
