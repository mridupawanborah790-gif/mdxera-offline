
import React, { useMemo, useState, useEffect } from 'react';
import Card from '@core/components/ui/Card';
import type { InventoryItem, RegisteredPharmacy, Transaction, Purchase, Medicine, Customer, Distributor, AppConfigurations } from '@core/types';
import Chatbot from '@core/components/ui/Chatbot'; // Import Chatbot here
import { MASTER_SHORTCUT_OPTIONS } from '@core/utils/constants';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';
import { buildCustomerInvoiceOutstandingMap, calculateCustomerReceivableBreakdown, calculateSupplierPayableBreakdown } from '@core/utils/helpers';
import { useOfflineAsset } from '@core/hooks/useOfflineAsset';
import { useModuleVisibility } from '@core/visibility/useModuleVisibility';

interface DashboardProps {
    currentUser: RegisteredPharmacy | null;
    configurations: AppConfigurations;
    transactions: Transaction[];
    inventory: InventoryItem[];
    purchases: Purchase[];
    medicines: Medicine[]; // Added for chatbot
    customers: Customer[]; // Added for chatbot
    distributors: Distributor[]; // Added for chatbot
    onKpiClick: (id: string) => void;
    brandName: string;
    lastRefreshed?: Date;
    onReload?: () => void;
    isReloading?: boolean;
    isKeyboardActive?: boolean;
}

const KpiBox = ({ label, value, color, onClick }: { label: string, value: any, color: string, onClick: () => void }) => (
    <button 
        onClick={onClick}
        className={`bg-white dark:bg-zinc-800 p-4 border-l-4 ${color} tally-border tally-shadow text-left hover:bg-gray-50 transition-all w-full outline-none focus:ring-2 focus:ring-primary`}
    >
        <p className="text-11px font-bold text-gray-400 uppercase mb-1">{label}</p>
        <p className="text-xl font-black text-gray-900 dark:text-white">{value}</p>
    </button>
);

