import React, { useState, useEffect, useMemo } from 'react';
import Modal from '@core/components/ui/Modal';
import ConfirmModal from '@core/components/ui/ConfirmModal';
import type { Supplier } from '@core/types';
import type { SupplierQuickResult } from '@core/services/supplierService';
import { handleEnterToNextField } from '@core/utils/navigation';
import { STATE_DISTRICT_MAP } from '@core/utils/constants';
import { getOutstandingBalance } from '@core/utils/helpers';
import { generateUUID } from '@core/services/storageService';
import { lookupPincode } from '@core/utils/pincode';

const states = Object.keys(STATE_DISTRICT_MAP).sort();
const supplierCategories = ["Wholesaler", "Manufacturer", "C&F", "Local Vendor", "Distributor", "Agency"];
const supplierGroupOptions = ["Sundry Creditors", "Import Vendors", "Service Vendors", "Local Vendors"];

const createInitialState = (): Omit<Supplier, 'ledger' | 'organization_id'> => ({
    id: generateUUID(),
    user_id: '',
    name: '',
    contact_person: '',
    category: 'Wholesaler',
    phone: '',
    mobile: '',
    email: '',
    website: '',
    address: '',
    address_line1: '',
    address_line2: '',
    area: '',
    pincode: '',
    district: '',
    state: '',
    gst_number: '',
    pan_number: '',
    drug_license: '',
    food_license: '',
    opening_balance: 0,
    payment_details: { 
        upi_id: '', 
        bank_name: '', 
        ifsc_code: '', 
        branch_name: '', 
        payment_terms: '30 Days', 
        account_number: '' 
    },
    is_active: true,
    is_blocked: false,
    remarks: '',
    supplier_group: 'Sundry Creditors',
    control_gl_id: ''
});

