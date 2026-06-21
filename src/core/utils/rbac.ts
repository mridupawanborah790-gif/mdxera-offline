import { BusinessRole, OrganizationMember, PermissionAction, PermissionSet, RegisteredPharmacy } from '@core/types';
import type { NavItem } from '@core/types';

export interface RbacModuleDefinition {
    id: string;
    name: string;
    children?: { id: string; name: string }[];
}

export const RBAC_ACTIONS: PermissionAction[] = ['view', 'entry', 'edit', 'delete', 'approve', 'print', 'export', 'full'];

export const RBAC_MODULES: RbacModuleDefinition[] = [
    { id: 'dashboard', name: 'Dashboard' },
    {
        id: 'sales',
        name: 'Sales',
        children: [
            { id: 'pos', name: 'POS' },
            { id: 'manualSalesEntry', name: 'Manual' },
            { id: 'salesChallans', name: 'Challan' },
            { id: 'salesReturns', name: 'Return' },
            { id: 'salesHistory', name: 'History' },
        ],
    },
    {
        id: 'purchase',
        name: 'Purchase',
        children: [
            { id: 'automatedPurchaseEntry', name: 'Auto' },
            { id: 'manualPurchaseEntry', name: 'Manual' },
            { id: 'manualSupplierInvoice', name: 'Invoice' },
            { id: 'purchaseOrders', name: 'Orders' },
            { id: 'purchaseHistory', name: 'History' },
            { id: 'purchaseReturn', name: 'Return' },
            { id: 'deliveryChallans', name: 'Challan' },
        ],
    },
    { id: 'inventory', name: 'Inventory', children: [{ id: 'inventory', name: 'Inventory' }, { id: 'physicalInventory', name: 'Audit' }] },
    { id: 'billing', name: 'Billing', children: [{ id: 'nonGstPos', name: 'Estimate Billing' }] },
    { id: 'accounts', name: 'Accounts', children: [{ id: 'accountReceivable', name: 'Receivable' }, { id: 'accountPayable', name: 'Payable' }] },
    {
        id: 'masters',
        name: 'Masters',
        children: [
            { id: 'suppliers', name: 'Suppliers' },
            { id: 'customers', name: 'Customers' },
            { id: 'medicineMasterParent', name: 'Material Master Parent' },
            { id: 'medicineMasterList', name: 'Material Master Data' },
            { id: 'masterPriceMaintain', name: 'Price Maintain' },
            { id: 'vendorNomenclature', name: 'Vendor Nomenclature' },
            { id: 'bulkUtility', name: 'Bulk Utility' },
            { id: 'otherMaster', name: 'Other Master Parent' },
            { id: 'doctorsMaster', name: 'Doctor’s Master' },
            { id: 'mbcCardParent', name: 'MBC Card Parent' },
            { id: 'mbcCardDashboard', name: 'MBC Card Dashboard' },
            { id: 'mbcCardList', name: 'MBC Card List' },
            { id: 'mbcGenerateCard', name: 'Generate MBC Card' },
            { id: 'mbcCardTypeMaster', name: 'MBC Card Type Master' },
            { id: 'mbcCardTemplateMaster', name: 'MBC Card Template Master' },
            { id: 'mbcCardPrintPreview', name: 'Print / Preview MBC Card' },
            { id: 'mbcCardRenewalHistory', name: 'MBC Card Renewal / Upgrade History' },
        ],
    },
    {
        id: 'utilities',
        name: 'Utilities',
        children: [
            { id: 'financialStatement', name: 'Financial Statement Parent' },
            { id: 'reports', name: 'Reports' },
            { id: 'balanceCarryforward', name: 'Balance Carryforward' },
            { id: 'newJournalEntryVoucher', name: 'New Journal Entry Voucher' },
            { id: 'eway', name: 'E-Way Bill' },
            { id: 'ewayLoginSetup', name: 'E-Way Setup' },
            { id: 'gst', name: 'GST' },
            { id: 'configuration', name: 'Configuration' },
            { id: 'companyConfiguration', name: 'Company Config' },
            { id: 'settings', name: 'Settings' },
            { id: 'substituteFinder', name: 'Substitute Finder' },
            { id: 'promotions', name: 'Promotions' },
            { id: 'classification', name: 'Classification' },
            { id: 'businessRoles', name: 'Business Roles' },
            { id: 'businessUsers', name: 'Business Users' },
        ],
    },
];