const Dashboard: React.FC<DashboardProps> = ({ currentUser, configurations, transactions, inventory, purchases, medicines, customers, distributors, onKpiClick, brandName, lastRefreshed, onReload, isReloading, isKeyboardActive = true }) => {
    const [focusedShortcutIndex, setFocusedShortcutIndex] = useState<number>(-1);
    const [expiryFilter, setExpiryFilter] = useState<'expired' | 'nearExpiry'>('expired');

    // Reset focus when menu becomes inactive
    useEffect(() => {
        if (!isKeyboardActive) {
            setFocusedShortcutIndex(-1);
        }
    }, [isKeyboardActive]);

    const promoImageUrl = useOfflineAsset(
        configurations.displayOptions?.dashboard_logo_url || 'https://sblmbkgoiefqzykjksgm.supabase.co/storage/v1/object/public/logos/IMG_9600.PNG'
    );

    const { isDashboardFieldHidden } = useModuleVisibility();
    const isVisible = (fieldId: string) =>
        configurations.modules?.dashboard?.fields?.[fieldId] !== false &&
        !isDashboardFieldHidden(fieldId);
    const showReceivables = isVisible('statReceivables');
    const showPayables = isVisible('statPayables');
    const showExpiryBar = !isDashboardFieldHidden('expiryBar');

    const todayLocalStr = useMemo(() => {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }, []);

    const isSameLocalDay = (dateValue?: string) => {
        if (!dateValue) return false;
        const raw = String(dateValue).trim();
        if (!raw) return false;

        // Fast path for ISO-like values.
        if (raw.startsWith(todayLocalStr)) return true;

        // Fallback for other date formats saved in legacy records.
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) return false;
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}` === todayLocalStr;
    };

    const todayTransactions = useMemo(() => {
        return transactions.filter(t => isSameLocalDay(t.date) && t.status !== 'cancelled');
    }, [transactions, todayLocalStr]);

    const todaySales = useMemo(() => todayTransactions.reduce((sum, t) => sum + t.total, 0), [todayTransactions]);

    const todayPurchases = useMemo(() => {
        return purchases
            .filter(p => isSameLocalDay(p.date) && p.status !== 'cancelled')
            .reduce((sum, p) => sum + (p.totalAmount || 0), 0);
    }, [purchases, todayLocalStr]);

    const todayProfit = useMemo(() => {
        const netSales = todayTransactions.reduce((sum, t) => sum + (t.total - (t.totalGst || 0)), 0);
        const cogs = todayTransactions.reduce((acc, t) => {
            return acc + (t.items || []).reduce((itemAcc, item) => {
                const inv = inventory.find(i => i.id === item.inventoryItemId);
                if (!inv) return itemAcc;
                const unitsPerPack = inv.unitsPerPack || 1;
                const totalUnitsSold = (item.quantity * unitsPerPack) + (item.looseQuantity || 0);
                const unitCost = inv.cost || (inv.purchasePrice / unitsPerPack);
                return itemAcc + (totalUnitsSold * unitCost);
            }, 0);
        }, 0);
        return Math.round(netSales - cogs);
    }, [todayTransactions, inventory]);

    const customerInvoiceOutstandingMap = useMemo(
        () => (showReceivables ? buildCustomerInvoiceOutstandingMap(customers, transactions) : {}),
        [customers, transactions, showReceivables]
    );

    const totalReceivable = useMemo(() => {
        if (!showReceivables) return 0;
        return customers.reduce((sum, customer) => {
            const receivable = calculateCustomerReceivableBreakdown(customer, customerInvoiceOutstandingMap[customer.id] || 0).netOutstanding;
            return sum + Math.max(receivable, 0);
        }, 0);
    }, [customers, customerInvoiceOutstandingMap, showReceivables]);

    const totalPayable = useMemo(() => {
        if (!showPayables) return 0;
        return distributors.reduce((sum, distributor) => {
            const payable = calculateSupplierPayableBreakdown(distributor).netOutstanding;
            return sum + Math.max(payable, 0);
        }, 0);
    }, [distributors, showPayables]);

    const lowStockCount = inventory.filter(i => i.stock <= i.minStockLimit).length;
    
    const inventoryValue = inventory.reduce((sum, i) => {
        const cost = i.cost || (i.purchasePrice / (i.unitsPerPack || 1));
        return sum + (i.stock * cost);
    }, 0);

    const formatCompactRupees = (value: number) => {
        const absolute = Math.abs(value);
        if (absolute >= 100000) {
            return `₹${(value / 100000).toFixed(2)}L`;
        }
        return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    };

    const amountClass = (value: number) => (
        value < 0 ? 'text-red-300' : 'text-accent'
    );

    const expiryAlerts = useMemo(() => {
        const threshold = configurations.displayOptions?.expiryThreshold || 90;
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const alertDate = new Date();
        alertDate.setDate(alertDate.getDate() + threshold);
        return inventory.filter(item => {
            if (!item.expiry) return false;
            const expDate = new Date(item.expiry);
            if (Number.isNaN(expDate.getTime())) return false;
            return expDate < todayStart || expDate <= alertDate;
        }).sort((a, b) => new Date(a.expiry).getTime() - new Date(b.expiry).getTime());
    }, [inventory, configurations.displayOptions]);

    const filteredExpiryAlerts = useMemo(() => {
        const threshold = configurations.displayOptions?.expiryThreshold || 90;
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const alertDate = new Date(todayStart);
        alertDate.setDate(alertDate.getDate() + threshold);

        return expiryAlerts.filter(item => {
            const expDate = new Date(item.expiry);
            if (Number.isNaN(expDate.getTime())) return false;
            if (expiryFilter === 'expired') {
                return expDate < todayStart;
            }
            return expDate >= todayStart && expDate <= alertDate;
        });
    }, [expiryAlerts, expiryFilter, configurations.displayOptions]);

    const tickerItems = useMemo(() => {
        if (filteredExpiryAlerts.length === 0) return [];
        return [...filteredExpiryAlerts, ...filteredExpiryAlerts];
    }, [filteredExpiryAlerts]);

    const tickerDuration = useMemo(() => {
        const secondsPerItem = 10;
        const minDuration = 55;
        return Math.max(minDuration, filteredExpiryAlerts.length * secondsPerItem);
    }, [filteredExpiryAlerts.length]);

    const getAlertType = (expiry?: string) => {
        const expDate = expiry ? new Date(expiry) : null;
        if (!expDate || Number.isNaN(expDate.getTime())) return 'nearExpiry' as const;

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return expDate < todayStart ? 'expired' as const : 'nearExpiry' as const;
    };

    const cleanAppData = useMemo(() => ({
        inventory, transactions, purchases, distributors, customers, medicines,
    }), [inventory, transactions, purchases, distributors, customers, medicines]);

    const activeShortcuts = useMemo(() => {
        if (configurations.masterShortcuts && configurations.masterShortcuts.length > 0) {
            const selectedSet = new Set(configurations.masterShortcuts);
            const selected = MASTER_SHORTCUT_OPTIONS.filter(opt => selectedSet.has(opt.id));
            const orderMap = configurations.masterShortcutOrder || {};
            const fallbackOrder = new Map(configurations.masterShortcuts.map((id, idx) => [id, idx + 1]));

            return selected
                .sort((a, b) => {
                    const orderA = orderMap[a.id] ?? fallbackOrder.get(a.id) ?? 999;
                    const orderB = orderMap[b.id] ?? fallbackOrder.get(b.id) ?? 999;
                    return orderA - orderB;
                });
        }
        // If no shortcuts selected, show first 12 defaults
        return MASTER_SHORTCUT_OPTIONS.slice(0, 12);
    }, [configurations.masterShortcutOrder, configurations.masterShortcuts]);

    // Keyboard navigation for Gateway Shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!isKeyboardActive) return;
            if (!shouldHandleScreenShortcut(e, 'dashboard')) return;
            // Don't intercept if an input is focused or sidebar has focus
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName || '')) return;
            if (document.querySelector('[role="dialog"]')) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setFocusedShortcutIndex(prev => (prev < activeShortcuts.length - 1 ? prev + 1 : 0));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setFocusedShortcutIndex(prev => (prev > 0 ? prev - 1 : activeShortcuts.length - 1));
            } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && focusedShortcutIndex >= 0) {
                e.preventDefault();
                onKpiClick(activeShortcuts[focusedShortcutIndex].id);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeShortcuts, focusedShortcutIndex, onKpiClick, isKeyboardActive]);

    return (
        <div className="relative min-h-full flex flex-col overflow-hidden bg-app-bg dark:bg-zinc-950">
            <main className="p-4 sm:p-6 space-y-6 view-enter flex-1 pb-28">
                
                {/* Header Strip - Reverted to original layout */}
                <div className="flex justify-between items-center bg-primary text-white px-4 py-3 tally-shadow">
                    <div className="flex items-center gap-3">
                        <h2 className="text-base font-bold uppercase tracking-widest">Dashboard Summary — {brandName}</h2>
                        {lastRefreshed && (
                            <span className="text-[10px] opacity-40 font-mono italic normal-case ml-2">Last Sync: {lastRefreshed.toLocaleTimeString()}</span>
                        )}
                    </div>
                    <div className="flex gap-8 text-[13px] font-bold uppercase">
                        {isVisible('statSales') && <span>Sales: <span className={amountClass(todaySales)}>{formatCompactRupees(todaySales)}</span></span>}
                        {isVisible('statProfit') && <span>Profit: <span className={amountClass(todayProfit)}>{formatCompactRupees(todayProfit)}</span></span>}
                        {isVisible('statPurchases') && <span>Purchases: <span className={amountClass(todayPurchases)}>{formatCompactRupees(todayPurchases)}</span></span>}
                        {isVisible('statStockValue') && <span>Inventory: <span className={amountClass(inventoryValue)}>{formatCompactRupees(inventoryValue)}</span></span>}
                        {showReceivables && <span>Receivables: <span className={amountClass(totalReceivable)}>{formatCompactRupees(totalReceivable)}</span></span>}
                        {showPayables && <span>Payables: <span className={amountClass(totalPayable)}>{formatCompactRupees(totalPayable)}</span></span>}
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    {/* Main Content Area */}
                    <div className="lg:col-span-9 space-y-6 order-1">
                        <Card className="p-0 tally-border !rounded-none overflow-hidden bg-white flex flex-col shadow-lg">
                            <div className="bg-gray-100 border-b border-gray-300 px-4 py-2 text-[10px] sm:text-[12px] font-bold uppercase tracking-[0.2em] text-gray-600">
                                Central Dashboard Display
                            </div>
                            <div className="flex-1 bg-gradient-to-b from-white to-gray-50 overflow-hidden h-[350px] sm:h-[450px] md:h-[550px] lg:h-[600px]">
                                <img
                                    src={promoImageUrl}
                                    alt="Dashboard promotion"
                                    className="w-full h-full object-cover bg-transparent"
                                    loading="lazy"
                                />
                            </div>
                        </Card>
                    </div>

                    {/* Sidebar Shortcuts */}
                    <div className="lg:col-span-3 flex justify-center lg:justify-end order-2 lg:order-2">
                        <Card className="w-full sm:max-w-md lg:w-[97%] p-0 tally-border !rounded-none bg-gray-100 dark:bg-zinc-800 shadow-xl overflow-hidden">
                            <div className="bg-primary px-3 py-2 text-white text-[12px] font-bold text-center uppercase tracking-[0.2em] border-b-2 border-gray-700">
                                MDXERA ENTERPRISE ERP
                            </div>
                            <div className="p-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-1">
                                {activeShortcuts.map((shortcut, idx) => (
                                    <button
                                        key={shortcut.id}
                                        onClick={() => onKpiClick(shortcut.id)}
                                        onMouseEnter={() => setFocusedShortcutIndex(idx)}
                                        className={`w-full text-left py-2.5 px-4 leading-tight transition-colors text-[14px] sm:text-[15px] font-semibold border border-gray-400 outline-none ${
                                            focusedShortcutIndex === idx
                                                ? 'bg-primary text-white border-primary shadow-lg'
                                                : 'bg-gray-200 text-gray-800 hover:bg-primary hover:text-white'
                                        }`}
                                    >
                                        {shortcut.label}
                                    </button>
                                ))}

                                {activeShortcuts.every(s => s.id !== 'configuration') && (
                                    <button
                                        onClick={() => onKpiClick('configuration')}
                                        onMouseEnter={() => setFocusedShortcutIndex(activeShortcuts.length)}
                                        className={`w-full text-left py-2.5 px-4 leading-tight transition-colors text-[14px] sm:text-[15px] font-semibold border border-gray-400 outline-none ${
                                            focusedShortcutIndex === activeShortcuts.length
                                                ? 'bg-primary text-white border-primary shadow-lg'
                                                : 'bg-gray-200 text-gray-800 hover:bg-primary hover:text-white'
                                        }`}
                                    >
                                        Full Configuration
                                    </button>
                                )}
                            </div>
                            <div className="px-2 py-2 bg-gray-200 border-t border-gray-400 text-center hidden sm:block">
                                <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wide">Use ↑ ↓ + Enter</span>
                            </div>
                        </Card>
                    </div>
                </div>

            </main>

            {showExpiryBar && expiryAlerts.length > 0 && (
                <div className="sticky bottom-0 z-20 border-t-2 border-emerald-700/70 bg-emerald-200/60 text-emerald-950 shadow-[0_-4px_16px_rgba(6,78,59,0.15)] backdrop-blur-sm">
                    <div className="flex flex-col gap-3 px-3 py-2 md:flex-row md:items-center md:justify-between md:px-5">
                        <div className="text-xs font-extrabold uppercase tracking-[0.12em]">
                            ATTENTION REQUIRED: EXPIRY ALERTS
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setExpiryFilter('expired')}
                                className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${expiryFilter === 'expired' ? 'bg-red-700 text-white shadow-sm' : 'bg-white/70 text-red-900 hover:bg-white'}`}
                            >
                                Expired
                            </button>
                            <button
                                type="button"
                                onClick={() => setExpiryFilter('nearExpiry')}
                                className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${expiryFilter === 'nearExpiry' ? 'bg-yellow-400 text-yellow-950 shadow-sm' : 'bg-white/70 text-yellow-900 hover:bg-white'}`}
                            >
                                Near Expiry
                            </button>
                        </div>
                    </div>

                    <div className="overflow-hidden border-t border-emerald-700/30 bg-emerald-100/40 py-2">
                        {filteredExpiryAlerts.length > 0 ? (
                            <div
                                className="expiry-ticker-track flex min-w-max items-center gap-3 px-4"
                                style={{ animationDuration: `${tickerDuration}s` }}
                            >
                                {tickerItems.map((item, idx) => {
                                    const isExpiredAlert = getAlertType(item.expiry) === 'expired';
                                    return (
                                        <div
                                            key={`${item.id}-${idx}`}
                                            className={`flex items-center gap-2 whitespace-nowrap rounded border px-3 py-1 text-xs md:text-sm ${isExpiredAlert ? 'border-red-500/60 bg-red-100/95 text-red-900' : 'border-yellow-500/70 bg-yellow-100/95 text-yellow-950'}`}
                                        >
                                            <span className="font-bold uppercase">{item.name}</span>
                                            <span className="font-mono uppercase">{item.batch || 'NO-BATCH'}</span>
                                            <span className="font-semibold">EXP: {item.expiry}</span>
                                            <span className="font-black">STOCK {item.stock}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="px-4 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-900 md:text-sm">
                                No materials found for selected filter.
                            </div>
                        )}
                    </div>
                </div>
            )}

            <style>{`
                .expiry-ticker-track {
                    animation: expiryTickerMove 55s linear infinite;
                    will-change: transform;
                }

                @keyframes expiryTickerMove {
                    0% {
                        transform: translateX(0);
                    }
                    100% {
                        transform: translateX(-50%);
                    }
                }
            `}</style>

            <Chatbot appData={cleanAppData} />
        </div>
    );
};

export default Dashboard;
