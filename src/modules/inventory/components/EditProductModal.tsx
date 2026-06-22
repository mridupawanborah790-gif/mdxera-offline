import React, { useState, useEffect, useMemo, useRef } from 'react';
import Modal from '@core/components/ui/Modal';
import type { InventoryItem, Medicine, RegisteredPharmacy } from '@core/types';
import { renderBarcode, generateRandomBarcode } from '@core/utils/barcode';
import { handleEnterToNextField } from '@core/utils/navigation';
import { normalizeImportDate, formatExpiryToMMYY } from '@core/utils/helpers';
import { buildTotalStockFromBreakup, getStockBreakup } from '@core/utils/stock';
import { isLiquidOrWeightPack, resolveUnitsPerStrip } from '@core/utils/pack';
import { materialKey } from '../services/materialMasterSync';
import AddMedicineModal from './AddMedicineModal';

interface EditProductModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (updatedProduct: InventoryItem) => void;
    productToEdit: InventoryItem | null;
    onPrintBarcodeClick?: (item: InventoryItem) => void;
    onNext?: () => void;
    onPrevious?: () => void;
    hasNext?: boolean;
    hasPrevious?: boolean;
    /** All inventory rows — used to find sibling batches of this material. */
    inventory?: InventoryItem[];
    medicines?: Medicine[];
    currentUser?: RegisteredPharmacy | null;
    addNotification?: (message: string, type: 'success' | 'error' | 'warning') => void;
    onRefresh?: () => Promise<void> | void;
    /** Bound to App.handleAddMedicineMaster — creates the master and
     *  auto-links sibling inventory rows by name+brand. */
    onAddMedicineMaster?: (med: Omit<Medicine, 'id'>) => Promise<Medicine | void> | Medicine | void;
    isReadOnly?: boolean;
}

const matrixRowTextStyle = "text-2xl font-normal tracking-tight uppercase leading-tight";

