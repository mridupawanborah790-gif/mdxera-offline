import React, { useState, useEffect } from 'react';
import Modal from '@core/components/ui/Modal';
import type { Customer, ModuleConfig, OrganizationMember } from '@core/types';
import { handleEnterToNextField } from '@core/utils/navigation';
import { lookupPincode } from '@core/utils/pincode';
import { getOutstandingBalance } from '@core/utils/helpers';
import { STATE_DISTRICT_MAP } from '@core/utils/constants';

const states = Object.keys(STATE_DISTRICT_MAP).sort();

interface EditCustomerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (customer: Customer) => void;
    customer: Customer;
    config: ModuleConfig;
    teamMembers?: OrganizationMember[];
    defaultControlGlId?: string;
    isReadOnly?: boolean;
}

const CUSTOMER_GROUP_OPTIONS = ['Sundry Debtors', 'Cash Customers', 'Corporate Customers', 'Retail Customers', 'Government Customers'] as const;

const Toggle: React.FC<{ label: string; enabled: boolean; setEnabled: (enabled: boolean) => void; disabled?: boolean }> = ({ label, enabled, setEnabled, disabled }) => (
    <div className="flex items-center justify-between border border-gray-300 p-2 bg-white">
        <span className="text-[10px] font-black uppercase text-gray-500">{label}</span>
        <button
            type="button"
            disabled={disabled}
            onClick={() => setEnabled(!enabled)}
            className={`${enabled ? 'bg-primary' : 'bg-gray-300'} ${disabled ? 'opacity-60 cursor-not-allowed' : ''} relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none`}
        >
            <span className={`${enabled ? 'translate-x-6' : 'translate-x-1'} inline-block w-4 h-4 transform bg-white rounded-full transition-transform`} />
        </button>
    </div>
);