const ALL_SCREEN_IDS = new Set(
    RBAC_MODULES.flatMap((module) => [module.id, ...(module.children || []).map((child) => child.id)])
);

export const createEmptyPermissionSet = (): PermissionSet => ({
    view: false,
    entry: false,
    edit: false,
    delete: false,
    approve: false,
    print: false,
    export: false,
    full: false,
});

export const applyFullAccess = (base: PermissionSet, full: boolean): PermissionSet => {
    if (!full) return { ...base, full: false };
    return {
        view: true,
        entry: true,
        edit: true,
        delete: true,
        approve: true,
        print: true,
        export: true,
        full: true,
    };
};

export const isAdminUser = (user: RegisteredPharmacy | null): boolean => {
    if (!user) return false;
    return user.role === 'owner' || user.role === 'admin';
};

export const normalizeRolePermissionMatrix = (role: BusinessRole): Record<string, PermissionSet> => {
    const matrix = role.permissionsMatrix || {};
    const output: Record<string, PermissionSet> = {};

    Object.keys(matrix).forEach((key) => {
        output[key] = applyFullAccess({ ...createEmptyPermissionSet(), ...matrix[key] }, Boolean(matrix[key]?.full));
    });

    if ((!role.permissionsMatrix || Object.keys(role.permissionsMatrix).length === 0) && role.workCenters?.length) {
        role.workCenters.forEach((center) => {
            center.views.forEach((view) => {
                if (view.assigned) {
                    output[view.id] = { ...createEmptyPermissionSet(), view: true };
                }
            });
        });
    }

    return output;
};

export const mergePermissionsForRoleIds = (roles: BusinessRole[], roleIds: string[]): Record<string, PermissionSet> => {
    const roleSet = new Set(roleIds);
    const assignedRoles = roles.filter((role) => roleSet.has(role.id) && role.is_active !== false);

    const merged: Record<string, PermissionSet> = {};
    for (const role of assignedRoles) {
        const matrix = normalizeRolePermissionMatrix(role);
        Object.entries(matrix).forEach(([moduleId, permission]) => {
            if (!merged[moduleId]) merged[moduleId] = createEmptyPermissionSet();
            RBAC_ACTIONS.forEach((action) => {
                merged[moduleId][action] = Boolean(merged[moduleId][action] || permission[action]);
            });
            merged[moduleId] = applyFullAccess(merged[moduleId], merged[moduleId].full);
        });
    }

    return merged;
};

export const getMemberRoleIds = (member: OrganizationMember | undefined): string[] => {
    if (!member) return [];
    if (Array.isArray(member.assignedRoles) && member.assignedRoles.length) return member.assignedRoles;
    return [];
};

export const getCurrentMember = (members: OrganizationMember[], user: RegisteredPharmacy | null): OrganizationMember | undefined => {
    if (!user) return undefined;
    return members.find((member) => member.email === user.email || member.technicalId === user.user_id);
};

export const canAccessScreen = (
    screenId: string,
    currentUser: RegisteredPharmacy | null,
    members: OrganizationMember[],
    roles: BusinessRole[],
    action: PermissionAction = 'view',
): boolean => {
    if (!currentUser) return false;
    if (isAdminUser(currentUser)) return true;
    if (!ALL_SCREEN_IDS.has(screenId)) return true;

    const member = getCurrentMember(members, currentUser);
    if (!member || member.isLocked) return false;

    const merged = mergePermissionsForRoleIds(roles, getMemberRoleIds(member));
    const screenPermission = merged[screenId] || createEmptyPermissionSet();
    return Boolean(screenPermission.full || screenPermission[action] || (action !== 'view' && screenPermission.view));
};

export const filterNavigationByPermissions = (
    items: NavItem[],
    currentUser: RegisteredPharmacy | null,
    members: OrganizationMember[],
    roles: BusinessRole[]
): NavItem[] => {
    if (!currentUser) return [];
    if (isAdminUser(currentUser)) return items;

    const prune = (node: NavItem): NavItem | null => {
        const children = node.children?.map(prune).filter(Boolean) as NavItem[] | undefined;
        const canViewSelf = canAccessScreen(node.id, currentUser, members, roles, 'view');

        if (children && children.length > 0) {
            if (!canViewSelf && children.length === 0) return null;
            return { ...node, children };
        }

        return canViewSelf ? node : null;
    };

    return items.map(prune).filter(Boolean) as NavItem[];
};