export const AddSupplierModal: React.FC<{
    isOpen: boolean; 
    onClose: () => void; 
    onAdd: (data: Omit<Supplier, 'ledger' | 'organization_id'>, balance: number, date: string) => Promise<SupplierQuickResult>;
    onDuplicate?: (supplier: Supplier) => void;
    organizationId: string;
    prefillData?: Partial<Supplier>;
    defaultControlGlId?: string;
}> = ({ isOpen, onClose, onAdd, onDuplicate, organizationId, prefillData, defaultControlGlId }) => {
    const initialState = useMemo(() => ({
        ...createInitialState(),
        control_gl_id: defaultControlGlId || '',
        ...prefillData,
        address_line1: prefillData?.address_line1 || prefillData?.address || '',
        address: prefillData?.address_line1 || prefillData?.address || '',
    }), [prefillData, defaultControlGlId]);

    const [form, setForm] = useState(initialState);
    const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split('T')[0]);
    const [isSaving, setIsSaving] = useState(false);
    const [isPincodeLoading, setIsPincodeLoading] = useState(false);
    const [showConfirmClose, setShowConfirmClose] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setForm(initialState);
            setAsOfDate(new Date().toISOString().split('T')[0]);
        }
    }, [isOpen, initialState]);

    const isDirty = useMemo(() => {
        return (
            form.name !== initialState.name ||
            form.phone !== initialState.phone ||
            form.address_line1 !== initialState.address_line1 ||
            form.gst_number !== initialState.gst_number ||
            form.opening_balance !== initialState.opening_balance
        );
    }, [form, initialState]);

    const handleCloseAttempt = () => {
        if (isDirty) {
            setShowConfirmClose(true);
        } else {
            onClose();
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value, type } = e.target;
        
        if (name.startsWith('payment_details.')) {
            const field = name.split('.')[1];
            setForm(prev => {
                const pd = prev.payment_details || { upi_id: '', bank_name: '', ifsc_code: '', branch_name: '', payment_terms: '30 Days', account_number: '' };
                return {
                    ...prev,
                    payment_details: { ...pd, [field]: value }
                };
            });
            return;
        }

        if (name === 'pincode') {
            const cleaned = value.replace(/\D/g, '').slice(0, 6);
            setForm(prev => ({ ...prev, pincode: cleaned }));
            if (cleaned.length === 6) {
                setIsPincodeLoading(true);
                lookupPincode(cleaned).then(res => {
                    if (res) {
                        setForm(prev => ({ ...prev, district: res.district, state: res.state }));
                    }
                    setIsPincodeLoading(false);
                });
            }
        } else if (name === 'supplier_group') {
            setForm(prev => ({ ...prev, supplier_group: value, control_gl_id: '' }));
        } else if (name === 'state') {
             setForm(prev => ({ ...prev, state: value, district: '' }));
        } else if (name === 'address_line1') {
             setForm(prev => ({ ...prev, address_line1: value, address: value }));
        } else {
             setForm(prev => ({ ...prev, [name]: type === 'number' ? parseFloat(value) || 0 : value } as any));
        }
    };

    const handleSubmit = async () => {
        if (!form.name.trim()) {
            alert('Supplier Name is required.');
            return;
        }
        if (!(form.supplier_group || '').trim()) {
            alert('Supplier Group is required.');
            return;
        }
        setIsSaving(true);
        try {
            const result = await onAdd(form, form.opening_balance || 0, asOfDate);
            if (result.status === 'duplicate' || result.status === 'created' || result.status === 'updated') {
                onDuplicate?.(result.supplier);
            }
            onClose();
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <>
            <Modal isOpen={isOpen} onClose={handleCloseAttempt} title="Register New Supplier Ledger" widthClass="max-w-4xl">
                <div className="p-6 overflow-y-auto max-h-[75vh] space-y-6" onKeyDown={handleEnterToNextField}>
                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Core Identity</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="md:col-span-2">
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Supplier Trade Name *</label>
                                <input type="text" name="name" value={form.name} onChange={handleChange} autoFocus className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" placeholder="e.g. GLOBAL PHARMA DISTRIBUTORS" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Contact Person</label>
                                <input type="text" name="contact_person" value={form.contact_person || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Supplier Category</label>
                                <select name="category" value={form.category} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none">
                                    {supplierCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Supplier Group *</label>
                                <select name="supplier_group" value={form.supplier_group || 'Sundry Creditors'} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none">
                                    {supplierGroupOptions.map(group => <option key={group} value={group}>{group}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Supplier Control GL</label>
                                <input type="text" readOnly value={form.control_gl_id || defaultControlGlId ? `Mapped (${form.control_gl_id || defaultControlGlId})` : 'Auto-map from Company Configuration'} className="w-full border border-gray-400 p-2 text-sm bg-gray-100" />
                            </div>
                        </div>
                    </section>

                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Contact & Communication</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Office Phone</label>
                                <input type="text" name="phone" value={form.phone || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Mobile No.</label>
                                <input type="text" name="mobile" value={form.mobile || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Email ID</label>
                                <input type="email" name="email" value={form.email || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">GSTIN</label>
                                <input type="text" name="gst_number" value={form.gst_number || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                        </div>
                    </section>

                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">License Details</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Drug License No.</label>
                                <input type="text" name="drug_license" value={form.drug_license || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Food License No.</label>
                                <input type="text" name="food_license" value={form.food_license || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                        </div>
                    </section>

                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Address Information</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="md:col-span-2">
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Address Line 1</label>
                                <input type="text" name="address_line1" value={form.address_line1 || form.address || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" placeholder="Building / Street / Landmark" />
                            </div>
                            <div className="md:col-span-2">
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Address Line 2</label>
                                <input type="text" name="address_line2" value={form.address_line2 || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" placeholder="Additional address details" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Area / Locality</label>
                                <input type="text" name="area" value={form.area || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" placeholder="Area / Locality" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1 flex items-center">Pincode
                                    {isPincodeLoading && <svg className="animate-spin ml-2 h-3 w-3 text-primary" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>}
                                </label>
                                <input type="text" name="pincode" value={form.pincode || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" placeholder="6 digit pincode" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">District</label>
                                <select name="district" value={form.district || ''} onChange={handleChange} disabled={!form.state} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                    <option value="">Select District</option>
                                    {form.state && STATE_DISTRICT_MAP[form.state]?.map(d => <option key={d} value={d}>{d}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">State</label>
                                <select name="state" value={form.state || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none">
                                    <option value="">Select State</option>
                                    {states.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                            </div>
                        </div>
                    </section>

                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Banking & Settlements</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">UPI ID for QR</label>
                                <input type="text" name="payment_details.upi_id" value={form.payment_details?.upi_id || ''} onChange={handleChange} placeholder="e.g. supplier@upi" className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Bank Name</label>
                                <input type="text" name="payment_details.bank_name" value={form.payment_details?.bank_name || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">A/c Number</label>
                                <input type="text" name="payment_details.account_number" value={form.payment_details?.account_number || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">IFSC Code</label>
                                <input type="text" name="payment_details.ifsc_code" value={form.payment_details?.ifsc_code || ''} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                        </div>
                    </section>

                    <section className="p-4 bg-primary/5 border border-primary/10">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] mb-4">Opening Balance Information</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Opening Amount (₹)</label>
                                <input type="number" name="opening_balance" value={form.opening_balance || 0} onChange={handleChange} className="w-full border border-gray-400 p-2 font-black text-base text-red-700 outline-none focus:bg-yellow-50" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Opening Date</label>
                                <input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none" />
                            </div>
                        </div>
                    </section>
                </div>
                <div className="flex justify-end p-5 bg-gray-100 border-t border-gray-300 gap-3">
                    <button onClick={handleCloseAttempt} className="px-6 py-2 text-[10px] font-black uppercase border border-gray-400 bg-white hover:bg-red-50 text-red-600 transition-colors">Discard</button>
                    <button onClick={handleSubmit} disabled={isSaving} className="px-14 py-2 tally-button-primary shadow-xl tracking-widest text-[11px] disabled:opacity-50">{isSaving ? 'Saving…' : 'Create Ledger'}</button>
                </div>
            </Modal>

            <ConfirmModal
                isOpen={showConfirmClose}
                onClose={() => setShowConfirmClose(false)}
                onConfirm={() => {
                    setShowConfirmClose(false);
                    onClose();
                }}
                title="Discard Changes"
                message="You have unsaved supplier data. Are you sure you want to close? All entered data will be lost."
                confirmLabel="Yes, Discard"
                cancelLabel="No, Stay"
            />
        </>
    );
};

export const EditSupplierModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onSave: (supplier: Supplier) => void;
    supplier: Supplier;
    defaultControlGlId?: string;
    isReadOnly?: boolean;
}> = ({ isOpen, onClose, onSave, supplier, defaultControlGlId, isReadOnly = false }) => {
    const [form, setForm] = useState<Supplier>(() => ({
        ...supplier,
        payment_details: { 
            upi_id: '', 
            bank_name: '', 
            ifsc_code: '', 
            branch_name: '', 
            payment_terms: '30 Days', 
            account_number: '',
            ...(supplier?.payment_details || {}) 
        }
    }));
    const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split('T')[0]);
    const [isPincodeLoading, setIsPincodeLoading] = useState(false);

    const resolveOpeningDate = (source: Supplier) => {
        if (!source) return new Date().toISOString().split('T')[0];
        const ledger = Array.isArray(source.ledger) ? source.ledger : [];
        const openingEntry = ledger.find((entry) => entry && entry.type === 'openingBalance');
        return openingEntry?.date || new Date().toISOString().split('T')[0];
    };

    useEffect(() => {
        if (isOpen && supplier) {
            setForm({
                ...supplier,
                control_gl_id: supplier.control_gl_id || defaultControlGlId || '',
                address_line1: supplier.address_line1 || supplier.address || '',
                address: supplier.address_line1 || supplier.address || '',
                payment_details: { 
                    upi_id: '', 
                    bank_name: '', 
                    ifsc_code: '', 
                    branch_name: '', 
                    payment_terms: '30 Days', 
                    account_number: '',
                    ...supplier.payment_details 
                }
            });
            setAsOfDate(resolveOpeningDate(supplier));
        }
    }, [isOpen, supplier, defaultControlGlId]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        if (isReadOnly) return;
        const { name, value, type } = e.target;
        
        if (name.startsWith('payment_details.')) {
            const field = name.split('.')[1];
            setForm(prev => {
                const pd = prev.payment_details || { upi_id: '', bank_name: '', ifsc_code: '', branch_name: '', payment_terms: '30 Days', account_number: '' };
                return {
                    ...prev,
                    payment_details: { ...pd, [field]: value }
                };
            });
            return;
        }

        if (name === 'pincode') {
            const cleaned = value.replace(/\D/g, '').slice(0, 6);
            setForm(prev => ({ ...prev, pincode: cleaned }));
            if (cleaned.length === 6) {
                setIsPincodeLoading(true);
                lookupPincode(cleaned).then(res => {
                    if (res) {
                        setForm(prev => ({ ...prev, district: res.district, state: res.state }));
                    }
                    setIsPincodeLoading(false);
                });
            }
        } else if (name === 'supplier_group') {
            setForm(prev => ({ ...prev, supplier_group: value, control_gl_id: '' }));
        } else if (name === 'state') {
            setForm(prev => ({ ...prev, state: value, district: '' }));
        } else if (name === 'address_line1') {
            setForm(prev => ({ ...prev, address_line1: value, address: value }));
        } else {
            setForm(prev => ({ ...prev, [name]: type === 'number' ? parseFloat(value) || 0 : value } as any));
        }
    };

    const handleSubmit = () => {
        if (isReadOnly) return;
        if (!form.name.trim()) {
            alert('Supplier Name is mandatory.');
            return;
        }
        if (!(form.supplier_group || '').trim()) {
            alert('Supplier Group is required.');
            return;
        }
        onSave(form);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={isReadOnly ? `View Supplier: ${supplier.name}` : `Alter Supplier: ${supplier.name}`} widthClass="max-w-4xl">
            <div className="p-6 overflow-y-auto max-h-[75vh] space-y-6" onKeyDown={handleEnterToNextField}>
                <section className="space-y-4">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Core Identity</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Supplier Trade Name *</label>
                            <input type="text" name="name" value={form.name} onChange={handleChange} disabled={isReadOnly} autoFocus className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" placeholder="e.g. GLOBAL PHARMA DISTRIBUTORS" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Contact Person</label>
                            <input type="text" name="contact_person" value={form.contact_person || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Supplier Category</label>
                            <select name="category" value={form.category} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                {supplierCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Supplier Group *</label>
                            <select name="supplier_group" value={form.supplier_group || 'Sundry Creditors'} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                {supplierGroupOptions.map(group => <option key={group} value={group}>{group}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Supplier Control GL</label>
                            <input type="text" readOnly value={form.control_gl_id || defaultControlGlId ? `Mapped (${form.control_gl_id || defaultControlGlId})` : 'Auto-map from Company Configuration'} className="w-full border border-gray-400 p-2 text-sm bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Status</label>
                            <select
                                name="is_blocked"
                                value={form.is_blocked ? 'blocked' : 'active'}
                                onChange={(e) => { if (isReadOnly) return; setForm(prev => ({ ...prev, is_blocked: e.target.value === 'blocked', is_active: e.target.value !== 'blocked' })); }}
                                disabled={isReadOnly}
                                className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100"
                            >
                                <option value="active">Active</option>
                                <option value="blocked">Blocked</option>
                            </select>
                        </div>
                    </div>
                </section>

                <section className="space-y-4">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Contact & Communication</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Office Phone</label>
                            <input type="text" name="phone" value={form.phone || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Mobile No.</label>
                            <input type="text" name="mobile" value={form.mobile || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Email ID</label>
                            <input type="email" name="email" value={form.email || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">GSTIN</label>
                            <input type="text" name="gst_number" value={form.gst_number || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                    </div>
                </section>

                <section className="space-y-4">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">License Details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Drug License No.</label>
                            <input type="text" name="drug_license" value={form.drug_license || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Food License No.</label>
                            <input type="text" name="food_license" value={form.food_license || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                    </div>
                </section>

                <section className="space-y-4">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Address Information</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Address Line 1</label>
                            <input type="text" name="address_line1" value={form.address_line1 || form.address || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Address Line 2</label>
                            <input type="text" name="address_line2" value={form.address_line2 || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Area / Locality</label>
                            <input type="text" name="area" value={form.area || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1 flex items-center">Pincode
                                {isPincodeLoading && <svg className="animate-spin ml-2 h-3 w-3 text-primary" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>}
                            </label>
                            <input type="text" name="pincode" value={form.pincode || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">District</label>
                            <select name="district" value={form.district || ''} onChange={handleChange} disabled={isReadOnly || !form.state} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                <option value="">Select District</option>
                                {form.state && STATE_DISTRICT_MAP[form.state]?.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">State</label>
                            <select name="state" value={form.state || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                <option value="">Select State</option>
                                {states.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                        </div>
                    </div>
                </section>

                <section className="space-y-4">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Banking & Settlements</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">UPI ID for QR</label>
                            <input type="text" name="payment_details.upi_id" value={form.payment_details?.upi_id || ''} onChange={handleChange} disabled={isReadOnly} placeholder="e.g. supplier@upi" className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Bank Name</label>
                            <input type="text" name="payment_details.bank_name" value={form.payment_details?.bank_name || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">A/c Number</label>
                            <input type="text" name="payment_details.account_number" value={form.payment_details?.account_number || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">IFSC Code</label>
                            <input type="text" name="payment_details.ifsc_code" value={form.payment_details?.ifsc_code || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                    </div>
                </section>

                <section className="p-4 bg-primary/5 border border-primary/10">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] mb-4">Opening Balance Information</h4>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Opening Amount (₹)</label>
                            <input type="number" name="opening_balance" value={form.opening_balance || 0} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-black text-base text-red-700 outline-none focus:bg-yellow-50 disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Opening Date</label>
                            <input type="date" value={asOfDate} onChange={e => { if (isReadOnly) return; setAsOfDate(e.target.value); }} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none disabled:bg-gray-100" />
                        </div>
                    </div>
                </section>
            </div>
            <div className="flex justify-end p-5 bg-gray-100 border-t border-gray-300 gap-3">
                <button onClick={onClose} className={`px-6 py-2 text-[10px] font-black uppercase border border-gray-400 bg-white transition-colors ${isReadOnly ? 'hover:bg-gray-50 text-gray-700' : 'hover:bg-red-50 text-red-600'}`}>{isReadOnly ? 'Close' : 'Cancel'}</button>
                {!isReadOnly && <button onClick={handleSubmit} className="px-14 py-2 tally-button-primary shadow-xl tracking-widest text-[11px]">Update Ledger</button>}
            </div>
        </Modal>
    );
};

export const RecordPaymentModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    supplier: Supplier;
    onRecord: (supplierId: string, amount: number, date: string, desc: string) => void;
}> = ({ isOpen, onClose, supplier, onRecord }) => {
    const [amount, setAmount] = useState<number>(0);
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [desc, setDesc] = useState('Supplier Payment');

    const handleSubmit = () => {
        if (amount <= 0) {
            alert('Please enter a valid payment amount.');
            return;
        }
        onRecord(supplier.id, amount, date, desc);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Record Payment: ${supplier.name}`} widthClass="max-w-md">
            <div className="p-6 space-y-6" onKeyDown={handleEnterToNextField}>
                <div className="bg-primary/5 p-4 text-center border border-primary/10">
                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Outstanding Balance</p>
                    <p className="text-3xl font-black text-red-600">₹{getOutstandingBalance(supplier).toFixed(2)}</p>
                </div>
                <div>
                    <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Payment Amount (₹) *</label>
                    <input type="number" value={amount} onChange={e => setAmount(parseFloat(e.target.value) || 0)} autoFocus className="w-full border border-gray-400 p-3 font-black text-2xl text-emerald-700 focus:bg-yellow-50 outline-none no-spinner" placeholder="0.00" />
                </div>
                <div>
                    <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Payment Date *</label>
                    <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none" />
                </div>
                <div>
                    <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Narration / Description</label>
                    <input type="text" value={desc} onChange={e => setDesc(e.target.value)} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                </div>
            </div>
            <div className="flex justify-end p-5 bg-gray-100 border-t border-gray-300">
                <button onClick={onClose} className="px-6 py-2 text-[10px] font-black uppercase border border-gray-400 bg-white hover:bg-red-50 text-red-600 transition-colors">Cancel</button>
                <button onClick={handleSubmit} className="ml-3 px-12 py-2 tally-button-primary shadow-xl">Post Payment (Ent)</button>
            </div>
        </Modal>
    );
};

export default AddSupplierModal;
