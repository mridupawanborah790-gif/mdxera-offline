import React, { useEffect, createContext, useContext, useState } from 'react';
import { SyncEngine, type SyncStatus } from '@core/sync/SyncEngine';
import { setVoucherRenumberListener, type VoucherRenumberNotice } from '@core/sync/SyncWorker';
import NotificationSystem from '@core/components/feedback/NotificationSystem';
import { useAuthStore } from '@core/auth/authStore';
import type { Notification } from '@core/types';

const SUPABASE_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ??
  'https://sblmbkgoiefqzykjksgm.supabase.co';

interface SyncContextValue {
  syncStatus: SyncStatus;
  pendingCount: number;
  forceSync: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue>({
  syncStatus: 'idle',
  pendingCount: 0,
  forceSync: async () => {},
});

export function useSyncStatus(): SyncContextValue {
  return useContext(SyncContext);
}

function describeVoucherDocType(docType: string): string {
  switch (docType) {
    case 'sales-gst':         return 'sales';
    case 'sales-non-gst':     return 'sales';
    case 'purchase-entry':    return 'purchase';
    case 'purchase-order':    return 'purchase order';
    case 'sales-challan':     return 'sales challan';
    case 'delivery-challan':  return 'delivery challan';
    case 'physical-inventory':return 'physical inventory';
    default:                  return 'voucher';
  }
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated } = useAuthStore();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [pendingCount, setPendingCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const addNotification = (type: Notification['type'], message: string): void => {
    setNotifications((prev) => [...prev, { id: Date.now() + Math.random(), type, message }]);
  };
  const removeNotification = (id: number): void => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  useEffect(() => {
    if (!isAuthenticated || !currentUser) return;

    SyncEngine.start(currentUser.organization_id, SUPABASE_URL);

    const unsubscribe = SyncEngine.on((status) => {
      setSyncStatus(status);
      SyncEngine.pendingCount().then(setPendingCount).catch(() => {});
    });

    // When the server renumbers any of our offline bills, surface a warning so
    // the user knows printed copies may not match what's in Supabase.
    const onRenumber = (notice: VoucherRenumberNotice): void => {
      const count = notice.renumbered.length;
      if (count === 0) return;
      const label = describeVoucherDocType(notice.docType);
      const sample = notice.renumbered.slice(0, 3).map((r) => r.newNumber).join(', ');
      const tail = count > 3 ? `, +${count - 3} more` : '';
      addNotification(
        'warning',
        `${count} ${label} bill${count > 1 ? 's' : ''} renumbered during sync: ${sample}${tail}`,
      );
      console.warn('[sync] voucher renumber notice:', notice);
    };
    setVoucherRenumberListener(onRenumber);

    return () => {
      unsubscribe();
      setVoucherRenumberListener(null);
      SyncEngine.stop();
    };
  }, [isAuthenticated, currentUser?.organization_id]);

  const forceSync = async () => {
    await SyncEngine.forceSync();
    setPendingCount(await SyncEngine.pendingCount());
  };

  return (
    <SyncContext.Provider value={{ syncStatus, pendingCount, forceSync }}>
      {children}
      <NotificationSystem notifications={notifications} removeNotification={removeNotification} />
    </SyncContext.Provider>
  );
}