const EditProductModal: React.FC<EditProductModalProps> = ({
    isOpen,
    onClose,
    onSave,
    productToEdit,
    onPrintBarcodeClick,
    onNext,
    onPrevious,
    hasNext,
    hasPrevious,
    inventory = [],
    medicines = [],
    currentUser,
    addNotification,
    onRefresh,
    onAddMedicineMaster,
    isReadOnly = false,
}) => {
    const [product, setProduct] = useState<InventoryItem | null>(null);
    const [expiryDisplay, setExpiryDisplay] = useState('');
    const [isAddMasterOpen, setIsAddMasterOpen] = useState(false);
    const barcodeRef = useRef<SVGSVGElement>(null);

    useEffect(() => {
        if (isOpen && productToEdit) {
            setProduct({ ...productToEdit });
            setExpiryDisplay(formatExpiryToMMYY(productToEdit.expiry));
        }
    }, [isOpen, productToEdit]);

    useEffect(() => {
        if (isOpen && product?.barcode && barcodeRef.current) {
            renderBarcode(barcodeRef.current, product.barcode);
        }
    }, [product?.barcode, isOpen]);

    const linkedMaster = useMemo(() => {
        if (!product) return null;
        const code = (product.code || '').trim();
        if (code) {
            const byCode = medicines.find(m => (m.materialCode || '').trim() === code);
            if (byCode) return byCode;
        }
        const key = materialKey(product.name, product.brand);
        return medicines.find(m => materialKey(m.name, m.brand) === key) || null;
    }, [product?.code, product?.name, product?.brand, medicines]);

    // Auto-link to Material Master on open: if a master matches this row by
    // name+brand but the inventory row has no code yet, stamp the code and
    // persist immediately so the user doesn't have to hit Save just to link.
    // The ref guards against re-firing while the async save is in flight (the
    // parent may re-render with productToEdit still lacking code). Cleared on
    // close so reopening always retries if the link still hasn't taken.
    const autoLinkedIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isOpen) {
            autoLinkedIdRef.current = null;
            return;
        }
        if (!product) return;
        if ((product.code || '').trim()) return;
        const masterCode = linkedMaster?.materialCode;
        if (!masterCode) return;
        if (autoLinkedIdRef.current === product.id) return;
        autoLinkedIdRef.current = product.id;
        const linked = { ...product, code: masterCode };
        setProduct(linked);
        void Promise.resolve(onSave(linked));
    }, [isOpen, product, linkedMaster, onSave]);

    /** Seed the AddMedicineModal from this inventory row so the user can
     *  review/tweak pack, GST, MRP, etc. before the master is created. */
    const masterInitialValues = useMemo((): Partial<Medicine> | undefined => {
        if (!product) return undefined;
        const packStr = (product.packType || '').trim();
        return {
            name: product.name || '',
            brand: product.brand || '',
            manufacturer: product.manufacturer || '',
            composition: product.composition || '',
            pack: packStr || '',
            barcode: product.barcode || '',
            hsnCode: product.hsnCode || '',
            gstRate: Number(product.gstPercent ?? 0),
            mrp: product.mrp != null ? String(product.mrp) : '0',
            description: product.description || '',
            materialMasterType: 'trading_goods',
            isInventorised: true,
            isSalesEnabled: true,
            isPurchaseEnabled: true,
            isPrescriptionRequired: false,
            valuationMethod: 'standard',
            standardPriceRate: Number(product.purchasePrice ?? 0) || 0,
            is_active: true,
        };
    }, [product]);

    if (!isOpen || !product) return null;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        if (isReadOnly) return;
        const { name, value, type } = e.target;
        
        if (name === 'expiry') {
            const cleaned = value.replace(/\D/g, '');
            let formatted = cleaned;
            if (cleaned.length === 0) {
                formatted = '';
            } else {
                let month = cleaned.slice(0, 2);
                let year = cleaned.slice(2, 4);
                if (month.length === 2) {
                    let m = parseInt(month);
                    if (m > 12) month = '12';
                    if (m === 0) month = '01';
                }
                if (cleaned.length > 2) formatted = `${month}/${year}`;
                else formatted = month;
            }
            setExpiryDisplay(formatted);
            if (formatted.length === 5) {
                const normalized = normalizeImportDate(formatted);
                setProduct(prev => prev ? ({ ...prev, expiry: normalized || '' }) : null);
            }
            return;
        }

        if (name === 'packType') {
            const inferredUnitsPerPack = parseInt(value.match(/\d+/)?.[0] || '1', 10);
            setProduct(prev => prev ? ({
                ...prev,
                packType: value,
                unitsPerPack: resolveUnitsPerStrip(inferredUnitsPerPack, value),
            }) : null);
            return;
        }

        setProduct(prev => prev ? ({
            ...prev,
            [name]: type === 'number' ? (parseFloat(value) || 0) : value,
        }) : null);
    };

    const handleSave = () => {
        if (isReadOnly || !product) return;
        // If a Material Master exists for this name+brand but no code is set
        // on the inventory row, stamp it now so the link actually persists.
        const codeToSave = (product.code || '').trim();
        const finalProduct = (!codeToSave && linkedMaster?.materialCode)
            ? { ...product, code: linkedMaster.materialCode }
            : product;
        onSave(finalProduct);
        onClose();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
        if (e.altKey && e.key.toLowerCase() === 'n' && hasNext && onNext) {
            e.preventDefault();
            onNext();
        } else if (e.altKey && e.key.toLowerCase() === 'p' && hasPrevious && onPrevious) {
            e.preventDefault();
            onPrevious();
        } else {
            handleEnterToNextField(e);
        }
    };

    const canLinkToMaster = !linkedMaster && !!currentUser && !!onAddMedicineMaster && !isReadOnly;

    const unitsPerPack = resolveUnitsPerStrip(product.unitsPerPack, product.packType);
    const isLiquidOrWeight = isLiquidOrWeightPack(product.packType);
    const stockBreakup = getStockBreakup(product.stock, unitsPerPack, product.packType);

    const handleStockBreakupChange = (field: 'pack' | 'loose', value: string) => {
        if (isReadOnly) return;
        const numericValue = Math.max(0, Math.floor(Number(value || 0)));
        const nextPack = field === 'pack' ? numericValue : stockBreakup.pack;
        const nextLoose = field === 'loose' ? numericValue : stockBreakup.loose;
        const totalUnits = buildTotalStockFromBreakup(nextPack, nextLoose, unitsPerPack, !isLiquidOrWeight, product.packType);
        setProduct(prev => prev ? ({ ...prev, stock: totalUnits }) : null);
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={isReadOnly ? `View Inventory: ${product.name}` : `Alter Inventory: ${product.name}`} widthClass="max-w-5xl">
            <div className="flex flex-col h-full bg-white dark:bg-zinc-950 overflow-hidden" onKeyDown={handleKeyDown}>
                {/* Navigation Bar */}
                {(onNext || onPrevious) && (
                    <div className="px-6 py-2 bg-gray-50 border-b border-app-border flex justify-between items-center no-print">
                        <div className="flex gap-2">
                            <button 
                                onClick={onPrevious} 
                                disabled={!hasPrevious}
                                className="px-4 py-1 text-[10px] font-black uppercase border border-gray-400 bg-white hover:bg-gray-50 disabled:opacity-30 transition-all"
                            >
                                ← Previous (Alt+P)
                            </button>
                            <button 
                                onClick={onNext} 
                                disabled={!hasNext}
                                className="px-4 py-1 text-[10px] font-black uppercase border border-gray-400 bg-white hover:bg-gray-50 disabled:opacity-30 transition-all"
                            >
                                Next (Alt+N) →
                            </button>
                        </div>
                        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Navigation Control</span>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                    {/* Header: Core ID & Barcode */}
                    <div className="flex flex-col md:flex-row justify-between items-start gap-8 border-b border-gray-100 pb-8">
                        <div className="flex-1 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                <div className="md:col-span-2">
                                    <label className="block text-[10px] font-black uppercase text-gray-400 tracking-widest mb-1.5 ml-1">Official Name</label>
                                    <input
                                        name="name"
                                        value={product.name}
                                        onChange={handleChange}
                                        readOnly
                                        className="w-full text-2xl font-black uppercase border-b-2 border-gray-100 outline-none bg-transparent text-gray-400 cursor-not-allowed"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black uppercase text-gray-400 tracking-widest mb-1.5 ml-1">Product Code</label>
                                    <input
                                        name="code"
                                        value={product.code || ''}
                                        onChange={handleChange}
                                        readOnly={!!product.code}
                                        placeholder="Link to Master Code"
                                        className={`w-full text-xl font-mono font-bold uppercase border-b-2 outline-none bg-transparent ${product.code ? 'border-gray-100 text-gray-400 cursor-not-allowed' : 'border-gray-300 focus:border-primary'}`}
                                    />
                                    {canLinkToMaster && (
                                        <button
                                            type="button"
                                            onClick={() => setIsAddMasterOpen(true)}
                                            className="mt-2 w-full px-3 py-1.5 text-[10px] font-black uppercase tracking-widest border border-primary text-primary hover:bg-primary hover:text-white transition-colors"
                                            title="Open Material Master creation prefilled from this row"
                                        >
                                            Create in Material Master…
                                        </button>
                                    )}
                                    {!!linkedMaster && !product.code && (
                                        <div className="mt-1 text-[9px] font-bold uppercase text-emerald-700">
                                            Linking to master <span className="font-mono">{linkedMaster.materialCode}</span>…
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-6">
                                <div>
                                    <label className="block text-[10px] font-black uppercase text-gray-400 tracking-widest mb-1.5 ml-1">Brand / MFR</label>
                                    <input name="brand" value={product.brand || ''} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input disabled:bg-gray-100 disabled:opacity-60" />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black uppercase text-gray-400 tracking-widest mb-1.5 ml-1">Category</label>
                                    <input name="category" value={product.category || ''} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input disabled:bg-gray-100 disabled:opacity-60" />
                                </div>
                            </div>
                        </div>
                        <div className="w-full md:w-64 flex flex-col items-center">
                            <div className="bg-white p-4 border-2 border-gray-200 shadow-sm mb-4">
                                <svg ref={barcodeRef} className="w-full h-16"></svg>
                            </div>
                            <div className="flex gap-2 w-full">
                                {!isReadOnly && <button onClick={() => setProduct(prev => prev ? ({...prev, barcode: generateRandomBarcode()}) : null)} className="flex-1 py-1.5 text-[9px] font-black uppercase border border-gray-400 hover:bg-gray-50">Generate</button>}
                                <button onClick={() => onPrintBarcodeClick?.(product)} className="flex-1 py-1.5 text-[9px] font-black uppercase bg-primary text-white hover:bg-primary-dark">Print Labels</button>
                            </div>
                        </div>
                    </div>

                    {/* Stock & Batch Segment */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
                        <div className="bg-primary/5 p-4 border border-primary/10">
                            <label className="block text-[10px] font-black uppercase text-primary tracking-widest mb-2">Batch Number</label>
                            <input name="batch" value={product.batch} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input font-mono !text-lg uppercase disabled:bg-gray-100 disabled:opacity-60" />
                        </div>
                        <div className="bg-red-50 p-4 border border-red-100">
                            <label className="block text-[10px] font-black uppercase text-red-600 tracking-widest mb-2">Expiry (MM/YY)</label>
                            <input name="expiry" value={expiryDisplay} onChange={handleChange} maxLength={5} placeholder="MM/YY" disabled={isReadOnly} className="w-full tally-input !text-lg !text-red-700 disabled:bg-gray-100 disabled:opacity-60" />
                        </div>
                        <div className="bg-emerald-50 p-4 border border-emerald-100 md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-emerald-700 tracking-widest mb-2">Current Stock Breakup</label>
                            <div className="grid gap-4 grid-cols-2">
                                <div>
                                    <label className="block text-[9px] font-black uppercase text-emerald-800 mb-1 ml-1">Pack qty</label>
                                    <input
                                        type="number"
                                        min={0}
                                        value={stockBreakup.pack}
                                        onChange={(e) => handleStockBreakupChange('pack', e.target.value)}
                                        disabled={isReadOnly}
                                        className="w-full tally-input !text-lg !text-emerald-800 disabled:opacity-60 disabled:cursor-not-allowed"
                                    />
                                </div>
                                <div>
                                        <label className="block text-[9px] font-black uppercase text-emerald-800 mb-1 ml-1">Loose qty</label>
                                        <input
                                            type="number"
                                            min={0}
                                            value={stockBreakup.loose}
                                            onChange={(e) => handleStockBreakupChange('loose', e.target.value)}
                                            disabled={isReadOnly || isLiquidOrWeight}
                                            className="w-full tally-input !text-lg !text-emerald-800 disabled:opacity-60 disabled:cursor-not-allowed"
                                        />
                                    </div>
                            </div>
                            {isLiquidOrWeight && (
                                <p className="mt-2 text-[9px] font-black uppercase tracking-wider text-emerald-700">
                                    Liquid/Weight pack detected: loose is always 0 and units per strip is fixed to 1.
                                </p>
                            )}
                            <p className="mt-2 text-[10px] font-black uppercase tracking-wider text-emerald-700">
                                Total Stock (Units): {stockBreakup.totalUnits} = ({stockBreakup.pack} × {unitsPerPack}) + {stockBreakup.loose}
                            </p>
                        </div>
                        <div className="bg-gray-100 p-4 border border-gray-200">
                            <label className="block text-[10px] font-black uppercase text-gray-500 tracking-widest mb-2">Min. Limit</label>
                            <input type="number" name="minStockLimit" value={product.minStockLimit} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input !text-lg disabled:bg-gray-100 disabled:opacity-60" />
                        </div>
                    </div>

                    {/* Pricing Structure */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded-none bg-primary text-white flex items-center justify-center font-black text-[9px]">₹</span>
                            <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-primary">Pricing Structure (Per Pack)</h3>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                            <div>
                                <label className="block text-[9px] font-black uppercase text-gray-400 mb-1 ml-1">Landed Cost</label>
                                <input type="number" name="purchasePrice" value={product.purchasePrice} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input !text-base disabled:bg-gray-100 disabled:opacity-60" />
                            </div>
                            <div>
                                <label className="block text-[9px] font-black uppercase text-gray-400 mb-1 ml-1">P.T.R</label>
                                <input type="number" name="ptr" value={product.ptr || 0} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input !text-base disabled:bg-gray-100 disabled:opacity-60" />
                            </div>
                            <div className="bg-yellow-50/50 p-1">
                                <label className="block text-[9px] font-black uppercase text-yellow-700 mb-1 ml-1">M.R.P</label>
                                <input type="number" name="mrp" value={product.mrp} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input !text-lg border-yellow-400 !bg-white disabled:bg-gray-100 disabled:opacity-60" />
                            </div>
                            <div>
                                <label className="block text-[9px] font-black uppercase text-gray-400 mb-1 ml-1">Rate A</label>
                                <input type="number" name="rateA" value={product.rateA || 0} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input !text-base disabled:bg-gray-100 disabled:opacity-60" />
                            </div>
                            <div>
                                <label className="block text-[9px] font-black uppercase text-gray-400 mb-1 ml-1">Rate B</label>
                                <input type="number" name="rateB" value={product.rateB || 0} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input !text-base disabled:bg-gray-100 disabled:opacity-60" />
                            </div>
                            <div>
                                <label className="block text-[9px] font-black uppercase text-gray-400 mb-1 ml-1">Rate C</label>
                                <input type="number" name="rateC" value={product.rateC || 0} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input !text-base disabled:bg-gray-100 disabled:opacity-60" />
                            </div>
                        </div>
                    </div>

                    {/* Packaging & Tax */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8 pt-4">
                        <div className="space-y-4">
                            <h4 className="text-[10px] font-black uppercase text-gray-500 border-b border-gray-100 pb-1">Packaging Utility</h4>
                            <div>
                                <label className="block text-[9px] font-black uppercase text-gray-400 mb-1 ml-1">Pack (e.g. 10s, 100ml)</label>
                                <input
                                    name="packType"
                                    value={product.packType || ''}
                                    onChange={handleChange}
                                    disabled={isReadOnly}
                                    placeholder="e.g. 10s, 100ml"
                                    className="w-full tally-input disabled:bg-gray-100 disabled:opacity-60"
                                />
                            </div>
                        </div>
                        <div className="space-y-4">
                            <h4 className="text-[10px] font-black uppercase text-gray-500 border-b border-gray-100 pb-1">Statutory Details</h4>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-[9px] font-black uppercase text-gray-400 mb-1 ml-1">G.S.T %</label>
                                    <input type="number" name="gstPercent" value={product.gstPercent} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input disabled:bg-gray-100 disabled:opacity-60" />
                                </div>
                                <div>
                                    <label className="block text-[9px] font-black uppercase text-gray-400 mb-1 ml-1">H.S.N Code</label>
                                    <input name="hsnCode" value={product.hsnCode || ''} onChange={handleChange} disabled={isReadOnly} className="w-full tally-input font-mono disabled:bg-gray-100 disabled:opacity-60" />
                                </div>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <h4 className="text-[10px] font-black uppercase text-gray-500 border-b border-gray-100 pb-1">Asset Monitoring</h4>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="p-2 bg-gray-50 border border-gray-200">
                                    <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest leading-none">Line Value</p>
                                    <p className="text-sm font-black mt-1">₹{(product.value || 0).toLocaleString()}</p>
                                </div>
                                <div className="p-2 bg-blue-50 border border-blue-100">
                                    <p className="text-[8px] font-black text-blue-400 uppercase tracking-widest leading-none">Unit Cost</p>
                                    <p className="text-sm font-black text-blue-900 mt-1">₹{(product.cost || 0).toFixed(2)}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="p-4 bg-gray-50 border-t border-app-border flex justify-end gap-3 flex-shrink-0">
                    <button type="button" onClick={onClose} className="px-8 py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-black">{isReadOnly ? 'Close' : 'Discard'}</button>
                    {!isReadOnly && (
                        <button 
                            type="button"
                            onClick={handleSave}
                            className="px-16 py-4 bg-primary text-white text-[12px] font-black uppercase tracking-[0.3em] shadow-2xl hover:bg-primary-dark transition-all transform active:scale-95"
                        >
                            Accept Alteration (Enter)
                        </button>
                    )}
                </div>
            </div>
            {isAddMasterOpen && onAddMedicineMaster && currentUser && (
                <AddMedicineModal
                    isOpen={isAddMasterOpen}
                    onClose={() => setIsAddMasterOpen(false)}
                    organizationId={currentUser.organization_id}
                    onAddMedicine={(med) => onAddMedicineMaster({ ...med, organization_id: currentUser.organization_id }) as any}
                    onMedicineSaved={async (saved) => {
                        // Stamp the new code onto the local product state so
                        // the user just clicks Accept Alteration to also
                        // persist any other field edits.
                        setProduct(prev => prev ? { ...prev, code: saved.materialCode } : prev);
                        addNotification?.(
                            `Linked to Material Master · code ${saved.materialCode}`,
                            'success',
                        );
                        await onRefresh?.();
                    }}
                    initialValues={masterInitialValues}
                    existingMedicines={medicines}
                />
            )}
        </Modal>
    );
};

export default EditProductModal;
