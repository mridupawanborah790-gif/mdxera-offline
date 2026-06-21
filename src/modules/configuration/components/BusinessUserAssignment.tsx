
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import InviteUserModal from '../components/InviteUserModal';
import ConfirmModal from '@core/components/ui/ConfirmModal';
import { RegisteredPharmacy, OrganizationMember, WorkCenter, SoDConflict, BusinessRole } from '@core/types';
import { addTeamMember, saveData, getData, removeTeamMember } from '@core/services/storageService';
import { mergePermissionsForRoleIds } from '@core/utils/rbac';

interface BusinessUserAssignmentProps {
    currentUser: RegisteredPharmacy;
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    members: OrganizationMember[];
    onRefresh: () => Promise<void>;
    isActive?: boolean;
}

const DEFAULT_WORK_CENTERS: WorkCenter[] = [
    {
        id: 'sales',
        name: 'Sales & Distribution',
        views: [
            { id: 'pos', name: 'POS Billing', assigned: false },
            { id: 'returns', name: 'Sales Returns', assigned: false },
            { id: 'history', name: 'Sales History', assigned: false },
        ]
    },
    {
        id: 'purchasing',
        name: 'Purchasing',
        views: [
            { id: 'pur_entry', name: 'Purchase Entry', assigned: false },
            { id: 'orders', name: 'Purchase Orders', assigned: false },
            { id: 'suppliers', name: 'Supplier Management', assigned: false },
        ]
    },
    {
        id: 'inventory',
        name: 'Inventory Management',
        views: [
            { id: 'inv_list', name: 'Current Inventory', assigned: false },
            { id: 'audit', name: 'Stock Audit', assigned: false },
            { id: 'master', name: 'Material Master', assigned: false },
        ]
    }
];

