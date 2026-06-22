import React, { useState, useCallback, useEffect } from 'react';
import Modal from '@core/components/ui/Modal';
import type { InventoryItem, Medicine } from '@core/types';
import { getResolvedMedicinePolicy, MATERIAL_TYPE_RULES, type MaterialMasterType } from '@core/utils/materialType';

interface EditMedicineModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (updatedMedicine: Medicine) => void | Promise<void>;
    medicine: Medicine | null;
    organizationType?: string | null;
    existingMedicines?: Medicine[];
    inventoryItems?: InventoryItem[];
    isReadOnly?: boolean;
}

const calculateMovingAverageRate = (medicine: Medicine, inventoryItems: InventoryItem[]): number => {
    const normalizedCode = String(medicine.materialCode || '').trim().toLowerCase();
    const normalizedName = String(medicine.name || '').trim().toLowerCase();
    const relatedBatches = inventoryItems.filter((item) => {
        const itemCode = String(item.code || '').trim().toLowerCase();
        const itemName = String(item.name || '').trim().toLowerCase();
        return (normalizedCode && itemCode === normalizedCode) || itemName === normalizedName;
    });
    if (!relatedBatches.length) return 0;
    const totals = relatedBatches.reduce((acc, batch) => {
        const qty = Math.max(0, Number(batch.stock || 0));
        const purchaseRate = Math.max(0, Number(batch.purchasePrice || 0));
        acc.totalQty += qty;
        acc.totalValue += qty * purchaseRate;
        return acc;
    }, { totalQty: 0, totalValue: 0 });
    if (totals.totalQty <= 0 || totals.totalValue <= 0) return 0;
    return Number((totals.totalValue / totals.totalQty).toFixed(2));
};

