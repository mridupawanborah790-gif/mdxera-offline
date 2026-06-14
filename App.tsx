import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Sidebar from '@core/components/layout/Sidebar';
import Header from '@core/components/layout/Header';
import StatusBar from '@core/components/layout/StatusBar';
import NotificationSystem from '@core/components/feedback/NotificationSystem';
import Dashboard from '@modules/pos/components/Dashboard';
import POS from '@modules/pos/components/POS';
import SalesHistory from '@modules/sales/components/SalesHistory';
import PurchaseForm from '@modules/purchase/components/PurchaseForm';
import PurchaseHistory from '@modules/purchase/components/PurchaseHistory';
import Inventory from '@modules/inventory/components/Inventory';
import PhysicalInventory from '@modules/inventory/components/PhysicalInventory';
import Suppliers from '@modules/suppliers/components/Suppliers';
import Customers from '@modules/customers/components/Customers';
import DoctorsMaster from '@modules/suppliers/components/DoctorsMaster';
import MbcCardManagement from '@modules/loyalty/components/MbcCardManagement';
import MaterialMaster from '@modules/inventory/components/MaterialMaster';
import SubstituteFinder from '@modules/inventory/components/SubstituteFinder';
import Promotions from '@modules/configuration/components/Promotions';
import Reports from '@modules/reports/components/Reports';
import DailyReports from '@modules/reports/components/DailyReports';
import BalanceCarryforward from '@modules/accounting/components/BalanceCarryforward';
import NewJournalEntryVoucher from '@modules/accounting/components/NewJournalEntryVoucher';
import GstCenter from '@modules/gst/components/GstCenter';
import EWayBilling from '@modules/gst/components/EWayBilling';
import EWayLoginSetup from '@modules/gst/components/EWayLoginSetup';
import BusinessUserAssignment from '@modules/configuration/components/BusinessUserAssignment';
import BusinessRoles from '@modules/configuration/components/BusinessRoles';
import Configuration from '@modules/configuration/components/Configuration';
import CompanyConfiguration from '@modules/configuration/components/CompanyConfiguration';
import Settings from '@modules/configuration/components/Settings';
import Auth from '@core/auth/components/Auth';
import AccountReceivable from '@modules/customers/components/AccountReceivable';
import AccountPayable from '@modules/suppliers/components/AccountPayable';
import Returns from '@modules/sales/components/Returns';
import DeliveryChallans from '@modules/purchase/components/DeliveryChallans';
import SalesChallans from '@modules/sales/components/SalesChallans';
import ManualSalesEntry from '@modules/sales/components/ManualSalesEntry';
import ManualPurchase from '@modules/purchase/components/ManualPurchase';
import PurchaseOrders from '@modules/purchase/components/PurchaseOrders';
import Classification from '@modules/reports/components/Classification';
import PrintBillModal from '@modules/pos/components/PrintBillModal';
import TransactionDetailModal from '@modules/sales/components/TransactionDetailModal';
import PurchaseDetailModal from '@modules/purchase/components/PurchaseDetailModal';
import PrintPurchaseOrderModal from '@modules/purchase/components/PrintPurchaseOrderModal';
import PrintableReportModal from '@modules/sales/components/PrintableReportModal';
import MobileCaptureView from '@core/components/ui/MobileCaptureView';
import TallyPrompt from '@core/components/ui/TallyPrompt';
import * as storage from './services/storageService';
import { supabase } from '@core/db/supabaseClient';
import { db as sqliteDb } from '@core/db/client';
import { TABLE as SQLITE_TABLE } from '@core/db/schema';
import { parseNetworkAndApiError } from '@core/utils/error';
import { evaluateCustomerCredit, getCustomerOpenChallanExposure } from '@core/utils/creditControl';
import {
    RegisteredPharmacy, InventoryItem, Transaction, BillItem, Purchase, PurchaseItem, Supplier, Distributor,
    Customer, Medicine, SupplierProductMap, EWayBill, AppConfigurations,
    Notification, PhysicalInventorySession, DeliveryChallan, SalesChallan,
    PurchaseOrder, DetailedBill, PhysicalInventoryStatus, SalesReturn, PurchaseReturn, DeliveryChallanStatus, SalesChallanStatus,
    PurchaseOrderStatus, PurchaseOrderReceiveMode, Category, SubCategory, Promotion, OrganizationMember, ModuleConfig, MrpChangeLogEntry, BusinessRole, DoctorMaster
} from '@core/types';
import { navigation } from './constants';
import { getInventoryPolicy } from '@core/utils/materialType';
import { extractPackMultiplier, resolveUnitsPerStrip } from '@core/utils/pack';
import { setActiveScreenScope, shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';
import { createSupplierQuick, formatSupplierApiError, SupplierQuickResult } from './services/supplierService';
import { canAccessScreen, filterNavigationByPermissions } from '@core/utils/rbac';
import { useModuleVisibilityStore } from '@core/visibility/moduleVisibilityStore';
import { filterNavByVisibility } from '@core/visibility/useModuleVisibility';
import ModuleVisibility from '@modules/configuration/components/ModuleVisibility';
import { normalizeStockHandlingConfig, resolveStockHandlingConfig, logStockMovement } from '@core/utils/stockHandling';
import SyncBootstrap, { triggerFullResync, triggerFreshInstallSync } from '@core/sync/SyncBootstrap';
import { SyncEngine } from '@core/sync/SyncEngine';
import FreshInstallSyncDialog from '@core/components/feedback/FreshInstallSyncDialog';
import { resolveAsset } from '@core/utils/assetCache';

const DATA_ENTRY_SCREENS = [
    'pos', 'nonGstPos', 'automatedPurchaseEntry', 'manualPurchaseEntry', 'manualSupplierInvoice',
    'manualSalesEntry', 'physicalInventory', 'deliveryChallans', 'salesChallans', 'purchaseOrders',
    'customers', 'suppliers', 'inventory', 'materialMaster', 'returns', 'salesReturns', 'purchaseReturn'
];

const APP_SCREEN_STATE_STORAGE_PREFIX = 'mdxera:screen-state:v1';
const PERSISTABLE_SCREENS = new Set([
    'dashboard', 'pos', 'nonGstPos', 'salesHistory', 'manualSalesEntry', 'salesChallans',
    'deliveryChallans', 'salesReturns', 'purchaseReturn', 'purchaseOrders', 'automatedPurchaseEntry',
    'manualPurchaseEntry', 'manualSupplierInvoice', 'purchaseHistory', 'inventory', 'physicalInventory',
    'suppliers', 'customers', 'medicineMasterList', 'masterPriceMaintain', 'vendorNomenclature', 'bulkUtility',
    'doctorsMaster',
    'substituteFinder', 'promotions', 'reports', 'dailyReports', 'balanceCarryforward', 'gst', 'eway', 'ewayLoginSetup',
    'businessUsers', 'businessRoles', 'companyConfiguration', 'configuration', 'settings', 'moduleVisibility',
    'classification', 'accountReceivable', 'accountPayable', 'newJournalEntryVoucher',
    'mbcCardDashboard', 'mbcCardList', 'mbcGenerateCard', 'mbcCardTypeMaster', 'mbcCardTemplateMaster', 'mbcCardPrintPreview', 'mbcCardRenewalHistory'
]);

type PersistedScreenState = {
    currentPage?: string;
    currentDailyReportId?: string;
    activeDashboardMenu?: 'left' | 'right';
};


const App: React.FC = () => {
    const [currentUser, setCurrentUser] = useState<RegisteredPharmacy | null>(null);
    const [showFreshInstallSyncDialog, setShowFreshInstallSyncDialog] = useState(false);
    const loadVisibilityForUser = useModuleVisibilityStore((s) => s.loadForUser);
    const hiddenScreens = useModuleVisibilityStore((s) => s.hiddenScreens);
    useEffect(() => {
        loadVisibilityForUser(currentUser?.user_id ?? null);
    }, [currentUser?.user_id, loadVisibilityForUser]);
    const [currentPage, setCurrentPage] = useState('dashboard');
    const [currentDailyReportId, setCurrentDailyReportId] = useState('dispatchSummary');
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [isAppLoading, setIsAppLoading] = useState(true);
    const [loadingProgress, setLoadingProgress] = useState(0);
    useEffect(() => {
        if (!isAppLoading) return;
        const interval = setInterval(() => {
            setLoadingProgress((prev) => (prev >= 10 ? 0 : prev + 1));
        }, 300);
        return () => clearInterval(interval);
    }, [isAppLoading]);
    const [appLoadError, setAppLoadError] = useState<string | null>(null);
    const [isReloading, setIsReloading] = useState(false);
    const [isMigrationLocked, setIsMigrationLocked] = useState(false);
    const [migrationUiState, setMigrationUiState] = useState<{ active: boolean; minimized: boolean; module: string; progressPercent: number; status: 'Processing…' | 'Completed' | 'Cancelled' }>({ active: false, minimized: false, module: '', progressPercent: 0, status: 'Processing…' });
    const [migrationPopupToken, setMigrationPopupToken] = useState(0);
    const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
    const [isRealtimeActive, setIsRealtimeActive] = useState(false);
    const [syncStatus, setSyncStatus] = useState<string>('idle');
    useEffect(() => {
        const unsub = SyncEngine.on((status) => {
            setSyncStatus(status);
        });
        return unsub;
    }, []);
    const [isOperationLoading, setIsOperationLoading] = useState(false);

    const [showLogoutPrompt, setShowLogoutPrompt] = useState(false);
    const [showEscSavePrompt, setShowEscSavePrompt] = useState(false);
    const [pendingNavigation, setPendingNavigation] = useState<{ pageId: string; skipPrompt?: boolean; isBack?: boolean } | null>(null);
    const [screenResetNonce, setScreenResetNonce] = useState<Record<string, number>>({});

    // Refs to trigger child save methods remotely
    const posRef = useRef<any>(null);
    const purchaseFormRef = useRef<any>(null);

    // Reactive online/offline status. `navigator.onLine` is read once at render
    // time and doesn't notify React when connectivity flips; subscribe to the
    // browser's online/offline events so StatusBar reflects reality live.
    const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    // Redundant handleHydrateComplete listener removed to prevent double re-renders.
    // The debounced listener below handles this safely.

    const [inventory, setInventory] = useState<InventoryItem[]>([]);
    const [medicines, setMedicines] = useState<Medicine[]>([]);
    const medicinesRef = useRef<Medicine[]>([]);
    useEffect(() => {
        medicinesRef.current = medicines;
    }, [medicines]);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [purchases, setPurchases] = useState<Purchase[]>([]);
    const [suppliers, setSuppliers] = useState<Supplier[]>([]);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [doctors, setDoctors] = useState<DoctorMaster[]>([]);
    const [ewayBills, setEwayBills] = useState<EWayBill[]>([]);
    const [mappings, setMappings] = useState<SupplierProductMap[]>([]);
    const [physicalInventory, setPhysicalInventory] = useState<PhysicalInventorySession[]>([]);
    const [deliveryChallans, setDeliveryChallans] = useState<DeliveryChallan[]>([]);
    const [salesChallans, setSalesChallans] = useState<SalesChallan[]>([]);
    const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
    const [mrpChangeLogs, setMrpChangeLogs] = useState<MrpChangeLogEntry[]>([]);

    const [salesReturns, setSalesReturns] = useState<SalesReturn[]>([]);
    const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [subCategories, setSubCategories] = useState<SubCategory[]>([]);
    const [promotions, setPromotions] = useState<Promotion[]>([]);
    const [teamMembers, setTeamMembers] = useState<OrganizationMember[]>([]);
    const [businessRoles, setBusinessRoles] = useState<BusinessRole[]>([]);

    const [configurations, setConfigurations] = useState<AppConfigurations>({ organization_id: '' });
    const [defaultCustomerControlGlId, setDefaultCustomerControlGlId] = useState<string>('');
    const [defaultSupplierControlGlId, setDefaultSupplierControlGlId] = useState<string>('');
    const [bankOptions, setBankOptions] = useState<Array<{ id: string; bankName: string; accountName: string; accountNumber: string; linkedBankGlId?: string; defaultBank?: boolean; activeStatus?: string }>>([]);

    const [sourceChallansForPurchase, setSourceChallansForPurchase] = useState<{ items: PurchaseItem[], supplier: string, ids: string[] } | null>(null);
    const [sourceChallansForSales, setSourceChallansForSales] = useState<Transaction | null>(null);
    const [purchaseCopyDraft, setPurchaseCopyDraft] = useState<{ sourceId: string; items: PurchaseItem[]; supplier: string; invoiceNumber: string; date: string } | null>(null);
    const [mobileSyncSessionId, setMobileSyncSessionId] = useState<string | null>(null);
    const [editingPurchase, setEditingPurchase] = useState<Purchase | null>(null);
    const [editingSale, setEditingSale] = useState<Transaction | null>(null);
    const [salesReturnPrefillInvoiceId, setSalesReturnPrefillInvoiceId] = useState<string | null>(null);
    const [purchaseReturnPrefillInvoiceId, setPurchaseReturnPrefillInvoiceId] = useState<string | null>(null);

    const [printBill, setPrintBill] = useState<(DetailedBill & { inventory: InventoryItem[]; configurations: AppConfigurations; }) | null>(null);
    const [viewTransaction, setViewTransaction] = useState<Transaction | null>(null);
    const [viewPurchase, setViewPurchase] = useState<Purchase | null>(null);
    const [printPO, setPrintPO] = useState<(PurchaseOrder & { distributor: Distributor }) | null>(null);
    const [viewReport, setViewReport] = useState<any>(null);

    const resolveAuthViewFromLocation = (): 'auth' | 'forgot' | 'reset' => {
        const path = window.location.pathname.toLowerCase();
        if (path === '/reset-password') return 'reset';
        if (path === '/forgot-password') return 'forgot';
        return 'auth';
    };

    const [authView, setAuthView] = useState<'auth' | 'forgot' | 'reset'>(resolveAuthViewFromLocation);
    const syncMovingAverageRates = useCallback(async (basePurchases: Purchase[] = purchases, basePurchaseReturns: PurchaseReturn[] = purchaseReturns) => {
        if (!currentUser || medicinesRef.current.length === 0) return;
        const completedPurchases = basePurchases.filter(p => p.status !== 'cancelled');
        const returnQtyByCode = new Map<string, number>();
        basePurchaseReturns.forEach(pr => {
            (pr.items || []).forEach((item: any) => {
                const code = String(item.materialCode || '').trim().toLowerCase();
                if (!code) return;
                const qty = Number(item.quantity || 0) + Number(item.looseQuantity || 0);
                returnQtyByCode.set(code, (returnQtyByCode.get(code) || 0) + qty);
            });
        });

        const aggregates = new Map<string, { qty: number; value: number }>();
        completedPurchases.forEach(p => {
            p.items.forEach(item => {
                const code = String(item.materialCode || '').trim().toLowerCase();
                if (!code) return;
                const qty = Number(item.quantity || 0) + Number(item.looseQuantity || 0);
                const value = qty * Number(item.purchasePrice || 0);
                const prev = aggregates.get(code) || { qty: 0, value: 0 };
                aggregates.set(code, { qty: prev.qty + qty, value: prev.value + value });
            });
        });

        const nextMedicines = medicinesRef.current.map(med => {
            const code = String(med.materialCode || '').trim().toLowerCase();
            const agg = aggregates.get(code);
            if (!agg || agg.qty <= 0) return med;
            const returnedQty = returnQtyByCode.get(code) || 0;
            const effectiveQty = Math.max(agg.qty - returnedQty, 0);
            const movingAverageRate = effectiveQty > 0 ? Number((agg.value / effectiveQty).toFixed(2)) : 0;
            if (Number(med.movingAverageRate || 0) === movingAverageRate) return med;
            return { ...med, movingAverageRate };
        });

        const changed = nextMedicines.filter((m, idx) => m !== medicinesRef.current[idx]);
        if (changed.length === 0) return;
        setMedicines(nextMedicines);
        await Promise.all(changed.map(m => storage.saveData('material_master', m, currentUser, true)));
    }, [currentUser, purchases, purchaseReturns]);

    const [activeDashboardMenu, setActiveDashboardMenu] = useState<'left' | 'right'>('right');
    const [mountedPages, setMountedPages] = useState<string[]>(['dashboard']);
    const [history, setHistory] = useState<string[]>([]);
    const [ewayLoginSetupReturnPage, setEwayLoginSetupReturnPage] = useState<string>('dashboard');
    const pageContainerRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const pageScrollPositionsRef = useRef<Record<string, number>>({});
    const previousPageRef = useRef('dashboard');

    const getScreenStateStorageKey = useCallback((user: RegisteredPharmacy) => {
        let windowLabel = 'main';
        try {
            if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
                windowLabel = getCurrentWindow().label;
            }
        } catch (e) {
            // fallback
        }
        return `${APP_SCREEN_STATE_STORAGE_PREFIX}:${user.organization_id}:${user.user_id}:${windowLabel}`;
    }, []);

    const readPersistedScreenState = useCallback((user: RegisteredPharmacy): PersistedScreenState | null => {
        try {
            const stored = window.localStorage.getItem(getScreenStateStorageKey(user));
            if (!stored) return null;
            return JSON.parse(stored) as PersistedScreenState;
        } catch {
            return null;
        }
    }, [getScreenStateStorageKey]);

    // Robust recovery detection on initial load
    useEffect(() => {
        if (window.location.hash.includes('type=recovery') || window.location.href.includes('recovery')) {
            setAuthView('reset');
        }
    }, []);

    useEffect(() => {
        const onPopState = () => {
            setAuthView(resolveAuthViewFromLocation());
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, []);

    useEffect(() => {
        if (!currentUser) return;
        const state = readPersistedScreenState(currentUser);
        if (!state) return;

        const nextPage = typeof state.currentPage === 'string' && PERSISTABLE_SCREENS.has(state.currentPage)
            ? state.currentPage
            : 'dashboard';
        const nextDailyReportId = typeof state.currentDailyReportId === 'string' && state.currentDailyReportId.trim()
            ? state.currentDailyReportId
            : 'dispatchSummary';
        const nextDashboardMenu = state.activeDashboardMenu === 'left' || state.activeDashboardMenu === 'right'
            ? state.activeDashboardMenu
            : 'right';

        setCurrentPage(nextPage);
        setCurrentDailyReportId(nextDailyReportId);
        setActiveDashboardMenu(nextDashboardMenu);
    }, [currentUser, readPersistedScreenState]);

    useEffect(() => {
        if (!currentUser) return;
        try {
            window.localStorage.setItem(
                getScreenStateStorageKey(currentUser),
                JSON.stringify({
                    currentPage,
                    currentDailyReportId,
                    activeDashboardMenu
                } satisfies PersistedScreenState)
            );
        } catch {
            // no-op: persistence is best effort
        }
    }, [activeDashboardMenu, currentDailyReportId, currentPage, currentUser, getScreenStateStorageKey]);

    useEffect(() => {
        setMountedPages(prev => (prev.includes(currentPage) ? prev : [...prev, currentPage]));
    }, [currentPage]);

    useEffect(() => {
        const previousPage = previousPageRef.current;
        if (previousPage !== currentPage) {
            const previousContainer = pageContainerRefs.current[previousPage];
            if (previousContainer) {
                pageScrollPositionsRef.current[previousPage] = previousContainer.scrollTop;
            }
        }

        const restoreScroll = () => {
            const container = pageContainerRefs.current[currentPage];
            if (!container) return;
            container.scrollTop = pageScrollPositionsRef.current[currentPage] ?? 0;
        };

        window.requestAnimationFrame(restoreScroll);
        previousPageRef.current = currentPage;
    }, [currentPage]);

    const addNotification = useCallback((message: string, type: 'success' | 'error' | 'warning' = 'success') => {
        setNotifications(prev => {
            // Ensure ID is unique even for rapid calls
            let id = Date.now();
            while (prev.some(n => n.id === id)) {
                id++;
            }
            return [...prev, { id, message, type }];
        });
    }, []);

    const removeNotification = useCallback((id: number) => {
        setNotifications(prev => prev.filter(n => n.id !== id));
    }, []);

    // Silent auto-update probe on app boot. Runs once per session; if an
    // update is found we just nudge the user with a notification — the actual
    // install happens from the Check-for-updates panel in Settings.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { checkForUpdate } = await import('@core/updates/updateService');
                const update = await checkForUpdate({ silent: true });
                if (cancelled || !update) return;
                addNotification(`Update available: v${update.version}. Open Settings → System & Updates to install.`, 'warning');
            } catch {
                // Silent failure — most likely the user is offline or the
                // updater endpoint is unreachable. Re-checks happen manually.
            }
        })();
        return () => { cancelled = true; };
    }, [addNotification]);

    const parseMrpNumber = useCallback((value: unknown): number => {
        const parsed = parseFloat(String(value ?? '').replace(/[^\d.]/g, ''));
        return Number.isFinite(parsed) ? parsed : 0;
    }, []);

    const normalizeCode = useCallback((value?: string) => (value || '').trim().toLowerCase(), []);

    const syncInventoryItemWithMaterialMaster = useCallback((item: InventoryItem, material?: Medicine): InventoryItem => {
        if (!material) return item;
        const syncedPack = (material.pack || '').trim() || (item.packType || '').trim();
        return {
            ...item,
            packType: syncedPack,
            unitsPerPack: resolveUnitsPerStrip(extractPackMultiplier(syncedPack) ?? item.unitsPerPack, syncedPack),
            gstPercent: Number(material.gstRate ?? item.gstPercent ?? 0),
            hsnCode: material.hsnCode || '',
            // MRP and Rates are now strictly batch-dependent and NOT synced from Master
        };
    }, []);

    const syncInventoryFromMaterialMaster = useCallback((items: InventoryItem[], meds: Medicine[]) => {
        const medicineByCode = new Map<string, Medicine>();
        meds.forEach(med => {
            const code = normalizeCode(med.materialCode);
            if (code) medicineByCode.set(code, med);
        });
        return items.map(item => syncInventoryItemWithMaterialMaster(item, medicineByCode.get(normalizeCode(item.code))));
    }, [normalizeCode, syncInventoryItemWithMaterialMaster]);

    const createMrpChangeLog = useCallback(async (
        sourceScreen: 'Inventory' | 'Material Master',
        materialCode: string,
        productName: string,
        oldMrp: number,
        newMrp: number,
    ) => {
        if (!currentUser) return;
        if (Math.abs(oldMrp - newMrp) < 0.0001) return;

        const logPayload: Omit<MrpChangeLogEntry, 'id'> = {
            organization_id: currentUser.organization_id,
            materialCode,
            productName: productName || 'UNKNOWN',
            oldMrp,
            newMrp,
            changedAt: new Date().toISOString(),
            changedById: currentUser.user_id || currentUser.id,
            changedByName: currentUser.full_name || currentUser.email,
            sourceScreen,
        };

        const saved = await storage.saveData('mrp_change_log', logPayload, currentUser);
        setMrpChangeLogs(prev => [saved, ...prev]);
    }, [currentUser]);

    const loadData = useCallback(async (user: RegisteredPharmacy, mode: 'initial' | 'sync' | 'background' | 'targeted' = 'sync', specificTable?: string) => {
        if (!user) return;

        if (mode === 'initial') {
            setIsAppLoading(true);
            setAppLoadError(null);
        }
        else if (mode === 'sync') setIsReloading(true);

        const orgId = user.organization_id;

        try {
            if (mode === 'targeted' && specificTable) {
                switch (specificTable) {
                    case 'inventory': {
                        const latestInventory = await storage.fetchInventory(user, true);
                        setInventory(syncInventoryFromMaterialMaster(latestInventory, medicinesRef.current));
                        break;
                    }
                    case 'material_master': {
                        const latestMedicines = await storage.fetchMedicineMaster(user, true);
                        setMedicines(latestMedicines);
                        setInventory(prev => syncInventoryFromMaterialMaster(prev, latestMedicines));
                        break;
                    }
                    case 'sales_bill':
                    case 'transactions':
                        setTransactions(await storage.fetchTransactions(user, true));
                        break;
                    case 'purchases': setPurchases(await storage.fetchPurchases(user, true)); break;
                    case 'suppliers': setSuppliers(await storage.fetchSuppliers(user, true)); break;
                    case 'customers': setCustomers(await storage.fetchCustomers(user, true)); break;
                    case 'doctor_master': setDoctors(await storage.fetchDoctors(user, true)); break;
                    case 'configurations':
                        const cfg = await storage.getData('configurations', [], user, true);
                        if (cfg && cfg.length > 0) {
                            const normalizedConfig = normalizeStockHandlingConfig(cfg[0]);
                            setConfigurations(normalizedConfig);
                            if (
                                (cfg[0].displayOptions?.strictStock ?? true) &&
                                (cfg[0].displayOptions?.enableNegativeStock ?? false)
                            ) {
                                storage.saveData('configurations', normalizedConfig, user).catch(console.error);
                            }
                        }
                        break;
                    case 'delivery_challans': setDeliveryChallans(await storage.getData('delivery_challans', [], user, true)); break;
                    case 'sales_challans': setSalesChallans(await storage.getData('sales_challans', [], user, true)); break;
                    case 'sales_returns': setSalesReturns(await storage.getData('sales_returns', [], user, true)); break;
                    case 'purchase_returns': setPurchaseReturns(await storage.getData('purchase_returns', [], user, true)); break;
                    case 'purchase_orders': setPurchaseOrders(await storage.fetchPurchaseOrders(user, true)); break;
                    case 'physical_inventory': setPhysicalInventory(await storage.fetchPhysicalInventory(user, true)); break;
                    case 'categories': setCategories(await storage.getData('categories', [], user)); break;
                    case 'sub_categories': setSubCategories(await storage.getData('sub_categories', [], user)); break;
                    case 'supplier_product_map': setMappings(await storage.fetchSupplierProductMaps(user)); break;
                    case 'mrp_change_log': setMrpChangeLogs(await storage.getData('mrp_change_log', [], user)); break;
                    case 'business_roles':
                        setBusinessRoles(await storage.getData('business_roles', [], user));
                        break;
                    case 'team_members':
                        setTeamMembers(await storage.fetchTeamMembers(user));
                        break;
                    case 'profiles':
                        const freshProfile = await storage.fetchProfile(user.user_id);
                        if (freshProfile) setCurrentUser(freshProfile);
                        break;
                }
                setLastRefreshed(new Date());
                return;
            }

            const withTimeout = async <T,>(label: string, task: Promise<T>, timeoutMs = 12000): Promise<T> => {
                return await Promise.race([
                    task,
                    new Promise<T>((_, reject) => {
                        setTimeout(() => reject(new Error(`${label} request timed out after ${timeoutMs}ms`)), timeoutMs);
                    })
                ]);
            };

            const loadJobs: Array<[string, Promise<any>]> = [
                ['profile', withTimeout('Profile', storage.fetchProfile(user.user_id))],
                ['inventory', withTimeout('Inventory', storage.fetchInventory(user))],
                ['material master', withTimeout('Material Master', storage.fetchMedicineMaster(user))],
                ['transactions', withTimeout('Transactions', storage.fetchTransactions(user))],
                ['purchases', withTimeout('Purchases', storage.fetchPurchases(user))],
                ['suppliers', withTimeout('Suppliers', storage.fetchSuppliers(user))],
                ['customers', withTimeout('Customers', storage.fetchCustomers(user))],
                ['doctors', withTimeout('Doctors', storage.fetchDoctors(user))],
                ['eway bills', withTimeout('E-Way Bills', storage.fetchEWayBills(user))],
                ['supplier product maps', withTimeout('Supplier Product Maps', storage.fetchSupplierProductMaps(user))],
                ['physical inventory', withTimeout('Physical Inventory', storage.fetchPhysicalInventory(user))],
                ['delivery challans', withTimeout('Delivery Challans', storage.getData('delivery_challans', [], user))],
                ['sales challans', withTimeout('Sales Challans', storage.getData('sales_challans', [], user))],
                ['purchase orders', withTimeout('Purchase Orders', storage.fetchPurchaseOrders(user))],
                ['sales returns', withTimeout('Sales Returns', storage.getData('sales_returns', [], user))],
                ['purchase returns', withTimeout('Purchase Returns', storage.getData('purchase_returns', [], user))],
                ['categories', withTimeout('Categories', storage.getData('categories', [], user))],
                ['sub categories', withTimeout('Sub Categories', storage.getData('sub_categories', [], user))],
                ['promotions', withTimeout('Promotions', storage.getData('promotions', [], user))],
                ['team members', withTimeout('Team Members', storage.fetchTeamMembers(user))],
                ['business roles', withTimeout('Business Roles', storage.getData('business_roles', [], user))],
                ['configurations', withTimeout('Configurations', storage.getData('configurations', [{ organization_id: orgId }], user))],
                ['bank masters', withTimeout('Bank Masters', storage.fetchBankMasters(user))],
                ['mrp logs', withTimeout('MRP Logs', storage.getData('mrp_change_log', [], user))]
            ];

            const settled = await Promise.allSettled(loadJobs.map(([, promise]) => promise));
            const readSettled = <T,>(index: number, fallback: T): T =>
                settled[index].status === 'fulfilled' ? (settled[index] as PromiseFulfilledResult<T>).value : fallback;

            const freshProfile = readSettled<RegisteredPharmacy | null>(0, null);
            const inv = readSettled<InventoryItem[]>(1, []);
            const med = readSettled<Medicine[]>(2, []);
            const tx = readSettled<Transaction[]>(3, []);
            const pur = readSettled<Purchase[]>(4, []);
            const supp = readSettled<Supplier[]>(5, []);
            const cust = readSettled<Customer[]>(6, []);
            const doctorsData = readSettled<DoctorMaster[]>(7, []);
            const ewb = readSettled<EWayBill[]>(8, []);
            const mapData = readSettled<SupplierProductMap[]>(9, []);
            const phy = readSettled<PhysicalInventorySession[]>(10, []);
            const dc = readSettled<DeliveryChallan[]>(11, []);
            const sc = readSettled<SalesChallan[]>(12, []);
            const po = readSettled<PurchaseOrder[]>(13, []);
            const sr = readSettled<SalesReturn[]>(14, []);
            const pr = readSettled<PurchaseReturn[]>(15, []);
            const cert = readSettled<Category[]>(16, []);
            const sub = readSettled<SubCategory[]>(17, []);
            const promo = readSettled<Promotion[]>(18, []);
            const team = readSettled<OrganizationMember[]>(19, []);
            const roleData = readSettled<BusinessRole[]>(20, []);
            const configData = readSettled<AppConfigurations[]>(21, [{ organization_id: orgId } as AppConfigurations]);
            const bankMastersData = readSettled<any[]>(22, []);
            const mrpLogs = readSettled<MrpChangeLogEntry[]>(23, []);

            const failedLoads = settled
                .map((result, index) => ({ result, label: loadJobs[index][0] }))
                .filter(entry => entry.result.status === 'rejected');
            if (failedLoads.length > 0) {
                const labels = failedLoads.map(entry => entry.label).join(', ');
                const message = `Partial sync completed. Some modules failed to refresh (${labels}).`;
                addNotification(message, 'warning');
                if (mode === 'initial') setAppLoadError(message);
            } else if (mode === 'initial') {
                setAppLoadError(null);
            }

            if (freshProfile) setCurrentUser(freshProfile);
            setInventory(syncInventoryFromMaterialMaster(inv || [], med || []));
            setMedicines(med || []);
            setTransactions(tx || []);
            setPurchases(pur || []);
            setSuppliers(supp || []);
            setCustomers(cust || []);
            setDoctors(doctorsData || []);
            setEwayBills(ewb || []);
            setMappings(mapData || []);
            setPhysicalInventory(phy || []);
            setDeliveryChallans(dc || []);
            setSalesChallans(sc || []);
            setPurchaseOrders(po || []);
            setBankOptions(bankMastersData || []);
            // setBankOptions replaced by loadJobs
            setSalesReturns(sr || []);
            setPurchaseReturns(pr || []);
            setCategories(cert || []);
            setSubCategories(sub || []);
            setPromotions(promo || []);
            setTeamMembers(team || []);
            setBusinessRoles(roleData || []);
            setMrpChangeLogs(mrpLogs || []);

            if (configData && configData.length > 0) {
                const normalizedConfig = normalizeStockHandlingConfig(configData[0]);
                setConfigurations(normalizedConfig);
                if (
                    (configData[0].displayOptions?.strictStock ?? true) &&
                    (configData[0].displayOptions?.enableNegativeStock ?? false)
                ) {
                    storage.saveData('configurations', normalizedConfig, user).catch(console.error);
                }
            } else {
                setConfigurations(normalizeStockHandlingConfig({ organization_id: orgId }));
            }
            setLastRefreshed(new Date());
            if (mode === 'sync') addNotification("ERP synchronized with cloud master.", "success");
        } catch (error) {
            const parsedError = parseNetworkAndApiError(error);
            addNotification(parsedError, 'error');
            if (mode === 'initial') setAppLoadError(parsedError);
        } finally {
            setIsAppLoading(false);
            setIsReloading(false);
        }
    }, [addNotification, syncInventoryFromMaterialMaster]);

    const refreshInventoryViews = useCallback(async (
        user: RegisteredPharmacy,
        dependentTables: Array<'transactions' | 'purchases' | 'sales_returns' | 'purchase_returns' | 'physical_inventory'> = []
    ) => {
        if (!user) return;

        await loadData(user, 'targeted', 'inventory');

        const uniqueTables = Array.from(new Set(dependentTables));
        if (uniqueTables.length > 0) {
            await Promise.all(
                uniqueTables.map((table) => {
                    if (table === 'sales_returns') return loadData(user, 'targeted', 'sales_returns');
                    if (table === 'purchase_returns') return loadData(user, 'targeted', 'purchase_returns');
                    return loadData(user, 'targeted', table);
                })
            );
        }
    }, [loadData]);

    const isDashboardScreen = currentPage === 'dashboard';

    const shouldPromptBeforeLeaving = useCallback((fromPage: string, toPage?: string) => {
        if (!DATA_ENTRY_SCREENS.includes(fromPage)) return false;
        
        // Check if the current component is "dirty" (has unsaved data)
        let isDirty = false;
        if (fromPage === 'pos' || fromPage === 'nonGstPos') {
            isDirty = posRef.current?.isDirty ?? false;
        } else {
            isDirty = purchaseFormRef.current?.isDirty ?? false;
        }
        
        if (!isDirty) return false;
        if (!toPage) return true;
        return fromPage !== toPage;
    }, []);

    // Global ESC Key Listener
    useEffect(() => {
        setActiveScreenScope(currentPage);

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Tab' && currentPage === 'dashboard') {
                e.preventDefault();
                setActiveDashboardMenu(prev => prev === 'left' ? 'right' : 'left');
                return;
            }

            if (!shouldHandleScreenShortcut(e, currentPage, { allowWhenInputFocused: true })) return;

            if (e.key === 'Escape') {
                // If a standard modal or dialog is open, let its own logic handle ESC
                if (document.querySelector('[role="dialog"]')) return;

                if (currentPage === 'dashboard') return;

                // Entry screens that require save/discard confirmation
                if (shouldPromptBeforeLeaving(currentPage)) {
                    setShowEscSavePrompt(true);
                } else {
                    // Navigation screens or clean entry screens, just go home
                    setCurrentPage('dashboard');
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentPage, activeDashboardMenu]);

    const handleEscSave = async () => {
        setShowEscSavePrompt(false);
        try {
            if (currentPage === 'pos' || currentPage === 'nonGstPos') {
                if (posRef.current) await posRef.current.handleSave();
            } else if (purchaseFormRef.current) {
                if (typeof purchaseFormRef.current.handleSubmit === 'function') {
                    await purchaseFormRef.current.handleSubmit();
                } else if (typeof purchaseFormRef.current.handleSave === 'function') {
                    await purchaseFormRef.current.handleSave();
                }
            }
            // Navigate after successful save
            if (pendingNavigation) {
                const target = pendingNavigation.pageId;
                const isBack = pendingNavigation.isBack;
                setPendingNavigation(null);
                
                if (isBack) {
                    setHistory(prev => prev.slice(0, -1));
                    setCurrentPage(target);
                } else {
                    handleNavigate(target, true);
                }
            } else {
                setCurrentPage('dashboard');
            }
        } catch (e) {
            addNotification("Failed to auto-save during exit.", "error");
        }
    };

    const handleEscDiscard = () => {
        setShowEscSavePrompt(false);
        const wasEditing = !!editingSale || !!editingPurchase;
        
        if (pendingNavigation) {
            const target = pendingNavigation.pageId;
            const isBack = pendingNavigation.isBack;
            setPendingNavigation(null);

            // Reset current screen before leaving
            if (currentPage === 'pos' || currentPage === 'nonGstPos') {
                posRef.current?.resetForm?.();
                setEditingSale(null);
            } else {
                purchaseFormRef.current?.resetForm?.();
                setEditingPurchase(null);
                setSourceChallansForPurchase(null);
                setPurchaseCopyDraft(null);
            }

            if (isBack) {
                setHistory(prev => prev.slice(0, -1));
                setCurrentPage(target);
            } else {
                handleNavigate(target, true);
            }
        } else {
            if (currentPage === 'pos' || currentPage === 'nonGstPos') {
                posRef.current?.resetForm?.();
                setEditingSale(null);
                handleNavigate(wasEditing ? 'salesHistory' : 'dashboard', true);
            } else {
                purchaseFormRef.current?.resetForm?.();
                if (currentPage === 'automatedPurchaseEntry' || currentPage === 'manualPurchaseEntry' || currentPage === 'manualSupplierInvoice') {
                    setEditingPurchase(null);
                    setSourceChallansForPurchase(null);
                    handleNavigate(wasEditing ? 'purchaseHistory' : 'dashboard', true);
                } else {
                    handleNavigate('dashboard', true);
                }
            }
        }
        setScreenResetNonce(prev => ({ ...prev, [currentPage]: (prev[currentPage] ?? 0) + 1 }));
    };

    // Handle Supabase Auth Session Changes
    useEffect(() => {
        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_OUT') {
                // Robust Logout Detection:
                // 1. Check if this is an explicit manual logout initiated by the user
                const isManualLogout = window.localStorage.getItem('MDXERA_MANUAL_LOGOUT') === 'true';
                
                if (isManualLogout) {
                    window.localStorage.removeItem('MDXERA_MANUAL_LOGOUT');
                    setCurrentUser(null);
                    setInventory([]);
                    setMedicines([]);
                    setTransactions([]);
                    setPurchases([]);
                    setMrpChangeLogs([]);
                    setIsAppLoading(false);
                    setAuthView('auth');
                    return;
                }

                // 2. If not manual, it might be a refresh token failure or network glitch.
                // We verify by checking the current session one last time.
                const { data: { session: verifiedSession } } = await supabase.auth.getSession();
                if (verifiedSession) {
                    console.warn('Recovered from transient SIGNED_OUT event.');
                    return;
                }
                // 3. No Supabase session — but a persisted Tauri session may
                // still be valid. Keep the user logged in if it is; the next
                // online sync will refresh the Supabase token.
                try {
                    const restored = await storage.getCurrentUser();
                    if (restored) {
                        console.warn('[auth] SIGNED_OUT ignored — local persisted session is still valid.');
                        // Attempt to silently refresh the Supabase session so
                        // subsequent API calls don't fail with 401. Non-blocking:
                        // if it fails, the user stays logged in locally and
                        // writes get queued for offline sync.
                        supabase.auth.refreshSession().then(({ data }) => {
                            if (data.session) {
                                console.info('[auth] Supabase session silently restored after transient SIGNED_OUT.');
                            }
                        }).catch(() => { /* offline or truly expired — ignored, local session keeps user in */ });
                        return;
                    }
                } catch (err) {
                    console.warn('[auth] getCurrentUser during SIGNED_OUT failed:', err);
                }
                // Truly gone — wipe state and bounce to login
                setCurrentUser(null);
                setInventory([]);
                setMedicines([]);
                setTransactions([]);
                setPurchases([]);
                setMrpChangeLogs([]);
                setIsAppLoading(false);
                setAuthView('auth');
            } else if (event === 'PASSWORD_RECOVERY') {
                setAuthView('reset');
            } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                if (session?.user) {
                    storage.getCurrentUser().then(async user => {
                        if (user) {
                            setCurrentUser(user);
                            loadData(user, 'background');
                        } else {
                            const profile = await storage.fetchProfile(session.user.id);
                            if (profile) {
                                setCurrentUser(profile);
                                loadData(profile, 'sync'); // Use sync mode to show progress
                            }
                        }
                    });
                }
            }
        });

        return () => subscription.unsubscribe();
    }, [loadData]);

    useEffect(() => {
        if (!currentUser) return;
        const orgId = currentUser.organization_id;

        const channel = supabase
            .channel(`public_changes_${orgId}`)
            .on(
                'postgres_changes',
                { event: '*', schema: 'public' },
                (payload) => {
                    const table = payload.table;
                    const record = payload.new as any;

                    if (record && record.organization_id && record.organization_id !== orgId) {
                        return;
                    }
                    loadData(currentUser, 'targeted', table);
                }
            )
            .subscribe((status) => {
                setIsRealtimeActive(status === 'SUBSCRIBED');
            });

        return () => {
            supabase.removeChannel(channel);
        };
    }, [currentUser, loadData]);

    useEffect(() => {
        let cancelled = false;

        const boot = async () => {
            let user: RegisteredPharmacy | null = null;
            try {
                user = await storage.getCurrentUser();
            } catch (err) {
                console.warn('[App] getCurrentUser failed:', err);
            }

            if (cancelled) return;

            if (!user) {
                setIsAppLoading(false);
                return;
            }

            // Kick off SQLite-to-memoryCache hydration in the background.
            // We don't await: the legacy app boots immediately; loadData('initial')
            // populates from Supabase (when online) and the listener below
            // will reload from cache as soon as hydration finishes.
            storage.hydrateMemoryCacheFromSqlite(user.organization_id);

            setCurrentUser(user);

            if (navigator.onLine) {
                try {
                    const fresh = await storage.fetchProfile(user.user_id);
                    if (!cancelled && fresh) setCurrentUser(fresh);
                } catch (err) {
                    console.warn('[App] fetchProfile failed:', err);
                }
            }

            if (cancelled) return;
            loadData(user, 'initial');
        };

        boot();
        return () => { cancelled = true; };
    }, []);

    // When SQLite hydration completes (after offline-first InitialSync or
    // returning to a session with cached data), refresh the legacy React state
    // so the app shows the freshly-cached masters/transactions.
    //
    // Debounced: SyncBootstrap + a POS offline-save can fire this event
    // multiple times in quick succession. Without the debounce each fire calls
    // loadData → Supabase fetches → ERR_INTERNET_DISCONNECTED spam → more
    // state updates → effectively an infinite loop while offline.
    // The 500 ms window collapses all rapid fires into one refresh.
    // We also skip loadData entirely when offline; memoryCache is already warm
    // from the hydration itself, so the only reason to call loadData is to
    // push the freshly-cached data into React state — but that happens through
    // storage.getData which falls back to memoryCache anyway.
    useEffect(() => {
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const onHydrateComplete = () => {
            if (!currentUser) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                // If offline, refresh legacy React state using 'background' mode (no network queries)
                if (!navigator.onLine) {
                    console.info('[App] hydrate complete (offline) — refreshing loadData (background)');
                    loadData(currentUser, 'background').catch((err) =>
                        console.warn('[App] post-hydrate offline reload failed:', err),
                    );
                    return;
                }
                console.info('[App] hydrate complete — refreshing loadData');
                loadData(currentUser, 'sync').catch((err) =>
                    console.warn('[App] post-hydrate reload failed:', err),
                );
            }, 500);
        };

        window.addEventListener('mdxera:hydrate-complete', onHydrateComplete);
        return () => {
            window.removeEventListener('mdxera:hydrate-complete', onHydrateComplete);
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    }, [currentUser, loadData]);

    const handleReload = useCallback(async () => {
        if (currentUser) await loadData(currentUser, 'sync');
    }, [currentUser, loadData]);

    const handleNavigate = useCallback((pageId: string, skipPrompt = false) => {
        const isDailyReportLink = pageId.startsWith('dailyReports:');
        const resolvedPageId = isDailyReportLink ? 'dailyReports' : pageId;

        if (!canAccessScreen(resolvedPageId, currentUser, teamMembers, businessRoles, 'view')) {
            addNotification('Access denied for this module.', 'error');
            return;
        }

        if (!skipPrompt && shouldPromptBeforeLeaving(currentPage, resolvedPageId)) {
            setPendingNavigation({ pageId, skipPrompt });
            setShowEscSavePrompt(true);
            return;
        }

        if (isDailyReportLink) {
            setCurrentDailyReportId(pageId.replace('dailyReports:', ''));
        }
        if (resolvedPageId === 'ewayLoginSetup') {
            setEwayLoginSetupReturnPage(currentPage || 'dashboard');
        }

        // --- HISTORY TRACKING ---
        if (currentPage !== resolvedPageId) {
            setHistory(prev => {
                // Limit history size to 20 to prevent bloat
                const next = [...prev, currentPage].slice(-20);
                return next;
            });
        }
        // ------------------------

        setCurrentPage(resolvedPageId);
        if (resolvedPageId !== 'manualSupplierInvoice' && resolvedPageId !== 'manualPurchaseEntry' && resolvedPageId !== 'automatedPurchaseEntry') {
            setEditingPurchase(null);
            setPurchaseCopyDraft(null);
        }
        if (resolvedPageId !== 'pos' && resolvedPageId !== 'nonGstPos') {
            setEditingSale(null);
        }
    }, [addNotification, businessRoles, currentPage, currentUser, shouldPromptBeforeLeaving, teamMembers]);

    const handleBack = useCallback(() => {
        const prevPage = history.length > 0 ? history[history.length - 1] : 'dashboard';

        if (shouldPromptBeforeLeaving(currentPage, prevPage)) {
            setPendingNavigation({ pageId: prevPage, isBack: true });
            setShowEscSavePrompt(true);
            return;
        }

        if (history.length === 0) {
            if (currentPage !== 'dashboard') {
                setCurrentPage('dashboard');
            }
            return;
        }

        setHistory(prev => prev.slice(0, -1));
        setCurrentPage(prevPage);
    }, [history, currentPage, shouldPromptBeforeLeaving]);

    const closeEwayLoginSetup = useCallback(() => {
        const targetPage = PERSISTABLE_SCREENS.has(ewayLoginSetupReturnPage) ? ewayLoginSetupReturnPage : 'dashboard';
        setScreenResetNonce(prev => ({ ...prev, ewayLoginSetup: (prev.ewayLoginSetup ?? 0) + 1 }));
        setCurrentPage(targetPage);
        window.requestAnimationFrame(() => {
            const container = pageContainerRefs.current[targetPage];
            if (!container) return;
            const focusable = container.querySelector<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            if (focusable) {
                focusable.focus();
            } else {
                container.setAttribute('tabindex', '-1');
                container.focus();
            }
        });
    }, [ewayLoginSetupReturnPage]);

    useEffect(() => {
        setConfigurations(prev => ({
            ...prev,
            sidebar: {
                ...prev.sidebar,
                isSidebarHidden: false,
                isSidebarCollapsed: prev.sidebar?.isSidebarCollapsed ?? false
            }
        }));
    }, []);

    const toggleSidebar = useCallback(async () => {
        const currentlyCollapsed = configurations.sidebar?.isSidebarCollapsed ?? false;

        const updatedConfig = {
            ...configurations,
            sidebar: {
                ...configurations.sidebar,
                isSidebarHidden: false,
                isSidebarCollapsed: !currentlyCollapsed
            }
        };

        setConfigurations(updatedConfig);
        if (currentUser) {
            await storage.saveData('configurations', updatedConfig, currentUser);
        }
    }, [configurations, currentUser]);

    useEffect(() => {
        if (!currentUser) return;
        
        const runSync = async () => {
            if (!navigator.onLine) return;
            try {
                const result = await storage.syncPendingData(currentUser);
                if (result.success > 0) {
                    console.log(`Background sync completed: ${result.success} items synced.`);
                    // Optional: Refresh local data if something was synced
                    loadData(currentUser, 'background');
                }
            } catch (err) {
                console.warn('Background sync cycle failed:', err);
            }
        };

        // Run sync every 60 seconds
        const interval = setInterval(runSync, 60000);
        // Also run immediately on mount or when coming online
        runSync();
        
        window.addEventListener('online', runSync);
        return () => {
            clearInterval(interval);
            window.removeEventListener('online', runSync);
        };
    }, [currentUser, loadData]);

    // Drop the stale `sync_status: 'pending'` marker from in-memory rows as
    // soon as SyncWorker confirms a successful push. Without this the
    // "Sync Pending" badges in Sales History (and similar views) stick until
    // the user reloads, even though the row is already on the server.
    useEffect(() => {
        const onSynced = (e: Event) => {
            const detail = (e as CustomEvent).detail || {};
            const table: string | undefined = detail.tableName;
            const ids: string[] = Array.isArray(detail.ids) ? detail.ids : [];
            if (!table || ids.length === 0) return;
            const idSet = new Set(ids);
            const clearStatus = <T extends { id?: string; sync_status?: string | null }>(rows: T[]) =>
                rows.map(row => (row && row.id && idSet.has(row.id) && row.sync_status === 'pending'
                    ? ({ ...row, sync_status: undefined } as T)
                    : row));
            switch (table) {
                case 'sales_bill':       setTransactions(prev => clearStatus(prev as any) as any); break;
                case 'purchases':        setPurchases(prev => clearStatus(prev as any) as any); break;
                case 'sales_returns':    setSalesReturns(prev => clearStatus(prev as any) as any); break;
                case 'suppliers':        setSuppliers(prev => clearStatus(prev as any) as any); break;
                case 'customers':        setCustomers(prev => clearStatus(prev as any) as any); break;
                case 'inventory':        setInventory(prev => clearStatus(prev as any) as any); break;
                case 'material_master':  setMedicines(prev => clearStatus(prev as any) as any); break;
                default: break;
            }
        };
        window.addEventListener('sync-rows-synced', onSynced);
        return () => window.removeEventListener('sync-rows-synced', onSynced);
    }, []);

    const handleLogin = (user: RegisteredPharmacy) => {
        setCurrentPage('dashboard');
        setAppLoadError(null);
        setConfigurations(prev => ({
            ...prev,
            sidebar: {
                ...prev.sidebar,
                isSidebarHidden: false,
                isSidebarCollapsed: false
            }
        }));
        setCurrentUser(user);
        loadData(user, 'initial');
    };

    const handleLogout = useCallback(async () => {
        setShowLogoutPrompt(false);
        setIsAppLoading(true);
        setAppLoadError(null);
        const persistedStateKey = currentUser ? getScreenStateStorageKey(currentUser) : null;
        // Mark this signOut as intentional so the auth listener doesn't try to
        // "heal" the session and keep the user logged in.
        window.localStorage.setItem('MDXERA_MANUAL_LOGOUT', 'true');
        try {
            await storage.clearCurrentUser();
            if (persistedStateKey) {
                window.localStorage.removeItem(persistedStateKey);
            }
            setCurrentUser(null);
            setCurrentPage('dashboard');
            setAuthView('auth');
            window.history.replaceState({}, '', '/');
        } catch (e) {
            if (persistedStateKey) {
                window.localStorage.removeItem(persistedStateKey);
            }
            setCurrentUser(null);
            setCurrentPage('dashboard');
            setAuthView('auth');
            window.history.replaceState({}, '', '/');
        } finally {
            setIsAppLoading(false);
        }
    }, [currentUser, getScreenStateStorageKey]);

    const toggleFullScreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
            setIsFullScreen(true);
        } else {
            document.exitFullscreen();
            setIsFullScreen(false);
        }
    };
    const [isFullScreen, setIsFullScreen] = useState(false);

    const handleSaveOrUpdateTransaction = async (tx: Transaction, isUpdate: boolean, nextCounter?: number) => {
        if (!currentUser) {
            throw new Error("Unauthorized: please log in again.");
        }

        setIsOperationLoading(true);
        try {
            const selectedCustomer = tx.customerId
                ? customers.find(c => c.id === tx.customerId)
                : undefined;

            // Check for linked payments if it's an update
            if (isUpdate && selectedCustomer && Array.isArray(selectedCustomer.ledger)) {
                const hasPayments = selectedCustomer.ledger.some(entry => 
                    entry.type === 'payment' && 
                    entry.status !== 'cancelled' &&
                    (entry.referenceInvoiceId === tx.id || (entry.referenceInvoiceNumber === tx.invoiceNumber && tx.invoiceNumber)) &&
                    ['invoice_payment', 'invoice_payment_adjustment', 'down_payment_adjustment'].includes(entry.entryCategory || '') &&
                    ((entry.adjustedAmount || 0) > 0 || (entry.credit || 0) > 0)
                );

                if (hasPayments) {
                    throw new Error("Cannot edit bill: A payment has been received against this invoice. Cancel the payment voucher first.");
                }
            }

            // Only perform credit and stock checks for COMPLETED bills.
            // Draft/Hold bills should be allowed to save even with issues.
            if (tx.status === 'completed') {
                const openChallanExposure = getCustomerOpenChallanExposure(salesChallans, selectedCustomer?.id);
                const creditCheck = evaluateCustomerCredit({
                    customer: selectedCustomer || null,
                    currentTransactionAmount: Number(tx.total || 0),
                    openChallanExposure,
                    moduleName: 'POS'
                });

                if (creditCheck && !creditCheck.canProceed) {
                    const detail = `Credit limit ₹${creditCheck.details.creditLimit.toFixed(2)}, projected exposure ₹${creditCheck.details.projectedExposure.toFixed(2)}`;
                    if (creditCheck.mode === 'warning_only') {
                        addNotification(`${creditCheck.message} ${detail} (Saved due to warning-only mode).`, 'warning');
                    } else {
                        throw new Error(`${creditCheck.message} ${detail}`);
                    }
                }

                const stockHandling = resolveStockHandlingConfig(configurations);
                const shouldPreventNegativeStock = stockHandling.mode === 'strict';

                if (shouldPreventNegativeStock) {
                    const requiredUnitsByInventoryId = new Map<string, number>();
                    for (const item of tx.items || []) {
                        if (!item.inventoryItemId) continue;
                        const requiredUnits = ((item.quantity || 0) * (item.unitsPerPack || 1)) + (item.looseQuantity || 0);
                        requiredUnitsByInventoryId.set(
                            item.inventoryItemId,
                            (requiredUnitsByInventoryId.get(item.inventoryItemId) || 0) + requiredUnits
                        );
                    }

                    for (const [inventoryItemId, requiredUnits] of requiredUnitsByInventoryId.entries()) {
                        const invItem = inventory.find(i => i.id === inventoryItemId);
                        if (!invItem) continue;
                        const policy = getInventoryPolicy(invItem, medicines);
                        if (!policy.inventorised) continue;
                        if (Number(invItem.stock || 0) <= 0 || Number(invItem.stock || 0) < requiredUnits) {
                            logStockMovement({ transactionType: 'sales-outward-validation', item: invItem.name, batch: invItem.batch || 'UNSET', qty: requiredUnits, stockBefore: Number(invItem.stock || 0), stockAfter: Number(invItem.stock || 0), validationResult: 'blocked', mode: stockHandling.mode });
                            throw new Error('Insufficient stock in selected batch. Billing not allowed due to Strict Stock Enforcement.');
                        }
                    }
                }
            }

            const savedTx = await storage.addTransaction(tx, currentUser, isUpdate);
            if (!isUpdate && tx.linkedChallans?.length) {
                const openLinkedChallans = salesChallans.filter(ch => tx.linkedChallans?.includes(ch.id) && ch.status === SalesChallanStatus.OPEN);
                await Promise.all(
                    openLinkedChallans.map(ch =>
                        storage.saveData('sales_challans', { ...ch, status: SalesChallanStatus.CONVERTED }, currentUser, true)
                    )
                );
            }

            // Synchronize the local configuration state with the next expected number.
            // This ensures that the "Preview" number shown in the UI is consistent with what's in the DB
            // without waiting for a background reload.
            if (!isUpdate && typeof nextCounter === 'number' && Number.isFinite(nextCounter) && nextCounter > 0) {
                const configKey = tx.billType === 'non-gst' ? 'nonGstInvoiceConfig' : 'invoiceConfig';
                setConfigurations(prev => {
                    const existing = (prev[configKey] || {}) as any;
                    // Only update if the nextCounter is actually greater than what we have (to avoid stale reverts)
                    if (nextCounter > (existing.currentNumber || 0)) {
                        return {
                            ...prev,
                            [configKey]: {
                                ...existing,
                                currentNumber: nextCounter,
                            }
                        };
                    }
                    return prev;
                });
            }

            // Immediate local state update to ensure data shows in history without waiting for background reload.
            if (isUpdate) {
                setTransactions(prev => prev.map(t => t.id === savedTx.id ? savedTx : t));
                setEditingSale(null);
            } else {
                setTransactions(prev => [savedTx, ...prev]);
                setSourceChallansForSales(null);
            }

            // Only refresh inventory here. Re-fetching `transactions` would
            // overwrite the optimistic update above with whatever loadData
            // returns from the cache, and historically that race left the
            // new bill invisible in Sales History until manual reload.
            await refreshInventoryViews(currentUser);
            // Only attempt a background Supabase reload when online; offline
            // the data is already fresh in memoryCache from the save itself.
            if (navigator.onLine) {
                loadData(currentUser, 'background').catch((err) => {
                    console.warn('Background reload after sales save failed:', err);
                });
            }

            addNotification(isUpdate ? 'Bill updated successfully.' : 'Bill saved successfully.', 'success');
        } catch (e) {
            throw new Error(parseNetworkAndApiError(e));
        } finally {
            setIsOperationLoading(false);
        }
    };

    const handleUpdatePurchase = async (p: Purchase, supplierGst?: string) => {
        if (!currentUser) return;

        setIsOperationLoading(true);
        try {
            // Check for linked payments
            const distributor = suppliers.find(d =>
                (d.name || '').trim().toLowerCase() === (p.supplier || '').trim().toLowerCase()
            );

            if (distributor && Array.isArray(distributor.ledger)) {
                const hasPayments = distributor.ledger.some(entry =>
                    entry.type === 'payment' &&
                    entry.status !== 'cancelled' &&
                    (entry.referenceInvoiceId === p.id || entry.referenceInvoiceNumber === p.invoiceNumber) &&
                    ['invoice_payment', 'invoice_payment_adjustment', 'down_payment_adjustment'].includes(entry.entryCategory || '') &&
                    ((entry.adjustedAmount || 0) > 0 || (entry.credit || 0) > 0)
                );

                if (hasPayments) {
                    addNotification("Cannot edit bill: A payment has been made against this purchase bill. Cancel the payment voucher first.", "error");
                    return;
                }
            }

            const savedPurchase = await storage.updatePurchase(p, currentUser);
            console.log('App: Purchase updated successfully, new status:', savedPurchase.status);

            // Immediate local state update with the fresh record from storage
            setPurchases(prev => {
                const index = prev.findIndex(pur => pur.id === savedPurchase.id);
                if (index === -1) return [savedPurchase, ...prev];
                const next = [...prev];
                next[index] = savedPurchase;
                return next;
            });

            // Only refresh inventory (not purchases) to avoid overwriting the optimistic update above
            // with potentially stale server data. The background loadData will sync everything later.
            await refreshInventoryViews(currentUser);
            await syncMovingAverageRates([savedPurchase, ...purchases], purchaseReturns);
            loadData(currentUser, 'background');

            addNotification("Purchase voucher updated.", "success");
            return savedPurchase;
        } catch (e) {
            addNotification(parseNetworkAndApiError(e), "error");
            throw e;
        } finally {
            setIsOperationLoading(false);
        }
    };
    const normalizeEntityKey = (value?: string | null) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const resolvePurchaseItemKey = (item: PurchaseItem) => {
        const byCode = normalizeEntityKey((item as any).materialCode || (item as any).itemCode || '');
        if (byCode) return `code:${byCode}`;
        return `name:${normalizeEntityKey(item.name)}`;
    };

    const resolvePoItemKey = (item: any) => {
        const byCode = normalizeEntityKey(item.itemCode || item.sku || item.materialCode || '');
        if (byCode) return `code:${byCode}`;
        return `name:${normalizeEntityKey(item.name)}`;
    };

    const createPOReceivePatchFromPurchase = (po: PurchaseOrder, purchaseBill: Purchase, mode: PurchaseOrderReceiveMode) => {
        const poSupplierKey = normalizeEntityKey(po.distributorName);
        const billSupplierKey = normalizeEntityKey(purchaseBill.supplier);
        if (poSupplierKey && billSupplierKey && poSupplierKey !== billSupplierKey) {
            throw new Error('Supplier mismatch between Purchase Order and Purchase Bill.');
        }

        if ((po.sourcePurchaseBillIds || []).includes(purchaseBill.id)) {
            throw new Error('This purchase bill is already linked to the selected Purchase Order.');
        }

        const receivedByItem = new Map<string, number>();
        (purchaseBill.items || []).forEach(item => {
            const key = resolvePurchaseItemKey(item);
            const qty = Math.max(0, Number(item.quantity || 0));
            receivedByItem.set(key, (receivedByItem.get(key) || 0) + qty);
        });

        const nextItems = (po.items || []).map(item => {
            const itemKey = resolvePoItemKey(item);
            const incomingQty = Number(receivedByItem.get(itemKey) || 0);
            const prevReceived = Number(item.receivedQuantity || 0);
            const orderedQty = Number(item.quantity || 0);
            const nextReceived = prevReceived + incomingQty;
            
            // For manual adjustments, we only update quantities if there's a match.
            // If the bill contains items NOT in the PO, they are simply ignored in the PO context.
            return {
                ...item,
                receivedQuantity: Number(nextReceived.toFixed(2)),
                pendingQuantity: Number(Math.max(0, orderedQty - nextReceived).toFixed(2)),
            };
        });

        const totalOrdered = nextItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        const totalReceived = nextItems.reduce((sum, item) => sum + Number(item.receivedQuantity || 0), 0);
        const resolvedStatus = totalReceived <= 0
            ? PurchaseOrderStatus.ORDERED
            : totalReceived < totalOrdered
                ? PurchaseOrderStatus.PARTIALLY_RECEIVED
                : PurchaseOrderStatus.RECEIVED;

        const adjustedQty = (purchaseBill.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0)), 0);

        return {
            ...po,
            items: nextItems,
            status: resolvedStatus,
            sourcePurchaseBillIds: [...(po.sourcePurchaseBillIds || []), purchaseBill.id],
            receiveLinks: [
                ...(po.receiveLinks || []),
                {
                    id: storage.generateUUID(),
                    purchaseOrderId: po.id,
                    poNumber: po.serialId,
                    purchaseBillId: purchaseBill.id,
                    purchaseSystemId: purchaseBill.purchaseSerialId,
                    receiveMode: mode,
                    receivedQty: adjustedQty,
                    adjustedQty,
                    adjustedAt: new Date().toISOString(),
                    adjustedBy: currentUser?.id
                }
            ]
        };
    };

    const handleAddPurchase = async (p: any, supplierGst: string, nextCounter?: number) => {
        if (!currentUser) return;
        setIsOperationLoading(true);
        try {
            const savedPurchase = await storage.addPurchase(p, currentUser);
            // Immediate local state update
            setPurchases(prev => [savedPurchase, ...prev]);

            // Only refresh inventory (not purchases) to avoid overwriting the optimistic update above
            // with potentially stale server data. The background loadData will sync everything later.
            await refreshInventoryViews(currentUser);
            if (savedPurchase?.sourcePurchaseOrderId) {
                const linkedPO = purchaseOrders.find(po => po.id === savedPurchase.sourcePurchaseOrderId);
                if (linkedPO) {
                    const poPatch = createPOReceivePatchFromPurchase(linkedPO, savedPurchase, PurchaseOrderReceiveMode.POST_RECEIVED_ENTRY);
                    await storage.saveData('purchase_orders', poPatch, currentUser, true);
                    setPurchaseOrders(prev => prev.map(po => po.id === poPatch.id ? poPatch : po));
                }
            }
            loadData(currentUser, 'background');
            addNotification("Purchase entry posted.", "success");
            return savedPurchase;
        } catch (e) {
            addNotification(parseNetworkAndApiError(e), "error");
            throw e;
        } finally {
            setIsOperationLoading(false);
        }
    };

    const handleCancelPurchase = async (purchaseId: string) => {
        if (!currentUser) return;
        setIsOperationLoading(true);
        try {
            const purchase = purchases.find(p => p.id === purchaseId);
            if (!purchase) return;
            if (purchase.status === 'cancelled') {
                addNotification('This purchase bill is already cancelled.', 'warning');
                return;
            }

            // Check for linked payments
            const distributor = suppliers.find(d => 
                (d.name || '').trim().toLowerCase() === (purchase.supplier || '').trim().toLowerCase()
            );
            
            if (distributor && Array.isArray(distributor.ledger)) {
                const hasPayments = distributor.ledger.some(entry => 
                    entry.type === 'payment' && 
                    entry.status !== 'cancelled' &&
                    (entry.referenceInvoiceId === purchase.id || entry.referenceInvoiceNumber === purchase.invoiceNumber) &&
                    ['invoice_payment', 'invoice_payment_adjustment', 'down_payment_adjustment'].includes(entry.entryCategory || '') &&
                    ((entry.adjustedAmount || 0) > 0 || (entry.credit || 0) > 0)
                );

                if (hasPayments) {
                    addNotification("Cannot cancel bill: A payment has been made against this purchase bill. Cancel the payment voucher first.", "error");
                    return;
                }
            }

            // 1. Mark status as cancelled
            const cancelledPurchase = {
                ...purchase,
                status: 'cancelled' as const,
                cancelledAt: new Date().toISOString(),
                cancelledBy: currentUser.id,
                cancellationReason: 'Cancelled from Purchase Register'
            };
            await storage.saveData('purchases', cancelledPurchase, currentUser, true);
            await storage.syncPurchaseLedger(cancelledPurchase, currentUser);
            await storage.markVoucherCancelled('purchase-entry', currentUser, cancelledPurchase.purchaseSerialId, cancelledPurchase.id);

            // 2. Reverse inventory (decrement stock that was added by this purchase)
            const latestInventory = await storage.fetchInventory(currentUser);
            for (const item of purchase.items) {
                // Find matching inventory item
                const inventoryMatch = latestInventory.find(i =>
                    (i.name || '').toLowerCase().trim() === (item.name || '').toLowerCase().trim() &&
                    (i.batch || 'UNSET').toLowerCase().trim() === (item.batch || 'UNSET').toLowerCase().trim()
                );

                if (inventoryMatch) {
                    const uPP = resolveUnitsPerStrip(inventoryMatch.unitsPerPack, inventoryMatch.packType);
                    const freeUnitsToRemove = (item.freeQuantity || 0) * uPP;
                    const unitsToRemove = ((item.quantity + (item.freeQuantity || 0)) * uPP) + (item.looseQuantity || 0);

                    const updatedInv = {
                        ...inventoryMatch,
                        stock: Math.max(0, Number(inventoryMatch.stock || 0) - unitsToRemove),
                        purchaseFree: Math.max(0, Number(inventoryMatch.purchaseFree || 0) - freeUnitsToRemove)
                    };
                    await storage.saveData('inventory', updatedInv, currentUser, true);
                }
            }

            await refreshInventoryViews(currentUser, ['purchases']);
            loadData(currentUser, 'background');
            addNotification("Purchase voucher cancelled and stock reversed.", "warning");
        } catch (e) {
            addNotification(parseNetworkAndApiError(e), "error");
        } finally {
            setIsOperationLoading(false);
        }
    };

    const handleAddInventoryItem = async (item: Omit<InventoryItem, 'id'>) => {
        if (!currentUser) throw new Error("Unauthorized");
        const saved = await storage.saveData('inventory', item, currentUser);
        await loadData(currentUser, 'background');
        return saved;
    };

    const handleUpdateInventoryItem = useCallback(async (updatedItem: InventoryItem) => {
        if (!currentUser) throw new Error("Unauthorized");
        setIsOperationLoading(true);
        try {
            const existingItem = inventory.find(i => i.id === updatedItem.id);
            const oldMrp = parseMrpNumber(existingItem?.mrp);
            const newMrp = parseMrpNumber(updatedItem.mrp);
            const normalizedCode = normalizeCode(updatedItem.code);
            
            // Find linked Master Record by Code (The Single Source of Truth)
            const linkedMedicine = normalizedCode
                ? medicines.find(m => normalizeCode(m.materialCode) === normalizedCode)
                : undefined;
            
            let syncedInventoryItem = updatedItem;

            if (normalizedCode && linkedMedicine) {
                const nextPack = (updatedItem.packType || '').trim() || (linkedMedicine.pack || '').trim();
                const nextGstRate = Number(updatedItem.gstPercent ?? linkedMedicine.gstRate ?? 0);
                const nextHsnCode = (updatedItem.hsnCode || linkedMedicine.hsnCode || '').trim();
                
                const nextMaterialMaster: Medicine = {
                    ...linkedMedicine,
                    pack: nextPack,
                    gstRate: nextGstRate,
                    hsnCode: nextHsnCode,
                    // MRP and Rates are strictly batch-dependent and NOT synced back to Master
                };

                const today = new Date().toISOString().slice(0, 10);
                const nextPriceRecords = (linkedMedicine.masterPriceMaintains || []).map(record => {
                    if (today < record.validFrom || today > record.validTo || record.status !== 'active') return record;
                    return {
                        ...record,
                        // Identity sync only, price propagation removed
                        lastUpdatedBy: currentUser.full_name || currentUser.email,
                        lastUpdatedOn: new Date().toISOString(),
                    };
                });

                const finalMaterialMaster: Medicine = {
                    ...nextMaterialMaster,
                    masterPriceMaintains: nextPriceRecords
                };

                // 1. Save Master Record
                await storage.saveData('material_master', finalMaterialMaster, currentUser, true);
                
                // 2. Update local state immediately
                setMedicines(prev => prev.map(m => m.id === finalMaterialMaster.id ? finalMaterialMaster : m));

                if (Math.abs(oldMrp - newMrp) >= 0.0001) {
                    await createMrpChangeLog(
                        'Inventory',
                        normalizedCode,
                        updatedItem.name || linkedMedicine.name,
                        oldMrp,
                        newMrp
                    );
                }
            }

            await storage.saveData('inventory', syncedInventoryItem, currentUser, true);
            await loadData(currentUser, 'background');
        } finally {
            setIsOperationLoading(false);
        }
    }, [currentUser, inventory, medicines, normalizeCode, parseMrpNumber, syncInventoryItemWithMaterialMaster, createMrpChangeLog, loadData]);

    const handleAddMedicineMaster = async (med: Omit<Medicine, 'id'>) => {
        if (!currentUser) throw new Error("Unauthorized");
        const normalizedBarcode = (med.barcode || '').trim().toLowerCase();
        if (normalizedBarcode) {
            const duplicateBarcode = medicines.find(existing => (existing.barcode || '').trim().toLowerCase() === normalizedBarcode);
            if (duplicateBarcode) {
                throw new Error(`Barcode "${med.barcode}" is already used in Material Master (${duplicateBarcode.name}).`);
            }
        }
        const saved = await storage.saveData('material_master', med, currentUser);

        // If the new master's name+brand matches inventory rows that aren't
        // linked to any code yet, stamp them with this code. This makes
        // "create master with the exact inventory name" auto-link to that
        // material's batches.
        try {
            const { linkInventoryToNewMaster } = await import('@modules/inventory/services/materialMasterSync');
            const linked = await linkInventoryToNewMaster(saved as Medicine, inventory, currentUser);
            if (linked > 0) {
                addNotification(`Linked ${linked} inventory batch${linked === 1 ? '' : 'es'} to new master ${saved.materialCode}.`, 'success');
            }
        } catch (err) {
            console.warn('[material_master:create] inventory auto-link failed:', err);
        }

        await loadData(currentUser, 'background');
        return saved;
    };

    const handleUpdateMedicineMaster = useCallback(async (updatedMedicine: Medicine) => {
        if (!currentUser) throw new Error("Unauthorized");
        setIsOperationLoading(true);
        try {
            const normalizedBarcode = (updatedMedicine.barcode || '').trim().toLowerCase();
            if (normalizedBarcode) {
                const duplicateBarcode = medicines.find(existing =>
                    existing.id !== updatedMedicine.id &&
                    (existing.barcode || '').trim().toLowerCase() === normalizedBarcode
                );
                if (duplicateBarcode) {
                    throw new Error(`Barcode "${updatedMedicine.barcode}" is already used in Material Master (${duplicateBarcode.name}).`);
                }
            }

            const updatedPack = (updatedMedicine.pack || '').trim();
            const inferredUnitsPerPack = resolveUnitsPerStrip(extractPackMultiplier(updatedPack) ?? 1, updatedPack);
            
            const previousMedicine = medicines.find(m => m.id === updatedMedicine.id);
            const normalizedOldCode = normalizeCode(previousMedicine?.materialCode);
            const normalizedNewCode = normalizeCode(updatedMedicine.materialCode);

            const isLinkedInventoryItem = (item: InventoryItem) => {
                const itemCode = normalizeCode(item.code);
                return Boolean(itemCode && (
                    (normalizedOldCode && itemCode === normalizedOldCode) ||
                    (normalizedNewCode && itemCode === normalizedNewCode)
                ));
            };

            const oldMrp = parseMrpNumber(previousMedicine?.mrp);
            const newMrp = parseMrpNumber(updatedMedicine.mrp);

            await storage.saveData('material_master', updatedMedicine, currentUser, true);

            const linkedInventoryItems = inventory.filter(isLinkedInventoryItem);
            if (linkedInventoryItems.length > 0) {
                await Promise.all(
                    linkedInventoryItems.map(item =>
                        storage.saveData('inventory', {
                            ...item,
                            name: updatedMedicine.name,
                            brand: updatedMedicine.brand || '',
                            manufacturer: updatedMedicine.manufacturer || '',
                            code: updatedMedicine.materialCode,
                            barcode: updatedMedicine.barcode || item.barcode,
                            composition: updatedMedicine.composition || '',
                            hsnCode: updatedMedicine.hsnCode || '',
                            description: updatedMedicine.description || '',
                            gstPercent: Number(updatedMedicine.gstRate ?? 0),
                            // Batch-specific pricing remains untouched
                            packType: updatedPack,
                            unitsPerPack: inferredUnitsPerPack,
                            is_active: updatedMedicine.is_active,
                        }, currentUser, true)
                    )
                );

                setInventory(prev => prev.map(item =>
                    isLinkedInventoryItem(item)
                        ? {
                            ...item,
                            name: updatedMedicine.name,
                            brand: updatedMedicine.brand || '',
                            manufacturer: updatedMedicine.manufacturer || '',
                            code: updatedMedicine.materialCode,
                            barcode: updatedMedicine.barcode || item.barcode,
                            composition: updatedMedicine.composition || '',
                            hsnCode: updatedMedicine.hsnCode || '',
                            description: updatedMedicine.description || '',
                            gstPercent: Number(updatedMedicine.gstRate ?? 0),
                            packType: updatedPack,
                            unitsPerPack: inferredUnitsPerPack,
                            is_active: updatedMedicine.is_active,
                        }
                        : item
                ));
            }

            await createMrpChangeLog(
                'Material Master',
                updatedMedicine.materialCode,
                updatedMedicine.name,
                oldMrp,
                newMrp
            );

            setMedicines(prev => prev.map(m => (m.id === updatedMedicine.id ? updatedMedicine : m)));
            await loadData(currentUser, 'background');
        } finally {
            setIsOperationLoading(false);
        }
    }, [createMrpChangeLog, currentUser, inventory, loadData, medicines, normalizeCode, parseMrpNumber]);

    // Offline-first: read from the local SQLite mirror (set_of_books / gl_master /
    // gl_assignments are all in SYNCABLE_TABLES so they're populated by InitialSync).
    // Falls back to Supabase only if local has no data and we happen to be online.
    const resolveControlGlByCode = useCallback(async (organizationId: string, glCode: string): Promise<string | undefined> => {
        try {
            const localBook = await sqliteDb.select<{ id: string }>(
                `SELECT id FROM ${SQLITE_TABLE.SET_OF_BOOKS}
                 WHERE organization_id = ? AND active_status = 'Active'
                 ORDER BY created_at ASC LIMIT 1`,
                [organizationId]
            );
            const activeBookId = localBook?.[0]?.id;
            if (activeBookId) {
                const localGl = await sqliteDb.select<{ id: string }>(
                    `SELECT id FROM ${SQLITE_TABLE.GL_MASTER}
                     WHERE organization_id = ? AND set_of_books_id = ?
                       AND gl_code = ? AND active_status = 'Active'
                     LIMIT 1`,
                    [organizationId, activeBookId, glCode]
                );
                if (localGl?.[0]?.id) return localGl[0].id;
            }
        } catch (e) {
            console.warn('[resolveControlGlByCode] local lookup failed, falling back to Supabase', e);
        }

        if (!navigator.onLine) return undefined;

        const { data: bookRows, error: bookErr } = await supabase
            .from('set_of_books')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('active_status', 'Active')
            .order('created_at', { ascending: true })
            .limit(1);

        if (bookErr) throw bookErr;
        const activeBookId = bookRows?.[0]?.id;
        if (!activeBookId) return undefined;

        const { data: glRows, error: glErr } = await supabase
            .from('gl_master')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('set_of_books_id', activeBookId)
            .eq('gl_code', glCode)
            .eq('active_status', 'Active')
            .limit(1);

        if (glErr) throw glErr;
        return glRows?.[0]?.id;
    }, []);

    const resolvePartyControlGlByGroup = useCallback(async (
        organizationId: string,
        partyType: 'customer' | 'supplier',
        partyGroup: string,
        fallbackGlCode: string,
    ): Promise<string | undefined> => {
        const trimmedGroup = (partyGroup || '').trim();
        if (!trimmedGroup) {
            throw new Error('Default GL not assigned for this Customer/Supplier Group. Please configure GL Assignment.');
        }

        // Local-first path (works fully offline once InitialSync has completed).
        try {
            const localBook = await sqliteDb.select<{ id: string }>(
                `SELECT id FROM ${SQLITE_TABLE.SET_OF_BOOKS}
                 WHERE organization_id = ? AND active_status = 'Active'
                 ORDER BY created_at ASC LIMIT 1`,
                [organizationId]
            );
            const activeBookId = localBook?.[0]?.id;
            if (activeBookId) {
                const localAssign = await sqliteDb.select<{ control_gl_id: string }>(
                    `SELECT control_gl_id FROM ${SQLITE_TABLE.GL_ASSIGNMENTS}
                     WHERE organization_id = ? AND set_of_books_id = ?
                       AND assignment_scope = 'PARTY_GROUP'
                       AND party_type = ?
                       AND party_group = ?
                       AND active_status = 'Active'
                     LIMIT 1`,
                    [organizationId, activeBookId, partyType === 'customer' ? 'Customer' : 'Supplier', trimmedGroup]
                );
                const mappedLocal = localAssign?.[0]?.control_gl_id;
                if (mappedLocal) return mappedLocal;
            }
            // Whether or not we had an active book locally, fall back to the
            // GL-code lookup (also local-first). This is critical for offline
            // mode: if no party-group mapping exists locally for this group,
            // we can still resolve the default control GL by its well-known
            // code (120000 customer / 210000 supplier) from the local
            // gl_master mirror — so customer/supplier creation works offline.
            const codeMatch = await resolveControlGlByCode(organizationId, fallbackGlCode);
            if (codeMatch) return codeMatch;
        } catch (e) {
            console.warn('[resolvePartyControlGlByGroup] local lookup failed, falling back to Supabase', e);
        }

        // If we're offline and got nothing locally, we cannot reach Supabase.
        if (!navigator.onLine) {
            throw new Error('Default GL not assigned for this Customer/Supplier Group, and no fallback GL is configured locally. Please configure GL Assignment or sync once while online so the defaults are cached.');
        }

        const { data: bookRows, error: bookErr } = await supabase
            .from('set_of_books')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('active_status', 'Active')
            .order('created_at', { ascending: true })
            .limit(1);

        if (bookErr) throw bookErr;
        const activeBookId = bookRows?.[0]?.id;
        if (!activeBookId) {
            return resolveControlGlByCode(organizationId, fallbackGlCode);
        }

        const { data: assignmentRows, error: assignmentErr } = await supabase
            .from('gl_assignments')
            .select('control_gl_id')
            .eq('organization_id', organizationId)
            .eq('set_of_books_id', activeBookId)
            .eq('assignment_scope', 'PARTY_GROUP')
            .eq('party_type', partyType === 'customer' ? 'Customer' : 'Supplier')
            .eq('party_group', trimmedGroup)
            .eq('active_status', 'Active')
            .limit(1);

        if (assignmentErr) throw assignmentErr;
        const mappedGlId = assignmentRows?.[0]?.control_gl_id as string | undefined;
        if (mappedGlId) return mappedGlId;

        throw new Error('Default GL not assigned for this Customer/Supplier Group. Please configure GL Assignment.');
    }, [resolveControlGlByCode]);

    const refreshDefaultControlGls = useCallback(async () => {
        if (!currentUser) return;
        try {
            const [customerGl, supplierGl] = await Promise.all([
                resolveControlGlByCode(currentUser.organization_id, '120000'),
                resolveControlGlByCode(currentUser.organization_id, '210000'),
            ]);
            setDefaultCustomerControlGlId(customerGl || '');
            setDefaultSupplierControlGlId(supplierGl || '');
        } catch {
            setDefaultCustomerControlGlId('');
            setDefaultSupplierControlGlId('');
        }
    }, [currentUser, resolveControlGlByCode]);

    useEffect(() => {
        refreshDefaultControlGls();
    }, [refreshDefaultControlGls]);

    const handleAddDistributor = async (data: Omit<Supplier, 'id' | 'ledger' | 'organization_id'>, balance: number, date: string): Promise<SupplierQuickResult> => {
        if (!currentUser) throw new Error("Unauthorized");
        setIsOperationLoading(true);
        try {
            const supplierGroup = data.supplier_group || 'Sundry Creditors';
            const mappedControlGlId = await resolvePartyControlGlByGroup(currentUser.organization_id, 'supplier', supplierGroup, '210000');
            if (!mappedControlGlId) throw new Error('Supplier Control GL (210000) not found in active Set of Books.');

            const result = await createSupplierQuick(currentUser.organization_id, {
                ...data,
                supplier_group: supplierGroup,
                control_gl_id: mappedControlGlId,
            }, {
                currentUser,
                existingSuppliers: suppliers,
                defaultControlGlId: mappedControlGlId,
            });

            if (result.status !== 'duplicate') {
                const savedSupplier = result.supplier;
                if (balance !== 0) {
                    await storage.addLedgerEntry({
                        id: storage.generateUUID(),
                        date,
                        type: 'openingBalance',
                        description: 'Opening Balance',
                        debit: balance < 0 ? Math.abs(balance) : 0,
                        credit: balance > 0 ? balance : 0,
                        balance: 0,
                    }, { type: 'supplier', id: savedSupplier.id }, currentUser);
                }
                
                // Immediate local state update
                setSuppliers(prev => [savedSupplier, ...prev]);
            }

            await loadData(currentUser, 'background');
            addNotification(result.message, result.status === 'duplicate' ? 'warning' : 'success');
            return result;
        } catch (e) {
            const message = formatSupplierApiError(e);
            addNotification(message, 'error');
            throw new Error(message);
        } finally {
            setIsOperationLoading(false);
        }
    };

    const handleAddCustomer = async (data: Omit<Customer, 'id' | 'ledger' | 'organization_id'>, balance: number, date: string) => {
        if (!currentUser) return;
        setIsOperationLoading(true);
        try {
            const customerGroup = data.customerGroup || 'Sundry Debtors';
            const mappedControlGlId = await resolvePartyControlGlByGroup(currentUser.organization_id, 'customer', customerGroup, '120000');
            if (!mappedControlGlId) throw new Error('Customer Control GL not found for selected Customer Group in active Set of Books.');
            const customerPayload = { ...data, customerGroup, controlGlId: mappedControlGlId, opening_balance: balance };
            const newCust = await storage.saveData('customers', customerPayload, currentUser);
            if (balance !== 0) {
                await storage.addLedgerEntry({
                    id: storage.generateUUID(),
                    date,
                    type: 'openingBalance',
                    description: 'Opening Balance',
                    debit: balance > 0 ? balance : 0,
                    credit: balance < 0 ? Math.abs(balance) : 0,
                    balance: 0,
                }, { type: 'customer', id: newCust.id }, currentUser);
            }
            await loadData(currentUser, 'background');
            addNotification(`Customer ${data.name} saved successfully.`, "success");
            return newCust;
        } catch (e) {
            addNotification(parseNetworkAndApiError(e), "error");
        } finally {
            setIsOperationLoading(false);
        }
    };

    const handleQuickAddCustomerFromPos = async (data: {
        name: string;
        phone?: string;
        address?: string;
        gstNumber?: string;
        customerGroup?: string;
    }): Promise<{ customer: Customer; isDuplicate: boolean }> => {
        if (!currentUser) throw new Error('Unauthorized');
        setIsOperationLoading(true);
        try {
            const trimmedName = (data.name || '').trim();
            if (!trimmedName) throw new Error('Customer Name is required.');

            const existingCustomer = customers.find(c => (c.name || '').trim().toLowerCase() === trimmedName.toLowerCase());
            if (existingCustomer) {
                return { customer: existingCustomer, isDuplicate: true };
            }

            const customerGroup = (data.customerGroup || 'Walk-in / Retail').trim();
            const mappedControlGlId = await resolvePartyControlGlByGroup(currentUser.organization_id, 'customer', customerGroup, '120000');
            if (!mappedControlGlId) throw new Error('Customer Control GL not found for selected Customer Group in active Set of Books.');

            const customerPayload: Omit<Customer, 'id' | 'ledger' | 'organization_id'> = {
                name: trimmedName,
                phone: data.phone?.trim() || '',
                address: data.address?.trim() || '',
                gstNumber: data.gstNumber?.trim() || '',
                customerGroup,
                controlGlId: mappedControlGlId,
                is_active: true,
                customerType: 'retail',
                defaultRateTier: 'none',
                defaultDiscount: 0,
            };

            const createdCustomer = await storage.saveData('customers', customerPayload, currentUser);
            setCustomers(prev => [createdCustomer, ...prev]);
            loadData(currentUser, 'background');
            return { customer: createdCustomer, isDuplicate: false };
        } finally {
            setIsOperationLoading(false);
        }
    };



    const handleUpdateSupplier = async (supplier: Supplier) => {
        if (!currentUser) return;
        setIsOperationLoading(true);
        try {
            const supplierGroup = supplier.supplier_group || 'Sundry Creditors';
            const mappedControlGlId = await resolvePartyControlGlByGroup(currentUser.organization_id, 'supplier', supplierGroup, '210000');
            if (!mappedControlGlId) throw new Error('Supplier Control GL (210000) not found in active Set of Books.');

            const result = await createSupplierQuick(currentUser.organization_id, {
                ...supplier,
                supplier_group: supplierGroup,
                control_gl_id: mappedControlGlId,
            }, {
                currentUser,
                existingSuppliers: suppliers,
                defaultControlGlId: mappedControlGlId,
                isUpdate: true
            });

            if (result.status !== 'duplicate') {
                const savedSupplier = result.supplier;
                // Immediate local state update
                setSuppliers(prev => prev.map(s => s.id === savedSupplier.id ? savedSupplier : s));
            }

            await loadData(currentUser, 'background');
            addNotification(result.message, result.status === 'duplicate' ? 'warning' : 'success');
            return result;
        } catch (e) {
            const message = formatSupplierApiError(e);
            addNotification(message, 'error');
            throw new Error(message);
        } finally {
            setIsOperationLoading(false);
        }
    };

    const handleUpdateCustomer = async (customer: Customer) => {
        if (!currentUser) return;
        setIsOperationLoading(true);
        try {
            const customerGroup = customer.customerGroup || 'Sundry Debtors';
            const mappedControlGlId = await resolvePartyControlGlByGroup(currentUser.organization_id, 'customer', customerGroup, '120000');
            if (!mappedControlGlId) throw new Error('Customer Control GL not found for selected Customer Group in active Set of Books.');
            const customerPayload = {
                ...customer,
                customerGroup,
                controlGlId: mappedControlGlId,
            };
            await storage.saveData('customers', customerPayload, currentUser, true);
            await loadData(currentUser, 'background');
            addNotification(`Customer ${customer.name} updated successfully.`, "success");
        } catch (e) {
            addNotification(parseNetworkAndApiError(e), "error");
        } finally {
            setIsOperationLoading(false);
        }
    };

    const hasCustomerTransactionDependency = useCallback((customer: Customer): boolean => {
        const customerId = customer.id;
        const customerName = (customer.name || '').trim().toLowerCase();
        const hasLedgerEntries = Array.isArray(customer.ledger) && customer.ledger.length > 0;
        const hasSales = transactions.some(tx =>
            tx &&
            tx.status !== 'cancelled' &&
            ((tx.customerId && tx.customerId === customerId) || ((tx.customerName || '').trim().toLowerCase() === customerName))
        );
        const hasSalesChallans = salesChallans.some(ch =>
            ch &&
            ch.status !== 'cancelled' &&
            ((ch.customerId && ch.customerId === customerId) || ((ch.customerName || '').trim().toLowerCase() === customerName))
        );
        const hasSalesReturns = salesReturns.some(sr =>
            sr &&
            ((sr.customerId && sr.customerId === customerId) || ((sr.customerName || '').trim().toLowerCase() === customerName))
        );
        return hasLedgerEntries || hasSales || hasSalesChallans || hasSalesReturns;
    }, [transactions, salesChallans, salesReturns]);

    const hasSupplierTransactionDependency = useCallback((supplier: Supplier): boolean => {
        const supplierId = supplier.id;
        const supplierName = (supplier.name || '').trim().toLowerCase();
        const hasLedgerEntries = Array.isArray(supplier.ledger) && supplier.ledger.length > 0;
        const hasPurchases = purchases.some(p =>
            p &&
            p.status !== 'cancelled' &&
            ((p.supplier || '').trim().toLowerCase() === supplierName)
        );
        const hasPurchaseOrders = purchaseOrders.some(po =>
            po &&
            po.status !== 'cancelled' &&
            ((po.distributorId && po.distributorId === supplierId) || ((po.distributorName || '').trim().toLowerCase() === supplierName))
        );
        const hasPurchaseReturns = purchaseReturns.some(pr =>
            pr &&
            ((pr.supplier || '').trim().toLowerCase() === supplierName)
        );
        return hasLedgerEntries || hasPurchases || hasPurchaseOrders || hasPurchaseReturns;
    }, [purchases, purchaseOrders, purchaseReturns]);

    const handleSetCustomerBlocked = async (customer: Customer, isBlocked: boolean) => {
        if (!currentUser) return;
        const payload: Customer = {
            ...customer,
            is_blocked: isBlocked,
            is_active: !isBlocked,
            creditStatus: isBlocked ? 'blocked' : (customer.creditStatus || 'active'),
        };
        await handleUpdateCustomer(payload);
        addNotification(`Customer ${customer.name} ${isBlocked ? 'blocked' : 'unblocked'} successfully.`, 'success');
        console.info(`[AUDIT] ${new Date().toISOString()} user=${currentUser.id} action=${isBlocked ? 'block' : 'unblock'} customer=${customer.id}`);
    };

    const handleSetSupplierBlocked = async (supplier: Supplier, isBlocked: boolean) => {
        if (!currentUser) return;
        const payload: Supplier = {
            ...supplier,
            is_blocked: isBlocked,
            is_active: !isBlocked,
        };
        await handleUpdateSupplier(payload);
        addNotification(`Supplier ${supplier.name} ${isBlocked ? 'blocked' : 'unblocked'} successfully.`, 'success');
        console.info(`[AUDIT] ${new Date().toISOString()} user=${currentUser.id} action=${isBlocked ? 'block' : 'unblock'} supplier=${supplier.id}`);
    };

    const handleDeleteCustomer = async (customer: Customer) => {
        if (!currentUser) return { success: false, message: 'Unauthorized' };
        const hasDependency = hasCustomerTransactionDependency(customer);
        console.info(`[AUDIT] ${new Date().toISOString()} user=${currentUser.id} action=delete_attempt customer=${customer.id} blocked=${hasDependency}`);
        if (hasDependency) {
            return {
                success: false,
                message: 'Cannot delete customer because transactions already exist. You may block this record instead.',
            };
        }
        await storage.deleteData('customers', customer.id, currentUser);
        await loadData(currentUser, 'background');
        console.info(`[AUDIT] ${new Date().toISOString()} user=${currentUser.id} action=delete_success customer=${customer.id}`);
        return { success: true, message: `Customer ${customer.name} deleted successfully.` };
    };

    const handleDeleteSupplier = async (supplier: Supplier) => {
        if (!currentUser) return { success: false, message: 'Unauthorized' };
        const hasDependency = hasSupplierTransactionDependency(supplier);
        console.info(`[AUDIT] ${new Date().toISOString()} user=${currentUser.id} action=delete_attempt supplier=${supplier.id} blocked=${hasDependency}`);
        if (hasDependency) {
            return {
                success: false,
                message: 'Cannot delete supplier because transactions already exist. You may block this record instead.',
            };
        }
        await storage.deleteData('suppliers', supplier.id, currentUser);
        await loadData(currentUser, 'background');
        console.info(`[AUDIT] ${new Date().toISOString()} user=${currentUser.id} action=delete_success supplier=${supplier.id}`);
        return { success: true, message: `Supplier ${supplier.name} deleted successfully.` };
    };

    const handleRecordPayment = async (id: string, amount: number, date: string, desc: string, type: 'customer' | 'supplier') => {
        if (!currentUser) return;
        await storage.addLedgerEntry({
            id: storage.generateUUID(),
            date,
            type: 'payment',
            description: desc,
            debit: type === 'customer' ? 0 : amount,
            credit: type === 'customer' ? amount : 0,
            balance: 0,
        }, { type, id }, currentUser);
        loadData(currentUser, 'background');
    };

    const handleRecordCustomerPaymentWithAccounting = async (args: {
        customerId: string;
        amount: number;
        date: string;
        description: string;
        paymentMode: string;
        bankAccountId: string;
        referenceInvoiceId?: string;
        referenceInvoiceNumber?: string;
        entryCategory?: 'invoice_payment' | 'down_payment';
    }): Promise<{ ledgerEntryId: string }> => {
        if (!currentUser) throw new Error('User context not available');
        const result = await storage.recordCustomerPaymentWithAccounting(args, currentUser);
        await loadData(currentUser, 'background');
        addNotification(args.entryCategory === 'down_payment' ? 'Customer down payment posted with accounting entry.' : 'Customer payment posted with accounting entry.', 'success');
        return { ledgerEntryId: result.ledgerEntryId };
    };

    const handleRecordSupplierPaymentWithAccounting = async (args: {
        supplierId: string;
        amount: number;
        date: string;
        description: string;
        paymentMode: string;
        bankAccountId: string;
        referenceInvoiceId?: string;
        referenceInvoiceNumber?: string;
        entryCategory?: 'invoice_payment' | 'down_payment';
    }): Promise<{ ledgerEntryId: string }> => {
        if (!currentUser) throw new Error('User context not available');
        const result = await storage.recordSupplierPaymentWithAccounting(args, currentUser);
        await loadData(currentUser, 'background');
        addNotification(args.entryCategory === 'down_payment' ? 'Supplier down payment posted with accounting entry.' : 'Supplier payment posted with accounting entry.', 'success');
        return { ledgerEntryId: result.ledgerEntryId };
    };

    const handleRecordCustomerDownPaymentAdjustment = async (args: {
        customerId: string;
        date: string;
        downPaymentId: string;
        referenceInvoiceId: string;
        referenceInvoiceNumber?: string;
        amount: number;
        description?: string;
    }) => {
        if (!currentUser) return;
        await storage.recordCustomerDownPaymentAdjustment(args, currentUser);
        await loadData(currentUser, 'background');
    };

    const handleRecordSupplierDownPaymentAdjustment = async (args: {
        supplierId: string;
        date: string;
        downPaymentId: string;
        referenceInvoiceId: string;
        referenceInvoiceNumber?: string;
        amount: number;
        description?: string;
    }) => {
        if (!currentUser) return;
        await storage.recordSupplierDownPaymentAdjustment(args, currentUser);
        await loadData(currentUser, 'background');
    };

    const handleRecordCustomerInvoicePaymentAdjustment = async (args: {
        customerId: string;
        date: string;
        sourcePaymentId: string;
        referenceInvoiceId: string;
        referenceInvoiceNumber?: string;
        amount: number;
        description?: string;
    }) => {
        if (!currentUser) return;
        await storage.recordCustomerInvoicePaymentAdjustment(args, currentUser);
        await loadData(currentUser, 'background');
    };

    const handleRecordSupplierInvoicePaymentAdjustment = async (args: {
        supplierId: string;
        date: string;
        sourcePaymentId: string;
        referenceInvoiceId: string;
        referenceInvoiceNumber?: string;
        amount: number;
        description?: string;
    }) => {
        if (!currentUser) return;
        await storage.recordSupplierInvoicePaymentAdjustment(args, currentUser);
        await loadData(currentUser, 'background');
    };

    const handleCancelPartyPaymentEntry = async (args: {
        ownerType: 'customer' | 'supplier';
        ownerId: string;
        paymentEntryId: string;
        cancellationDate: string;
        reason: string;
    }) => {
        if (!currentUser) return;
        await storage.cancelPartyPaymentEntry({
            ...args,
            cancelledBy: currentUser.id,
        }, currentUser);
        await loadData(currentUser, 'background');
        addNotification('Payment cancelled using reversal entry and bill reopened.', 'warning');
    };

    const handleCancelTransaction = async (id: string) => {
        if (!currentUser) return;
        const tx = transactions.find(t => t.id === id);
        if (tx) {
            if (tx.status === 'cancelled') {
                addNotification("This sales bill is already cancelled.", "warning");
                return;
            }
            // Check for linked payments
            const customer = customers.find(c => 
                c.id === tx.customerId || 
                (c.name || '').trim().toLowerCase() === (tx.customerName || '').trim().toLowerCase()
            );
            
            if (customer && Array.isArray(customer.ledger)) {
                const hasPayments = customer.ledger.some(entry => 
                    entry.type === 'payment' && 
                    entry.status !== 'cancelled' &&
                    (entry.referenceInvoiceId === tx.id || (entry.referenceInvoiceNumber === tx.invoiceNumber && tx.invoiceNumber)) &&
                    ['invoice_payment', 'invoice_payment_adjustment', 'down_payment_adjustment'].includes(entry.entryCategory || '') &&
                    ((entry.adjustedAmount || 0) > 0 || (entry.credit || 0) > 0)
                );

                if (hasPayments) {
                    addNotification("Cannot cancel bill: A payment has been received against this invoice. Cancel the payment voucher first.", "error");
                    return;
                }
            }

            const cancelledTx = { ...tx, status: 'cancelled' as const };
            await storage.saveData('sales_bill', cancelledTx, currentUser, true);
            await storage.syncSalesLedger(cancelledTx, currentUser);
            try {
                await storage.markVoucherCancelled(cancelledTx.billType === 'non-gst' ? 'sales-non-gst' : 'sales-gst', currentUser, cancelledTx.id, cancelledTx.id);
            } catch (error) {
                console.warn('Unable to log voucher cancellation for invoice', cancelledTx.id, error);
            }
            const latestInventory = await storage.fetchInventory(currentUser);
            for (const item of tx.items) {
                const inv = latestInventory.find(i => i.id === item.inventoryItemId);
                if (inv) {
                    const policy = getInventoryPolicy(inv, medicines);
                    if (!policy.inventorised) continue;
                    const restoredUnits = (item.quantity * resolveUnitsPerStrip(inv.unitsPerPack, inv.packType) + (item.looseQuantity || 0));
                    const stockBefore = Number(inv.stock || 0);
                    const stockAfter = stockBefore + restoredUnits;
                    logStockMovement({ transactionType: 'sales-cancellation-reversal', voucherId: tx.id, item: inv.name, batch: inv.batch || 'UNSET', qty: restoredUnits, qtyIn: restoredUnits, stockBefore, stockAfter, organizationId: currentUser.organization_id, validationResult: 'allowed', mode: resolveStockHandlingConfig(configurations).mode });
                    await storage.saveData('inventory', { ...inv, stock: stockAfter }, currentUser, true);
                }
            }
            loadData(currentUser, 'background');
            addNotification("Voucher cancelled and stock reversed.", "warning");
        }
    };

    const handleConvertToPurchase = (items: PurchaseItem[], supplier: string, ids: string[]) => {
        setSourceChallansForPurchase({ items, supplier, ids });
        handleNavigate('manualSupplierInvoice');
    };

    const handleConvertToInvoice = (items: BillItem[], customer: Customer, ids: string[]) => {
        if (!ids.length) {
            addNotification('Please select at least one challan to convert.', 'error');
            return;
        }
        const selectedChallans = salesChallans.filter(ch => ids.includes(ch.id) && ch.status === SalesChallanStatus.OPEN);
        if (!selectedChallans.length) {
            addNotification('Selected challan is already converted/cancelled or unavailable.', 'error');
            return;
        }
        const first = selectedChallans[0];
        const mergedItems: BillItem[] = [];
        selectedChallans.forEach(ch => mergedItems.push(...(ch.items || [])));

        setSourceChallansForSales({
            id: '',
            organization_id: currentUser?.organization_id || first.organization_id || '',
            date: first.date,
            customerName: first.customerName || customer.name,
            customerId: first.customerId || customer.id,
            customerPhone: first.customerPhone || customer.phone || '',
            customerAddress: first.customerAddress || customer.address || '',
            referredBy: first.referredBy || '',
            items: mergedItems,
            total: Number(selectedChallans.reduce((sum, ch) => sum + Number(ch.totalAmount || 0), 0)),
            itemCount: mergedItems.length,
            status: 'draft',
            paymentMode: first.billCategory || 'Cash',
            billType: 'regular',
            subtotal: Number(selectedChallans.reduce((sum, ch) => sum + Number(ch.subtotal || 0), 0)),
            totalItemDiscount: 0,
            totalGst: Number(selectedChallans.reduce((sum, ch) => sum + Number(ch.totalGst || 0), 0)),
            schemeDiscount: 0,
            roundOff: 0,
            narration: [first.narration, `Converted from Challan: ${selectedChallans.map(ch => ch.challanSerialId).join(', ')}`].filter(Boolean).join('\n'),
            linkedChallans: selectedChallans.map(ch => ch.id)
        });
        handleNavigate('pos');
    };

    const handleUpdateModuleConfig = useCallback(async (moduleId: string, nextConfig: ModuleConfig) => {
        if (!currentUser) return;
        const updated = {
            ...configurations,
            modules: {
                ...(configurations.modules || {}),
                [moduleId]: nextConfig
            }
        };
        setConfigurations(updated);
        await storage.saveData('configurations', updated, currentUser);
    }, [configurations, currentUser]);

    const buildBillPharmacy = () => {
        if (!currentUser) return null;
        // Prefer the logo from display options, fall back to profile logo.
        const rawLogo = configurations.displayOptions?.pharmacy_logo_url || currentUser.pharmacy_logo_url;
        // Always resolve to cached base64 so invoice templates and html2canvas
        // never receive tauri:// or remote URLs that fail in non-webview contexts.
        const resolvedLogo = rawLogo ? resolveAsset(rawLogo) : undefined;
        return { ...currentUser, pharmacy_logo_url: resolvedLogo };
    };

    const buildPrintBillPayload = (tx: Transaction) => {
        const billPharmacy = buildBillPharmacy();
        if (!billPharmacy) return null;

        const normalizedCustomerId = String(tx.customerId || '').trim();
        const normalizedCustomerName = String(tx.customerName || '').trim().toLowerCase();
        const normalizedCustomerPhone = String(tx.customerPhone || '').replace(/\D/g, '');

        const matchedCustomer = customers.find((customer) => {
            if (normalizedCustomerId && String(customer.id || '').trim() === normalizedCustomerId) return true;
            const nameMatch = normalizedCustomerName && String(customer.name || '').trim().toLowerCase() === normalizedCustomerName;
            if (!nameMatch) return false;
            if (!normalizedCustomerPhone) return true;
            const customerPhone = String(customer.phone || '').replace(/\D/g, '');
            return customerPhone ? customerPhone === normalizedCustomerPhone : true;
        });

        return {
            ...tx,
            pharmacy: billPharmacy,
            customerDetails: matchedCustomer,
            inventory,
            configurations
        } as DetailedBill & { inventory: InventoryItem[]; configurations: AppConfigurations; };
    };

    const renderPage = (pageId: string, isActive: boolean) => {
        const configId = pageId === 'nonGstPos' ? 'pos' : pageId;
        const config: ModuleConfig = { visible: true, fields: configurations.modules?.[configId]?.fields || {} };

        try {
            if (pageId !== 'moduleVisibility' && hiddenScreens.has(pageId)) {
                return (
                    <div className="flex-1 flex items-center justify-center bg-gray-50 p-8">
                        <div className="bg-white border-2 border-gray-400 p-6 text-center">
                            <h2 className="text-xl font-black uppercase text-gray-700">Module Hidden</h2>
                            <p className="text-xs font-bold text-gray-600 mt-3 uppercase">
                                This module is hidden for your user. Ask the admin to unhide it from Module Hide/Unhide.
                            </p>
                        </div>
                    </div>
                );
            }
            if (!canAccessScreen(pageId, currentUser, teamMembers, businessRoles, 'view')) {
                return (
                    <div className="flex-1 flex items-center justify-center bg-amber-50 p-8">
                        <div className="bg-white border-2 border-amber-400 p-6 text-center">
                            <h2 className="text-xl font-black uppercase text-amber-700">Access Restricted</h2>
                            <p className="text-xs font-bold text-gray-600 mt-3 uppercase">You do not have permission to open this module.</p>
                        </div>
                    </div>
                );
            }

            switch (pageId) {
                case 'dashboard':
                    return <Dashboard
                        currentUser={currentUser} configurations={configurations} inventory={inventory}
                        transactions={transactions} purchases={purchases} medicines={medicines}
                        customers={customers} distributors={suppliers} onKpiClick={handleNavigate}
                        brandName="MDXERA" lastRefreshed={lastRefreshed} onReload={handleReload} isReloading={isReloading}
                        isKeyboardActive={activeDashboardMenu === 'right'}
                    />;
                case 'pos':
                case 'nonGstPos':
                    return <POS
                        ref={isActive ? posRef : undefined}
                        inventory={inventory} purchases={purchases} medicines={medicines} customers={customers}
                        transactions={transactions}
                        doctors={doctors}
                        onSaveOrUpdateTransaction={handleSaveOrUpdateTransaction}
                        onPrintBill={(tx) => {
                            const payload = buildPrintBillPayload(tx);
                            if (!payload) return;
                            setPrintBill(payload);
                        }}
                        currentUser={currentUser} config={config} configurations={configurations}
                        billType={pageId === 'nonGstPos' ? 'non-gst' : 'regular'}
                        addNotification={addNotification} onAddMedicineMaster={handleAddMedicineMaster}
                        onAddInventoryItem={handleAddInventoryItem}
                        onUpdateMedicineMaster={handleUpdateMedicineMaster}
                        onQuickAddCustomer={handleQuickAddCustomerFromPos}
                        onAddCustomer={handleAddCustomer}
                        teamMembers={teamMembers}
                        defaultCustomerControlGlId={defaultCustomerControlGlId}
                        onCancel={() => {
                            setEditingSale(null);
                            handleNavigate('salesHistory', true);
                        }}
                        transactionToEdit={editingSale}
                        conversionDraft={sourceChallansForSales}
                        onRefreshConfig={() => loadData(currentUser!, 'background')}
                        salesChallans={salesChallans}
                    />;
                case 'salesHistory':
                    return <SalesHistory
                        transactions={transactions} inventory={inventory}
                        customers={customers}
                        configurations={configurations}
                        onAddMedicineMaster={handleAddMedicineMaster}
                        onViewDetails={setViewTransaction}
                        onPrintBill={(tx) => {
                            const payload = buildPrintBillPayload(tx);
                            if (!payload) return;
                            setPrintBill(payload);
                        }}
                        onCancelTransaction={handleCancelTransaction}
                        currentUser={currentUser} onViewSale={setViewTransaction}
                        onEditSale={(tx) => { setEditingSale(tx); handleNavigate(tx.billType === 'non-gst' ? 'nonGstPos' : 'pos'); }}
                        onCreateReturn={(tx) => { setSalesReturnPrefillInvoiceId(tx.id); handleNavigate('salesReturns'); }}
                        salesReturns={salesReturns}
                        purchases={purchases}
                        medicines={medicines}
                        onQuickAddCustomer={handleQuickAddCustomerFromPos}
                        onGoToPOS={() => handleNavigate('pos')}
                    />;
                case 'manualSalesEntry':
                    return <ManualSalesEntry
                        ref={isActive ? purchaseFormRef : undefined}
                        currentUser={currentUser}
                        customers={customers}
                        inventory={inventory}
                        configurations={configurations}
                        addNotification={addNotification}
                        onSaved={async () => {
                            await refreshInventoryViews(currentUser!, ['transactions']);
                            loadData(currentUser!, 'background').catch((err) => {
                                console.warn('Background reload after manual sales save failed:', err);
                            });
                        }}
                    />;
                case 'salesChallans':
                    return <SalesChallans
                        salesChallans={salesChallans}
                        inventory={inventory}
                        medicines={medicines}
                        purchases={purchases}
                        customers={customers}
                        currentUser={currentUser}
                        configurations={configurations}
                        onAddChallan={async (challan) => {
                            const customer = challan.customerId
                                ? customers.find(c => c.id === challan.customerId)
                                : customers.find(c => (c.name || '').trim().toLowerCase() === (challan.customerName || '').trim().toLowerCase());
                            const openExposure = getCustomerOpenChallanExposure(salesChallans, customer?.id);
                            const check = evaluateCustomerCredit({
                                customer: customer || null,
                                currentTransactionAmount: Number(challan.totalAmount || 0),
                                openChallanExposure: openExposure,
                                moduleName: 'Sales Challan'
                            });
                            if (check && !check.canProceed && check.mode !== 'warning_only') {
                                throw new Error(`${check.message} Projected exposure ₹${check.details.projectedExposure.toFixed(2)} exceeds credit limit ₹${check.details.creditLimit.toFixed(2)}.`);
                            }
                            await storage.saveData('sales_challans', challan, currentUser!);
                            await loadData(currentUser!, 'background');
                        }}
                        onUpdateChallan={async (challan) => {
                            await storage.saveData('sales_challans', challan, currentUser!);
                            await loadData(currentUser!, 'background');
                        }}
                        onCancelChallan={async (id) => {
                            const challan = salesChallans.find(c => c.id === id);
                            if (challan) {
                                await storage.saveData('sales_challans', { ...challan, status: SalesChallanStatus.CANCELLED }, currentUser!);
                                await storage.markVoucherCancelled('sales-challan', currentUser!, challan.id, challan.id);
                                await loadData(currentUser!, 'background');
                            }
                        }}
                        onConvertToInvoice={handleConvertToInvoice}
                        addNotification={addNotification}
                        onAddMedicineMaster={handleAddMedicineMaster}
                    />;
                case 'deliveryChallans':
                    return <DeliveryChallans
                        deliveryChallans={deliveryChallans}
                        inventory={inventory}
                        distributors={suppliers}
                        medicines={medicines}
                        currentUser={currentUser}
                        configurations={configurations}
                        onAddChallan={async (challan) => {
                            await storage.saveData('delivery_challans', challan, currentUser!);
                            await loadData(currentUser!, 'background');
                        }}
                        onUpdateChallan={async (challan) => {
                            await storage.saveData('delivery_challans', challan, currentUser!);
                            await loadData(currentUser!, 'background');
                        }}
                        onCancelChallan={async (id) => {
                            const challan = deliveryChallans.find(c => c.id === id);
                            if (challan) {
                                await storage.saveData('delivery_challans', { ...challan, status: DeliveryChallanStatus.CANCELLED }, currentUser!);
                                await storage.markVoucherCancelled('delivery-challan', currentUser!, challan.id, challan.id);
                                await loadData(currentUser!, 'background');
                            }
                        }}
                        onConvertToPurchase={handleConvertToPurchase}
                        onAddInventoryItem={handleAddInventoryItem}
                        onAddMedicineMaster={handleAddMedicineMaster}
                        onAddDistributor={handleAddDistributor}
                        onSaveMapping={(map) => storage.saveData('supplier_product_map', map, currentUser!).then(() => loadData(currentUser!, 'background'))}
                        addNotification={addNotification}
                        mappings={mappings}
                    />;
                case 'salesReturns':
                case 'purchaseReturn':
                    return <Returns
                        ref={isActive ? purchaseFormRef : undefined}
                        currentUser={currentUser}
                        transactions={transactions}
                        inventory={inventory}
                        salesReturns={salesReturns}
                        purchaseReturns={purchaseReturns}
                        purchases={purchases}
                        onAddSalesReturn={async (sr) => {
                            await storage.addSalesReturn(sr, currentUser!);
                            const savedSalesReturn = await storage.saveData('sales_returns', sr, currentUser!);

                            try {
                                await storage.syncSalesReturnLedger(savedSalesReturn, currentUser!);
                            } catch (error) {
                                console.warn('Unable to sync sales return ledger for', savedSalesReturn.id, error);
                            }

                            await refreshInventoryViews(currentUser!, ['sales_returns']);
                            await loadData(currentUser!, 'background');
                            addNotification('Sales return recorded.', 'success');
                        }}
                        onAddPurchaseReturn={async (pr) => {
                            await storage.addPurchaseReturn(pr, currentUser!);
                            await refreshInventoryViews(currentUser!, ['purchase_returns']);
                            await syncMovingAverageRates(purchases, [pr, ...purchaseReturns]);
                            await loadData(currentUser!, 'background');
                            addNotification('Purchase return recorded.', 'success');
                        }}
                        addNotification={addNotification}
                        defaultTab={pageId === 'salesReturns' ? 'sales' : 'purchase'}
                        isFixedMode={true}
                        prefillSalesInvoiceId={salesReturnPrefillInvoiceId || undefined}
                        prefillPurchaseInvoiceId={purchaseReturnPrefillInvoiceId || undefined}
                        onPrefillSalesInvoiceHandled={() => setSalesReturnPrefillInvoiceId(null)}
                        onPrefillPurchaseInvoiceHandled={() => setPurchaseReturnPrefillInvoiceId(null)}
                    />;
                case 'purchaseOrders':
                    return <PurchaseOrders
                        ref={isActive ? purchaseFormRef : undefined}
                        distributors={suppliers}
                        inventory={inventory}
                        medicines={medicines}
                        mappings={mappings}
                        purchaseOrders={purchaseOrders}
                        onAddPurchaseOrder={async (po, serialId) => {
                            const newPO = await storage.saveData('purchase_orders', { ...po, serialId }, currentUser!);
                            await loadData(currentUser!, 'background');
                            addNotification(`Purchase Order ${newPO.serialId} saved.`, 'success');
                        }}
                        onReservePONumber={async () => {
                            const reserved = await storage.reserveVoucherNumber('purchase-order', currentUser!);
                            return reserved.documentNumber;
                        }}
                        onUpdatePurchaseOrder={async (po) => {
                            await storage.saveData('purchase_orders', po, currentUser!, true);
                            await loadData(currentUser!, 'background');
                        }}
                        onPostReceivedEntry={(po) => {
                            const items: PurchaseItem[] = po.items.map(item => ({
                                id: storage.generateUUID(),
                                name: item.name,
                                brand: item.brand || '',
                                category: 'General',
                                batch: '',
                                expiry: item.expiry || '',
                                quantity: item.quantity,
                                freeQuantity: item.freeQuantity || 0,
                                mrp: item.mrp || 0,
                                purchasePrice: item.purchasePrice || 0,
                                discountPercent: 0,
                                schemeDiscountPercent: 0,
                                gstPercent: item.gstPercent || 0,
                                amount: 0,
                                packType: item.packType || '',
                                looseQuantity: 0,
                                hsnCode: item.hsnCode || '',
                                schemeDiscountAmount: 0
                            }));
                            setPurchaseCopyDraft({
                                sourceId: `poid:${po.id}|po:${po.serialId}`,
                                items,
                                supplier: po.distributorName || '',
                                invoiceNumber: '',
                                date: new Date().toISOString().slice(0, 10),
                            });
                            handleNavigate('manualPurchaseEntry');
                        }}
                        onAdjustReceivedEntry={async (po, purchaseBill) => {
                            const updatedPO = createPOReceivePatchFromPurchase(po, purchaseBill, PurchaseOrderReceiveMode.ADJUST_RECEIVED_ENTRY);
                            await storage.saveData('purchase_orders', updatedPO, currentUser!, true);
                            setPurchaseOrders(prev => prev.map(order => order.id === updatedPO.id ? updatedPO : order));
                            await loadData(currentUser!, 'background');
                        }}
                        onPrintPurchaseOrder={(po) => {
                            const distributor = suppliers.find(d => d.id === po.distributorId);
                            if (distributor) {
                                setPrintPO({ ...po, distributor });
                            } else {
                                // Fallback if distributor object is not found in suppliers list
                                setPrintPO({
                                    ...po,
                                    distributor: {
                                        id: po.distributorId,
                                        name: po.distributorName,
                                        organization_id: po.organization_id,
                                        is_active: true,
                                        address: '',
                                        gst_number: ''
                                    } as any
                                });
                            }
                        }}
                        onCancelPurchaseOrder={async (id) => {
                            const po = purchaseOrders.find(p => p.id === id);
                            if (po) {
                                await storage.saveData('purchase_orders', { ...po, status: PurchaseOrderStatus.CANCELLED }, currentUser!, true);
                                await storage.markVoucherCancelled('purchase-order', currentUser!, po.serialId, po.id);
                                await loadData(currentUser!, 'background');
                            }
                        }}
                        purchases={purchases}
                        addNotification={addNotification}
                        draftItems={null}
                        onClearDraft={() => {}}
                        setIsDirty={() => {}}
                        currentUserPharmacyName={currentUser?.pharmacy_name || ''}
                        currentUserEmail={currentUser?.email || ''}
                        currentUserOrgId={currentUser?.organization_id}
                    />;
                case 'automatedPurchaseEntry':
                    return <PurchaseForm
                        ref={isActive ? purchaseFormRef : undefined}
                        onAddPurchase={handleAddPurchase} onUpdatePurchase={handleUpdatePurchase}
                        inventory={inventory} suppliers={suppliers} medicines={medicines}
                        mappings={mappings} purchases={purchases} purchaseToEdit={editingPurchase}
                        draftItems={sourceChallansForPurchase?.items || null}
                        draftSupplier={sourceChallansForPurchase?.supplier}
                        onClearDraft={() => setSourceChallansForPurchase(null)}
                        currentUser={currentUser} onAddMedicineMaster={handleAddMedicineMaster} onUpdateMedicineMaster={handleUpdateMedicineMaster}
                        onAddsupplier={handleAddDistributor} onSaveMapping={(map) => storage.saveData('supplier_product_map', map, currentUser).then(() => loadData(currentUser!, 'background'))}
                        setIsDirty={() => { }} addNotification={addNotification}
                        title="AI-Powered Automated Purchase"
                        isManualEntry={false}
                        configurations={configurations}
                        config={configurations.modules?.['purchase']}
                        mobileSyncSessionId={mobileSyncSessionId} setMobileSyncSessionId={setMobileSyncSessionId}
                        organizationId={currentUser?.organization_id || ''} onCancel={() => {
                            setEditingPurchase(null);
                            handleNavigate('purchaseHistory', true);
                        }}
                        onPrint={setViewPurchase}
                    />;
                case 'manualPurchaseEntry':
                    return <PurchaseForm
                        ref={isActive ? purchaseFormRef : undefined}
                        onAddPurchase={handleAddPurchase} onUpdatePurchase={handleUpdatePurchase}
                        inventory={inventory} suppliers={suppliers} medicines={medicines}
                        mappings={mappings} purchases={purchases} purchaseToEdit={editingPurchase}
                        draftItems={purchaseCopyDraft?.items || null}
                        draftSupplier={purchaseCopyDraft?.supplier}
                        draftInvoiceNumber={purchaseCopyDraft?.invoiceNumber}
                        draftDate={purchaseCopyDraft?.date}
                        draftSourceId={purchaseCopyDraft?.sourceId}
                        onClearDraft={() => setPurchaseCopyDraft(null)}
                        currentUser={currentUser} onAddMedicineMaster={handleAddMedicineMaster} onUpdateMedicineMaster={handleUpdateMedicineMaster}
                        onAddsupplier={handleAddDistributor} onSaveMapping={(map) => storage.saveData('supplier_product_map', map, currentUser).then(() => loadData(currentUser!, 'background'))}
                        setIsDirty={() => { }} addNotification={addNotification}
                        title="Manual Purchase Entry"
                        isManualEntry={true}
                        configurations={configurations}
                        config={configurations.modules?.['purchase']}
                        mobileSyncSessionId={mobileSyncSessionId} setMobileSyncSessionId={setMobileSyncSessionId}
                        organizationId={currentUser?.organization_id || ''} onCancel={() => {
                            setEditingPurchase(null);
                            handleNavigate('purchaseHistory', true);
                        }}
                        onPrint={setViewPurchase}
                    />;

                case 'manualSupplierInvoice':
                    return <ManualPurchase
                        ref={isActive ? purchaseFormRef : undefined}
                        currentUser={currentUser}
                        suppliers={suppliers}
                        inventory={inventory}
                        medicines={medicines}
                        purchases={purchases}
                        configurations={configurations}
                        addNotification={addNotification}
                        onAddPurchase={handleAddPurchase}
                        onSaved={async () => handleNavigate('purchaseHistory', true)}
                        onAddMedicineMaster={handleAddMedicineMaster}
                    />;
                case 'purchaseHistory':
                    return <PurchaseHistory
                        purchases={purchases} distributors={suppliers} onViewDetails={setViewPurchase}
                        onCancelPurchase={handleCancelPurchase} inventory={inventory} medicines={medicines}
                        onUpdatePurchase={handleUpdatePurchase}
                        onEditPurchase={(p) => {
                            setPurchaseCopyDraft(null);
                            setEditingPurchase(p);
                            handleNavigate('manualPurchaseEntry');
                        }}
                        onCopyPurchase={(p) => {
                            setEditingPurchase(null);
                            setPurchaseCopyDraft({
                                sourceId: p.id,
                                items: (p.items || []).map(item => ({ ...item, id: storage.generateUUID() })),
                                supplier: p.supplier || '',
                                invoiceNumber: p.invoiceNumber || '',
                                date: p.date ? p.date.split('T')[0] : new Date().toISOString().split('T')[0],
                            });
                            handleNavigate('manualPurchaseEntry');
                        }}
                        onCreateReturn={(p) => { setPurchaseReturnPrefillInvoiceId(p.id); handleNavigate('purchaseReturn'); }}
                        purchaseReturns={purchaseReturns}
                        onRefresh={async () => loadData(currentUser!, 'background')}
                        onAddInventoryItem={handleAddInventoryItem}
                        currentUser={currentUser} 
                        onSaveMapping={(map) => storage.saveData('supplier_product_map', map, currentUser).then(() => loadData(currentUser!, 'background'))}
                        onAddMedicineMaster={handleAddMedicineMaster}
                        onPrintPurchase={setViewPurchase}
                        configurations={configurations}
                        onCreateNew={() => handleNavigate('manualPurchaseEntry')}
                    />;
                case 'inventory':
                    return <Inventory
                        inventory={inventory} medicines={medicines} currentUser={currentUser}
                        onCreatePurchaseOrder={() => { }} config={config} onUpdateConfig={(newConfig) => handleUpdateModuleConfig('inventory', newConfig)}
                        onBulkAddInventory={(list) => storage.saveBulkData('inventory', list, currentUser)}
                        onAddProduct={handleAddInventoryItem} onUpdateProduct={handleUpdateInventoryItem}
                        mrpChangeLogs={mrpChangeLogs}
                        configurations={configurations}
                        addNotification={addNotification}
                        onRefresh={() => currentUser ? loadData(currentUser, 'background') : Promise.resolve()}
                        onAddMedicineMaster={handleAddMedicineMaster}
                    />;
                case 'physicalInventory':
                    return <PhysicalInventory
                        inventory={inventory} medicines={medicines} physicalInventorySessions={physicalInventory}
                        onStartNewCount={async () => {
                            if (!currentUser) return;

                            try {
                                const hasOpenSession = physicalInventory.some(s => s.status === PhysicalInventoryStatus.IN_PROGRESS);
                                if (hasOpenSession) {
                                    addNotification('An audit session is already in progress.', 'warning');
                                    return;
                                }

                                let sessionId = '';
                                try {
                                    const reserved = await storage.reserveVoucherNumber('physical-inventory', currentUser);
                                    sessionId = reserved.documentNumber;
                                } catch (reservationError) {
                                    console.warn('Unable to reserve physical inventory voucher number, using timestamp fallback.', reservationError);
                                    sessionId = `PHY-TEMP-${Date.now()}`;
                                    addNotification('Voucher numbering is unavailable. A temporary audit ID was used.', 'warning');
                                }

                                const session: PhysicalInventorySession = {
                                    id: sessionId,
                                    organization_id: currentUser.organization_id,
                                    user_id: currentUser.user_id, // Ensure owner tracking uses Auth UUID
                                    status: PhysicalInventoryStatus.IN_PROGRESS,
                                    startDate: new Date().toISOString(),
                                    reason: '',
                                    items: [],
                                    totalVarianceValue: 0,
                                    performedById: currentUser.user_id, // Use Auth UUID for DB FK consistency
                                    performedByName: currentUser.full_name,
                                };

                                await storage.saveData('physical_inventory', session, currentUser);
                                await loadData(currentUser, 'background');
                                addNotification(`Stock audit ${sessionId} created successfully.`, 'success');
                            } catch (error) {
                                addNotification(parseNetworkAndApiError(error), 'error');
                            }
                        }} onUpdateCount={(s) => storage.saveData('physical_inventory', s, currentUser)}
                        onFinalizeCount={(s) => storage.finalizePhysicalInventorySession(s, currentUser!)
                            .then(async () => {
                                await refreshInventoryViews(currentUser!, ['physical_inventory']);
                                await loadData(currentUser!, 'background');
                            })}
                        onCancelCount={async (session) => {
                            if (!currentUser) return;

                            // IF the session is empty (no items added), we treat it as a "discard" of a new session.
                            // We should RECLAIM the ID by not saving it and calling markVoucherCancelled (which reverts the counter).
                            const isNewEmptySession = !session.items || session.items.length === 0;

                            if (isNewEmptySession) {
                                // 1. Remove from local IndexedDB if it was ever saved there
                                await storage.deleteData('physical_inventory', session.id, currentUser);
                                // 2. Attempt to revert the counter in Supabase
                                await storage.markVoucherCancelled('physical-inventory', currentUser, session.voucher_no || session.id, session.id);
                                // 3. Refresh local state
                                await loadData(currentUser, 'background');
                                return;
                            }

                            // Standard cancellation for sessions that actually had data
                            const cancelledSession: PhysicalInventorySession = {
                                ...session,
                                user_id: currentUser.user_id,
                                status: PhysicalInventoryStatus.CANCELLED,
                                endDate: new Date().toISOString(),
                                performedById: currentUser.user_id,
                                performedByName: currentUser.full_name,
                            };
                            
                            return storage.saveData('physical_inventory', cancelledSession, currentUser)
                                .then(() => storage.markVoucherCancelled('physical-inventory', currentUser, cancelledSession.voucher_no || cancelledSession.id, cancelledSession.id))
                                .catch(err => {
                                    console.warn('Sync failed during audit discard, but local state will be updated:', err);
                                })
                                .then(() => loadData(currentUser, 'background'));
                        }}
                    />;
                case 'suppliers':
                    return <Suppliers
                        suppliers={suppliers} onAddSupplier={handleAddDistributor}
                        onBulkAddSuppliers={(list) => storage.saveBulkData('suppliers', list, currentUser)}
                        onRecordPayment={(id, amt, dt, desc) => handleRecordPayment(id, amt, dt, desc, 'supplier')}
                        onUpdateSupplier={handleUpdateSupplier}
                        onBlockSupplier={(supplier) => handleSetSupplierBlocked(supplier, true)}
                        onUnblockSupplier={(supplier) => handleSetSupplierBlocked(supplier, false)}
                        onDeleteSupplier={handleDeleteSupplier}
                        config={config} currentUser={currentUser} defaultSupplierControlGlId={defaultSupplierControlGlId}
                    />;
                case 'customers':
                    return <Customers
                        customers={customers} teamMembers={teamMembers} onAddCustomer={handleAddCustomer}
                        onBulkAddCustomers={(list) => storage.saveBulkData('customers', list, currentUser)}
                        onRecordPayment={(id, amt, dt, desc) => handleRecordPayment(id, amt, dt, desc, 'customer')}
                        onUpdateCustomer={handleUpdateCustomer}
                        onBlockCustomer={(customer) => handleSetCustomerBlocked(customer, true)}
                        onUnblockCustomer={(customer) => handleSetCustomerBlocked(customer, false)}
                        onDeleteCustomer={handleDeleteCustomer}
                        currentUser={currentUser} config={config} inventory={inventory} defaultCustomerControlGlId={defaultCustomerControlGlId}
                    />;
                case 'doctorsMaster':
                    return <DoctorsMaster
                        doctors={doctors}
                        onSaveDoctor={async (doctor, isUpdate) => {
                            const saved = await storage.saveData('doctor_master', doctor, currentUser, isUpdate);
                            setDoctors(prev => {
                                const index = prev.findIndex(d => d.id === saved.id);
                                if (index >= 0) {
                                    const next = [...prev];
                                    next[index] = saved;
                                    return next;
                                }
                                return [...prev, saved].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                            });
                            await loadData(currentUser!, 'targeted', 'doctor_master');
                        }}
                        onToggleDoctorStatus={async (doctor, nextActive) => {
                            const saved = await storage.saveData('doctor_master', { ...doctor, is_active: nextActive }, currentUser, true);
                            setDoctors(prev => {
                                const index = prev.findIndex(d => d.id === saved.id);
                                if (index >= 0) {
                                    const next = [...prev];
                                    next[index] = saved;
                                    return next;
                                }
                                return prev;
                            });
                            await loadData(currentUser!, 'targeted', 'doctor_master');
                        }}
                    />;
                case 'mbcCardDashboard':
                case 'mbcCardList':
                case 'mbcGenerateCard':
                case 'mbcCardTypeMaster':
                case 'mbcCardTemplateMaster':
                case 'mbcCardPrintPreview':
                case 'mbcCardRenewalHistory':
                    return <MbcCardManagement currentUser={currentUser!} activeScreen={pageId as any} onNavigate={handleNavigate as any} />;
                case 'medicineMasterList':
                case 'masterPriceMaintain':
                case 'vendorNomenclature':
                case 'bulkUtility':
                    return <MaterialMaster
                        medicines={medicines} inventory={inventory} onAddMedicine={handleAddMedicineMaster}
                        onUpdateMedicine={handleUpdateMedicineMaster} currentUser={currentUser}
                        suppliers={suppliers} onAddPurchase={handleAddPurchase as any}
                        onBulkAddMedicines={(list) => storage.saveBulkData('material_master', list, currentUser)}
                        onSearchMedicines={() => { }} onMassUpdateClick={() => { }}
                        onSaveMapping={(map) => storage.saveData('supplier_product_map', map, currentUser).then(() => loadData(currentUser!, 'background'))} onDeleteMapping={(id) => storage.deleteData('supplier_product_map', id, currentUser).then(() => loadData(currentUser!, 'background'))}
                        mappings={mappings}
                        initialSubModule={pageId === 'vendorNomenclature' ? 'sync' : pageId === 'bulkUtility' ? 'bulk' : pageId === 'masterPriceMaintain' ? 'pricing' : 'master'}
                        addNotification={addNotification}
                    />;
                case 'substituteFinder':
                    return <SubstituteFinder inventory={inventory} />;
                case 'promotions':
                    return <Promotions currentUser={currentUser} addNotification={addNotification} />;
                case 'reports':
                    return <Reports
                        inventory={inventory} transactions={transactions} purchases={purchases}
                        distributors={suppliers} customers={customers} doctors={doctors} salesReturns={salesReturns}
                        purchaseReturns={purchaseReturns} onPrintReport={setViewReport} config={config}
                    />;
                case 'dailyReports':
                    return <DailyReports
                        transactions={transactions}
                        inventory={inventory}
                        purchases={purchases}
                        salesChallans={salesChallans}
                        deliveryChallans={deliveryChallans}
                        customers={customers}
                        reportId={currentDailyReportId}
                    />;
                case 'balanceCarryforward':
                    return currentUser ? <BalanceCarryforward currentUser={currentUser} /> : null;
                case 'newJournalEntryVoucher':
                    return <NewJournalEntryVoucher currentUser={currentUser} addNotification={addNotification} />;
                case 'gst':
                    return <GstCenter
                        transactions={transactions} purchases={purchases} customers={customers}
                        currentUser={currentUser} configurations={configurations}
                        onUpdateConfigurations={(cfg) => {
                            const normalizedConfig = normalizeStockHandlingConfig(cfg);
                            return storage.saveData('configurations', normalizedConfig, currentUser).then(() => {
                            setConfigurations(normalizedConfig);
                            window.dispatchEvent(new CustomEvent('configurations-updated', { detail: normalizedConfig }));
                        })}
                        }
                    />;
                case 'eway':
                    return <EWayBilling
                        onOpenLoginSetup={() => {
                            setEwayLoginSetupReturnPage(pageId);
                            setCurrentPage('ewayLoginSetup');
                        }}
                        currentUser={currentUser}
                        transactions={transactions}
                        purchases={purchases}
                        salesChallans={salesChallans}
                        deliveryChallans={deliveryChallans}
                        customers={customers}
                        suppliers={suppliers}
                        ewayBills={ewayBills}
                        configurations={configurations}
                        onGenerate={(eway) => storage.saveData('ewaybills', eway, currentUser).then(() => loadData(currentUser!, 'background'))}
                        addNotification={addNotification}
                    />;
                case 'ewayLoginSetup':
                    return <EWayLoginSetup
                        configurations={configurations}
                        currentUser={currentUser}
                        onUpdateConfigurations={(cfg) => {
                            const normalizedConfig = normalizeStockHandlingConfig(cfg);
                            return storage.saveData('configurations', normalizedConfig, currentUser).then(() => {
                            setConfigurations(normalizedConfig);
                            window.dispatchEvent(new CustomEvent('configurations-updated', { detail: normalizedConfig }));
                        })}
                        }
                        addNotification={addNotification}
                        onCancel={closeEwayLoginSetup}
                        isActive={isActive}
                    />;
                case 'businessUsers':
                    return <BusinessUserAssignment
                        currentUser={currentUser!} addNotification={addNotification}
                        members={teamMembers} onRefresh={() => loadData(currentUser!, 'sync')}
                    />;
                case 'businessRoles':
                    return <BusinessRoles currentUser={currentUser!} addNotification={addNotification} />;
                case 'companyConfiguration':
                    return <CompanyConfiguration currentUser={currentUser} />;
                case 'configuration':
                    return <Configuration
                        configurations={configurations}
                        onUpdateConfigurations={(cfg: any) => {
                            const normalizedConfig = normalizeStockHandlingConfig(cfg);
                            return storage.saveData('configurations', normalizedConfig, currentUser).then(() => {
                            setConfigurations(normalizedConfig);
                            window.dispatchEvent(new CustomEvent('configurations-updated', { detail: normalizedConfig }));
                        })}
                        }
                        addNotification={addNotification} currentUser={currentUser} inventory={inventory}
                        transactions={transactions} purchases={purchases} distributors={suppliers} customers={customers} medicines={medicines}
                        onBulkAddInventory={(l: any) => storage.saveBulkData('inventory', l, currentUser)}
                        onBulkAddDistributors={(l: any) => storage.saveBulkData('suppliers', l, currentUser)}
                        onBulkAddCustomers={(l: any) => storage.saveBulkData('customers', l, currentUser)}
                        onBulkAddPurchases={(l: any) => storage.saveBulkData('purchases', l, currentUser)}
                        onBulkAddSales={(l: any) => storage.saveBulkData('sales_bill', l, currentUser)}
                        onBulkAddMedicines={(l: any) => storage.saveBulkData('material_master', l, currentUser)}
                        onBulkAddMappings={(l: any) => storage.saveBulkData('supplier_product_map', l, currentUser)}
                        mappings={mappings}
                        onMigrationLockChange={setIsMigrationLocked}
                        onMigrationStateChange={setMigrationUiState}
                        forceShowMigrationPopupToken={migrationPopupToken}
                        isActive={isActive}
                    />;
                case 'settings':
                    return <Settings
                        currentUser={currentUser}
                        onUpdateProfile={(p) => storage.updateProfile(p).then((updated) => {
                            setCurrentUser(updated);
                            loadData(updated, 'background');
                        })}
                        addNotification={addNotification}
                    />;
                case 'moduleVisibility':
                    return <ModuleVisibility
                        currentUser={currentUser}
                        addNotification={addNotification}
                        onCancel={() => handleNavigate('dashboard')}
                        isActive={isActive}
                    />;
                case 'classification':
                    return <Classification
                        categories={categories} subCategories={subCategories}
                        onAddCategory={(d) => storage.saveData('categories', d, currentUser).then(() => loadData(currentUser!, 'background'))}
                        onUpdateCategory={(d) => storage.saveData('categories', d, currentUser).then(() => loadData(currentUser!, 'background'))}
                        onDeleteCategory={(id) => storage.deleteData('categories', id, currentUser).then(() => loadData(currentUser!, 'background'))}
                        onAddSubCategory={(d) => storage.saveData('sub_categories', d, currentUser).then(() => loadData(currentUser!, 'background'))}
                        onUpdateSubCategory={(d) => storage.saveData('sub_categories', d, currentUser).then(() => loadData(currentUser!, 'background'))}
                        onDeleteSubCategory={(id) => storage.deleteData('sub_categories', id, currentUser).then(() => loadData(currentUser!, 'background'))}
                    />;
                case 'accountReceivable':
                    return <AccountReceivable
                        customers={customers}
                        transactions={transactions}
                        bankOptions={bankOptions as any}
                        onRecordPayment={handleRecordCustomerPaymentWithAccounting}
                        onRecordDownPaymentAdjustment={handleRecordCustomerDownPaymentAdjustment}
                        onRecordInvoicePaymentAdjustment={handleRecordCustomerInvoicePaymentAdjustment}
                        onCancelPaymentEntry={handleCancelPartyPaymentEntry}
                        currentUser={currentUser}
                    />;
                case 'accountPayable':
                    return <AccountPayable
                        distributors={suppliers}
                        purchases={purchases}
                        bankOptions={bankOptions as any}
                        onRecordPayment={handleRecordSupplierPaymentWithAccounting}
                        onRecordDownPaymentAdjustment={handleRecordSupplierDownPaymentAdjustment}
                        onRecordInvoicePaymentAdjustment={handleRecordSupplierInvoicePaymentAdjustment}
                        onCancelPaymentEntry={handleCancelPartyPaymentEntry}
                        currentUser={currentUser}
                    />;
                default:
                    return <Dashboard
                        currentUser={currentUser} configurations={configurations} inventory={inventory}
                        transactions={transactions} purchases={purchases} medicines={medicines}
                        customers={customers} distributors={suppliers} onKpiClick={handleNavigate}
                        brandName="MDXERA" lastRefreshed={lastRefreshed} onReload={handleReload} isReloading={isReloading}
                        isKeyboardActive={activeDashboardMenu === 'right'}
                    />;
            }
        } catch (e) {
            console.error('CRITICAL PAGE RENDER ERROR:', e);
            return (
                <div className="flex-1 flex items-center justify-center bg-red-50 p-10">
                    <div className="max-w-md w-full bg-white border-2 border-red-500 p-8 shadow-2xl">
                        <h2 className="text-2xl font-black text-red-600 uppercase mb-4 tracking-tight">Application Fault</h2>
                        <p className="text-sm font-bold text-gray-700 mb-6">The module <span className="text-red-600 uppercase">{pageId}</span> has encountered a critical failure and could not be rendered.</p>
                        <div className="bg-red-50 p-4 border border-red-100 rounded mb-6">
                            <p className="text-[10px] font-black text-red-400 uppercase mb-1">Error Trace</p>
                            <p className="text-xs font-mono text-red-700 break-words">{String(e)}</p>
                        </div>
                        <button onClick={() => window.location.reload()} className="w-full py-3 bg-red-600 text-white font-black uppercase text-xs tracking-widest hover:bg-red-700 transition-colors">
                            Re-initialize System
                        </button>
                    </div>
                </div>
            );
        }
    };

    const queryParams = new URLSearchParams(window.location.search);
    const mobileSyncSession = queryParams.get('sync_session');
    const mobileSyncOrgId = queryParams.get('org_id');

    if (mobileSyncSession && mobileSyncOrgId) {
        return <MobileCaptureView sessionId={mobileSyncSession} orgId={mobileSyncOrgId} />;
    }

    // Keep URL aligned with auth/app state for direct links like /login.
    useEffect(() => {
        if (isAppLoading) return;

        const currentPath = window.location.pathname;
        if (!currentUser || authView === 'reset') {
            const target = authView === 'forgot' ? '/forgot-password' : authView === 'reset' ? '/reset-password' : '/login';
            if (currentPath !== target) {
                window.history.replaceState({}, '', target);
            }
            return;
        }

        if (currentPath !== '/') {
            window.history.replaceState({}, '', '/');
        }
    }, [authView, currentUser, isAppLoading]);

    // Show Auth page if no user is logged in OR if we are in the middle of a password reset
    if ((!currentUser || authView === 'reset') && !isAppLoading) {
        return <Auth onLogin={handleLogin} initialView={authView} />;
    }

    if (isAppLoading) {
        return (
            <div className="h-screen w-screen flex items-center justify-center bg-app-bg">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-xs font-black uppercase text-primary tracking-widest animate-pulse">Initializing ERP Modules...</p>
                </div>
            </div>
        );
    }

    if (appLoadError && currentUser) {
        return (
            <div className="h-screen w-screen flex items-center justify-center bg-app-bg px-4">
                <div className="w-full max-w-xl bg-white border border-red-200 shadow-lg p-6">
                    <h2 className="text-lg font-black uppercase tracking-wide text-red-700 mb-3">Module initialization failed</h2>
                    <p className="text-sm text-gray-700 mb-4">
                        Purchase Order and related modules could not be initialized cleanly. The loader has been stopped to avoid an infinite wait.
                    </p>
                    <div className="text-xs font-mono bg-red-50 border border-red-200 p-3 text-red-700 mb-4 break-words">
                        {appLoadError}
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => loadData(currentUser, 'initial')}
                            className="px-4 py-2 bg-primary text-white text-xs font-black uppercase"
                        >
                            Retry initialization
                        </button>
                        <button
                            onClick={() => setAppLoadError(null)}
                            className="px-4 py-2 border border-gray-300 text-xs font-black uppercase"
                        >
                            Continue with partial data
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="h-screen flex flex-col bg-app-bg overflow-hidden text-app-text-primary">
            <SyncBootstrap currentUser={currentUser} />
            <Header
                currentUser={currentUser}
                onNavigate={handleNavigate}
                onBack={handleBack}
                canGoBack={history.length > 0 || currentPage !== 'dashboard'}
                onLogout={() => setShowLogoutPrompt(true)}
                onNewBillClick={() => handleNavigate('pos')}
                isFullScreen={isFullScreen}
                onToggleFullScreen={toggleFullScreen}
                brandName="MDXERA ERP"
                currentPage={currentPage}
                onReload={handleReload}
                isReloading={isReloading}
                onResyncAll={() => {
                    if (!currentUser) return;
                    addNotification('Starting full resync — setup modal will appear shortly.', 'success');
                    triggerFullResync();
                    // Refresh the legacy app state after the foreground phase
                    // completes (5s buffer; background phase will continue
                    // asynchronously and SyncBootstrap will rehydrate).
                    setTimeout(() => {
                        if (currentUser) loadData(currentUser, 'sync');
                    }, 5000);
                }}
                onFreshInstallSync={() => setShowFreshInstallSyncDialog(true)}
                onToggleSidebar={toggleSidebar}
            />
            <div className="flex-1 flex overflow-hidden">
                {isDashboardScreen && (
                    <Sidebar
                        currentPage={currentPage}
                        onNavigate={handleNavigate}
                        currentUser={currentUser}
                        navigationItems={filterNavByVisibility(filterNavigationByPermissions(navigation, currentUser, teamMembers, businessRoles), hiddenScreens)}
                        configurations={configurations}
                        onToggleMasterExplorer={toggleSidebar}
                        brandName="MDXERA"
                        isKeyboardActive={activeDashboardMenu === 'left'}
                    />
                )}
                <div className="flex-1 relative overflow-hidden flex flex-col">
                    {mountedPages.map((pageId) => (
                        <div
                            key={`${pageId}-${screenResetNonce[pageId] ?? 0}`}
                            ref={(node) => { pageContainerRefs.current[pageId] = node; }}
                            className={`absolute inset-0 overflow-auto ${pageId === currentPage ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none z-0'}`}
                            aria-hidden={pageId === currentPage ? undefined : true}
                        >
                            {renderPage(pageId, pageId === currentPage)}
                        </div>
                    ))}
                </div>
            </div>
            <div className="no-print">
                <StatusBar
                    userName={currentUser?.full_name || 'Admin'}
                    isOnline={isOnline}
                    pharmacyName={currentUser?.pharmacy_name || 'MDXERA'}
                    isSyncing={isReloading || syncStatus === 'syncing'}
                    appEdition={isRealtimeActive ? "Enterprise Edition [Live]" : "Enterprise Edition"}
                    configurations={configurations}
                />
            </div>
            <NotificationSystem notifications={notifications} removeNotification={removeNotification} />
            <FreshInstallSyncDialog 
                isOpen={showFreshInstallSyncDialog} 
                onCancel={() => setShowFreshInstallSyncDialog(false)} 
                onConfirm={() => {
                    setShowFreshInstallSyncDialog(false);
                    triggerFreshInstallSync();
                }} 
            />
            {isMigrationLocked && migrationUiState.active && migrationUiState.minimized && (
                <div className="fixed bottom-4 right-4 z-[310] px-4 py-2 bg-yellow-100 border-2 border-yellow-500 text-yellow-900 text-xs font-black uppercase tracking-wider shadow-xl flex items-center gap-3">
                    <span>
                        {migrationUiState.status === 'Processing…'
                            ? `Migration in progress (${migrationUiState.progressPercent}%)`
                            : `Migration ${migrationUiState.status} (${migrationUiState.progressPercent}%)`}
                    </span>
                    <button
                        type="button"
                        className="px-2 py-1 border border-yellow-700 bg-white text-yellow-900"
                        onClick={() => {
                            setMigrationPopupToken(prev => prev + 1);
                            setCurrentPage('configuration');
                        }}
                    >
                        View
                    </button>
                </div>
            )}

            {printBill && (
                <PrintBillModal 
                    isOpen={!!printBill} 
                    onClose={() => {
                        setPrintBill(null);
                        if (currentPage === 'pos' || currentPage === 'nonGstPos') {
                            setCurrentPage('salesHistory');
                        }
                    }} 
                    bill={printBill} 
                    medicines={medicines} 
                />
            )}
            {viewTransaction && (
                <TransactionDetailModal
                    isOpen={!!viewTransaction}
                    onClose={() => setViewTransaction(null)}
                    transaction={viewTransaction}
                    customer={customers.find(c => c.id === viewTransaction.customerId)}
                    onPrintBill={(tx) => { 
                        const payload = buildPrintBillPayload(tx);
                        if (!payload) return;
                        setPrintBill(payload);
                    }}
                    onProcessReturn={() => { }}
                    currentUser={currentUser}
                    salesReturns={salesReturns}
                    configurations={configurations}
                />            )}
            {viewPurchase && (
                <PurchaseDetailModal 
                    isOpen={!!viewPurchase} 
                    onClose={() => setViewPurchase(null)} 
                    purchase={viewPurchase} 
                    purchaseReturns={purchaseReturns}
                    currentUser={currentUser}
                    configurations={configurations}
                />
            )}
            {printPO && <PrintPurchaseOrderModal isOpen={!!printPO} onClose={() => setPrintPO(null)} purchaseOrder={printPO as any} pharmacy={currentUser} />}
            {viewReport && <PrintableReportModal isOpen={!!viewReport} onClose={() => setViewReport(null)} {...viewReport} pharmacyDetails={currentUser} />}
            {showLogoutPrompt && <TallyPrompt isOpen={showLogoutPrompt} title="Quit Application" message="Are you sure you want to exit Medimart ERP?" onAccept={handleLogout} onDiscard={() => setShowLogoutPrompt(false)} onCancel={() => setShowLogoutPrompt(false)} />}

            {showEscSavePrompt && (
                <TallyPrompt
                    isOpen={showEscSavePrompt}
                    title="Quit and Save"
                    message="Do you want to save data?"
                    acceptLabel="Yes"
                    discardLabel="No"
                    onAccept={handleEscSave}
                    onDiscard={handleEscDiscard}
                    onCancel={() => {
                        setShowEscSavePrompt(false);
                        setPendingNavigation(null);
                    }}
                />
            )}

            {isOperationLoading && (
                <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center bg-[#004242] font-sans select-none">
                    <div className="flex flex-col items-center gap-8">
                        {/* The 10 loading blocks */}
                        <div className="flex gap-2.5">
                            {[...Array(10)].map((_, i) => {
                                const isFilled = i < loadingProgress;
                                return (
                                    <div
                                        key={i}
                                        className={`w-[18px] h-[52px] rounded-[1px] transition-all duration-300 ${
                                            isFilled 
                                                ? 'bg-white shadow-[0_6px_12px_rgba(0,0,0,0.25),0_0_2px_rgba(255,255,255,0.4)] translate-y-[-2px]' 
                                                : 'bg-[#002222]/45 shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)] border border-[#ffffff]/5'
                                        }`}
                                    />
                                );
                            })}
                        </div>
                        {/* The loading... text */}
                        <div 
                            className="text-white text-3xl font-extrabold tracking-wider select-none opacity-95 animate-pulse"
                            style={{
                                fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                                textShadow: '0 2px 4px rgba(0,0,0,0.25)',
                            }}
                        >
                            loading...
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default App;
