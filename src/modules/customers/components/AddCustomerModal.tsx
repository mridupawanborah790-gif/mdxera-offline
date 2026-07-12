import React, { useState, useEffect, useMemo } from 'react';
import Modal from '@core/components/ui/Modal';
import ConfirmModal from '@core/components/ui/ConfirmModal';
import type { Customer, OrganizationMember } from '@core/types';
import { handleEnterToNextField } from '@core/utils/navigation';
import { lookupPincode } from '@core/utils/pincode';
import { STATE_DISTRICT_MAP } from '@core/utils/constants';

const states = Object.keys(STATE_DISTRICT_MAP).sort();

const Toggle: React.FC<{ label: string; enabled: boolean; setEnabled: (enabled: boolean) => void }> = ({ label, enabled, setEnabled }) => (
    <div className="flex items-center justify-between border border-gray-300 p-2 bg-white">
        <span className="text-[10px] font-black uppercase text-gray-500">{label}</span>
        <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`${enabled ? 'bg-primary' : 'bg-gray-300'} relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none`}
        >
            <span className={`${enabled ? 'translate-x-6' : 'translate-x-1'} inline-block w-4 h-4 transform bg-white rounded-full transition-transform`} />
        </button>
    </div>
);

interface AddCustomerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAdd: (customer: Omit<Customer, 'id' | 'ledger'>, openingBalance: number, asOfDate: string) => void;
    teamMembers?: OrganizationMember[];
    organizationId: string;
    defaultControlGlId?: string;
    initialName?: string;
    initialPhone?: string;
    getGlLabel?: (id?: string) => string;
}

const CUSTOMER_GROUP_OPTIONS = ['Sundry Debtors', 'Cash Customers', 'Corporate Customers', 'Retail Customers', 'Government Customers'] as const;

const createInitialState = (initialName?: string, initialPhone?: string) => ({
    name: initialName || '',
    phone: initialPhone || '',
    address: '',
    area: '',
    pincode: '',
    district: '',
    state: '',
    customerType: 'regular' as 'regular' | 'retail',
    customerGroup: 'Sundry Debtors',
    gstNumber: '',
    drugLicense: '',
    panNumber: '',
    openingBalance: 0,
    asOfDate: new Date().toISOString().split('T')[0],
    is_active: true,
    defaultDiscount: 0,
    defaultRateTier: 'none' as 'none' | 'rateA' | 'rateB' | 'rateC',
    assignedStaffId: '',
    assignedStaffName: '',
    organization_id: '',
    controlGlId: '',
    enableCreditLimit: false,
    creditLimit: 0,
    creditDays: 0,
    creditStatus: 'active' as 'active' | 'blocked',
    creditControlMode: 'hard_block' as 'warning_only' | 'hard_block',
    allowOverride: false,
    overrideApprovalRequired: false,
});

