import React, { useState, useEffect } from 'react';
import Card from '@core/components/ui/Card';
import AddBusinessRoleModal from '../components/AddBusinessRoleModal';
import ConfirmModal from '@core/components/ui/ConfirmModal';
import { BusinessRole, OrganizationMember, RegisteredPharmacy } from '@core/types';
import { deleteData, getData, saveData } from '@core/services/storageService';
import { normalizeRolePermissionMatrix, RBAC_ACTIONS, RBAC_MODULES } from '@core/utils/rbac';

const uniformTextStyle = 'text-2xl font-normal tracking-tight uppercase leading-tight';

interface BusinessRolesProps {
    currentUser: RegisteredPharmacy;
    addNotification: (message: string, type?: 'success' | 'error') => void;
}

const BusinessRoles: React.FC<BusinessRolesProps> = ({ currentUser, addNotification }) => {
    const [roles, setRoles] = useState<BusinessRole[]>([]);
    const [members, setMembers] = useState<OrganizationMember[]>([]);
    const [selectedRole, setSelectedRole] = useState<BusinessRole | null>(null);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [roleToEdit, setRoleToEdit] = useState<BusinessRole | null>(null);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [roleToRemove, setRoleToRemove] = useState<BusinessRole | null>(null);

    const loadRoles = async () => {
        try {
            const [roleData, memberData] = await Promise.all([
                getData('business_roles', [], currentUser),
                getData('team_members', [], currentUser),
            ]);
            setRoles(roleData);
            setMembers(memberData);
            if (selectedRole && !roleData.some(r => r.id === selectedRole.id)) {
                setSelectedRole(null);
            } else if (roleData.length > 0 && !selectedRole) {
                setSelectedRole(roleData[0]);
            }
        } catch {
            addNotification('Failed to fetch business roles.', 'error');
        }
    };

    useEffect(() => {
        loadRoles();
    }, []);

    const handleSaveRole = async (roleData: Omit<BusinessRole, 'id'> | BusinessRole) => {
        try {
            const saved = await saveData('business_roles', roleData, currentUser);
            addNotification(`Role '${saved.name}' saved successfully.`, 'success');
            await loadRoles();
            setSelectedRole(saved);
        } catch {
            addNotification('Failed to save business role.', 'error');
        }
    };

    const handleCopyRole = async () => {
        if (!selectedRole) return;
        try {
            const { id, ...rest } = selectedRole;
            const copied = await saveData('business_roles', { ...rest, name: `${selectedRole.name} COPY` }, currentUser);
            addNotification(`Role '${selectedRole.name}' copied.`, 'success');
            await loadRoles();
            setSelectedRole(copied);
        } catch {
            addNotification('Failed to copy role.', 'error');
        }
    };

    const handleToggleActive = async (role: BusinessRole) => {
        try {
            await saveData('business_roles', { ...role, is_active: !role.is_active }, currentUser);
            addNotification(`Role '${role.name}' ${role.is_active ? 'disabled' : 'activated'}.`, 'success');
            await loadRoles();
        } catch {
            addNotification('Failed to update role status.', 'error');
        }
    };

    const handleDeleteClick = (role: BusinessRole) => {
        if (role.isSystemRole) {
            addNotification('System roles cannot be deleted.', 'error');
            return;
        }

        const assignedCount = members.filter((member) => (member.assignedRoles || []).includes(role.id)).length;
        if (assignedCount > 0) {
            addNotification(`Cannot delete role. It is assigned to ${assignedCount} user(s).`, 'error');
            return;
        }

        setRoleToRemove(role);
        setIsConfirmOpen(true);
    };

    const handleConfirmDelete = async () => {
        if (!roleToRemove) return;
        try {
            await deleteData('business_roles', roleToRemove.id, currentUser);
            addNotification(`Role '${roleToRemove.name}' deleted.`, 'success');
            await loadRoles();
            if (selectedRole?.id === roleToRemove.id) setSelectedRole(null);
        } catch {
            addNotification('Failed to delete role.', 'error');
        } finally {
            setIsConfirmOpen(false);
            setRoleToRemove(null);
        }
    };

    const matrix = selectedRole ? normalizeRolePermissionMatrix(selectedRole) : {};

    return (
        <main className="h-full overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Access Control Matrix (Business Roles)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Templates: {roles.length}</span>
            </div>

            <div className="p-4 flex-1 flex gap-4 overflow-hidden">
                <Card className="w-1/3 flex flex-col p-0 tally-border overflow-hidden bg-white">
                    <div className="p-3 border-b border-gray-400 bg-gray-50 flex justify-between items-center flex-shrink-0">
                        <span className="text-[10px] font-black uppercase text-gray-500 tracking-widest">Role Directory</span>
                        <button onClick={() => { setRoleToEdit(null); setIsAddModalOpen(true); }} className="bg-primary text-white px-3 py-1 text-[9px] font-black uppercase hover:bg-primary-dark transition-all">+ Create Role</button>
                    </div>
                    <div className="flex-1 overflow-y-auto divide-y divide-gray-200">
                        {roles.map((role) => (
                            <button key={role.id} onClick={() => setSelectedRole(role)} className={`w-full text-left p-4 transition-all border-l-[8px] ${selectedRole?.id === role.id ? 'bg-accent text-black border-primary' : 'border-transparent hover:bg-gray-100'}`}>
                                <div className="flex justify-between items-center mb-1">
                                    <p className={`${uniformTextStyle} truncate pr-2`}>{role.name}</p>
                                    <span className={`text-[8px] font-black uppercase px-2 py-0.5 border ${role.is_active ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-red-50 text-red-600 border-red-300'}`}>{role.is_active ? 'Active' : 'Disabled'}</span>
                                </div>
                                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest truncate">{role.description || 'No description provided'}</p>
                            </button>
                        ))}
                    </div>
                </Card>

                <Card className="flex-1 p-0 tally-border bg-white overflow-hidden flex flex-col shadow-inner">
                    {selectedRole ? (
                        <div className="flex flex-col h-full overflow-hidden">
                            <div className="p-6 bg-slate-50 border-b border-gray-400 flex justify-between items-start flex-shrink-0">
                                <div>
                                    <h3 className={`${uniformTextStyle} !text-4xl text-primary`}>{selectedRole.name}</h3>
                                    <p className="text-sm font-bold text-gray-500 uppercase mt-3 tracking-widest">{selectedRole.description || 'General Business Role Template'}</p>
                                </div>
                                <div className="flex gap-2 flex-wrap justify-end">
                                    <button onClick={handleCopyRole} className="px-4 py-2 border-2 border-gray-500 text-gray-700 font-black text-[10px] uppercase hover:bg-gray-50">Copy</button>
                                    <button onClick={() => handleToggleActive(selectedRole)} className="px-4 py-2 border-2 border-amber-500 text-amber-700 font-black text-[10px] uppercase hover:bg-amber-50">{selectedRole.is_active ? 'Disable' : 'Activate'}</button>
                                    <button onClick={() => handleDeleteClick(selectedRole)} className="px-4 py-2 border-2 border-red-500 text-red-600 font-black text-[10px] uppercase hover:bg-red-50">Delete</button>
                                    <button onClick={() => { setRoleToEdit(selectedRole); setIsAddModalOpen(true); }} className="px-6 py-2 tally-button-primary text-[10px] shadow-lg">Edit</button>
                                </div>
                            </div>

                            <div className="flex-1 overflow-auto p-8 custom-scrollbar bg-slate-50/30">
                                <div className="overflow-x-auto border border-gray-200">
                                    <table className="w-full text-xs bg-white">
                                        <thead className="bg-gray-100">
                                            <tr>
                                                <th className="p-2 text-left uppercase">Module</th>
                                                {RBAC_ACTIONS.map((action) => <th key={action} className="p-2 uppercase">{action}</th>)}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {RBAC_MODULES.map((module) => (
                                                <React.Fragment key={module.id}>
                                                    <tr className="border-t border-gray-200 bg-slate-50">
                                                        <td className="p-2 font-black uppercase">{module.name}</td>
                                                        {RBAC_ACTIONS.map((action) => <td key={`${module.id}-${action}`} className="text-center">{matrix[module.id]?.[action] ? '✓' : '—'}</td>)}
                                                    </tr>
                                                    {(module.children || []).map((child) => (
                                                        <tr key={child.id} className="border-t border-gray-100">
                                                            <td className="p-2 pl-8 font-bold uppercase text-gray-600">{child.name}</td>
                                                            {RBAC_ACTIONS.map((action) => <td key={`${child.id}-${action}`} className="text-center">{matrix[child.id]?.[action] ? '✓' : '—'}</td>)}
                                                        </tr>
                                                    ))}
                                                </React.Fragment>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="h-full flex items-center justify-center text-gray-300">Select role template</div>
                    )}
                </Card>
            </div>

            <AddBusinessRoleModal
                isOpen={isAddModalOpen}
                onClose={() => { setIsAddModalOpen(false); setRoleToEdit(null); }}
                onSave={handleSaveRole}
                roleToEdit={roleToEdit}
                organizationId={currentUser.organization_id}
                existingRoles={roles}
            />

            <ConfirmModal
                isOpen={isConfirmOpen}
                onClose={() => setIsConfirmOpen(false)}
                onConfirm={handleConfirmDelete}
                title="Delete Business Role"
                message={`Are you sure you want to delete the role '${roleToRemove?.name}'? This action cannot be undone.`}
            />
        </main>
    );
};

export default BusinessRoles;
