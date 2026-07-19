
import React from 'react';
import type { NavItem } from '@core/types';

const DashboardIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="3" width="7" height="7" rx="2" ry="2"></rect>
    <rect x="14" y="3" width="7" height="7" rx="2" ry="2"></rect>
    <rect x="14" y="14" width="7" height="7" rx="2" ry="2"></rect>
    <rect x="3" y="14" width="7" height="7" rx="2" ry="2"></rect>
  </svg>
);

const POSIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"></path>
    <path d="M12 12v.01"></path>
  </svg>
);

const SalesHistoryIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 20v-6M6 20V10M18 20V4"></path>
  </svg>
);

const PurchaseIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"></path>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
    <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"></path>
    <path d="M2 7h20"></path>
    <path d="M22 7v3a2 2 0 0 1-2 2v0a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12v0a2 2 0 0 1-2-2V7"></path>
  </svg>
);

const InventoryIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path>
    <path d="m3.3 7 8.7 5 8.7-5"></path>
    <path d="M12 22V12"></path>
  </svg>
);

const AuditIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
        <path d="M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"></path>
        <path d="M9 12h6"></path>
        <path d="M9 16h6"></path>
        <path d="M9 8h6"></path>
    </svg>
);

const ChallanIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M16 2h4a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h4"></path>
    <path d="M10 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h2z"></path>
    <path d="m9 14 2 2 4-4"></path>
  </svg>
);

const CustomersIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
    <circle cx="9" cy="7" r="4"></circle>
    <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
  </svg>
);

const SuppliersIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z"></path>
    <path d="m3 9 2.45-4.9A2 2 0 0 1 7.24 3h9.52a2 2 0 0 1 1.8 1.1L21 9"></path>
    <path d="M12 3v6"></path>
  </svg>
);

const ReportsIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <path d="M12 18v-4"></path>
    <path d="M8 18v-2"></path>
    <path d="M16 18v-6"></path>
  </svg>
);

const SettingsIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 1 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 1 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
);

const ReturnsIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
    <polyline points="9 22 9 12 15 12 15 22"></polyline>
    <path d="M9 10l-3 3 3 3"></path>
  </svg>
);

const PromotionIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
  </svg>
);

const GstIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
  </svg>
);

const TeamIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
    <circle cx="9" cy="7" r="4"></circle>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
  </svg>
);

const ConfigIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"></path>
    <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"></path>
    <path d="M12 2v2"></path>
    <path d="M12 22v-2"></path>
    <path d="m17 20.66-1-1.73"></path>
    <path d="M11 10.27 7 3.34"></path>
    <path d="m20.66 17-1.73-1"></path>
    <path d="m3.34 7 1.73 1"></path>
    <path d="M14 12h8"></path>
    <path d="M2 12h2"></path>
    <path d="m20.66 7-1.73 1"></path>
    <path d="m3.34 17 1.73-1"></path>
    <path d="m17 3.34-1 1.73"></path>
    <path d="m11 13.73-4 6.93"></path>
  </svg>
);

const SubstituteIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="m16 3 4 4-4 4"></path>
    <path d="M20 7H4"></path>
    <path d="m8 21-4-4 4-4"></path>
    <path d="M4 17h16"></path>
  </svg>
);

const MedicineIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"></path>
        <path d="m8.5 8.5 7 7"></path>
    </svg>
);

const PaymentIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <line x1="2" y1="10" x2="22" y2="10" />
        <line x1="7" y1="15" x2="7.01" y2="15" />
        <line x1="11" y1="15" x2="11.01" y2="15" />
    </svg>
);

const RoleIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"></path>
    <path d="M12 8v4"></path>
    <path d="M12 16h.01"></path>
  </svg>
);

const StethoscopeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8 3v7a4 4 0 0 0 8 0V3"></path>
    <path d="M5 3h6"></path>
    <path d="M13 3h6"></path>
    <path d="M16 14a4 4 0 1 0 4 4"></path>
    <circle cx="20" cy="18" r="1.5"></circle>
    <path d="M12 14v2a6 6 0 0 0 6 6"></path>
  </svg>
);

export const FileTextIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>
);

const UploadIcon_Internal = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
);

const CategoryIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <line x1="12" y1="13" x2="12" y2="18"></line>
    <line x1="8" y1="17" x2="16" y2="17"></line>
  </svg>
);


