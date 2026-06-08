
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Modal from '@core/components/ui/Modal';
import ConfirmModal from '@core/components/ui/ConfirmModal';
import type { Medicine } from '@core/types';
import { getResolvedMedicinePolicy, MATERIAL_TYPE_RULES, type MaterialMasterType } from '@core/utils/materialType';

interface AddMedicineModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAddMedicine: (newMedicine: Omit<Medicine, 'id' | 'created_at' | 'updated_at'>) => void | Medicine | Promise<void | Medicine>;
    onMedicineSaved?: (savedMedicine: Medicine) => void;
    initialName?: string;
    /** Optional bulk-prefill for all fields (used when seeding from an
     *  inventory row in the alter flow). `initialName` still wins if both
     *  are provided. */
    initialValues?: Partial<Omit<Medicine, 'id' | 'created_at' | 'updated_at'>>;
    organizationId: string;
    organizationType?: string | null;
    existingMedicines?: Medicine[];
}

const initialState: Omit<Medicine, 'id' | 'created_at' | 'updated_at'> = {
    name: '', 
    materialCode: 'Auto-generated on save',
    brand: '', 
    pack: '', 
    hsnCode: '', 
    imei: '',
    productDiscount: 0,
    composition: '', 
    description: '',
    directions: '',
    gstRate: 12, 
    mrp: '0', 
    manufacturer: '',
    marketer: '',
    barcode: '',
    countryOfOrigin: 'India', 
    isPrescriptionRequired: false, 
    materialMasterType: 'trading_goods',
    isInventorised: true,
    isSalesEnabled: true,
    isPurchaseEnabled: true,
    isProductionEnabled: false,
    isInternalIssueEnabled: false,
    valuationMethod: 'standard',
    standardPriceRate: 0,
    movingAverageRate: 0,
    // Renamed isActive to is_active
    is_active: true,
    organization_id: '',
};

type FormErrors = Partial<Record<keyof typeof initialState, string>>;

