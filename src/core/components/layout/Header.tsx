import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { RegisteredPharmacy, NavItem } from '@core/types';
import { navigation, settingsNavigation } from '@core/utils/constants';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

interface HeaderProps {
  onNewBillClick: () => void;
  currentUser: RegisteredPharmacy | null;
  onNavigate: (pageId: string) => void;
  onBack: () => void;
  canGoBack: boolean;
  onLogout: () => void;
  isFullScreen: boolean;
  onToggleFullScreen: () => void;
  brandName: string;
  currentPage: string;
  onReload: () => void;
  isReloading?: boolean;
  onResyncAll?: () => void;
  onToggleSidebar: () => void;
}

const Header: React.FC<HeaderProps> = ({ onNewBillClick, currentUser, onNavigate, onBack, canGoBack, onLogout, isFullScreen, onToggleFullScreen, brandName, currentPage, onReload, isReloading, onResyncAll, onToggleSidebar }) => {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const menuItems = [
    { id: 'data', label: '<u>K</u>: Company', children: [{id: 'settings', label: 'Alter Profile'}, {id: 'team', label: 'User Roles'}] },
    { id: 'data_mgt', label: '<u>Y</u>: Data', children: [{id: 'configuration', label: 'Settings'}, {id: 'inventory', label: 'Import Items'}] },
    { id: 'exchange', label: '<u>Z</u>: Exchange', children: [{id: 'eway', label: 'E-Way Bill'}] },
    { id: 'go_to', label: '<u>G</u>: Go To', children: [{id: 'pos', label: 'Sale Entry'}, {id: 'manualSupplierInvoice', label: 'Manual Supplier Invoice'}, {id: 'reports', label: 'Management Reports'}] }
  ];

  const utilitiesSetupMenu = {
    id: 'utilities_setup',
    label: 'Utilities & Setup',
    children: [
      { id: 'configuration', label: 'Global ERP Configuration (Control Room)' },
      { id: 'companyConfiguration', label: 'Company Configuration' },
      { id: 'businessRoles', label: 'Business Roles' },
      { id: 'businessUsers', label: 'Business Users' },
      { id: 'classification', label: 'Classification' },
      { id: 'settings', label: 'System Settings' },
      { id: 'moduleVisibility', label: 'Module Hide / Unhide  (Locked)' },
      { id: 'eway', label: 'Statutory / E-Way Billing Management' },
      { id: 'ewayLoginSetup', label: 'E-Way Login Setup' },
    ]
  };

  const dailyReportsMenu = {
    id: 'daily_reports',
    label: 'Daily Reports',
    children: [
      {
        id: 'dailyWorking',
        label: 'Daily Working',
        children: [
          { id: 'dailyReports:dispatchSummary', label: 'Dispatch Summary' },
          { id: 'dailyReports:reorderManagement', label: 'Re-order Management' },
          { id: 'dailyReports:stockSaleAnalysis', label: 'Stock & Sale Analysis' },
          { id: 'dailyReports:multiBillPrinting', label: 'Multi Bill / Other Printing' },
          { id: 'dailyReports:challanToBill', label: 'Challan to Bill' },
          { id: 'dailyReports:pendingChallans', label: 'Pending Challans' },
          { id: 'dailyReports:dispatchManagementReports', label: 'Dispatch Management Reports' },
          { id: 'dailyReports:rateComparisonStatement', label: 'Rate Comparison Statement' },
          { id: 'dailyReports:mergeBillsSingleOrder', label: 'Merge Bills in Single Order' },
          { id: 'dailyReports:partyNotVisited', label: 'Party Not Visited' },
          { id: 'dailyReports:billNotPrinted', label: 'Bill Not Printed' },
        ]
      },
      { id: 'dailyReports:fastReports', label: 'Fast Reports' },
      { id: 'dailyReports:businessAnalysis', label: 'Business Analysis' },
      { id: 'dailyReports:orderCrm', label: 'Order CRM' },
      { id: 'dailyReports:saleReport', label: 'Sale Report' },
      { id: 'dailyReports:purchaseReport', label: 'Purchase Report' },
      { id: 'dailyReports:inventoryReports', label: 'Inventory Reports' },
      { id: 'dailyReports:abcAnalysis', label: 'ABC Analysis' },
      { id: 'dailyReports:allAccountingRecords', label: 'All Accounting Records' },
      { id: 'dailyReports:purchasePlanning', label: 'Purchase Planning' },
    ]
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
        if (e.altKey && e.key.toLowerCase() === 'r') {
            e.preventDefault();
            onReload();
        }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [onReload]);

  const handleNewWindow = useCallback(async () => {
    try {
        const timestamp = Date.now();
        const webview = new WebviewWindow(`window-${timestamp}`, {
            url: '/',
            title: `MDXera ERP - Window ${timestamp}`,
            minWidth: 1024,
            minHeight: 768,
        });
        
        webview.once('tauri://error', function (e) {
            console.error('Error creating new window:', e);
        });
    } catch (err) {
        console.error('Failed to create new window:', err);
    }
  }, []);

  return (
    <div className="flex flex-col border-b border-gray-400 bg-[#e1e1e1] dark:bg-zinc-900 select-none print:hidden">
      {/* Top Bar - Restored to non-scrollable */}
      <div className="flex items-center h-9 bg-primary text-white text-[12px] sm:text-[13px] font-bold" ref={menuRef}>
        <div className="flex items-center h-full px-2">
            <div className="px-3 bg-white/10 h-full flex items-center mr-2">
                <span className="tracking-widest uppercase text-[11px] sm:text-[13px]">MDXERA ERP</span>
            </div>
            <button
                onClick={onToggleSidebar}
                className="h-full px-3 hover:bg-white/20 transition-colors flex items-center border-r border-white/10 text-base"
                title="Toggle Sidebar"
                aria-label="Toggle Sidebar"
            >
                ☰
            </button>
            {canGoBack && (
                <button
                    onClick={onBack}
                    className="h-full px-3 hover:bg-white/20 transition-colors flex items-center border-r border-white/10 text-base gap-1"
                    title="Go Back"
                    aria-label="Go Back"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                    <span className="text-[11px] uppercase font-bold hidden sm:inline">Back</span>
                </button>
            )}
            {menuItems.map(item => (
                <div key={item.id} className="relative h-full">
                    <button 
                        onClick={() => setActiveMenu(activeMenu === item.id ? null : item.id)}
                        className={`h-full px-3 sm:px-4 hover:bg-white/20 transition-colors flex items-center border-r border-white/10 ${activeMenu === item.id ? 'bg-white/20' : ''} whitespace-nowrap`}
                        dangerouslySetInnerHTML={{ __html: item.label }}
                    />
                    {activeMenu === item.id && (
                        <div className="absolute top-full left-0 w-48 sm:w-56 bg-white dark:bg-zinc-800 border border-gray-400 shadow-xl z-[100] py-1">
                            {item.children.map(child => (
                                <button
                                    key={child.id}
                                    onClick={() => { onNavigate(child.id); setActiveMenu(null); }}
                                    className="w-full text-left px-4 py-2 hover:bg-primary hover:text-white text-gray-800 dark:text-gray-200 text-[11px] sm:text-[12px] font-bold"
                                >
                                    {child.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            ))}
            <button
                onClick={onReload}
                disabled={isReloading}
                className={`h-full px-3 sm:px-4 hover:bg-white/20 transition-colors flex items-center border-r border-white/10 gap-2 ${isReloading ? 'opacity-50' : ''}`}
            >
                {isReloading ? (
                    <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                ) : <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>}
                <span className="whitespace-nowrap font-bold"><u>R</u>eload</span>
            </button>
            <button
                onClick={handleNewWindow}
                className="h-full px-3 sm:px-4 hover:bg-white/20 transition-colors flex items-center border-r border-white/10 gap-2"
                title="Open a new independent window"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="9" y1="3" x2="9" y2="21"/>
                    <path d="M13 8h4"/>
                    <path d="M15 6v4"/>
                </svg>
                <span className="whitespace-nowrap font-bold text-[#4ade80]">New Window</span>
            </button>
            {onResyncAll && (
                <button
                    onClick={onResyncAll}
                    className="h-full px-3 sm:px-4 hover:bg-white/20 transition-colors flex items-center border-r border-white/10 gap-2"
                    title="Re-download every table from the server into local storage"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <span className="whitespace-nowrap font-bold">Sync All</span>
                </button>
            )}
            <div className="relative h-full">
                <button
                    onClick={() => setActiveMenu(activeMenu === dailyReportsMenu.id ? null : dailyReportsMenu.id)}
                    className={`h-full px-3 sm:px-4 hover:bg-white/20 transition-colors flex items-center border-r border-white/10 whitespace-nowrap ${activeMenu === dailyReportsMenu.id ? 'bg-white/20' : ''}`}
                >
                    {dailyReportsMenu.label}
                </button>
                {activeMenu === dailyReportsMenu.id && (
                    <div className="absolute top-full left-0 w-64 sm:w-72 bg-white dark:bg-zinc-800 border border-gray-400 shadow-xl z-[100] py-1 overflow-y-auto max-h-[70vh]">
                        {dailyReportsMenu.children.map(child => (
                            <div key={child.id} className="group relative">
                                <button
                                    onClick={() => {
                                        if (!('children' in child) || !child.children) {
                                            onNavigate(child.id);
                                            setActiveMenu(null);
                                        }
                                    }}
                                    className="w-full text-left px-4 py-2 hover:bg-primary hover:text-white text-gray-800 dark:text-gray-200 text-[11px] sm:text-[12px] font-bold flex justify-between items-center"
                                >
                                    {child.label}
                                    {'children' in child && child.children ? <span>▸</span> : null}
                                </button>
                                {'children' in child && child.children && (
                                    <div className="absolute top-0 left-full w-64 sm:w-80 bg-white dark:bg-zinc-800 border border-gray-400 shadow-xl hidden group-hover:block z-[110] py-1">
                                        {child.children.map(grandChild => (
                                            <button
                                                key={grandChild.id}
                                                onClick={() => { onNavigate(grandChild.id); setActiveMenu(null); }}
                                                className="w-full text-left px-4 py-2 hover:bg-primary hover:text-white text-gray-800 dark:text-gray-200 text-[11px] sm:text-[12px] font-bold"
                                            >
                                                {grandChild.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="relative h-full">
                <button
                    onClick={() => setActiveMenu(activeMenu === utilitiesSetupMenu.id ? null : utilitiesSetupMenu.id)}
                    className={`h-full px-3 sm:px-4 hover:bg-white/20 transition-colors flex items-center border-r border-white/10 whitespace-nowrap ${activeMenu === utilitiesSetupMenu.id ? 'bg-white/20' : ''}`}
                >
                    {utilitiesSetupMenu.label}
                </button>
                {activeMenu === utilitiesSetupMenu.id && (
                    <div className="absolute top-full left-0 w-64 sm:w-72 bg-white dark:bg-zinc-800 border border-gray-400 shadow-xl z-[100] py-1">
                        {utilitiesSetupMenu.children.map(child => (
                            <button
                                key={child.id}
                                onClick={() => { onNavigate(child.id); setActiveMenu(null); }}
                                className="w-full text-left px-4 py-2 hover:bg-primary hover:text-white text-gray-800 dark:text-gray-200 text-[11px] sm:text-[12px] font-bold"
                            >
                                {child.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            
            <div className="ml-auto flex items-center gap-3 h-full pr-2">
                <div className="flex items-center gap-2 px-2 border-l border-white/10 h-full text-accent">
                    <span className="text-[10px] sm:text-[11px] uppercase truncate max-w-[100px] sm:max-w-none">{currentUser?.pharmacy_name}</span>
                </div>
                <button onClick={onLogout} className="px-3 hover:bg-red-700 h-full transition-colors font-bold text-[10px] sm:text-[11px] uppercase">Quit</button>
            </div>
        </div>
      </div>

      {/* Button Toolbar - Only visible on Dashboard */}
      {currentPage === 'dashboard' && (
        <div className="flex items-center h-10 px-2 gap-1.5 bg-[#f1f1f1] dark:bg-zinc-800 border-b border-gray-300">
            <ToolbarButton label="F2: Date" onClick={() => {}} />
            <ToolbarButton label="F3: Company" onClick={() => onNavigate('settings')} />
            <ToolbarButton label="F4: Stock" onClick={() => onNavigate('inventory')} />
            <ToolbarButton label="F10: Other Vouchers" onClick={() => onNavigate('pos')} />
            <div className="flex-1"></div>
            <button onClick={onToggleFullScreen} className="px-4 py-1.5 text-[11px] font-bold hover:bg-gray-200 rounded">
                {isFullScreen ? 'Exit Full' : 'Fullscreen'}
            </button>
        </div>
      )}
    </div>
  );
};

const ToolbarButton: React.FC<{ label: string, onClick: () => void }> = ({ label, onClick }) => (
    <button 
        onClick={label.toLowerCase().includes('reload') ? (e) => e.preventDefault() : onClick}
        className="flex items-center h-8 px-4 bg-white dark:bg-zinc-700 border border-gray-300 hover:bg-primary hover:border-primary hover:text-white transition-all text-[12px] font-bold uppercase tracking-tighter"
    >
        {label}
    </button>
);

export default Header;