export const navigation: NavItem[] = [
  { id: 'dashboard', name: 'Dashboard', href: '#', icon: DashboardIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk', 'viewer'] },
  {
    id: 'salesMaster',
    name: 'Sales',
    href: '#',
    icon: SalesHistoryIcon, 
    roles: ['owner', 'admin', 'manager', 'clerk'],
    children: [
      { id: 'pos', name: 'POS Sales', href: '#', icon: POSIcon, roles: ['owner', 'admin', 'manager', 'clerk'] },
      { id: 'manualSalesEntry', name: 'Manual Sales Entry', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'clerk'] },
      { id: 'salesChallans', name: 'Sales Challan', href: '#', icon: ChallanIcon, roles: ['owner', 'admin', 'manager', 'clerk'] },
      { id: 'salesReturns', name: 'Sales Return', href: '#', icon: ReturnsIcon, roles: ['owner', 'admin', 'manager', 'clerk'] },
      { id: 'salesHistory', name: 'Sales History', href: '#', icon: SalesHistoryIcon, roles: ['owner', 'admin', 'manager', 'clerk'] },
    ]
  },
  {
    id: 'purchaseMaster', 
    name: 'Purchase',
    href: '#',
    icon: PurchaseIcon,
    roles: ['owner', 'admin', 'manager', 'purchase'],
    children: [
      { id: 'automatedPurchaseEntry', name: 'Automated Purchase Entry', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase'] }, 
      { id: 'manualPurchaseEntry', name: 'Manual Purchase Entry', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
      { id: 'manualSupplierInvoice', name: 'Manual Supplier Invoice', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase'] }, 
      { id: 'deliveryChallans', name: 'Purchase Challan', href: '#', icon: ChallanIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
      { id: 'purchaseOrders', name: 'Purchase Orders', href: '#', icon: PurchaseIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
      { id: 'purchaseHistory', name: 'Purchase History', href: '#', icon: SalesHistoryIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
      { id: 'purchaseReturn', name: 'Purchase Return', href: '#', icon: ReturnsIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
    ]
  },
  { id: 'inventory', name: 'Inventory', href: '#', icon: InventoryIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
  { id: 'physicalInventory', name: 'Stock Audit', href: '#', icon: AuditIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
  { id: 'nonGstPos', name: 'Estimate Billing', href: '#', icon: POSIcon, roles: ['owner', 'admin', 'manager', 'clerk'] },
  { id: 'accountReceivable', name: 'Account Receivable', href: '#', icon: PaymentIcon, roles: ['owner', 'admin', 'manager'] },
  { id: 'accountPayable', name: 'Account Payable', href: '#', icon: PaymentIcon, roles: ['owner', 'admin', 'manager'] },
  { id: 'suppliers', name: 'Suppliers', href: '#', icon: SuppliersIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
  { id: 'customers', name: 'Customers', href: '#', icon: CustomersIcon, roles: ['owner', 'admin', 'manager', 'clerk'] },
  {
    id: 'medicineMasterParent', 
    name: 'Material Master',
    href: '#',
    icon: MedicineIcon,
    roles: ['owner', 'admin', 'manager', 'purchase'],
    children: [
      { id: 'medicineMasterList', name: 'Material Master Data', href: '#', icon: MedicineIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
      { id: 'vendorNomenclature', name: 'Vendor Nomenclature', href: '#', icon: SuppliersIcon, roles: ['owner', 'admin', 'manager', 'purchase'] },
      { id: 'bulkUtility', name: 'Bulk Utility', href: '#', icon: UploadIcon_Internal, roles: ['owner', 'admin', 'manager', 'purchase'] },
    ]
  },
  {
    id: 'otherMaster',
    name: 'Other Master',
    href: '#',
    icon: RoleIcon,
    roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'],
    children: [
      { id: 'priceMaster', name: 'Price Master', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager'] },
      { id: 'doctorsMaster', name: 'Doctor’s Master', href: '#', icon: StethoscopeIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'] },
      {
        id: 'mbcCardParent',
        name: 'MBC Card',
        href: '#',
        icon: FileTextIcon,
        roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'],
        children: [
          { id: 'mbcCardDashboard', name: 'MBC Card Dashboard', href: '#', icon: DashboardIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'] },
          { id: 'mbcCardList', name: 'MBC Card List', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'] },
          { id: 'mbcGenerateCard', name: 'Generate MBC Card', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'] },
          { id: 'mbcCardTypeMaster', name: 'MBC Card Type Master', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'] },
          { id: 'mbcCardTemplateMaster', name: 'MBC Card Template Master', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'] },
          { id: 'mbcCardPrintPreview', name: 'Print / Preview MBC Card', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'] },
          { id: 'mbcCardRenewalHistory', name: 'MBC Card Renewal / Upgrade History', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk'] },
        ]
      },
    ]
  },
  { id: 'substituteFinder', name: 'Substitute Finder', href: '#', icon: SubstituteIcon, roles: ['owner', 'admin', 'manager', 'purchase', 'clerk', 'viewer'] },
  { id: 'promotions', name: 'Promotions', href: '#', icon: PromotionIcon, roles: ['owner', 'admin', 'manager'] },
  {
    id: 'financialStatement',
    name: 'Financial Statement',
    href: '#',
    icon: ReportsIcon,
    roles: ['owner', 'admin', 'manager'],
    children: [
      { id: 'reports', name: 'Report', href: '#', icon: ReportsIcon, roles: ['owner', 'admin', 'manager'] },
      { id: 'balanceCarryforward', name: 'Balance Carryforward', href: '#', icon: ReportsIcon, roles: ['owner', 'admin', 'manager'] },
      { id: 'newJournalEntryVoucher', name: 'New Journal Entry Voucher', href: '#', icon: FileTextIcon, roles: ['owner', 'admin', 'manager'] },
    ],
  },
  { id: 'eway', name: 'E-Way Billing', href: '#', icon: GstIcon, roles: ['owner', 'admin', 'manager'] },
  { id: 'gst', name: 'GST Center', href: '#', icon: GstIcon, roles: ['owner', 'admin', 'manager'] },
];

export const settingsNavigation: NavItem[] = [];

export const MASTER_SHORTCUT_OPTIONS = [
    { id: 'pos', label: 'POS Sales', group: 'Sales', color: 'text-green-600', icon: <POSIcon /> },
    { id: 'manualSalesEntry', label: 'Manual Sales Entry', group: 'Sales', color: 'text-green-700', icon: <FileTextIcon /> },
    { id: 'salesChallans', label: 'Sales Challan', group: 'Sales', color: 'text-blue-600', icon: <ChallanIcon /> },
    { id: 'salesReturns', label: 'Sales Return', group: 'Sales', color: 'text-amber-700', icon: <ReturnsIcon /> },
    { id: 'salesHistory', label: 'Sales History', group: 'Sales', color: 'text-gray-600', icon: <SalesHistoryIcon /> },

    { id: 'automatedPurchaseEntry', label: 'Automated Purchase Entry', group: 'Purchase', color: 'text-indigo-600', icon: <PurchaseIcon /> },
    { id: 'manualPurchaseEntry', label: 'Manual Purchase Entry', group: 'Purchase', color: 'text-indigo-700', icon: <FileTextIcon /> },
    { id: 'manualSupplierInvoice', label: 'Manual Supplier Invoice', group: 'Purchase', color: 'text-violet-600', icon: <FileTextIcon /> },
    { id: 'deliveryChallans', label: 'Purchase Challan', group: 'Purchase', color: 'text-sky-600', icon: <ChallanIcon /> },
    { id: 'purchaseOrders', label: 'Purchase Orders', group: 'Purchase', color: 'text-blue-700', icon: <PurchaseIcon /> },
    { id: 'purchaseHistory', label: 'Purchase History', group: 'Purchase', color: 'text-cyan-700', icon: <SalesHistoryIcon /> },
    { id: 'purchaseReturn', label: 'Purchase Return', group: 'Purchase', color: 'text-amber-800', icon: <ReturnsIcon /> },
    { id: 'inventory', label: 'Inventory', group: 'Purchase', color: 'text-orange-600', icon: <InventoryIcon /> },

    { id: 'physicalInventory', label: 'Stock Audit', group: 'Stock Audit', color: 'text-amber-600', icon: <AuditIcon /> },

    { id: 'nonGstPos', label: 'Estimate Billing', group: 'Billing', color: 'text-lime-700', icon: <POSIcon /> },

    { id: 'accountReceivable', label: 'Account Receivable', group: 'Accounts', color: 'text-blue-600', icon: <PaymentIcon /> },
    { id: 'accountPayable', label: 'Account Payable', group: 'Accounts', color: 'text-red-600', icon: <PaymentIcon /> },

    { id: 'suppliers', label: 'Suppliers', group: 'Masters', color: 'text-cyan-600', icon: <SuppliersIcon /> },
    { id: 'customers', label: 'Customers', group: 'Masters', color: 'text-teal-600', icon: <CustomersIcon /> },
    { id: 'medicineMasterList', label: 'Material Master Data', group: 'Masters', color: 'text-purple-600', icon: <MedicineIcon /> },
    { id: 'vendorNomenclature', label: 'Vendor Nomenclature', group: 'Masters', color: 'text-fuchsia-700', icon: <SuppliersIcon /> },
    { id: 'bulkUtility', label: 'Bulk Utility', group: 'Masters', color: 'text-slate-700', icon: <UploadIcon_Internal /> },
    { id: 'doctorsMaster', label: 'Doctor’s Master', group: 'Masters', color: 'text-emerald-700', icon: <StethoscopeIcon /> },
    { id: 'mbcCardDashboard', label: 'MBC Card Dashboard', group: 'Masters', color: 'text-indigo-700', icon: <DashboardIcon /> },
    { id: 'mbcCardList', label: 'MBC Card List', group: 'Masters', color: 'text-indigo-700', icon: <FileTextIcon /> },
    { id: 'mbcGenerateCard', label: 'Generate MBC Card', group: 'Masters', color: 'text-indigo-700', icon: <FileTextIcon /> },
    { id: 'mbcCardTypeMaster', label: 'MBC Card Type Master', group: 'Masters', color: 'text-indigo-700', icon: <FileTextIcon /> },
    { id: 'mbcCardTemplateMaster', label: 'MBC Card Template Master', group: 'Masters', color: 'text-indigo-700', icon: <FileTextIcon /> },
    { id: 'mbcCardPrintPreview', label: 'Print / Preview MBC Card', group: 'Masters', color: 'text-indigo-700', icon: <FileTextIcon /> },
    { id: 'mbcCardRenewalHistory', label: 'MBC Card Renewal / Upgrade History', group: 'Masters', color: 'text-indigo-700', icon: <FileTextIcon /> },

    { id: 'substituteFinder', label: 'Substitute Finder', group: 'Utilities', color: 'text-rose-500', icon: <SubstituteIcon /> },
    { id: 'promotions', label: 'Promotions', group: 'Utilities', color: 'text-pink-600', icon: <PromotionIcon /> },
];

export const BASE_UNITS = ['Tablet', 'Capsule', 'Bottle', 'Injection', 'Cream', 'Gel', 'Sachet', 'Piece', 'Unit', 'kg', 'g', 'ml', 'L'];
export const PACK_UNITS = ['Strip', 'Box', 'Bottle', 'Tube', 'Jar', 'Pack', 'Sachet', 'Vial', 'Ampoule', 'Bag', 'Carton'];

export const configurableModules = [
  {
    id: 'dashboard',
    name: 'Dashboard',
    fields: [
      { id: 'statSales', name: 'Today’s Sales' },
      { id: 'statProfit', name: 'Today’s Profit' },
      { id: 'statStockValue', name: 'Stock Value' },
      { id: 'statPurchases', name: 'Purchases' },
      { id: 'recentVouchers', name: 'Recent Vouchers' },
      { id: 'kpiLowStock', name: 'Low Stock' },
      { id: 'kpiAudits', name: 'Audits' },
      { id: 'kpiReturns', name: 'Purchase Returns' },
    ]
  },
  {
    id: 'pos',
    name: 'POS Sales',
    fields: [
      { id: 'colDate', name: 'Date' },
      { id: 'colCustomer', name: 'Particulars (Customer Name)' },
      { id: 'colAddress', name: 'Address' },
      { id: 'colPhone', name: 'Phone Number' },
      { id: 'colReferred', name: 'Referred By' },
      { id: 'colName', name: 'Name of Item' },
      { id: 'colBatch', name: 'Batch' },
      { id: 'colExpiry', name: 'Expiry' },
      { id: 'colPack', name: 'Pack' },
      { id: 'colMrp', name: 'MRP' },
      { id: 'colRate', name: 'RATE' },
      { id: 'colPQty', name: 'Pack qty' },
      { id: 'colLQty', name: 'Loose qty' },
      { id: 'colFree', name: 'Free' },
      { id: 'colDisc', name: 'Disc %' },
      { id: 'colGst', name: 'GST %' },
      { id: 'colSch', name: 'Line Item Column: Scheme (SCH)' },
      { id: 'colAmount', name: 'Amount' },
      { id: 'optPrescription', name: 'Prescription Management' },
      { id: 'optBillingCategory', name: 'Billing Category' },
      { id: 'intelHub', name: 'Intelligence Hub Section' },
      { id: 'intelProfit', name: 'Profit Quotient Panel' },
      { id: 'intelIdentity', name: 'Identity & Validity Panel' },
      { id: 'intelPricing', name: 'Pricing Vector Panel' },
    ]
  },
  {
    id: 'purchase',
    name: 'Purchase Entry',
    fields: [
      { id: 'fieldSupplier', name: 'Supplier / Party Name' },
      { id: 'fieldInvoiceNo', name: 'Invoice #' },
      { id: 'fieldDate', name: 'Date' },
      { id: 'colName', name: 'Name of Item' },
      { id: 'colBrand', name: 'MFR / Brand' },
      { id: 'colBatch', name: 'Batch' },
      { id: 'colExpiry', name: 'Exp.' },
      { id: 'colPack', name: 'Pack' },
      { id: 'colFree', name: 'Free' },
      { id: 'colMrp', name: 'MRP' },
      { id: 'colPQty', name: 'Pack qty' },
      { id: 'colLQty', name: 'Loose qty' },
      { id: 'colPurRate', name: 'Pur. Rate' },
      { id: 'colDisc', name: 'Disc %' },
      { id: 'colSch', name: 'Sch %' },
      { id: 'colGst', name: 'GST %' },
      { id: 'colAmount', name: 'Amount' },
      { id: 'sumGross', name: 'Summary: Gross Amount' },
      { id: 'sumTradeDisc', name: 'Summary: Trade Discount' },
      { id: 'sumSchDisc', name: 'Summary: Scheme Discount' },
      { id: 'sumTaxable', name: 'Summary: Taxable Value' },
      { id: 'sumGst', name: 'Summary: GST Tax' },
    ]
  },
  {
    id: 'inventory',
    name: 'Inventory',
    fields: [
      { id: 'colName', name: 'Product Name' },
      { id: 'colCategory', name: 'Category' },
      { id: 'colManufacturer', name: 'Manufacturer' },
      { id: 'colComposition', name: 'Composition' },
      { id: 'colHsn', name: 'HSN/SAC Code' },
      { id: 'colBarcode', name: 'Barcode' },
      { id: 'colBatch', name: 'Batch Number' },
      { id: 'colStrips', name: 'Pack qty' },
      { id: 'colLoose', name: 'Loose qty' },
      { id: 'colStock', name: 'Total Base Units (Stock)' },
      { id: 'colBaseUnit', name: 'Base Unit' },
      { id: 'colPackUnit', name: 'Pack Unit' },
      { id: 'colUnitsPerPack', name: 'Units per Pack' },
      { id: 'colPackType', name: 'Pack Display' },
      { id: 'colUom', name: 'Unit of Measurement' },
      { id: 'colMinStock', name: 'Minimum Stock Limit' },
      { id: 'colExpiry', name: 'Expiry Date' },
      { id: 'colPurPrice', name: 'Purchase Price' },
      { id: 'colPtr', name: 'PTR' },
      { id: 'colRateA', name: 'Rate A' },
      { id: 'colRateB', name: 'Rate B' },
      { id: 'colRateC', name: 'Rate C' },
      { id: 'colMrp', name: 'MRP' },
      { id: 'colGst', name: 'GST %' },
      { id: 'colScheme', name: 'Sale Scheme' },
      { id: 'colSupplier', name: 'Supplier Name' }
    ]
  },
  {
    id: 'reports',
    name: 'Financial Statement',
    fields: [
        { id: 'report', name: 'Report' },
        { id: 'balanceCarryforward', name: 'Balance Carryforward' },
        { id: 'salesRegister', name: 'Sales Register' },
        { id: 'salesSummary', name: 'Sales Summary' },
        { id: 'billWiseSales', name: 'Bill-wise Sales' },
        { id: 'dateWiseSales', name: 'Date-wise Sales' },
        { id: 'partyWiseSales', name: 'Party-wise Sales' },
        { id: 'doctorWiseSales', name: 'Doctor-wise Sales Report' },
        { id: 'itemWiseSales', name: 'Item-wise Sales' },
        { id: 'categoryWiseSales', name: 'Category-wise Sales' },
        { id: 'areaWiseSales', name: 'Area-wise Sales' },
        { id: 'salesReturnRegister', name: 'Sales Return Register' },
        { id: 'creditNoteRegister', name: 'Credit Note Register' },
        { id: 'schemeDiscountReport', name: 'Scheme/Discount Report' },
        { id: 'freeQuantityReport', name: 'Free Quantity Report' },
        { id: 'profitOnSales', name: 'Profit on Sales' },
        { id: 'marginAnalysis', name: 'Margin Analysis' },
        { id: 'cancelledDeletedBills', name: 'Cancelled Bills' },
        { id: 'purchaseRegister', name: 'Purchase Register' },
        { id: 'purchaseSummary', name: 'Purchase Summary' },
        { id: 'billWisePurchase', name: 'Bill-wise Purchase' },
        { id: 'supplierWisePurchase', name: 'Supplier-wise Purchase' },
        { id: 'itemWisePurchase', name: 'Item-wise Purchase' },
        { id: 'purchaseReturnRegister', name: 'Purchase Return Register' },
        { id: 'debitNoteRegister', name: 'Debit Note Register' },
        { id: 'stockSummary', name: 'Stock Summary' },
        { id: 'batchWiseStock', name: 'Batch-wise Stock' },
        { id: 'expiryWiseStock', name: 'Expiry-wise Stock' },
        { id: 'nearExpiryReport', name: 'Near Expiry Report' },
        { id: 'expiredStockReport', name: 'Expired Stock Report' },
        { id: 'negativeStock', name: 'Negative Stock Report' },
        { id: 'reorderLevelReport', name: 'Reorder Level Report' },
        { id: 'stockMovementSummary', name: 'Stock Movement Summary' },
        { id: 'ledgerReport', name: 'Account Ledger' },
        { id: 'dayBook', name: 'Day Book' },
        { id: 'outstandingReceivables', name: 'Outstanding Receivables' },
        { id: 'outstandingPayables', name: 'Outstanding Payables' }
    ]
  }
];

export const STATE_DISTRICT_MAP: { [key: string]: string[] } = {
    "Andhra Pradesh": ["Anantapur", "Chittoor", "East Godavari", "Guntur", "Krishna", "Kurnool", "Prakasam", "Srikakulam", "Sri Potti Sriramulu Nellore", "Visakhapatnam", "Vizianagaram", "West Godavari", "YSR Kadapa"],
    "Arunachal Pradesh": ["Anjaw", "Changlang", "Dibang Valley", "East Kameng", "East Siang", "Kamle", "Kra Daadi", "Kurung Kumey", "Lepa Rada", "Lohit", "Longding", "Lower Dibang Valley", "Lower Siang", "Lower Subansiri", "Namsai", "Pakke Kessang", "Papum Pare", "Shi Yomi", "Siang", "Tawang", "Tirap", "Upper Siang", "Upper Subansiri", "West Kameng", "West Siang"],
    "Assam": ["Bajali", "Baksa", "Barpeta", "Biswanath", "Bongaigaon", "Cachar", "Charaideo", "Chirang", "Darrang", "Dhemaji", "Dhubri", "Dibrugarh", "Dima Hasao", "Goalpara", "Golaghat", "Hailakandi", "Hojai", "Jorhat", "Kamrup", "Kamrup Metropolitan", "Karbi Long", "Karimganj", "Kokrajhar", "Lakhimpur", "Majuli", "Morigaon", "Nagaon", "Nalbari", "Sivasagar", "Sonitpur", "South Salmara-Mankachar", "Tinsukia", "Udalguri", "West Karbi Long"],
    "Bihar": ["Araria", "Arwal", "Aurangabad", "Banka", "Begusarai", "Bhagalpur", "Bhojpur", "Buxar", "Darbhanga", "East Champaran (Motihari)", "Gaya", "Gopalganj", "Jamui", "Jehanabad", "Kaimur (Bhabua)", "Katihar", "Khagaria", "Kishanganj", "Lakhisarai", "Madhepura", "Madhubani", "Munger (Monghyr)", "Vamuzzaffarpur", "Nalanda", "Nawada", "Potna", "Purnia (Purnea)", "Rohtas", "Saharsa", "Samastipur", "Saran", "Sheikhpura", "Sheohar", "Sitamarhi", "Siwan", "Supaul", "Vaishali", "West Champaran"],
    "Chandigarh": ["Chandigarh"],
    "Chhattisgarh": ["Balod", "Baloda Bazar", "Balrampur", "Bastar", "Bemetara", "Bijapur", "Bilaspur", "Dantewada (South Bastar)", "Dhamtari", "Durg", "Gariyaband", "Gaurela-Pendra-Marwahi", "Janjgir-Champa", "Jashpur", "Kabirdham (Kawardha)", "Kanker (North Bastar)", "Kondagaon", "Korba", "Korea (Koriya)", "Mahasamund", "Mungeli", "Narayanpur", "Raigarh", "Raipur", "Rajnandgaon", "Sukma", "Surajpur", "Surguja"],
    "Dadra and Nagar Haveli and Daman and Diu": ["Dadra & Nagar Haveli", "Daman", "Diu"],
    "Delhi": ["Central Delhi", "East Delhi", "New Delhi", "North Delhi", "North East Delhi", "North West Delhi", "Shahdara", "South Delhi", "South East Delhi", "South West Delhi", "West Delhi"],
    "Goa": ["North Goa", "South Goa"],
    "Gujarat": ["Ahmedabad", "Amreli", "Anand", "Aravalli", "Banaskantha (Palanpur)", "Bharuch", "Bhavnagar", "Botad", "Chhota Udepur", "Dahod", "Dang (Ahwa)", "Devbhoomi Dwarka", "Gandhinagar", "Gir Somnath", "Jamnagar", "Junagadh", "Kachchh", "Kheda (Nadiad)", "Mahisagar", "Mehsana", "Morbi", "Narmada (Rajpipla)", "Navsari", "Panchmahal (Godhra)", "Patan", "Porbandar", "Regal", "Sabarkantha (Himatnagar)", "Surat", "Surendranagar", "Tapi (Vyara)", "Vadodara", "Valsad"],
    "Haryana": ["Ambala", "Bhiwani", "Charkhi Dadri", "Faridabad", "Fatehabad", "Gurugram (Gurgaon)", "Hisar", "Jhajjar", "Jind", "Kaithal", "Karnal", "Kurukshetra", "Mahendragarh", "Nuh", "Palwal", "Panchkula", "Panipat", "Rewari", "Rohtak", "Sirsa", "Sonipat", "Yamunanagar"],
    "Himachal Pradesh": ["Bilaspur", "Chamba", "Hamirpur", "Inter", "Kinnaur", "Kullu", "Lahaul & Spiti", "Mandi", "Clarify Confirmation", "Shimla", "Sirmaur (Sirmour)", "Solan", "Una"],
    "Jammu and Kashmir": ["Anantnag", "Bandipora", "Baramulla", "Budgam", "Doda", "Ganderbal", "Jammu", "Kathua", "Kishtwar", "Kulgam", "Kupwara", "Poonch", "Plwama", "Rajouri", "Ramban", "Reasi", "Samba", "Shopian", "Srinagar", "Udhampur"],
    "Jharkhand": ["Bokaro", "Chatra", "Deoghar", "Dhanbad", "Dummy", "East Singhbhum", "Garhwa", "Giridih", "Godda", "Gumla", "Hazaribag", "Jamtara", "Khunti", "Koderma", "Latehar", "Lohardaga", "Popur", "Palamu", "Ramgarh", "Ranchi", "Sahibganj", "Seraikela-Kharsawan", "Simdega", "West Singhbhum"],
    "Karnataka": ["Bagalkot", "Ballari (Bellary)", "Belagavi (Belgaum)", "Bengaluru (Bangalore) Rural", "Bengaluru (Bangalore) Urban", "Bidar", "Chamarajanagar", "Chikkaballapur", "Chikkamagaluru (Chikmagalur)", "Chitradurga", "Dakshina Kannada", "Davangere", "Dharwad", "Gadag", "Kalaburagi (Gulbarga)", "Hassan", "Haveri", "Kodagu", "Kolar", "Koppal", "Mandya", "Mysuru (Mysore)", "Raichur", "Ramanagara", "Shivamogga (Shimoga)", "Tumakuru (Tumkur)", "Udupi", "Uttara Kannada (Karwar)", "Vijayapura (Bijapur)", "Yadgir"],
    "Kerala": ["Alappuzha", "Ernakulam", "Idukki", "Kannur", "Kasaragod", "Kollam", "Kottayam", "Kozhikode", "Malappuram", "Palakkad", "Pathanamthitta", "Thiruvananthapuram", "Thrissur", "Wayanad"],
    "Ladakh": ["Kargil", "Leh"],
    "Lakshadweep": ["Agatti", "Amini", "Androth", "Bithra", "Chetlat", "Kadmat", "Kalpeni", "Kavaratti", "Kiltan", "Minicoy"],
    "Madhya Pradesh": ["Agar Malwa", "Alirajpur", "Anuppur", "Ashoknagar", "Balghat", "Barwani", "Betul", "Bhind", "Bhopal", "Burhanpur", "Chhatarpur", "Chhindwara", "Damoh", "Datia", "Dewas", "Dhar", "Dindori", "Guna", "Gwalior", "Harda", "Hoshangabad", "Indore", "Jabalpur", "Jhabua", "Katni", "Khandwa", "Khargone", "Mandla", "Mandsaur", "Morena", "Narsinpghur", "Neemuch", "Niwari", "Panna", "Raisen", "Rajgarh", "Ratlam", "Rewa", "Sagar", "Satna", "Sehore", "Seoni", "Shahdol", "Shajapur", "Sheopur", "Shivpuri", "Sidhi", "Singrauli", "Tikamgarh", "Ujjain", "Umaria", "Vidisha"],
    "Maharashtra": ["Ahmednagar", "Akola", "Amravati", "Aurangabad", "Beed", "Bhandara", "Buldhana", "Chandrapur", "Dhule", "Gadchiroli", "Gondia", "Hingoli", "Jalgaon", "Jalna", "Kolhapur", "Latur", "Mumbai City", "Mumbai Suburban", "Nagpur", "Nanded", "Nandurbar", "Nashik", "Osmanabad", "Palghar", "Parbhani", "Pune", "Raigad", "Ratnagiri", "Change Confirmation", "Solapur", "Thane", "Wardha", "Washim", "Yavatmal"],
    "Manipur": ["Bishnupur", "Chandel", "Churachandpur", "Imphal East", "Imphal West", "Jiribam", "Kakching", "Kamjong", "Kangpokpi", "Noney", "Pherzawl", "Senapati", "Tamenglong", "Tengnoupal", "Tengnoupal", "Thoubal", "Ukhrul"],
    "Meghalaya": ["East Garo Hills", "East Jaintia Hills", "East Khasi Hills", "North Garo Hills", "Ri Bhoi", "South Garo Hills", "South West Garo Hills", "South West Khasi Hills", "West Garo Hills", "West Jasiang Hills", "West Khasi Hills"],
    "Mizoram": ["Aizawl", "Champhai", "Hnahthial", "Khawzawl", "Kolasib", "Lawngtlai", "Lunglei", "Mamit", "Saiha", "Saitual", "Serchhip"],
    "Nagaland": ["Dimapur", "Kiphire", "Kohima", "Longleng", "Mokokchung", "Mon", "Noklak", "Peren", "Phek", "Tuensang", "Wokha", "Zunheboto"],
    "Odisha": ["Angul", "Balangir", "Balasore", "Bargarh", "Bhadrak", "Boudh", "Cuttack", "Deogarh", "Dhenkanal", "Gajapati", "Ganjam", "Jagatsinghpur", "Jajpur", "Jharsuguda", "Kalahandi", "Kandhamal", "Kendrapara", "Kendujhar (Keonjhar)", "Khordha", "Koraput", "Malkangiri", "Mayurbhyanj", "Nabarangpur", "Nayagarh", "Nuapada", "Puri", "Rayagada", "Sambalpur", "Sonepur", "Sundargarh"],
    "Puducherry": ["Karaikal", "Mahe", "Puducherry", "Yanam"],
    "Punjab": ["Amritsar", "Barnala", "Bathinda", "Faridkot", "Fatehgarh Sahib", "Fazilka", "Ferozepur", "Gurdaspur", "Hoshiarpur", "Jalandhar", "Kapurthala", "Ludhiana", "Mansa", "Moga", "Muktsar", "Pathankot", "Patientia", "Rupnagar", "Sahibzada Ajit Singh Nagar (Mohali)", "Sangrur", "Shahid Bhagat Singh Nagar (Nawanshahr)", "Sri Muktsar Sahib", "Tarn Taran"],
    "Rajasthan": ["Ajmer", "Alwar", "Banswara", "Baran", "Barmer", "Bharatpur", "Bhilwara", "Bikaner", "Bundi", "Chittorgarh"]
};