const BusinessUserAssignment: React.FC<BusinessUserAssignmentProps> = ({ currentUser, addNotification, members, onRefresh, isActive }) => {
    const [businessRoles, setBusinessRoles] = useState<BusinessRole[]>([]);
    const [selectedUser, setSelectedUser] = useState<OrganizationMember | null>(null);
    const [activeTab, setActiveTab] = useState<'general' | 'roles' | 'workcenters' | 'sod'>('general');
    const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [isLoadingRoles, setIsLoadingRoles] = useState(true);
    const [focusedIndex, setFocusedIndex] = useState(0);
    const hasInitializedSelection = useRef(false);

    const loadExtraData = useCallback(async () => {
        if (selectedUser && !members.some(m => m.id === selectedUser.id)) {
            setSelectedUser(null);
            return;
        }

        setIsLoadingRoles(true);
        try {
            const rolesData = await getData('business_roles', [], currentUser);
            setBusinessRoles(rolesData);
            
            // Prioritize selecting the current user (Owner/Super User) by default on mount
            if (members.length === 0) {
                hasInitializedSelection.current = false;
                setSelectedUser(null);
            } else if (!selectedUser && !hasInitializedSelection.current) {
                const me = members.find(m => m.email === currentUser.email || m.technicalId === currentUser.user_id);
                if (me) {
                    setSelectedUser(me);
                    const meIdx = members.indexOf(me);
                    if (meIdx !== -1) setFocusedIndex(meIdx);
                } else {
                    setSelectedUser(members[0]);
                }
                hasInitializedSelection.current = true;
            }
        } catch (err) {
            addNotification("Failed to fetch administrative templates", "error");
        } finally {
            setIsLoadingRoles(false);
        }
    }, [currentUser, addNotification, members, selectedUser]);

    useEffect(() => {
        if (isActive !== false) {
            loadExtraData();
        }
    }, [isActive, loadExtraData]);

    const handleAddMember = async (payload: {
        name: string;
        username: string;
        password: string;
        department: string;
        mobile: string;
        email: string;
        isActive: boolean;
        assignedRoleIds: string[];
    }) => {
        try {
            await addTeamMember(
                payload.email,
                'viewer',
                payload.name,
                payload.password,
                currentUser.organization_id,
                {
                    department: payload.department,
                    employeeId: payload.username,
                    company: payload.mobile,
                    assignedRoles: payload.assignedRoleIds,
                    status: payload.isActive ? 'active' : 'suspended',
                    isLocked: !payload.isActive,
                },
            );
            addNotification(`Identity for ${payload.name} registered in directory.`, 'success');
            await onRefresh();
        } catch (err: any) {
            addNotification(err.message || "Failed to create team record.", "error");
        }
    };

    const handleToggleLock = async (member: OrganizationMember) => {
        // Prevent locking oneself
        if (member.email === currentUser.email || member.technicalId === currentUser.user_id) {
            addNotification("Access Restriction: You cannot lock your own system identity.", "warning");
            return;
        }
        const updated = { ...member, isLocked: !member.isLocked };
        await saveData('team_members', updated, currentUser);
        addNotification(`User ${member.name} ${updated.isLocked ? 'Locked' : 'Unlocked'}`, 'success');
        await onRefresh();
    };

    const handleSaveUser = async () => {
        if (!selectedUser) return;
        await saveData('team_members', selectedUser, currentUser);
        addNotification(`Settings for ${selectedUser.name} synchronized.`, 'success');
        await onRefresh();
    };

    const handleDeleteUser = async () => {
        if (!selectedUser || selectedUser.email === currentUser.email || selectedUser.technicalId === currentUser.user_id) {
            addNotification("Access Restriction: System Owner cannot be deleted.", "error");
            return;
        }
        try {
            await removeTeamMember(selectedUser.id, currentUser);
            addNotification(`User ${selectedUser.name} removed from directory.`, 'success');
            setSelectedUser(null);
            await onRefresh();
        } catch (e) {
            addNotification("Failed to remove user.", "error");
        } finally {
            setIsConfirmOpen(false);
        }
    };

    const sodConflicts = useMemo<SoDConflict[]>(() => {
        if (!selectedUser || !selectedUser.workCenters) return [];
        const conflicts: SoDConflict[] = [];
        const assignedViews = selectedUser.workCenters.flatMap(wc => wc.views.filter(v => v.assigned).map(v => v.id));
        
        if (assignedViews.includes('pur_entry') && assignedViews.includes('audit')) {
            conflicts.push({
                id: '1',
                viewA: 'Purchase Entry',
                viewB: 'Stock Audit',
                severity: 'High',
                description: 'Dual authority: User can influence stock levels through both purchases and physical adjustments.',
                mitigation: 'Implement mandatory manager level review for all audit finalizations.'
            });
        }
        return conflicts;
    }, [selectedUser]);

    // Keyboard Navigation for list
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName || '')) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setFocusedIndex(prev => (prev < members.length - 1 ? prev + 1 : 0));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setFocusedIndex(prev => (prev > 0 ? prev - 1 : members.length - 1));
            } else if (e.key === 'Enter' && members[focusedIndex]) {
                e.preventDefault();
                setSelectedUser(members[focusedIndex]);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [members, focusedIndex]);

    return (
        <main className="h-full overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Enterprise Identity Control (Directory)</span>
                <div className="flex gap-4">
                    <button onClick={() => onRefresh()} className="text-[10px] font-black uppercase hover:text-accent flex items-center gap-1">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                        Refresh
                    </button>
                </div>
            </div>

            <div className="p-4 flex-1 flex gap-4 overflow-hidden">
                {/* Left: Team Directory List */}
                <Card className="w-80 flex flex-col p-0 tally-border bg-white !rounded-none shadow-lg overflow-hidden flex-shrink-0">
                    <div className="bg-primary p-3 text-white flex justify-between items-center flex-shrink-0">
                        <span className="text-[11px] font-black uppercase tracking-widest">Team Directory</span>
                        <button 
                            onClick={() => setIsInviteModalOpen(true)}
                            className="bg-accent text-black px-3 py-1 text-[9px] font-black uppercase hover:bg-white transition-colors rounded-none shadow-sm"
                        >
                            + Add (F2)
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto divide-y divide-gray-200 custom-scrollbar">
                        {members.map((member, idx) => {
                            const isMe = member.email === currentUser.email || member.technicalId === currentUser.user_id;
                            return (
                                <button 
                                    key={member.id}
                                    onClick={() => setSelectedUser(member)}
                                    className={`w-full p-4 text-left hover:bg-slate-50 transition-all border-l-4 ${selectedUser?.id === member.id ? 'border-primary bg-blue-50/50' : focusedIndex === idx ? 'border-accent bg-gray-50' : 'border-transparent'} ${isMe ? 'bg-amber-50/20' : ''}`}
                                >
                                    <div className="flex justify-between items-center mb-1">
                                        <div className="flex items-center gap-2 truncate pr-2">
                                            <span className="text-xs font-black text-primary uppercase truncate">{member.name}</span>
                                            {isMe && <span className="text-[7px] bg-accent text-primary px-1.5 py-0.5 font-black rounded-none shadow-sm border border-primary/20">SUPER USER</span>}
                                        </div>
                                        <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 border flex-shrink-0 ${member.isLocked ? 'bg-red-50 text-red-600 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                                            {member.isLocked ? 'Blocked' : 'Active'}
                                        </span>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <span className={`text-[9px] font-black uppercase ${isMe ? 'text-accent bg-primary px-1.5 py-0.5' : 'text-gray-400'}`}>
                                            {isMe ? 'SYSTEM OWNER' : member.role}
                                        </span>
                                        <span className="text-[8px] text-gray-400 font-mono flex-shrink-0 ml-2">{member.email}</span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </Card>

                {/* Right: Detailed Control Panel */}
                <Card className="flex-1 flex flex-col p-0 tally-border bg-white !rounded-none shadow-xl overflow-hidden relative">
                    {selectedUser ? (
                        <div className="flex flex-col h-full overflow-hidden animate-in slide-in-from-right-4 duration-300">
                            {/* Identity Header */}
                            <div className="p-6 bg-slate-100 border-b border-gray-400 flex justify-between items-center">
                                <div className="flex items-center gap-4">
                                    <div className={`w-16 h-16 flex items-center justify-center font-black text-3xl shadow-lg border-2 ${selectedUser.email === currentUser.email ? 'bg-accent text-primary border-primary' : 'bg-primary text-white border-accent'}`}>
                                        {selectedUser.name.charAt(0)}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-3">
                                            <h2 className="text-3xl font-black text-primary uppercase tracking-tighter leading-none">{selectedUser.name}</h2>
                                            {(selectedUser.email === currentUser.email || selectedUser.technicalId === currentUser.user_id) && (
                                                <span className="bg-accent text-primary text-[10px] font-black px-3 py-1 shadow-md tracking-widest uppercase border border-primary/20">Super User</span>
                                            )}
                                        </div>
                                        <div className="flex gap-4 mt-3">
                                            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest bg-white px-2 py-0.5 border border-gray-300">Identity ID: {selectedUser.id.slice(0, 8)}</span>
                                            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest bg-white px-2 py-0.5 border border-gray-300">Status: {selectedUser.status}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-3">
                                    {selectedUser.email !== currentUser.email && selectedUser.technicalId !== currentUser.user_id && (
                                        <>
                                            <button 
                                                onClick={() => setIsConfirmOpen(true)}
                                                className="px-4 py-2 border-2 border-red-500 text-red-600 font-black text-[10px] uppercase hover:bg-red-50 transition-colors"
                                            >
                                                Revoke Identity
                                            </button>
                                            <button 
                                                onClick={() => handleToggleLock(selectedUser)}
                                                className={`px-4 py-2 text-[10px] font-black uppercase border-2 transition-all ${selectedUser.isLocked ? 'bg-emerald-50 border-emerald-500 text-emerald-700' : 'bg-red-50 border-red-500 text-red-700'}`}
                                            >
                                                {selectedUser.isLocked ? 'Unlock Access' : 'Lock Account'}
                                            </button>
                                        </>
                                    )}
                                    <button onClick={handleSaveUser} className="px-10 py-2 tally-button-primary text-[10px] shadow-lg">Post Changes (Ent)</button>
                                </div>
                            </div>

                            {/* Control Tabs */}
                            <div className="flex bg-[#e1e1e1] px-4 pt-2 border-b border-gray-400">
                                {[
                                    { id: 'general', name: 'Identity Profile' },
                                    { id: 'roles', name: 'Assigned Roles' },
                                    { id: 'workcenters', name: 'Access Rights' },
                                    { id: 'sod', name: `Compliance Audit ${sodConflicts.length ? `(${sodConflicts.length})` : ''}` },
                                ].map(tab => (
                                    <button 
                                        key={tab.id}
                                        onClick={() => setActiveTab(tab.id as any)}
                                        className={`px-8 py-3 text-[10px] font-black uppercase tracking-tighter transition-all ${activeTab === tab.id ? 'bg-white border-t-2 border-x-2 border-gray-400 border-b-transparent translate-y-[1px]' : 'text-gray-500 hover:text-black'}`}
                                    >
                                        {tab.name}
                                    </button>
                                ))}
                            </div>

                            {/* Panel Content */}
                            <div className="flex-1 overflow-y-auto p-10 custom-scrollbar bg-slate-50/20">
                                {activeTab === 'general' && (
                                    <div className="max-w-2xl space-y-8 animate-in fade-in duration-200">
                                        <section className="space-y-6">
                                            <h3 className="text-[11px] font-black text-gray-500 uppercase tracking-[0.25em] border-b border-gray-200 pb-2 mb-4">Identity Record</h3>
                                            <div className="grid grid-cols-2 gap-8">
                                                <div>
                                                    <label className="text-[9px] font-black uppercase text-gray-400 ml-1">Legal Name</label>
                                                    <input type="text" value={selectedUser.name} onChange={e => setSelectedUser({...selectedUser, name: e.target.value.toUpperCase()})} className="w-full tally-input uppercase mt-1" />
                                                </div>
                                                <div>
                                                    <label className="text-[9px] font-black uppercase text-gray-400 ml-1">System Alias (Email)</label>
                                                    <input type="email" value={selectedUser.email} onChange={e => setSelectedUser({...selectedUser, email: e.target.value})} className="w-full tally-input mt-1" />
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-2 gap-8">
                                                <div>
                                                    <label className="text-[9px] font-black uppercase text-gray-400 ml-1">Functional Department</label>
                                                    <input type="text" value={selectedUser.department || ''} onChange={e => setSelectedUser({...selectedUser, department: e.target.value.toUpperCase()})} className="w-full tally-input uppercase mt-1" />
                                                </div>
                                                <div>
                                                    <label className="text-[9px] font-black uppercase text-gray-400 ml-1">Identity Ref. #</label>
                                                    <input type="text" value={selectedUser.employeeId || ''} onChange={e => setSelectedUser({...selectedUser, employeeId: e.target.value})} className="w-full tally-input uppercase mt-1" />
                                                </div>
                                            </div>
                                        </section>
                                        
                                        {(selectedUser.email === currentUser.email || selectedUser.technicalId === currentUser.user_id) && (
                                            <div className="bg-accent/10 border-2 border-accent p-6 flex items-start gap-4">
                                                <div className="bg-accent p-2 text-primary font-black">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>
                                                </div>
                                                <div>
                                                    <p className="text-sm font-black text-primary uppercase tracking-tight">Enterprise Master Authority</p>
                                                    <p className="text-[10px] font-bold text-gray-600 uppercase mt-1 leading-relaxed">
                                                        This account is the primary organization owner. You have full recursive access to all modules, financial data, and security controls across the organization.
                                                    </p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === 'roles' && (
                                    <div className="space-y-6 animate-in fade-in duration-200">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            {businessRoles.map(role => (
                                                <label key={role.id} className="flex items-center gap-2 border border-gray-200 bg-white p-3 text-xs font-bold uppercase">
                                                    <input
                                                        type="checkbox"
                                                        checked={(selectedUser.assignedRoles || []).includes(role.id)}
                                                        onChange={() => {
                                                            const current = selectedUser.assignedRoles || [];
                                                            const next = current.includes(role.id)
                                                                ? current.filter(id => id !== role.id)
                                                                : [...current, role.id];
                                                            setSelectedUser({ ...selectedUser, assignedRoles: next });
                                                        }}
                                                    />
                                                    <span>{role.name}</span>
                                                    <span className={`ml-auto text-[9px] ${role.is_active ? 'text-emerald-600' : 'text-red-600'}`}>{role.is_active ? 'ACTIVE' : 'DISABLED'}</span>
                                                </label>
                                            ))}
                                        </div>
                                        <div className="bg-slate-100 border border-gray-200 p-4">
                                            <p className="text-[10px] font-black uppercase text-gray-500 mb-2">Merged Effective Permissions (highest permission wins)</p>
                                            <pre className="text-[10px] overflow-auto max-h-64 whitespace-pre-wrap">{JSON.stringify(mergePermissionsForRoleIds(businessRoles, selectedUser.assignedRoles || []), null, 2)}</pre>
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'workcenters' && (
                                    <div className="space-y-6 animate-in fade-in duration-200">
                                        <div className="bg-primary/5 p-4 border-l-4 border-primary rounded-none mb-8">
                                            <p className="text-[10px] font-black text-primary uppercase tracking-widest leading-relaxed">
                                                {selectedUser.email === currentUser.email 
                                                    ? "You are the Super User. Your access matrix is pre-authorized for all organizational nodes." 
                                                    : "The Rights Matrix defines which screens and actions are visible to this user. As a Super User, you can restrict other staff to specific functional clusters."}
                                            </p>
                                        </div>
                                        
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                            {(!selectedUser.workCenters || selectedUser.workCenters.length === 0 ? DEFAULT_WORK_CENTERS : selectedUser.workCenters).map((wc, wcIdx) => (
                                                <Card key={wc.id} className="p-0 border-2 border-gray-200 bg-white !rounded-none shadow-md">
                                                    <div className="bg-gray-100 p-3 border-b border-gray-200 flex justify-between items-center">
                                                        <span className="text-xs font-black uppercase text-primary">{wc.name}</span>
                                                        <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Access Node</span>
                                                    </div>
                                                    <div className="p-4 space-y-2">
                                                        {wc.views.map((view, vIdx) => (
                                                            <div 
                                                                key={view.id} 
                                                                onClick={() => {
                                                                    if (selectedUser.email === currentUser.email) return; // Prevent disabling own access in UI
                                                                    const currentWc = !selectedUser.workCenters || selectedUser.workCenters.length === 0 ? DEFAULT_WORK_CENTERS : selectedUser.workCenters;
                                                                    const newWc = JSON.parse(JSON.stringify(currentWc));
                                                                    newWc[wcIdx].views[vIdx].assigned = !newWc[wcIdx].views[vIdx].assigned;
                                                                    setSelectedUser({...selectedUser, workCenters: newWc});
                                                                }}
                                                                className={`p-3 flex justify-between items-center transition-colors ${view.assigned || selectedUser.email === currentUser.email ? 'bg-primary/5 text-primary border border-primary/10' : 'text-gray-300 border border-transparent'} ${selectedUser.email === currentUser.email ? 'cursor-default' : 'cursor-pointer'}`}
                                                            >
                                                                <span className="text-[11px] font-black uppercase">{view.name}</span>
                                                                <div className={`w-5 h-5 border-2 flex items-center justify-center transition-all ${view.assigned || selectedUser.email === currentUser.email ? 'bg-primary border-primary scale-110 shadow-lg' : 'bg-white border-gray-300'}`}>
                                                                    {(view.assigned || selectedUser.email === currentUser.email) && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg>}
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </Card>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'sod' && (
                                    <div className="space-y-6 animate-in fade-in duration-200">
                                        {sodConflicts.length > 0 ? (
                                            <div className="space-y-4">
                                                <div className="bg-red-600 text-white p-4 font-black uppercase tracking-widest text-center shadow-lg border-b-4 border-red-900">
                                                    Compliance Warning: Segregation of Duties Conflict
                                                </div>
                                                {sodConflicts.map(conflict => (
                                                    <Card key={conflict.id} className="p-6 border-red-500 bg-red-50/30 !rounded-none shadow-xl border-l-8">
                                                        <div className="flex justify-between items-start mb-6">
                                                            <span className="text-sm font-black text-red-800 uppercase tracking-tighter">
                                                                {conflict.viewA} <span className="mx-2 opacity-30">↔</span> {conflict.viewB}
                                                            </span>
                                                            <span className="text-[9px] font-black uppercase bg-red-600 text-white px-3 py-1 shadow-md">Policy Violation</span>
                                                        </div>
                                                        <p className="text-xs font-bold text-gray-800 leading-relaxed mb-6 bg-white/70 p-3 border border-red-100 italic">"{conflict.description}"</p>
                                                        <div className="bg-white p-4 border-2 border-dashed border-red-200">
                                                            <p className="text-[9px] font-black uppercase text-gray-400 mb-2 tracking-widest">Recommended Mitigation</p>
                                                            <p className="text-xs font-bold text-emerald-800 leading-relaxed">{conflict.mitigation}</p>
                                                        </div>
                                                    </Card>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="h-full flex flex-col items-center justify-center py-20 text-center">
                                                <div className="w-24 h-24 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-8 shadow-inner border-2 border-emerald-200">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                                </div>
                                                <p className="text-2xl font-black uppercase tracking-[0.3em] text-emerald-800">Authorization Clean</p>
                                                <p className="text-xs font-bold text-gray-400 uppercase mt-4 tracking-widest max-w-sm leading-relaxed">System audit identifies no significant Segregation of Duties conflicts for this access profile.</p>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center opacity-30 text-center p-20">
                            <div className="p-16 bg-primary/5 rounded-full mb-10 border-2 border-primary/5">
                                <svg className="w-32 h-32 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                            </div>
                            <p className="text-4xl font-black uppercase tracking-[0.4em] text-gray-900 leading-none">Security Center</p>
                            <p className="text-sm font-bold mt-8 uppercase tracking-widest max-w-sm leading-relaxed text-gray-500">
                                Identify a team member from the directory to configure their organizational presence and functional access rights.
                            </p>
                        </div>
                    )}
                </Card>
            </div>

            <InviteUserModal 
                isOpen={isInviteModalOpen} 
                onClose={() => setIsInviteModalOpen(false)} 
                onInvite={handleAddMember}
                availableRoles={businessRoles}
            />

            <ConfirmModal 
                isOpen={isConfirmOpen} 
                onClose={() => setIsConfirmOpen(false)} 
                onConfirm={handleDeleteUser} 
                title="Deactivate Identity" 
                message={`Warning: You are about to permanently revoke the system identity for ${selectedUser?.name}. They will be immediately logged out of all active sessions.`} 
            />
        </main>
    );
};

export default BusinessUserAssignment;
