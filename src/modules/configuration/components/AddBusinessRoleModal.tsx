import React, { useMemo, useState, useEffect } from 'react';
import Modal from '@core/components/ui/Modal';
import { BusinessRole, PermissionAction, PermissionSet } from '@core/types';
import { applyFullAccess, createEmptyPermissionSet, RBAC_ACTIONS, RBAC_MODULES } from '@core/utils/rbac';

const DISPLAY_ACTIONS = RBAC_ACTIONS.filter(action => action !== 'approve' && action !== 'delete');
const DISPLAY_MODULES = RBAC_MODULES.filter(module => module.id !== 'dashboard');

interface AddBusinessRoleModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (role: Omit<BusinessRole, 'id'> | BusinessRole) => void;
    roleToEdit?: BusinessRole | null;
    organizationId: string;
    existingRoles?: BusinessRole[];
}

const AddBusinessRoleModal: React.FC<AddBusinessRoleModalProps> = ({
    isOpen,
    onClose,
    onSave,
    roleToEdit,
    organizationId,
    existingRoles = [],
}) => {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [isActive, setIsActive] = useState(true);
    const [permissionsMatrix, setPermissionsMatrix] = useState<Record<string, PermissionSet>>({});
    const [copyRoleId, setCopyRoleId] = useState('');

    const roleOptions = useMemo(
        () => existingRoles.filter((role) => !roleToEdit || role.id !== roleToEdit.id),
        [existingRoles, roleToEdit],
    );

    useEffect(() => {
        if (!isOpen) return;
        if (roleToEdit) {
            setName(roleToEdit.name || '');
            setDescription(roleToEdit.description || '');
            setIsActive(roleToEdit.is_active !== false);
            setPermissionsMatrix(roleToEdit.permissionsMatrix || {});
        } else {
            setName('');
            setDescription('');
            setIsActive(true);
            setPermissionsMatrix({});
        }
        setCopyRoleId('');
    }, [isOpen, roleToEdit]);

    const updatePermission = (moduleId: string, action: PermissionAction, checked: boolean) => {
        setPermissionsMatrix((prev) => {
            const base = { ...createEmptyPermissionSet(), ...(prev[moduleId] || {}) };
            const next: PermissionSet = { ...base, [action]: checked };
            if (action === 'full') {
                return { ...prev, [moduleId]: applyFullAccess(next, checked) };
            }
            next.full = false;
            return { ...prev, [moduleId]: next };
        });
    };

    const updateParentModule = (moduleId: string, action: PermissionAction, checked: boolean) => {
        updatePermission(moduleId, action, checked);

        const module = RBAC_MODULES.find((item) => item.id === moduleId);
        if (!module?.children?.length) return;

        setPermissionsMatrix((prev) => {
            const updated = { ...prev };
            module.children!.forEach((child) => {
                const base = { ...createEmptyPermissionSet(), ...(updated[child.id] || {}) };
                const next = { ...base, [action]: checked } as PermissionSet;
                updated[child.id] = action === 'full' ? applyFullAccess(next, checked) : { ...next, full: false };
            });
            return updated;
        });
    };

    const applyToAll = (enabled: boolean) => {
        const next: Record<string, PermissionSet> = {};
        RBAC_MODULES.forEach((module) => {
            next[module.id] = applyFullAccess(createEmptyPermissionSet(), enabled);
            module.children?.forEach((child) => {
                next[child.id] = applyFullAccess(createEmptyPermissionSet(), enabled);
            });
        });
        setPermissionsMatrix(next);
    };

    const copyFromRole = (roleId: string) => {
        setCopyRoleId(roleId);
        const source = existingRoles.find((role) => role.id === roleId);
        if (!source) return;
        setPermissionsMatrix(source.permissionsMatrix || {});
    };

    const handleSubmit = () => {
        if (!name.trim()) {
            alert('Role name is required');
            return;
        }

        const payload: Omit<BusinessRole, 'id'> = {
            organization_id: organizationId,
            name: name.trim(),
            description: description.trim(),
            permissionsMatrix,
            is_active: isActive,
            isSystemRole: false,
        };

        if (roleToEdit) {
            onSave({ ...payload, id: roleToEdit.id });
        } else {
            onSave(payload);
        }

        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={roleToEdit ? 'Edit Business Role' : 'Create Business Role'} widthClass="max-w-7xl">
            <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-zinc-950">
                <div className="p-6 border-b border-gray-200 bg-slate-50 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1 tracking-widest">Role Name</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full p-2 border-2 border-gray-400 font-bold text-sm uppercase focus:bg-yellow-50 outline-none"
                                placeholder="e.g. SENIOR PHARMACIST"
                                autoFocus
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1 tracking-widest">Description</label>
                            <input
                                type="text"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                className="w-full p-2 border-2 border-gray-400 font-bold text-sm focus:bg-yellow-50 outline-none"
                                placeholder="Role purpose"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="block text-[10px] font-black uppercase text-gray-500 mb-1 ml-1 tracking-widest">Role Status</label>
                            <label className="flex items-center gap-2 text-xs font-bold uppercase text-gray-700">
                                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                                Active
                            </label>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-3 items-end">
                        <button onClick={() => applyToAll(true)} className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase">Select All</button>
                        <button onClick={() => applyToAll(false)} className="px-4 py-2 border border-gray-400 text-[10px] font-black uppercase">Clear All</button>
                        <div className="ml-auto flex items-center gap-2">
                            <label className="text-[10px] font-black uppercase text-gray-500">Copy From Role</label>
                            <select value={copyRoleId} onChange={(e) => copyFromRole(e.target.value)} className="border-2 border-gray-300 px-2 py-1 text-xs font-black uppercase">
                                <option value="">Select Role</option>
                                {roleOptions.map((role) => (
                                    <option key={role.id} value={role.id}>{role.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                    <h4 className="text-[11px] font-black uppercase tracking-[0.25em] text-primary border-b border-primary pb-2 mb-4">Permission Matrix</h4>
                    <div className="overflow-x-auto border border-gray-200">
                        <table className="w-full text-xs">
                            <thead className="bg-gray-100">
                                <tr>
                                    <th className="p-2 text-left uppercase">Module</th>
                                    {DISPLAY_ACTIONS.map((action) => (
                                        <th key={action} className="p-2 uppercase">{action}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {DISPLAY_MODULES.map((module) => (
                                    <React.Fragment key={module.id}>
                                        <tr className="bg-slate-50 border-t border-gray-200">
                                            <td className="p-2 font-black uppercase">{module.name}</td>
                                            {DISPLAY_ACTIONS.map((action) => (
                                                <td key={`${module.id}-${action}`} className="text-center p-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={Boolean(permissionsMatrix[module.id]?.[action])}
                                                        onChange={(e) => updateParentModule(module.id, action, e.target.checked)}
                                                    />
                                                </td>
                                            ))}
                                        </tr>
                                        {(module.children || []).map((child) => (
                                            <tr key={child.id} className="border-t border-gray-100">
                                                <td className="p-2 pl-8 font-bold uppercase text-gray-700">{child.name}</td>
                                                {DISPLAY_ACTIONS.map((action) => (
                                                    <td key={`${child.id}-${action}`} className="text-center p-2">
                                                        <input
                                                            type="checkbox"
                                                            checked={Boolean(permissionsMatrix[child.id]?.[action])}
                                                            onChange={(e) => updatePermission(child.id, action, e.target.checked)}
                                                        />
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </React.Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="p-4 bg-gray-100 border-t border-gray-300 flex justify-end gap-3 flex-shrink-0">
                    <button onClick={onClose} className="px-8 py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-black">Discard</button>
                    <button onClick={handleSubmit} className="px-12 py-3 bg-primary text-white text-[11px] font-black uppercase tracking-[0.2em] shadow-xl hover:bg-primary-dark transition-all transform active:scale-95">Save Role</button>
                </div>
            </div>
        </Modal>
    );
};

export default AddBusinessRoleModal;
