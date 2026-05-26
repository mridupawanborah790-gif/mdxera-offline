import React, { useEffect, createContext, useContext, useRef, useState, useCallback } from 'react';
import { useAuthStore } from '@core/auth/authStore';
import { restoreSession } from '@core/auth/authService';
import { initDatabase } from '@core/db/client';
import { warmupVoucherRanges } from '@core/voucher/voucherService';
import {
  isForegroundComplete,
  runForegroundSync,
  startBackgroundSync,
} from '@core/sync/InitialSync';
import { isOnline } from '@core/sync/networkMonitor';
import InitialSyncModal from '@core/components/feedback/InitialSyncModal';
import type { RegisteredPharmacy } from '@core/types';

interface AuthContextValue {
  currentUser: RegisteredPharmacy | null;
  isAuthenticated: boolean;
  isOfflineSession: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  currentUser: null,
  isAuthenticated: false,
  isOfflineSession: false,
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

interface Props {
  children: React.ReactNode;
  loadingFallback?: React.ReactNode;
  loginFallback: React.ReactNode;
}

type InitialSyncPhase = 'unchecked' | 'running' | 'done' | 'skipped' | 'error';

export function AuthProvider({ children, loadingFallback, loginFallback }: Props) {
  const {
    currentUser, isAuthenticated, isOfflineSession,
    isRestoringSession, setUser, setRestoringSession,
  } = useAuthStore();

  const [initialSyncPhase, setInitialSyncPhase] = useState<InitialSyncPhase>('unchecked');
  const lastSyncedOrgRef = useRef<string | null>(null);

  // Trigger initial sync once we have an authenticated user.
  // The function below decides whether sync is needed at all and handles retries.
  const startInitialSync = useCallback(async (user: RegisteredPharmacy) => {
    // If we already have all foreground tables → skip directly to background phase
    try {
      const fgDone = await isForegroundComplete(user.organization_id);
      if (fgDone) {
        // Continue/restart background phase (resumable; no-op if everything done)
        setInitialSyncPhase('done');
        if (isOnline()) startBackgroundSync(user);
        return;
      }

      // Foreground sync is required. Show modal.
      if (!isOnline()) {
        // No internet on first launch — can't initial-sync. Let the user in
        // with an empty local DB (they can still log in offline if they had
        // _local_auth seeded, but they won't have any data to see).
        setInitialSyncPhase('skipped');
        return;
      }

      setInitialSyncPhase('running');
      await runForegroundSync(user);
      setInitialSyncPhase('done');
      // Kick off background phase
      startBackgroundSync(user);
    } catch (err) {
      console.error('[AuthProvider] Initial sync failed:', err);
      setInitialSyncPhase('error');
    }
  }, []);

  // Re-run sync after a successful login (when login happens mid-app-session).
  // Also: if the active organization actually changes (user logged out of A
  // and back in as B), reset the phase so initial sync runs again. Without
  // this, the React state would stay at 'done' from the previous account and
  // the new account would never trigger a foreground/background pull. The
  // per-org migration (015) already isolates _sync_meta / _initial_sync_state,
  // but this hook is what tells the UI machine to actually kick off the
  // re-pull.
  useEffect(() => {
    if (!currentUser || isRestoringSession) return;
    const orgId = currentUser.organization_id;
    if (lastSyncedOrgRef.current && lastSyncedOrgRef.current !== orgId) {
      console.info(
        '[AuthProvider] active org changed',
        lastSyncedOrgRef.current, '→', orgId, '— resetting initial sync phase.'
      );
      setInitialSyncPhase('unchecked');
    }
    lastSyncedOrgRef.current = orgId;
  }, [currentUser, isRestoringSession]);

  useEffect(() => {
    if (currentUser && !isRestoringSession && initialSyncPhase === 'unchecked') {
      startInitialSync(currentUser);
    }
  }, [currentUser, isRestoringSession, initialSyncPhase, startInitialSync]);

  // Boot: init DB + restore session
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        await initDatabase();
        const user = await restoreSession();

        if (!cancelled) {
          if (user) {
            setUser(user);
            // Pre-fetch voucher ranges (non-blocking)
            warmupVoucherRanges(user).catch((err) =>
              console.warn('[AuthProvider] voucher warmup failed:', err)
            );
            // Initial-sync decision happens in the effect above
          }
          setRestoringSession(false);
        }
      } catch (err) {
        console.error('[AuthProvider] Boot error:', err);
        if (!cancelled) setRestoringSession(false);
      }
    }

    boot();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Rendering ────────────────────────────────────────────────────────────

  if (isRestoringSession) {
    return <>{loadingFallback ?? <div className="flex items-center justify-center h-screen text-gray-400">Starting MDXera ERP…</div>}</>;
  }

  // Not logged in → show login screen
  if (!isAuthenticated) {
    return <AuthContext.Provider value={{ currentUser, isAuthenticated, isOfflineSession }}>{loginFallback}</AuthContext.Provider>;
  }

  // Logged in but initial sync still running → block UI with modal
  if (initialSyncPhase === 'running' || initialSyncPhase === 'error') {
    return (
      <AuthContext.Provider value={{ currentUser, isAuthenticated, isOfflineSession }}>
        <InitialSyncModal
          onRetry={() => currentUser && startInitialSync(currentUser)}
          onSkip={() => setInitialSyncPhase('skipped')}
        />
      </AuthContext.Provider>
    );
  }

  // Initial sync done (or skipped because offline) → render the app
  return (
    <AuthContext.Provider value={{ currentUser, isAuthenticated, isOfflineSession }}>
      {children}
    </AuthContext.Provider>
  );
}