const AddMedicineModal: React.FC<AddMedicineModalProps> = ({ isOpen, onClose, onAddMedicine, onMedicineSaved, initialName, initialValues, organizationId, organizationType, existingMedicines = [] }) => {
    const [formState, setFormState] = useState(initialState);
    const [errors, setErrors] = useState<FormErrors>({});
    const [showConfirmClose, setShowConfirmClose] = useState(false);

    const [isSaving, setIsSaving] = useState(false);
    const isDirty = useMemo(() => {
        return (
            formState.name !== (initialName || initialState.name) ||
            formState.materialCode !== initialState.materialCode ||
            formState.brand !== initialState.brand ||
            formState.pack !== initialState.pack ||
            formState.hsnCode !== initialState.hsnCode
        );
    }, [formState, initialName]);

    const handleCloseAttempt = () => {
        if (isDirty) {
            setShowConfirmClose(true);
        } else {
            onClose();
        }
    };

    const validate = useCallback(() => {
        const newErrors: FormErrors = {};
        
        if (!organizationId) {
            alert("Application Error: Security context (Organization ID) is missing.");
            return false;
        }

        if (!formState.name.trim()) {
            newErrors.name = "Product Name is required.";
        }
        if ((formState.valuationMethod || 'standard') === 'standard' && Number(formState.standardPriceRate || 0) < 0) {
            newErrors.standardPriceRate = 'Standard Price Rate cannot be negative.';
        }
        const isElectronics = String(organizationType || '').toLowerCase() === 'electronics';
        if (isElectronics && !String(formState.imei || '').trim()) {
            newErrors.imei = 'IMEI is required for Electronics sector.';
        }
        if (String(formState.imei || '').trim()) {
            if (!/^[a-z0-9]+$/i.test(String(formState.imei || '').trim())) {
                newErrors.imei = 'IMEI must be alphanumeric.';
            }
            const duplicate = existingMedicines.some(m => String(m.imei || '').trim() && String(m.imei || '').trim().toLowerCase() === String(formState.imei || '').trim().toLowerCase());
            if (duplicate) newErrors.imei = 'Duplicate IMEI is not allowed.';
        }
        const discount = Number(formState.productDiscount ?? 0);
        if (Number.isNaN(discount) || discount < 0 || discount > 100) {
            newErrors.productDiscount = 'Product Discount must be between 0 and 100.';
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    }, [formState, organizationId]);

    useEffect(() => {
        if (isOpen) {
            setFormState({
                ...initialState,
                ...(initialValues || {}),
                // explicit overrides win over initialValues
                name: initialName || initialValues?.name || '',
                organization_id: organizationId,
            });
            setErrors({});
            setIsSaving(false);
        }
    }, [isOpen, initialName, initialValues, organizationId]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isSaving || !validate()) return;

        try {
            setIsSaving(true);
            const savedMedicine = await onAddMedicine({ ...formState, organization_id: organizationId });
            if (savedMedicine && typeof savedMedicine === 'object' && 'id' in savedMedicine && 'name' in savedMedicine) {
                onMedicineSaved?.(savedMedicine as Medicine);
            }
            onClose();
        } catch (error: any) {
            console.error("Failed to save SKU:", error);
            alert(error.message || "Failed to save SKU. Please try again.");
        } finally {
            setIsSaving(false);
        }
    };
    
    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        if (name === 'materialMasterType') {
            const policy = getResolvedMedicinePolicy({ materialMasterType: value as MaterialMasterType });
            setFormState(prev => ({
                ...prev,
                materialMasterType: value as MaterialMasterType,
                isInventorised: policy.inventorised,
                isSalesEnabled: policy.salesEnabled,
                isPurchaseEnabled: policy.purchaseEnabled,
                isProductionEnabled: policy.productionEnabled,
                isInternalIssueEnabled: policy.internalIssueEnabled,
            }));
            return;
        }
        const isNumber = type === 'number';
        setFormState(prev => ({ ...prev, [name]: isNumber ? parseFloat(value) || 0 : value }));
    };
    
    const materialPolicy = getResolvedMedicinePolicy(formState);

    const renderInput = (
        name: keyof typeof initialState,
        label: string,
        type = 'text',
        isOptional = true,
        placeholder = "",
        options?: { readOnly?: boolean }
    ) => (
        <div>
            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">{label} {!isOptional && '*'}</label>
            <input 
                type={type} 
                name={name} 
                value={formState[name] as string | number} 
                onChange={handleChange} 
                placeholder={placeholder}
                readOnly={options?.readOnly}
                className={`mt-1 block w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg text-app-text-primary ${options?.readOnly ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${errors[name] ? 'border-red-500' : 'focus:bg-yellow-50 outline-none'}`} 
            />
            {errors[name] && <p className="text-[10px] text-red-500 mt-1 uppercase font-bold">{errors[name]}</p>}
        </div>
    );

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title="Register New Material Master Record" widthClass="max-w-6xl">
                <form onSubmit={handleSubmit} className="flex flex-col h-full overflow-hidden">
                    <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-[var(--modal-bg-light)] dark:bg-[var(--modal-bg-dark)]">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {renderInput('name', 'Product Name', 'text', false)}
                            {renderInput('materialCode', 'Material Code', 'text', false, '', { readOnly: true })}
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
                                    className="mt-1 block w-full p-2 border border-gray-400 font-bold text-sm bg-white text-app-text-primary focus:bg-yellow-50 outline-none"
                                >
                                    {Object.entries(MATERIAL_TYPE_RULES).map(([value, rule]) => (
                                        <option key={value} value={value}>{rule.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="bg-blue-50 p-4 border border-blue-100 grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div className="text-xs font-bold uppercase text-blue-900">Inventorised: {materialPolicy.inventorised ? 'Yes' : 'No'}</div>
                                <div className="text-xs font-bold uppercase text-blue-900">Sales Enabled: {materialPolicy.salesEnabled ? 'Yes' : 'No'}</div>
                                <div className="text-xs font-bold uppercase text-blue-900">Purchase Enabled: {materialPolicy.purchaseEnabled ? 'Yes' : 'No'}</div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="md:col-span-1">
                                    <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Chemical Composition (Salt)</label>
                                    <textarea name="composition" value={formState.composition || ''} onChange={handleChange} rows={2} className="w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg focus:bg-yellow-50 outline-none" />
                                </div>
                                <div className="md:col-span-1">
                                    <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Description</label>
                                    <textarea name="description" value={formState.description || ''} onChange={handleChange} rows={2} className="w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg focus:bg-yellow-50 outline-none" />
                                </div>
                                <div className="md:col-span-2">
                                    <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Usage Directions</label>
                                    <textarea name="directions" value={formState.directions || ''} onChange={handleChange} rows={2} className="w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg focus:bg-yellow-50 outline-none" placeholder="e.g. 1-0-1 after meals" />
                                </div>
                            </div>

                            <div className="bg-gray-50 p-4 border border-gray-200">
                                <p className="text-[11px] font-black text-primary uppercase tracking-widest mb-4">Pricing & Taxes</p>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">GST Rate (%)</label>
                                        <select name="gstRate" value={formState.gstRate} onChange={handleChange} className="w-full p-2 border border-gray-400 font-bold text-sm bg-white outline-none">
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
                                        <select name="valuationMethod" value={formState.valuationMethod || 'standard'} onChange={handleChange} className="w-full p-2 border border-gray-400 font-bold text-sm bg-white outline-none">
                                            <option value="standard">Standard</option>
                                            <option value="moving_average">Moving Average</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Standard Price Rate</label>
                                        <input type="number" step="0.01" name="standardPriceRate" value={Number(formState.standardPriceRate || 0)} onChange={handleChange} disabled={(formState.valuationMethod || 'standard') !== 'standard'} className="w-full p-2 border border-gray-400 font-bold text-sm bg-input-bg disabled:bg-gray-100 disabled:text-gray-500 outline-none" />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Moving Average Rate</label>
                                        <input type="number" step="0.01" name="movingAverageRate" value={Number(formState.movingAverageRate || 0).toFixed(2)} readOnly className="w-full p-2 border border-gray-400 font-bold text-sm bg-gray-100 text-gray-500 cursor-not-allowed outline-none" />
                                    </div>
                                </div>
                            </div>

                            <div className="pt-4 border-t border-gray-100 flex gap-4">
                                <div className="flex items-center gap-2 bg-blue-50 p-3 border border-blue-100 flex-1">
                                    <input 
                                        type="checkbox" 
                                        id="prescReq" 
                                        checked={!!formState.isPrescriptionRequired} 
                                        onChange={e => setFormState(p => ({ ...p, isPrescriptionRequired: e.target.checked }))} 
                                        className="w-4 h-4 text-primary" 
                                    />
                                    <label htmlFor="prescReq" className="text-xs font-bold text-blue-900 uppercase">Prescription Required</label>
                                </div>
                                <div className="flex items-center gap-2 bg-gray-50 p-3 border border-gray-100 flex-1">
                                    <input 
                                        type="checkbox" 
                                        id="is_active" 
                                        // Fixed: isActive -> is_active
                                        checked={!!formState.is_active} 
                                        onChange={e => setFormState(p => ({ ...p, is_active: e.target.checked }))} 
                                        className="w-4 h-4 text-primary" 
                                    />
                                    <label htmlFor="is_active" className="text-xs font-bold text-gray-700 uppercase">Active Record</label>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="p-4 bg-[var(--modal-footer-bg-light)] dark:bg-[var(--modal-bg-dark)] border-t border-[var(--modal-footer-border-light)] dark:border-[var(--modal-footer-border-dark)] flex justify-end gap-3 flex-shrink-0">
                        <button type="button" onClick={handleCloseAttempt} className="px-8 py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-black">Cancel</button>
                        <button type="submit" className="px-12 py-3 bg-[var(--modal-header-bg-light)] dark:bg-[var(--modal-header-bg-dark)] text-white text-[11px] font-black uppercase tracking-[0.2em] shadow-xl hover:bg-primary-dark transition-all transform active:scale-95">Save Material Record</button>
                    </div>
                </form>
            </Modal>

            <ConfirmModal
                isOpen={showConfirmClose}
                onClose={() => setShowConfirmClose(false)}
                onConfirm={() => {
                    setShowConfirmClose(false);
                    onClose();
                }}
                title="Discard Changes"
                message="You have unsaved material data. Are you sure you want to close? All entered data will be lost."
                confirmLabel="Yes, Discard"
                cancelLabel="No, Stay"
            />
        </>
    );
};

export default AddMedicineModal;