export const EditCustomerModal: React.FC<EditCustomerModalProps> = ({ isOpen, onClose, onSave, customer, config, teamMembers = [], defaultControlGlId, isReadOnly = false }) => {
    void config;
    const [formData, setFormData] = useState(customer);
    const [isPincodeLoading, setIsPincodeLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setFormData({
                ...customer,
                enableCreditLimit: customer.enableCreditLimit === true || (customer as any).enable_credit_limit === true,
                allowOverride: customer.allowOverride === true || (customer as any).allow_override === true,
                overrideApprovalRequired: customer.overrideApprovalRequired === true || (customer as any).override_approval_required === true,
                is_active: customer.is_active ?? true,
                is_blocked: customer.is_blocked ?? false
            });
        }
    }, [isOpen, customer]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        if (isReadOnly) return;
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

        if (name === 'customerGroup') {
            setFormData(prev => ({ ...prev, customerGroup: value, controlGlId: '' }));
            return;
        }

        if (name === 'state') {
            setFormData(prev => ({ ...prev, state: value, district: '' }));
            return;
        }

        setFormData(prev => ({ ...prev, [name]: type === 'number' ? parseFloat(value) || 0 : value }));
    };

    const handleSubmit = () => {
        if (isReadOnly) return;
        if (!formData.name.trim()) {
            alert('Customer Name is required');
            return;
        }
        if (!formData.customerGroup?.trim()) {
            alert('Customer Group is required');
            return;
        }
        if (formData.enableCreditLimit && (!Number.isFinite(Number(formData.creditLimit ?? 0)) || Number(formData.creditLimit ?? 0) <= 0)) {
            alert('Credit Limit is required and must be greater than 0 when credit limit is enabled');
            return;
        }
        onSave({
            ...formData,
            gstNumber: formData.gstNumber,
            panNumber: formData.panNumber,
            drugLicense: formData.drugLicense,
            enableCreditLimit: formData.enableCreditLimit === true,
            is_active: formData.is_blocked === true ? false : (formData.is_active !== false),
            is_blocked: formData.is_blocked === true
        });
        onClose();
    };

    const currentOutstandingBalance = getOutstandingBalance(formData);
    const creditLimit = Number(formData.creditLimit || 0);
    const availableCredit = creditLimit - currentOutstandingBalance;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={isReadOnly ? `View Customer: ${customer.name}` : `Alter Customer: ${customer.name}`} widthClass="max-w-4xl">
            <div className="p-6 overflow-y-auto max-h-[75vh] space-y-6" onKeyDown={handleEnterToNextField}>
                <section className="space-y-4">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Core Identity</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Customer Name *</label>
                            <input name="name" type="text" value={formData.name} onChange={handleChange} disabled={isReadOnly} autoFocus className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Phone Number</label>
                            <input name="phone" type="text" value={formData.phone || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Customer Type</label>
                            <select name="customerType" value={formData.customerType} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                <option value="regular">General</option>
                                <option value="retail">Retailer</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Customer Group *</label>
                            <select name="customerGroup" value={formData.customerGroup || 'Sundry Debtors'} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                {CUSTOMER_GROUP_OPTIONS.map(group => <option key={group} value={group}>{group}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Customer Control GL</label>
                            <input type="text" readOnly value={formData.controlGlId || defaultControlGlId ? `Mapped (${formData.controlGlId || defaultControlGlId})` : 'Auto-map from Company Configuration'} className="w-full border border-gray-400 p-2 text-sm bg-gray-100" />
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Assign Staff Member</label>
                            <select name="assignedStaffId" value={formData.assignedStaffId || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
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
                            <input name="gstNumber" type="text" value={formData.gstNumber || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">PAN Number</label>
                            <input name="panNumber" type="text" value={formData.panNumber || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Drug License No.</label>
                            <input name="drugLicense" type="text" value={formData.drugLicense || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                    </div>
                </section>

                <section className="space-y-4">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Address Information</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Address Line 1</label>
                            <input name="address" type="text" value={formData.address || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Area / Locality</label>
                            <input name="area" type="text" value={formData.area || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm uppercase focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1 flex items-center">Pincode
                                {isPincodeLoading && <svg className="animate-spin ml-2 h-3 w-3 text-primary" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>}
                            </label>
                            <input name="pincode" type="text" value={formData.pincode || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">District</label>
                            <select name="district" value={formData.district || ''} onChange={handleChange} disabled={isReadOnly || !formData.state} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                <option value="">Select District</option>
                                {formData.state && STATE_DISTRICT_MAP[formData.state]?.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">State</label>
                            <select name="state" value={formData.state || ''} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm focus:bg-yellow-50 outline-none disabled:bg-gray-100">
                                <option value="">Select State</option>
                                {states.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                        </div>
                    </div>
                </section>

                <section className="space-y-4">
                    <h4 className="text-[11px] font-black text-primary uppercase tracking-[0.2em] border-b border-gray-200 pb-1 mb-4">Credit Control & Pricing</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Toggle label="Enable Credit Limit" enabled={formData.enableCreditLimit === true} setEnabled={(enabled) => setFormData(prev => ({ ...prev, enableCreditLimit: enabled }))} disabled={isReadOnly} />
                        <Toggle label="Blocked" enabled={formData.is_blocked === true} setEnabled={(enabled) => setFormData(prev => ({ ...prev, is_blocked: enabled, is_active: !enabled }))} disabled={isReadOnly} />
                        <Toggle label="Allow Override" enabled={formData.allowOverride === true} setEnabled={(enabled) => setFormData(prev => ({ ...prev, allowOverride: enabled }))} disabled={isReadOnly} />
                        <Toggle label="Override Approval Required" enabled={formData.overrideApprovalRequired === true} setEnabled={(enabled) => setFormData(prev => ({ ...prev, overrideApprovalRequired: enabled }))} disabled={isReadOnly} />
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Credit Limit (₹)</label>
                            <input name="creditLimit" type="number" min="0" step="0.01" value={formData.creditLimit || 0} onChange={handleChange} disabled={isReadOnly || !formData.enableCreditLimit} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Credit Days</label>
                            <input name="creditDays" type="number" min="0" value={formData.creditDays || 0} onChange={handleChange} disabled={isReadOnly || !formData.enableCreditLimit} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Credit Status</label>
                            <select name="creditStatus" value={formData.creditStatus || 'active'} onChange={handleChange} disabled={isReadOnly || !formData.enableCreditLimit} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100">
                                <option value="active">Active</option>
                                <option value="blocked">Blocked</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Credit Control Mode</label>
                            <select name="creditControlMode" value={formData.creditControlMode || 'hard_block'} onChange={handleChange} disabled={isReadOnly || !formData.enableCreditLimit} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100">
                                <option value="hard_block">Hard Block</option>
                                <option value="warning_only">Warning Only</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Default Discount (%)</label>
                            <input name="defaultDiscount" type="number" min="0" max="100" value={formData.defaultDiscount || 0} onChange={handleChange} disabled={isReadOnly} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Default Rate Tier</label>
                            <select name="defaultRateTier" value={formData.defaultRateTier || 'none'} onChange={handleChange} disabled={isReadOnly || formData.customerType !== 'retail'} className="w-full border border-gray-400 p-2 font-bold text-sm outline-none focus:bg-yellow-50 disabled:bg-gray-100">
                                <option value="none">None</option>
                                <option value="rateA">Rate A</option>
                                <option value="rateB">Rate B</option>
                                <option value="rateC">Rate C</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Current Outstanding</label>
                            <input type="number" readOnly value={currentOutstandingBalance} className={`w-full border border-gray-400 p-2 font-bold text-sm bg-gray-100 ${currentOutstandingBalance > 0 ? 'text-red-600' : 'text-emerald-700'}`} />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1">Available Credit</label>
                            <input type="number" readOnly value={availableCredit} className={`w-full border border-gray-400 p-2 font-bold text-sm bg-gray-100 ${availableCredit < 0 ? 'text-red-600' : 'text-emerald-700'}`} />
                        </div>
                    </div>
                </section>
            </div>
            <div className="flex justify-end p-5 bg-gray-100 border-t border-gray-300 gap-3">
                <button onClick={onClose} className={`px-6 py-2 text-[10px] font-black uppercase border border-gray-400 bg-white transition-colors ${isReadOnly ? 'hover:bg-gray-50 text-gray-700' : 'hover:bg-red-50 text-red-600'}`}>{isReadOnly ? 'Close' : 'Cancel'}</button>
                {!isReadOnly && (
                    <button onClick={handleSubmit} className="px-14 py-2 tally-button-primary shadow-xl tracking-widest text-[11px]">Update Ledger</button>
                )}
            </div>
        </Modal>
    );
};
