import React, { useMemo, useState, useRef, useEffect } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import type { DoctorMaster, PermissionSet } from '@core/types';
import { fuzzyMatch } from '@core/utils/search';

interface DoctorsMasterProps {
  doctors: DoctorMaster[];
  onSaveDoctor: (doctor: DoctorMaster, isUpdate: boolean) => Promise<void>;
  onToggleDoctorStatus: (doctor: DoctorMaster, nextActive: boolean) => Promise<void>;
  permissions?: PermissionSet;
}

const emptyDoctor: DoctorMaster = {
  id: '',
  organization_id: '',
  doctorCode: '',
  name: '',
  qualification: '',
  specialization: '',
  registrationNo: '',
  mobile: '',
  alternateContact: '',
  email: '',
  clinicName: '',
  area: '',
  city: '',
  state: '',
  pincode: '',
  commissionPercent: 0,
  is_active: true,
  notes: '',
};

const DoctorsMaster: React.FC<DoctorsMasterProps> = ({ doctors, onSaveDoctor, onToggleDoctorStatus, permissions }) => {
  const defaultPermissions: PermissionSet = {
    view: true,
    entry: true,
    edit: true,
    delete: true,
    approve: true,
    print: true,
    export: true,
    full: true,
  };
  const perms = permissions || defaultPermissions;

  const [searchTerm, setSearchTerm] = useState('');
  const [specializationFilter, setSpecializationFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [selectedDoctor, setSelectedDoctor] = useState<DoctorMaster | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formState, setFormState] = useState<DoctorMaster>(emptyDoctor);
  const [isSaving, setIsSaving] = useState(false);
  
  const nameInputRef = useRef<HTMLInputElement>(null);

  const filteredDoctors = useMemo(() => {
    return doctors
      .filter(d => !activeOnly || d.is_active !== false)
      .filter(d => !specializationFilter || (d.specialization || '').toLowerCase() === specializationFilter.toLowerCase())
      .filter(d => {
        if (!searchTerm) return true;
        const s = searchTerm.toLowerCase();
        return (
          fuzzyMatch(d.name || '', s) ||
          fuzzyMatch(d.mobile || '', s) ||
          fuzzyMatch(d.specialization || '', s) ||
          fuzzyMatch(d.clinicName || '', s)
        );
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [activeOnly, doctors, searchTerm, specializationFilter]);

  const specializations = useMemo(() => {
    return Array.from(new Set(doctors.map(d => (d.specialization || '').trim()).filter(Boolean))).sort();
  }, [doctors]);

  const openCreateModal = () => {
    setSelectedDoctor(null);
    setFormState({ ...emptyDoctor, id: crypto.randomUUID(), is_active: true });
    setIsModalOpen(true);
  };

  const openEditModal = (doctor: DoctorMaster) => {
    setSelectedDoctor(doctor);
    setFormState({ ...emptyDoctor, ...doctor });
    setIsModalOpen(true);
  };

  useEffect(() => {
    if (isModalOpen) {
      setTimeout(() => nameInputRef.current?.focus(), 150);
    }
  }, [isModalOpen]);

  const handleSave = async () => {
    if (!formState.name?.trim()) {
      alert('Doctor Name is required.');
      nameInputRef.current?.focus();
      return;
    }
    
    try {
      setIsSaving(true);
      await onSaveDoctor({ ...formState, name: formState.name.trim() }, !!selectedDoctor);
      setIsModalOpen(false);
    } catch (error) {
      console.error('Failed to save doctor:', error);
      alert('Failed to save doctor details. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const isReadOnly = selectedDoctor ? !perms.edit : !perms.entry;

  return (
    <main className="flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg">
      {/* Tally Style Header */}
      <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
        <span className="text-[10px] font-black uppercase tracking-widest">Other Master → Doctor&apos;s Master</span>
        <span className="text-[10px] font-black uppercase text-accent">Total: {doctors.length}</span>
      </div>

      <div className="p-4 flex-1 overflow-hidden flex flex-col gap-3">
        {/* Filters Card */}
        <Card className="p-3 grid grid-cols-1 md:grid-cols-5 gap-2 tally-border bg-white">
          <input
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search Name / Mobile / Specialization"
            className="md:col-span-2 h-9 border border-gray-400 p-2 text-xs font-bold uppercase outline-none focus:bg-yellow-50"
          />
          <select
            value={specializationFilter}
            onChange={e => setSpecializationFilter(e.target.value)}
            className="h-9 border border-gray-400 p-2 text-xs font-bold uppercase outline-none cursor-pointer"
          >
            <option value="">All Specialization</option>
            {specializations.map(spec => <option key={spec} value={spec}>{spec}</option>)}
          </select>
          <label className="h-9 border border-gray-300 px-3 flex items-center gap-2 text-xs font-bold uppercase cursor-pointer hover:bg-gray-50">
            <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="w-4 h-4" />
            Active only
          </label>
          {perms.entry && (
            <button onClick={openCreateModal} className="h-9 bg-primary text-white text-xs font-black uppercase hover:bg-primary-dark transition-colors shadow-sm">
              + Add Doctor
            </button>
          )}
        </Card>

        {/* Data Table Card */}
        <Card className="flex-1 overflow-hidden p-0 tally-border bg-white flex flex-col">
          <div className="flex-1 overflow-auto custom-scrollbar">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-gray-100 sticky top-0 z-10">
                <tr className="border-b border-gray-300">
                  <th className="p-2.5 text-left font-black uppercase tracking-tighter border-r border-gray-200">Doctor Name</th>
                  <th className="p-2.5 text-left font-black uppercase tracking-tighter border-r border-gray-200">Mobile</th>
                  <th className="p-2.5 text-left font-black uppercase tracking-tighter border-r border-gray-200">Specialization</th>
                  <th className="p-2.5 text-left font-black uppercase tracking-tighter border-r border-gray-200">Area</th>
                  <th className="p-2.5 text-left font-black uppercase tracking-tighter border-r border-gray-200">Status</th>
                  <th className="p-2.5 text-right font-black uppercase tracking-tighter">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredDoctors.length > 0 ? (
                  filteredDoctors.map(doc => (
                    <tr key={doc.id} className="hover:bg-yellow-50 transition-colors">
                      <td className="p-2.5 border-r border-gray-100 font-bold uppercase tracking-tight">{doc.name}</td>
                      <td className="p-2.5 border-r border-gray-100 font-mono">{doc.mobile || '-'}</td>
                      <td className="p-2.5 border-r border-gray-100 uppercase text-[10px] font-bold text-gray-600">{doc.specialization || '-'}</td>
                      <td className="p-2.5 border-r border-gray-100 uppercase text-[10px]">{doc.area || '-'}</td>
                      <td className="p-2.5 border-r border-gray-100">
                        <span className={`px-2 py-0.5 text-[9px] font-black uppercase ${doc.is_active === false ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
                          {doc.is_active === false ? 'Inactive' : 'Active'}
                        </span>
                      </td>
                      <td className="p-2.5 text-right space-x-1">
                        <button onClick={() => openEditModal(doc)} className="px-2 py-1 border border-gray-400 font-black text-[9px] uppercase hover:bg-primary hover:text-white transition-all">{perms.edit ? 'Edit' : 'View'}</button>
                        {perms.edit && (
                          <button
                            onClick={() => onToggleDoctorStatus(doc, doc.is_active === false)}
                            className={`px-2 py-1 border border-gray-400 font-black text-[9px] uppercase transition-all ${doc.is_active === false ? 'hover:bg-emerald-600' : 'hover:bg-red-600'} hover:text-white`}
                          >
                            {doc.is_active === false ? 'Enable' : 'Disable'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="p-10 text-center opacity-30 font-black uppercase tracking-[0.2em]">No Records Found</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Entry Modal */}
      {isModalOpen && (
        <Modal 
          isOpen={isModalOpen} 
          onClose={() => setIsModalOpen(false)} 
          title={isReadOnly ? 'View Doctor Details' : (selectedDoctor ? 'Edit Doctor Details' : 'Register New Doctor')}
          widthClass="max-w-2xl"
        >
          <div className="flex flex-col h-full max-h-[70vh]">
            {/* Scrollable Form Content */}
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar p-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
                {[
                  ['Doctor Name*', 'name', 'text'], 
                  ['Doctor Code', 'doctorCode', 'text'], 
                  ['Qualification', 'qualification', 'text'], 
                  ['Specialization', 'specialization', 'text'],
                  ['Registration No', 'registrationNo', 'text'], 
                  ['Mobile', 'mobile', 'tel'], 
                  ['Alternate Contact', 'alternateContact', 'tel'], 
                  ['Email', 'email', 'email'],
                  ['Clinic/Hospital Name', 'clinicName', 'text'], 
                  ['Area', 'area', 'text'], 
                  ['City', 'city', 'text'], 
                  ['State', 'state', 'text'], 
                  ['Pincode', 'pincode', 'text'],
                ].map(([label, key, type]) => (
                  <div key={key}>
                    <label className="block mb-1 font-black uppercase text-[10px] text-gray-500 tracking-tighter">{label}</label>
                    <input
                      ref={key === 'name' ? nameInputRef : null}
                      type={type}
                      value={String((formState as any)[key] || '')}
                      onChange={e => { if (isReadOnly) return; setFormState(prev => ({ ...prev, [key]: e.target.value })); }}
                      disabled={isReadOnly}
                      className="w-full h-9 border border-gray-400 p-2 text-xs font-bold uppercase outline-none focus:bg-yellow-50 focus:border-primary transition-colors disabled:bg-gray-100"
                    />
                  </div>
                ))}
                <div>
                  <label className="block mb-1 font-black uppercase text-[10px] text-gray-500 tracking-tighter">Commission %</label>
                  <input
                    type="number"
                    value={formState.commissionPercent || 0}
                    onChange={e => { if (isReadOnly) return; setFormState(prev => ({ ...prev, commissionPercent: Number(e.target.value || 0) })); }}
                    disabled={isReadOnly}
                    className="w-full h-9 border border-gray-400 p-2 text-xs font-bold uppercase outline-none focus:bg-yellow-50 focus:border-primary transition-colors disabled:bg-gray-100"
                  />
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <input
                    id="isActiveCheck"
                    type="checkbox"
                    checked={formState.is_active !== false}
                    onChange={e => { if (isReadOnly) return; setFormState(prev => ({ ...prev, is_active: e.target.checked })); }}
                    disabled={isReadOnly}
                    className="w-5 h-5 cursor-pointer"
                  />
                  <label htmlFor="isActiveCheck" className="font-black uppercase text-[10px] cursor-pointer select-none text-gray-700">Is Active Status</label>
                </div>
                <div className="md:col-span-2">
                  <label className="block mb-1 font-black uppercase text-[10px] text-gray-500 tracking-tighter">Internal Notes</label>
                  <textarea
                    value={formState.notes || ''}
                    onChange={e => { if (isReadOnly) return; setFormState(prev => ({ ...prev, notes: e.target.value })); }}
                    disabled={isReadOnly}
                    className="w-full h-20 border border-gray-400 p-2 text-xs font-bold uppercase outline-none focus:bg-yellow-50 focus:border-primary transition-colors resize-none disabled:bg-gray-100"
                  />
                </div>
              </div>
            </div>

            {/* Sticky Action Footer */}
            <div className="mt-4 flex justify-end gap-2 pt-4 border-t border-gray-200">
              <button 
                onClick={() => setIsModalOpen(false)} 
                className="px-6 py-2 border-2 border-gray-400 text-xs font-black uppercase hover:bg-gray-100 transition-colors"
              >
                {isReadOnly ? 'Close' : 'Cancel'}
              </button>
              {!isReadOnly && (
                <button 
                  onClick={handleSave} 
                  disabled={isSaving}
                  className="px-8 py-2 bg-primary text-white text-xs font-black uppercase hover:bg-primary-dark transition-all shadow-md disabled:opacity-50 flex items-center gap-2"
                >
                  {isSaving && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>}
                  {selectedDoctor ? 'Update (Ctrl+S)' : 'Save (Enter)'}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
};

export default DoctorsMaster;
