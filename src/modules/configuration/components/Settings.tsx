import React, { useState, useEffect, useRef } from 'react';
import Card from '@core/components/ui/Card';
import type { RegisteredPharmacy } from '@core/types';
import { handleEnterToNextField } from '@core/utils/navigation';
import { STATE_DISTRICT_MAP } from '@core/utils/constants';
import UpdateChecker from '@core/updates/UpdateChecker';
import { cacheRemoteAsset } from '@core/utils/assetCache';

interface SettingsProps {
    currentUser: RegisteredPharmacy | null;
    onUpdateProfile: (updatedProfile: RegisteredPharmacy) => void;
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    onResyncAll?: () => void;
    onFreshInstallSync?: () => void;
}

const InputGroup = ({ label, name, value, onChange, type = "text", placeholder = "", required = false, readOnly = false, className = '' }: any) => (
    <div className="space-y-1">
        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">
            {label} {required && <span className="text-red-500">*</span>}
        </label>
        <input 
            type={type}
            name={name}
            value={value || ''}
            onChange={onChange}
            placeholder={placeholder}
            required={required}
            readOnly={readOnly}
            className={`w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-sm font-bold uppercase transition-all ${readOnly ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-input-bg'} ${className}`}
        />
    </div>
);

const Settings: React.FC<SettingsProps> = ({ currentUser, onUpdateProfile, addNotification, onResyncAll, onFreshInstallSync }) => {
    const [formData, setFormData] = useState<RegisteredPharmacy | null>(currentUser);
    const [isSaving, setIsSaving] = useState(false);
    const initializedRef = useRef<string | null>(currentUser?.user_id || null);

    const states = Object.keys(STATE_DISTRICT_MAP).sort();

    useEffect(() => {
        if (currentUser && (currentUser.user_id !== initializedRef.current || !formData)) {
            setFormData({ ...currentUser });
            initializedRef.current = currentUser.user_id;
        }
    }, [currentUser]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        if (!formData) return;
        const { name, value } = e.target;
        
        if (name === 'state') {
            setFormData(prev => prev ? ({ ...prev, state: value, district: '' }) : null);
        } else if (name === 'organization_type') {
            // Logic: If Distributor → force Rate Based
            const updates: Partial<RegisteredPharmacy> = { organization_type: value as any };
            if (value === 'Distributor') {
                updates.subscription_plan = 'rate'; // We can use subscription_plan or a dedicated field if we had one in DB, 
                // but let's assume we want to store it in a way that matches AppConfigurations later or just profile
            }
            setFormData(prev => prev ? ({ ...prev, ...updates }) : null);
        } else {
            setFormData(prev => prev ? ({ ...prev, [name]: value }) : null);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData || isSaving) return;

        setIsSaving(true);
        try {
            await onUpdateProfile(formData);
            // Cache any remote logo URL for offline use
            if (formData.pharmacy_logo_url && !formData.pharmacy_logo_url.startsWith('data:')) {
                cacheRemoteAsset(formData.pharmacy_logo_url).catch(() => {});
            }
            addNotification("Business profile synchronized with database.", "success");
        } catch (error: any) {
            addNotification(error.message || "Failed to update profile.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    if (!formData) return <div className="p-20 text-center font-black uppercase text-gray-300">Loading Master Profile...</div>;

    return (
        <main className="flex-1 h-full overflow-hidden flex flex-col view-enter bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Company Configuration (Profile)</span>
                <span className="text-[10px] font-black uppercase text-accent">Master Alteration</span>
            </div>

            <div className="p-4 flex-1 overflow-y-auto custom-scrollbar" onKeyDown={handleEnterToNextField}>
                <form onSubmit={handleSubmit} className="max-w-5xl mx-auto pb-24">
                    <Card className="p-8 tally-border bg-white !rounded-none shadow-lg space-y-10">
                        {/* 1. Identity Section */}
                        <section className="space-y-6">
                            <div className="border-b-2 border-primary pb-2 flex justify-between items-end">
                                <h3 className="text-lg font-black text-primary uppercase tracking-tight">Organization Identity</h3>
                                <span className="text-[9px] font-bold text-gray-400">UUID: {formData.user_id}</span>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <InputGroup label="Trade Name" name="pharmacy_name" value={formData.pharmacy_name} onChange={handleChange} required />
                                <InputGroup label="Manager Name" name="manager_name" value={formData.manager_name} onChange={handleChange} required />
                                <InputGroup label="Authorized Person" name="full_name" value={formData.full_name} onChange={handleChange} required />
                                
                                <div className="space-y-1">
                                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">
                                        Organization Type <span className="text-red-500">*</span>
                                    </label>
                                    <select 
                                        name="organization_type" 
                                        value={formData.organization_type || ''} 
                                        onChange={handleChange}
                                        required
                                        className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-sm font-bold uppercase transition-all bg-input-bg"
                                    >
                                        <option value="">Select Type</option>
                                        <option value="Retail">Retail</option>
                                        <option value="Distributor">Distributor</option>
                                    </select>
                                </div>

                                <div className="space-y-1">
                                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1">
                                        Default Pricing Mode <span className="text-red-500">*</span>
                                    </label>
                                    <select 
                                        name="subscription_plan" 
                                        value={formData.subscription_plan || 'mrp'} 
                                        onChange={handleChange}
                                        required
                                        disabled={formData.organization_type === 'Distributor'}
                                        className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-sm font-bold uppercase transition-all bg-input-bg disabled:opacity-50 disabled:bg-gray-100"
                                    >
                                        <option value="mrp">MRP Based (GST Inclusive)</option>
                                        <option value="rate">Rate Based (GST Extra)</option>
                                    </select>
                                    {formData.organization_type === 'Distributor' && (
                                        <p className="text-[9px] text-primary font-bold mt-1 italic">* Distributors are forced to Rate Based mode.</p>
                                    )}
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <InputGroup label="Drug License" name="drug_license" value={formData.drug_license} onChange={handleChange} placeholder="e.g. DL-12345" />
                                    <InputGroup label="D.L. Valid To" name="dl_valid_to" type="date" value={formData.dl_valid_to} onChange={handleChange} />
                                </div>
                                <InputGroup label="Food License (FSSAI)" name="food_license" value={formData.food_license} onChange={handleChange} />
                                
                                <div className="grid grid-cols-2 gap-4">
                                    <InputGroup label="Org GSTIN" name="gstin" value={formData.gstin} onChange={handleChange} />
                                    <InputGroup label="Retailer GSTIN" name="retailer_gstin" value={formData.retailer_gstin} onChange={handleChange} />
                                </div>
                                <InputGroup label="PAN (Income Tax No.)" name="pan_number" value={formData.pan_number} onChange={handleChange} />
                                
                                <div className="md:col-span-2">
                                    <InputGroup 
                                        label="Internal Organization ID" 
                                        name="organization_id" 
                                        value={formData.organization_id} 
                                        readOnly={true} 
                                        className="font-mono" 
                                    />
                                </div>
                            </div>
                        </section>

                        {/* 2. Contact Section */}
                        <section className="space-y-6">
                            <div className="border-b-2 border-primary pb-2">
                                <h3 className="text-lg font-black text-primary uppercase tracking-tight">Location & Contact</h3>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="md:col-span-2">
                                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1">Building/Street Address</label>
                                    <input 
                                        name="address"
                                        value={formData.address || ''}
                                        onChange={handleChange}
                                        className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-sm font-bold uppercase transition-all"
                                    />
                                </div>

                                <div className="md:col-span-2">
                                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1">Address Line 2 (Area)</label>
                                    <input 
                                        name="address_line2"
                                        value={formData.address_line2 || ''}
                                        onChange={handleChange}
                                        className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-sm font-bold uppercase transition-all"
                                    />
                                </div>
                                
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:col-span-2">
                                    <div>
                                        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1">State</label>
                                        <select 
                                            name="state" 
                                            value={formData.state || ''} 
                                            onChange={handleChange}
                                            className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-sm font-bold uppercase transition-all"
                                        >
                                            <option value="">Select State</option>
                                            {states.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1">District</label>
                                        <select 
                                            name="district" 
                                            value={formData.district || ''} 
                                            onChange={handleChange}
                                            disabled={!formData.state}
                                            className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-sm font-bold uppercase transition-all disabled:opacity-50"
                                        >
                                            <option value="">Select District</option>
                                            {formData.state && STATE_DISTRICT_MAP[formData.state]?.map(d => <option key={d} value={d}>{d}</option>)}
                                        </select>
                                    </div>
                                    <InputGroup label="Pincode" name="pincode" value={formData.pincode} onChange={handleChange} />
                                </div>

                                <InputGroup label="Mobile / Support Line" name="mobile" value={formData.mobile} onChange={handleChange} required />
                                <InputGroup label="Official Email Address" name="email" value={formData.email} onChange={handleChange} type="email" required />
                            </div>
                        </section>

                        {/* 3. Banking Section */}
                        <section className="space-y-6">
                            <div className="border-b-2 border-primary pb-2">
                                <h3 className="text-lg font-black text-primary uppercase tracking-tight">Banking & Settlement</h3>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <InputGroup label="Bank Name" name="bank_account_name" value={formData.bank_account_name} onChange={handleChange} />
                                <InputGroup label="Account Number" name="bank_account_number" value={formData.bank_account_number} onChange={handleChange} />
                                <InputGroup label="IFSC Code" name="bank_ifsc_code" value={formData.bank_ifsc_code} onChange={handleChange} />
                                <InputGroup label="UPI ID (For QR Collections)" name="bank_upi_id" value={formData.bank_upi_id} onChange={handleChange} placeholder="e.g. pharmacy@upi" />
                                <InputGroup label="Authorized Signatory Name" name="authorized_signatory" value={formData.authorized_signatory} onChange={handleChange} />
                                <InputGroup label="Logo URL (Branding)" name="pharmacy_logo_url" value={formData.pharmacy_logo_url} onChange={handleChange} placeholder="https://..." />
                            </div>
                        </section>

                        {/* 4. Policy Section */}
                        <section className="space-y-6">
                            <div className="border-b-2 border-primary pb-2">
                                <h3 className="text-lg font-black text-primary uppercase tracking-tight">Document Policies</h3>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1">Sales Invoice Terms & Conditions</label>
                                    <textarea 
                                        name="terms_and_conditions"
                                        value={formData.terms_and_conditions || ''}
                                        onChange={handleChange}
                                        rows={4}
                                        className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-xs font-bold transition-all resize-none"
                                        placeholder="Enter line by line..."
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1">Purchase Order Instructions</label>
                                    <textarea 
                                        name="purchase_order_terms"
                                        value={formData.purchase_order_terms || ''}
                                        onChange={handleChange}
                                        rows={3}
                                        className="w-full tally-input border-gray-400 focus:bg-yellow-50 focus:border-primary text-xs font-bold transition-all resize-none"
                                        placeholder="Delivery instructions for suppliers..."
                                    />
                                </div>
                            </div>
                        </section>

                        {/* 5. Database Synchronisation */}
                        {(onResyncAll || onFreshInstallSync) && (
                            <section className="space-y-4 pt-4 border-t-2 border-primary">
                                <div className="pb-1">
                                    <h3 className="text-lg font-black text-primary uppercase tracking-tight">Database Synchronisation</h3>
                                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-0.5">Manage local database sync from the server</p>
                                </div>
                                <div className="flex flex-wrap gap-4 pt-2">
                                    {onResyncAll && (
                                        <button
                                            type="button"
                                            onClick={onResyncAll}
                                            className="px-6 py-3 border-2 border-primary bg-primary text-white font-black uppercase text-[10px] tracking-widest hover:bg-primary-dark transition-all transform active:scale-95 flex items-center gap-2"
                                            title="Re-download every table from the server into local storage"
                                        >
                                            <svg className="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 4.79M9 9H4M9 9V4" /></svg>
                                            Sync All (Resume)
                                        </button>
                                    )}
                                    {onFreshInstallSync && (
                                        <button
                                            type="button"
                                            onClick={onFreshInstallSync}
                                            className="px-6 py-3 border-2 border-red-500 text-red-600 font-black uppercase text-[10px] tracking-widest hover:bg-red-50 transition-all transform active:scale-95 flex items-center gap-2"
                                            title="Wipe local database and start fresh from Supabase"
                                        >
                                            <svg className="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                                            Fresh Install Sync
                                        </button>
                                    )}
                                </div>
                            </section>
                        )}

                        {/* 6. System & Updates */}
                        <UpdateChecker addNotification={addNotification} />

                        {/* Submit Actions */}
                        <div className="pt-10 border-t border-gray-200 flex justify-end gap-4">
                            <button 
                                type="button"
                                onClick={() => setFormData({ ...currentUser! })}
                                className="px-10 py-3 tally-border bg-white text-gray-600 font-black uppercase text-[11px] tracking-widest hover:bg-gray-50"
                            >
                                Reset Form
                            </button>
                            <button 
                                type="submit"
                                disabled={isSaving}
                                className="px-16 py-4 tally-button-primary shadow-2xl shadow-primary/20 uppercase text-xs font-black tracking-[0.3em] flex items-center gap-3 transition-all transform active:scale-95"
                            >
                                {isSaving ? (
                                    <>
                                        <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                                        Syncing...
                                    </>
                                ) : 'Update Master Profile (Enter)'}
                            </button>
                        </div>
                    </Card>
                </form>
            </div>
        </main>
    );
};

export default Settings;