const EditMedicineModal: React.FC<EditMedicineModalProps> = ({ isOpen, onClose, onSave, medicine, organizationType, existingMedicines = [], inventoryItems = [], isReadOnly = false }) => {
    const [formState, setFormState] = useState<Medicine | null>(null);
    const [errors, setErrors] = useState<Partial<Record<keyof Medicine, string>>>({});

    useEffect(() => {
        if (isOpen && medicine) {
            const movingAverageRate = calculateMovingAverageRate(medicine, inventoryItems);
            setFormState({ ...medicine, movingAverageRate });
            setErrors({});
        }
    }, [isOpen, medicine]); // inventoryItems omitted: default [] creates a new ref each render, which would reset formState on every keystroke

    const validate = useCallback(() => {
        if (!formState) return false;
        const newErrors: Partial<Record<keyof Medicine, string>> = {};
        if (!formState.name.trim()) newErrors.name = "Product Name is required.";
        if (!formState.materialCode?.trim()) newErrors.materialCode = "Material Code is required.";
        const isElectronics = String(organizationType || '').toLowerCase() === 'electronics';
        if (isElectronics && !String(formState.imei || '').trim()) newErrors.imei = 'IMEI is required for Electronics sector.';
        if (String(formState.imei || '').trim()) {
            if (!/^[a-z0-9]+$/i.test(String(formState.imei || '').trim())) newErrors.imei = 'IMEI must be alphanumeric.';
            const duplicate = existingMedicines.some(m => m.id !== formState.id && String(m.imei || '').trim().toLowerCase() === String(formState.imei || '').trim().toLowerCase());
            if (duplicate) newErrors.imei = 'Duplicate IMEI is not allowed.';
        }
        const discount = Number(formState.productDiscount ?? 0);
        if (Number.isNaN(discount) || discount < 0 || discount > 100) newErrors.productDiscount = 'Product Discount must be between 0 and 100.';
        if ((formState.valuationMethod || 'standard') === 'standard' && Number(formState.standardPriceRate || 0) < 0) newErrors.standardPriceRate = 'Standard Price Rate cannot be negative.';
        
        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    }, [formState]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isReadOnly) return;
        if (formState && validate()) {
            try {
                await onSave(formState);
                onClose();
            } catch (err: any) {
                console.error('[EditMedicineModal] onSave failed:', err);
                alert(err.message || 'Failed to save medicine');
            }
        }
    };
    
    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        if (!formState || isReadOnly) return;
        const { name, value, type } = e.target;
        if (name === 'materialMasterType') {
            const policy = getResolvedMedicinePolicy({ materialMasterType: value as MaterialMasterType });
            setFormState(prev => prev ? ({
                ...prev,
                materialMasterType: value as MaterialMasterType,
                isInventorised: policy.inventorised,
                isSalesEnabled: policy.salesEnabled,
                isPurchaseEnabled: policy.purchaseEnabled,
                isProductionEnabled: policy.productionEnabled,
                isInternalIssueEnabled: policy.internalIssueEnabled,
            }) : null);
            return;
        }
        const isNumber = type === 'number';
        setFormState(prev => prev ? ({ ...prev, [name]: isNumber ? parseFloat(value) || 0 : value }) : null);
    };

    if (!formState) return null;

    const materialPolicy = getResolvedMedicinePolicy(formState);

    const renderInput = (name: keyof Medicine, label: string, type = 'text', isOptional = true, readOnly = false) => {
        const actualReadOnly = readOnly || isReadOnly;
        return (
            <div>
                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">{label} {!isOptional && '*'}</label>
                <input
                    type={type}
                    name={name}
                    value={(formState[name] as string | number) ?? ''}
                    onChange={actualReadOnly ? undefined : handleChange}
                    readOnly={actualReadOnly}
                    className={`mt-1 block w-full p-2 border font-bold text-sm text-app-text-primary ${actualReadOnly ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed select-none' : `bg-input-bg border-gray-400 ${errors[name] ? 'border-red-500' : 'focus:bg-yellow-50 outline-none'}`}`}
                />
                {errors[name] && <p className="text-[10px] text-red-500 mt-1 uppercase font-bold">{errors[name]}</p>}
            </div>
        );
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`${isReadOnly ? 'View' : 'Alter'} Material Record: ${medicine?.name}`} widthClass="max-w-6xl">
            <form onSubmit={handleSubmit} className="flex flex-col h-full overflow-hidden">
                <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-[var(--modal-bg-light)] dark:bg-[var(--modal-bg-dark)]">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {renderInput('name', 'Product Name', 'text', false, true)}
                        {renderInput('materialCode', 'Material Code', 'text', false, true)}
                        {renderInput('barcode', 'Barcode')}
                        {renderInput('brand', 'Brand Name')}
                        {renderInput('manufacturer', 'Manufacturer')}
                        {renderInput('marketer', 'Marketer')}
                        {renderInput('pack', 'Pack (e.g. 10s, 100ml)')}
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Material Master Type *</label>
                            <select
                                name="materialMasterType"
                                value={formState.materialMasterType || 'trading_goods'}
                                onChange={handleChange}
                                disabled={isReadOnly}
                                className={`mt-1 block w-full p-2 border border-gray-400 font-bold text-sm bg-white text-app-text-primary ${isReadOnly ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed select-none' : 'focus:bg-yellow-50 outline-none'}`}
                            >
                                {Object.entries(MATERIAL_TYPE_RULES).map(([value, rule]) => (
                                    <option key={value} value={value}>{rule.label}</option>
                                ))}
                            </select>
                        </div>
                        {renderInput('countryOfOrigin', 'Country of Origin')}
                    </div>

                    <div className="bg-blue-50 p-4 border border-blue-100 grid grid-cols-1 md:grid-cols-3 gap-3">
                        <label className="text-xs font-bold uppercase text-blue-900 flex items-center gap-2">
                            <input type="checkbox" checked={Boolean(formState.isInventorised ?? materialPolicy.inventorised)} onChange={(e) => !isReadOnly && setFormState(p => p ? ({ ...p, isInventorised: e.target.checked }) : null)} disabled={isReadOnly} className="w-4 h-4 text-primary" />
                            Inventorised
                        </label>
                        <label className="text-xs font-bold uppercase text-blue-900 flex items-center gap-2">
                            <input type="checkbox" checked={Boolean(formState.isSalesEnabled ?? materialPolicy.salesEnabled)} onChange={(e) => !isReadOnly && setFormState(p => p ? ({ ...p, isSalesEnabled: e.target.checked }) : null)} disabled={isReadOnly} className="w-4 h-4 text-primary" />
                            Sales Enabled
                        </label>
                        <label className="text-xs font-bold uppercase text-blue-900 flex items-center gap-2">
                            <input type="checkbox" checked={Boolean(formState.isPurchaseEnabled ?? materialPolicy.purchaseEnabled)} onChange={(e) => !isReadOnly && setFormState(p => p ? ({ ...p, isPurchaseEnabled: e.target.checked }) : null)} disabled={isReadOnly} className="w-4 h-4 text-primary" />
                            Purchase Enabled
                        </label>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-1">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Chemical Composition</label>
                            <textarea name="composition" value={formState.composition || ''} onChange={handleChange} readOnly={isReadOnly} rows={2} className={`w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg ${isReadOnly ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed select-none' : 'focus:bg-yellow-50 outline-none'}`} />
                        </div>
                        <div className="md:col-span-1">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Description</label>
                            <textarea name="description" value={formState.description || ''} onChange={handleChange} readOnly={isReadOnly} rows={2} className={`w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg ${isReadOnly ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed select-none' : 'focus:bg-yellow-50 outline-none'}`} />
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Usage Directions</label>
                            <textarea name="directions" value={formState.directions || ''} onChange={handleChange} readOnly={isReadOnly} rows={2} className={`w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg ${isReadOnly ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed select-none' : 'focus:bg-yellow-50 outline-none'}`} />
                        </div>
                    </div>

                    <div className="bg-gray-50 p-4 border border-gray-200">
                        <p className="text-[11px] font-black text-primary uppercase tracking-widest mb-4">Pricing & Taxes</p>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">GST Rate (%)</label>
                                <select name="gstRate" value={formState.gstRate} onChange={handleChange} disabled={isReadOnly} className={`w-full p-2 border border-gray-400 font-bold text-sm bg-white ${isReadOnly ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed select-none' : 'focus:bg-yellow-50 outline-none'}`}>
                                    <option value={0}>0%</option>
                                    <option value={5}>5%</option>
                                    <option value={12}>12%</option>
                                    <option value={18}>18%</option>
                                    <option value={28}>28%</option>
                                </select>
                            </div>
                            {renderInput('hsnCode', 'HSN Code')}
                            {renderInput('imei', 'IMEI', 'text', String(organizationType || '').toLowerCase() !== 'electronics')}
                            {renderInput('productDiscount', 'Product Discount (%)', 'number')}
                        </div>
                    </div>
                    <div className="bg-gray-50 p-4 border border-gray-200">
                        <p className="text-[11px] font-black text-primary uppercase tracking-widest mb-4">Inventory Valuation</p>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Valuation Method</label>
                                <select name="valuationMethod" value={formState.valuationMethod || 'standard'} onChange={handleChange} disabled={isReadOnly} className={`w-full p-2 border border-gray-400 font-bold text-sm bg-white ${isReadOnly ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed select-none' : 'focus:bg-yellow-50 outline-none'}`}>
                                    <option value="standard">Standard</option>
                                    <option value="moving_average">Moving Average</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Standard Price Rate</label>
                                <input type="number" step="0.01" name="standardPriceRate" value={Number(formState.standardPriceRate || 0)} onChange={handleChange} disabled={isReadOnly || (formState.valuationMethod || 'standard') !== 'standard'} className="w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg disabled:bg-gray-100 disabled:text-gray-500 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Moving Average Rate</label>
                                <input type="number" step="0.01" name="movingAverageRate" value={Number(formState.movingAverageRate || 0).toFixed(2)} readOnly className="w-full p-2 border border-gray-400 font-bold text-sm bg-gray-100 text-gray-500 cursor-not-allowed outline-none" />
                            </div>
                        </div>
                    </div>

                    <div className="pt-4 border-t border-gray-100 flex gap-4">
                        <div className="flex items-center gap-2 bg-blue-50 p-3 border border-blue-100 flex-1">
                            <input type="checkbox" id="prescReqEdit" checked={!!formState.isPrescriptionRequired} onChange={e => !isReadOnly && setFormState(p => p ? ({ ...p, isPrescriptionRequired: e.target.checked }) : null)} disabled={isReadOnly} className="w-4 h-4 text-primary" />
                            <label htmlFor="prescReqEdit" className="text-xs font-bold text-blue-900 uppercase">Prescription Required</label>
                        </div>
                        <div className="flex items-center gap-2 bg-gray-50 p-3 border border-gray-100 flex-1">
                            <input type="checkbox" id="isActiveEdit" checked={!!formState.is_active} onChange={e => !isReadOnly && setFormState(p => p ? ({ ...p, is_active: e.target.checked }) : null)} disabled={isReadOnly} className="w-4 h-4 text-primary" />
                            <label htmlFor="isActiveEdit" className="text-xs font-bold text-gray-700 uppercase">Active Record</label>
                        </div>
                    </div>
                </div>
                <div className="p-4 bg-[var(--modal-footer-bg-light)] dark:bg-[var(--modal-footer-bg-dark)] border-t border-[var(--modal-footer-border-light)] dark:border-[var(--modal-footer-border-dark)] flex justify-end gap-3 flex-shrink-0">
                    <button type="button" onClick={onClose} className="px-8 py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-black">{isReadOnly ? 'Close' : 'Cancel'}</button>
                    {!isReadOnly && (
                        <button type="submit" className="px-12 py-3 bg-[var(--modal-header-bg-light)] dark:bg-[var(--modal-header-bg-dark)] text-white text-[11px] font-black uppercase tracking-[0.2em] shadow-xl hover:bg-primary-dark transition-all transform active:scale-95">Update Master Record</button>
                    )}
                </div>
            </form>
        </Modal>
    );
};

export default EditMedicineModal;
