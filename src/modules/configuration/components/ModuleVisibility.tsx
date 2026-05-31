import React, { useEffect, useMemo, useState } from 'react';
import Card from '@core/components/ui/Card';
import AdminPasswordModal from '@core/components/ui/AdminPasswordModal';
import { navigation } from '@core/utils/constants';
import { useModuleVisibilityStore } from '@core/visibility/moduleVisibilityStore';
import type { NavItem, RegisteredPharmacy } from '@core/types';

interface DashboardField {
  id: string;
  name: string;
}

const DASHBOARD_FIELDS: DashboardField[] = [
  { id: 'statSales', name: 'Today’s Sales' },
  { id: 'statProfit', name: 'Today’s Profit' },
  { id: 'statStockValue', name: 'Inventory (Stock Value)' },
  { id: 'statPurchases', name: 'Today’s Purchases' },
  { id: 'statReceivables', name: 'Account Receivables' },
  { id: 'statPayables', name: 'Account Payables' },
  { id: 'expiryBar', name: 'Expiry Alerts Bar' },
];

interface ModuleVisibilityProps {
  currentUser: RegisteredPharmacy | null;
  addNotification: (message: string, type: 'success' | 'error' | 'warning') => void;
  /** When true, the lock modal is bypassed (e.g. caller already authenticated). */
  preAuthorized?: boolean;
  onCancel?: () => void;
  /** When false, the screen re-locks itself so the next visit requires the
   *  password again. App.tsx keeps pages mounted, so we can't rely on
   *  unmount-on-navigate to clear local state. */
  isActive?: boolean;
}

function renderNavRow(
  item: NavItem,
  hiddenScreens: Set<string>,
  toggleScreen: (id: string) => void,
  depth: number
): React.ReactNode {
  return (
    <div key={item.id} className="space-y-1">
      <Row
        label={item.name}
        hidden={hiddenScreens.has(item.id)}
        onToggle={() => toggleScreen(item.id)}
        indent={depth}
      />
      {item.children?.map((child) =>
        renderNavRow(child, hiddenScreens, toggleScreen, depth + 1)
      )}
    </div>
  );
}

const Row: React.FC<{
  label: string;
  hidden: boolean;
  onToggle: () => void;
  indent?: number;
}> = ({ label, hidden, onToggle, indent = 0 }) => (
  <label
    className={`flex items-center justify-between gap-3 px-3 py-2 border border-gray-300 ${hidden ? 'bg-red-50' : 'bg-white'} hover:bg-yellow-50 cursor-pointer`}
    style={{ marginLeft: indent * 18 }}
  >
    <span className="text-[11px] font-bold uppercase tracking-wide text-gray-800">
      {label}
    </span>
    <span className="flex items-center gap-2">
      <span className={`text-[9px] font-black uppercase tracking-widest ${hidden ? 'text-red-600' : 'text-emerald-700'}`}>
        {hidden ? 'Hidden' : 'Visible'}
      </span>
      <input
        type="checkbox"
        checked={!hidden}
        onChange={onToggle}
        className="w-4 h-4 accent-primary"
      />
    </span>
  </label>
);

const ModuleVisibility: React.FC<ModuleVisibilityProps> = ({ currentUser, addNotification, preAuthorized = false, onCancel, isActive = true }) => {
  const [authorized, setAuthorized] = useState(preAuthorized);

  // Re-lock the screen whenever the user navigates away. Pages in this app
  // stay mounted across navigation, so without this the password gate would
  // only fire on the first visit per session.
  useEffect(() => {
    if (!isActive) setAuthorized(preAuthorized);
  }, [isActive, preAuthorized]);

  const hiddenScreens = useModuleVisibilityStore((s) => s.hiddenScreens);
  const hiddenDashboardFields = useModuleVisibilityStore((s) => s.hiddenDashboardFields);
  const setHiddenScreens = useModuleVisibilityStore((s) => s.setHiddenScreens);
  const setHiddenDashboardFields = useModuleVisibilityStore((s) => s.setHiddenDashboardFields);
  const loadForUser = useModuleVisibilityStore((s) => s.loadForUser);

  useEffect(() => {
    if (currentUser?.user_id) loadForUser(currentUser.user_id);
  }, [currentUser?.user_id, loadForUser]);

  const toggleScreen = (id: string) => {
    const next = new Set(hiddenScreens);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHiddenScreens(Array.from(next));
  };

  const toggleDashboardField = (id: string) => {
    const next = new Set(hiddenDashboardFields);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHiddenDashboardFields(Array.from(next));
  };

  const resetAll = () => {
    setHiddenScreens([]);
    setHiddenDashboardFields([]);
    addNotification('All modules and dashboard fields reset to visible.', 'success');
  };

  const summary = useMemo(() => {
    const screens = hiddenScreens.size;
    const fields = hiddenDashboardFields.size;
    return `${screens} screen${screens === 1 ? '' : 's'} hidden · ${fields} dashboard field${fields === 1 ? '' : 's'} hidden`;
  }, [hiddenScreens, hiddenDashboardFields]);

  if (!authorized) {
    return (
      <AdminPasswordModal
        isOpen={isActive}
        title="Module Hide / Unhide — Admin Lock"
        onSuccess={() => setAuthorized(true)}
        onCancel={() => {
          onCancel?.();
        }}
      />
    );
  }

  return (
    <main className="flex-1 h-full overflow-hidden flex flex-col view-enter bg-app-bg">
      <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
        <span className="text-[10px] font-black uppercase tracking-widest">
          Module Hide / Unhide — Per-User
        </span>
        <span className="text-[10px] font-black uppercase text-accent">{summary}</span>
      </div>

      <div className="p-4 flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-5xl mx-auto pb-16 space-y-6">
          <Card className="p-6 tally-border bg-white !rounded-none shadow-lg">
            <div className="flex items-end justify-between border-b-2 border-primary pb-2 mb-4">
              <div>
                <h3 className="text-lg font-black text-primary uppercase tracking-tight">
                  Module & Submodule Visibility
                </h3>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-1">
                  Uncheck to hide for this user (
                  {currentUser?.full_name || currentUser?.email || 'current user'}
                  ). Settings are saved per user, on this device.
                </p>
              </div>
              <button
                type="button"
                onClick={resetAll}
                className="px-4 py-1.5 tally-border bg-white text-gray-700 font-black uppercase text-[10px] tracking-widest hover:bg-gray-50"
              >
                Reset All
              </button>
            </div>

            <div className="space-y-2">
              {navigation.map((mod) => renderNavRow(mod, hiddenScreens, toggleScreen, 0))}
            </div>
          </Card>

          <Card className="p-6 tally-border bg-white !rounded-none shadow-lg">
            <div className="border-b-2 border-primary pb-2 mb-4">
              <h3 className="text-lg font-black text-primary uppercase tracking-tight">
                Dashboard Fields
              </h3>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-1">
                Hide individual KPI tiles or the expiry alerts bar on the dashboard.
              </p>
            </div>

            <div className="space-y-1">
              {DASHBOARD_FIELDS.map((field) => (
                <Row
                  key={field.id}
                  label={field.name}
                  hidden={hiddenDashboardFields.has(field.id)}
                  onToggle={() => toggleDashboardField(field.id)}
                />
              ))}
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
};

export default ModuleVisibility;