const AddCustomerModal: React.FC<AddCustomerModalProps> = ({ isOpen, onClose, onAdd, teamMembers = [], organizationId, defaultControlGlId, initialName, initialPhone, getGlLabel }) => {
    const effectiveControlGlId = useMemo(() => defaultControlGlId || '', [defaultControlGlId]);
    const initialState = useMemo(() => ({ ...createInitialState(initialName, initialPhone), organization_id: organizationId, controlGlId: effectiveControlGlId }), [organizationId, effectiveControlGlId, initialName, initialPhone]);

    const [formData, setFormData] = useState(initialState);
    const [isPincodeLoading, setIsPincodeLoading] = useState(false);
    const [showConfirmClose, setShowConfirmClose] = useState(false);

    const isDirty = useMemo(() => {
        return (
            formData.name !== initialState.name ||
            formData.phone !== initialState.phone ||
            formData.address !== initialState.address ||
            formData.gstNumber !== initialState.gstNumber ||
            formData.openingBalance !== initialState.openingBalance
        );
    }, [formData, initialState]);

    useEffect(() => {
        if (isOpen) {
            setFormData(initialState);
        }
    }, [isOpen, initialState]);

    const handleCloseAttempt = () => {
        if (isDirty) {
            setShowConfirmClose(true);
        } else {
            onClose();
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;

        if (name === 'pincode') {
            const cleaned = value.replace(/\D/g, '').slice(0, 6);
            setFormData(prev => ({ ...prev, pincode: cleaned }));

            if (cleaned.length === 6) {
                setIsPincodeLoading(true);
                lookupPincode(cleaned).then(res => {
                    if (res) {
                        setFormData(prev => ({ ...prev, district: res.district, state: res.state }));
                    }
                    setIsPincodeLoading(false);
                });
            }
            return;
        }

        if (name === 'assignedStaffId') {
            const member = teamMembers.find(m => m.id === value);
            setFormData(prev => ({ ...prev, assignedStaffId: value, assignedStaffName: member?.name || '' }));
            return;
        }

        if (name === 'state') {
            setFormData(prev => ({ ...prev, state: value, district: '' }));
            return;
        }

        if (name === 'customerGroup') {
            setFormData(prev => ({ ...prev, customerGroup: value, controlGlId: '' }));
            return;
        }

        setFormData(prev => ({ ...prev, [name]: type === 'number' ? parseFloat(value) || 0 : value }));
    };

    const handleSubmit = () => {
        if (!formData.name.trim()) {
            alert('Customer Name is required');
            return;
        }
        if (!organizationId) {
            alert('Error: Missing organization context. Please refresh.');
            return;
        }
        if (!formData.customerGroup.trim()) {
            alert('Customer Group is required');
            return;
        }
        if (formData.enableCreditLimit && (!Number.isFinite(formData.creditLimit) || formData.creditLimit <= 0)) {
            alert('Credit Limit is required and must be greater than 0 when credit limit is enabled');
            return;
        }

        const { openingBalance, asOfDate, ...customerData } = formData;
        const cleanData = {
            ...customerData,
            organization_id: organizationId,
        };

        if (!cleanData.assignedStaffId) {
            delete (cleanData as any).assignedStaffId;
        }

        onAdd(cleanData, openingBalance, asOfDate);
        onClose();
    };

    return (
        <>
            <Modal isOpen={isOpen} onClose={handleCloseAttempt} title="Register New Customer Ledger" widthClass="max-w-4xl">
                <div className="p-6 overflow-y-auto max-h-[75vh] space-y-6" onKeyDown={handleEnterToNextField}>
                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Core Identity</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="md:col-span-2">
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Customer Name *</label>
                                <input name="name" type="text" value={formData.name} onChange={handleChange} autoFocus className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" placeholder="e.g. CITY CARE PHARMACY" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Phone Number</label>
                                <input name="phone" type="text" value={formData.phone} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Customer Type</label>
                                <select name="customerType" value={formData.customerType} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none">
                                    <option value="regular">General</option>
                                    <option value="retail">Retailer</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Customer Group *</label>
                                <select name="customerGroup" value={formData.customerGroup} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none">
                                    {CUSTOMER_GROUP_OPTIONS.map(group => <option key={group} value={group}>{group}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Customer Control GL</label>
                                <input type="text" readOnly value={(() => {
                                    const label = getGlLabel ? getGlLabel(effectiveControlGlId) : effectiveControlGlId;
                                    return label ? `Mapped (${label})` : 'Auto-map from Company Configuration';
                                })()} className="w-full border border-gray-400 p-2 text-sm bg-gray-100" />
                            </div>
                            <div className="md:col-span-2">
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Assign Staff Member</label>
                                <select name="assignedStaffId" value={formData.assignedStaffId} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none">
                                    <option value="">— No Assignment —</option>
                                    {teamMembers.map(member => <option key={member.id} value={member.id}>{member.name} ({member.role})</option>)}
                                </select>
                            </div>
                        </div>
                    </section>

                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Contact & Compliance</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">GSTIN</label>
                                <input name="gstNumber" type="text" value={formData.gstNumber} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">PAN Number</label>
                                <input name="panNumber" type="text" value={formData.panNumber} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                            <div className="md:col-span-2">
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Drug License No.</label>
                                <input name="drugLicense" type="text" value={formData.drugLicense} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                        </div>
                    </section>

                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Address Information</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="md:col-span-2">
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Address Line 1</label>
                                <input name="address" type="text" value={formData.address} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" placeholder="Building / Street / Landmark" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Area / Locality</label>
                                <input name="area" type="text" value={formData.area} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1 flex items-center">Pincode
                                    {isPincodeLoading && <svg className="animate-spin ml-2 h-3 w-3 text-primary" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>}
                                </label>
                                <input name="pincode" type="text" value={formData.pincode} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none" placeholder="6 digit pincode" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">District</label>
                                <select name="district" value={formData.district} onChange={handleChange} disabled={!formData.state} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                    <option value="">Select District</option>
                                    {formData.state && STATE_DISTRICT_MAP[formData.state]?.map(d => <option key={d} value={d}>{d}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">State</label>
                                <select name="state" value={formData.state} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none">
                                    <option value="">Select State</option>
                                    {states.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                            </div>
                        </div>
                    </section>

                    <section className="space-y-4">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Credit Control & Pricing</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <Toggle label="Enable Credit Limit" enabled={formData.enableCreditLimit === true} setEnabled={(enabled) => setFormData(prev => ({ ...prev, enableCreditLimit: enabled }))} />
                            <Toggle label="Allow Override" enabled={formData.allowOverride === true} setEnabled={(enabled) => setFormData(prev => ({ ...prev, allowOverride: enabled }))} />
                            <Toggle label="Override Approval Required" enabled={formData.overrideApprovalRequired === true} setEnabled={(enabled) => setFormData(prev => ({ ...prev, overrideApprovalRequired: enabled }))} />
                            <Toggle label="Is Active" enabled={formData.is_active !== false} setEnabled={(enabled) => setFormData(prev => ({ ...prev, is_active: enabled }))} />
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Credit Limit (₹)</label>
                                <input name="creditLimit" type="number" min="0" step="0.01" value={formData.creditLimit} onChange={handleChange} disabled={!formData.enableCreditLimit} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Credit Days</label>
                                <input name="creditDays" type="number" min="0" value={formData.creditDays} onChange={handleChange} disabled={!formData.enableCreditLimit} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Credit Status</label>
                                <select name="creditStatus" value={formData.creditStatus} onChange={handleChange} disabled={!formData.enableCreditLimit} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100">
                                    <option value="active">Active</option>
                                    <option value="blocked">Blocked</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Credit Control Mode</label>
                                <select name="creditControlMode" value={formData.creditControlMode} onChange={handleChange} disabled={!formData.enableCreditLimit} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100">
                                    <option value="hard_block">Hard Block</option>
                                    <option value="warning_only">Warning Only</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Default Discount (%)</label>
                                <input name="defaultDiscount" type="number" min="0" max="100" value={formData.defaultDiscount} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Default Rate Tier</label>
                                <select name="defaultRateTier" value={formData.defaultRateTier || 'none'} onChange={handleChange} disabled={formData.customerType !== 'retail'} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100">
                                    <option value="none">None</option>
                                    <option value="rateA">Rate A</option>
                                    <option value="rateB">Rate B</option>
                                    <option value="rateC">Rate C</option>
                                </select>
                            </div>
                        </div>
                    </section>

                    <section className="p-4 bg-primary/5 border border-primary/10">
                        <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] mb-4">Opening Balance Information</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Opening Amount (₹)</label>
                                <input name="openingBalance" type="number" value={formData.openingBalance} onChange={handleChange} className="w-full border border-gray-400 p-2 font-black text-base text-red-700 outline-none focus:bg-yellow-50" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Opening Date</label>
                                <input name="asOfDate" type="date" value={formData.asOfDate} onChange={handleChange} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none" />
                            </div>
                        </div>
                    </section>
                </div>
                <div className="flex justify-end p-5 bg-gray-100 border-t border-gray-300 gap-3">
                    <button onClick={handleCloseAttempt} className="px-6 py-2 text-[10px] font-black uppercase border border-gray-400 bg-white hover:bg-red-50 text-red-600 transition-colors">Discard</button>
                    <button onClick={handleSubmit} className="px-14 py-2 tally-button-primary shadow-xl tracking-widest text-[11px]">Create Ledger</button>
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
                message="You have unsaved customer data. Are you sure you want to close? All entered data will be lost."
                confirmLabel="Yes, Discard"
                cancelLabel="No, Stay"
            />
        </>
    );
};

export default AddCustomerModal;
