/**
 * Bridge between the legacy App.tsx (which owns `currentUser` in its own
 * useState) and the new offline-first sync stack. Drop this anywhere in the
 * legacy app's render tree once the user is known and it will:
 *
 *   1. Run the foreground InitialSync (with blocking modal) if this device
 *      hasn't downloaded master data yet.
 *   2. Start the background InitialSync phase for transactional history.
 *   3. Start the SyncEngine (delta pulls + outbound queue flushing).
 *   4. Mirror the legacy currentUser into the Zustand authStore so any newer
 *      code that reads `useAuthStore()` sees it.
 *
 * The component renders nothing once setup is complete; while foreground sync
 * is running it overlays the InitialSyncModal on top of the app.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  isForegroundComplete,
  runForegroundSync,
  startBackgroundSync,
} from '@core/sync/InitialSync';
import { SyncEngine } from '@core/sync/SyncEngine';
import {
  warmupVoucherRanges,
  warmupVoucherSeries,
  diagnoseVoucherSeries,
  resetVoucherCursors,
  clearVoucherReservations,
} from '@core/voucher/voucherService';
import { isOnline } from '@core/sync/networkMonitor';
import { useAuthStore } from '@core/auth/authStore';
import InitialSyncModal from '@core/components/feedback/InitialSyncModal';
import { hydrateMemoryCacheFromSqlite } from '@core/services/storageService';
import { db } from '@core/db/client';
import { TABLE, SYNCABLE_TABLES } from '@core/db/schema';
import {
  resetSchemaDriftCache,
  snapshotSchemaDrift,
} from '@core/sync/schemaDriftCache';
import { auditSchemas, snapshotSchemaAudit } from '@core/sync/schemaAudit';
import { warmupAssets } from '@core/utils/assetCache';
import type { RegisteredPharmacy } from '@core/types';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Brand assets that are always needed offline — cached on every online boot.
const STATIC_BRAND_ASSETS = [
  'https://sblmbkgoiefqzykjksgm.supabase.co/storage/v1/object/public/logos/IMG_9600.PNG',
  'https://sblmbkgoiefqzykjksgm.supabase.co/storage/v1/object/public/logos/ChatGPT%20Image%20Feb%203,%202026,%2009_44_47%20PM.png',
  'https://sblmbkgoiefqzykjksgm.supabase.co/storage/v1/object/public/logos/ChatGPT%20Image%20Feb%203,%202026,%2009_44_47%20PM%20(1).png',
];

/**
 * Event name fired by Header's "Sync All" button (or any other caller) to
 * force a full re-download of every table from Supabase. SyncBootstrap
 * listens for this and re-runs the foreground + background phases.
 */
export const RESYNC_EVENT = 'mdxera:resync-all';

/** Fire from anywhere to ask SyncBootstrap to perform a full resync. */
export function triggerFullResync(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(RESYNC_EVENT));
  }
}

const SUPABASE_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ??
  'https://sblmbkgoiefqzykjksgm.supabase.co';

type Phase = 'unchecked' | 'running' | 'done' | 'skipped' | 'error';

interface Props {
  currentUser: RegisteredPharmacy | null;
}

export const SyncBootstrap: React.FC<Props> = ({ currentUser }) => {
  const [phase, setPhase] = useState<Phase>('unchecked');
  const setAuthUser = useAuthStore((s) => s.setUser);
  const orgId = currentUser?.organization_id;

  // Mirror legacy currentUser into the zustand authStore so any code that
  // reads useAuthStore() (BackgroundSyncBadge, SyncIndicator, etc.) works.
  useEffect(() => {
    setAuthUser(currentUser ?? null);
  }, [currentUser, setAuthUser]);

  // Expose recovery helpers on the global window so users can call them from
  // DevTools without rebuilding. e.g. `await window.__mdxera.resetFailedQueueItems()`.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const resetFailedQueueItems = async () => {
      await db.execute(
        `UPDATE _sync_queue SET status = 'pending', attempts = 0, last_error = NULL WHERE status = 'failed'`
      );
      console.info('[SyncBootstrap] Failed queue items reset to pending.');
    };
    // Voucher cursor helpers. Both look up currentUser from the authStore
    // internally so the caller can fire-and-forget from DevTools without
    // having to construct a user object:
    //
    //   await window.__mdxera.warmupVoucherSeries()
    //   await window.__mdxera.diagnoseVoucherSeries()
    const warmupVoucherSeriesFromConsole = async (): Promise<void> => {
      const user = useAuthStore.getState().currentUser;
      if (!user) {
        console.warn('[SyncBootstrap] no currentUser — cannot warmup voucher series');
        return;
      }
      await warmupVoucherSeries(user.organization_id);
      console.info('[SyncBootstrap] voucher series warmed up for', user.organization_id);
    };
    const diagnoseVoucherSeriesFromConsole = async () => {
      const user = useAuthStore.getState().currentUser;
      if (!user) {
        console.warn('[SyncBootstrap] no currentUser — cannot diagnose voucher series');
        return null;
      }
      return diagnoseVoucherSeries(user.organization_id);
    };
    // Drop all local cursors and re-seed from the authoritative sources.
    // Use when a cursor has been left inflated by a past bug and warmup's
    // "only bump up" rule won't shrink it.
    //   await window.__mdxera.resetVoucherCursors()
    const resetVoucherCursorsFromConsole = async (): Promise<void> => {
      const user = useAuthStore.getState().currentUser;
      if (!user) {
        console.warn('[SyncBootstrap] no currentUser — cannot reset voucher cursors');
        return;
      }
      await resetVoucherCursors(user.organization_id);
      await warmupVoucherSeries(user.organization_id);
      console.info(
        '[SyncBootstrap] voucher cursors reset + re-warmed for',
        user.organization_id
      );
    };
    (window as unknown as { __mdxera?: Record<string, unknown> }).__mdxera = {
      clearVoucherReservations,
      hydrateMemoryCacheFromSqlite,
      runForegroundSync,
      startBackgroundSync,
      triggerFullResync,
      isOnline,
      resetFailedQueueItems,
      // Voucher cursor recovery — for when "Next Sequence No" drifts.
      //   await window.__mdxera.diagnoseVoucherSeries()  // see why
      //   await window.__mdxera.warmupVoucherSeries()    // bump up only
      //   await window.__mdxera.resetVoucherCursors()    // wipe + re-seed
      warmupVoucherSeries: warmupVoucherSeriesFromConsole,
      diagnoseVoucherSeries: diagnoseVoucherSeriesFromConsole,
      resetVoucherCursors: resetVoucherCursorsFromConsole,
      // Schema-drift cache controls. Call these from DevTools after an org
      // upgrades its Supabase schema so the client re-discovers what columns
      // are now accepted (instead of permanently skipping them).
      //   await window.__mdxera.resetSchemaDriftCache()
      //   console.table(window.__mdxera.snapshotSchemaDrift())
      resetSchemaDriftCache,
      snapshotSchemaDrift,
      // Definitive schema diff against live Supabase. Requires the RPC in
      // supabase/functions/_shared/inspect_columns.sql to be deployed.
      //   console.table(await window.__mdxera.snapshotSchemaAudit())
      //   const full = await window.__mdxera.auditSchemas()
      auditSchemas,
      snapshotSchemaAudit,
    };
  }, []);

  // Listen for the "Sync All" button (or any caller of triggerFullResync).
  // Clears the per-table sync state + meta FOR THE ACTIVE ORG so the next
  // pass re-pulls every row from scratch, then re-arms the foreground modal.
  // Other orgs' progress (if the same install has signed in elsewhere) is
  // intentionally preserved.
  useEffect(() => {
    if (!currentUser) return;
    const onResync = async () => {
      console.info('[SyncBootstrap] Full resync requested for org', currentUser.organization_id);
      try {
        await db.execute(
          `DELETE FROM ${TABLE.INITIAL_SYNC_STATE} WHERE organization_id = ?`,
          [currentUser.organization_id]
        );
        await db.execute(
          `DELETE FROM ${TABLE.SYNC_META} WHERE organization_id = ?`,
          [currentUser.organization_id]
        );
        
        // Wipe all successfully synced local records so InitialSync re-downloads
        // them completely fresh, removing any "ghost" records that were deleted
        // on the server. We safely keep rows with _sync_status = 'pending' or 'failed'
        // so offline work isn't lost.
        for (const tableName of SYNCABLE_TABLES) {
          try {
            await db.execute(
              `DELETE FROM ${tableName} WHERE organization_id = ? AND _sync_status NOT IN ('pending', 'failed')`,
              [currentUser.organization_id]
            );
          } catch (delErr) {
            console.warn(`[SyncBootstrap] Failed to clear table ${tableName}:`, delErr);
          }
        }
      } catch (err) {
        console.warn('[SyncBootstrap] Failed to clear sync state:', err);
      }
      // Also drop everything the client has *learned* about server schema
      // drift. The user's mental model for "Sync All" is "start fresh" —
      // that should include re-discovering which columns the server now
      // accepts, in case they ran a Supabase migration since the last sync.
      // The next push attempt will include every column; PGRST204s will
      // re-populate the cache for whatever is still genuinely missing.
      try {
        resetSchemaDriftCache();
      } catch (err) {
        console.warn('[SyncBootstrap] Failed to reset schema drift cache:', err);
      }
      // Force the boot effect to run again from scratch.
      setPhase('unchecked');
    };
    window.addEventListener(RESYNC_EVENT, onResync);
    return () => window.removeEventListener(RESYNC_EVENT, onResync);
  }, [currentUser]);

  useEffect(() => {
    if (!orgId || !currentUser) {
      setPhase('unchecked');
      SyncEngine.stop();
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const isMainWindow = getCurrentWindow().label === 'main';
        
        if (!isMainWindow) {
            console.info('[SyncBootstrap] Child window detected; skipping sync engines and hydrating only.');
            setPhase('done');
            hydrateMemoryCacheFromSqlite(currentUser.organization_id);
            return;
        }

        console.info('[SyncBootstrap] starting for org', currentUser.organization_id, 'online=', isOnline());

        // Voucher range warmup (non-blocking, network only).
        warmupVoucherRanges(currentUser).catch((err) =>
          console.warn('[SyncBootstrap] voucher warmup failed:', err)
        );

        // Cache brand + user-configured assets for offline use (best-effort).
        if (isOnline()) {
          const userAssets: string[] = [];
          try {
            const profile = currentUser as RegisteredPharmacy & { pharmacy_logo_url?: string; dashboard_logo_url?: string };
            if (profile.pharmacy_logo_url && !profile.pharmacy_logo_url.startsWith('data:')) userAssets.push(profile.pharmacy_logo_url);
            if (profile.dashboard_logo_url && !profile.dashboard_logo_url.startsWith('data:')) userAssets.push(profile.dashboard_logo_url);
          } catch { /* ignore */ }
          warmupAssets([...STATIC_BRAND_ASSETS, ...userAssets]).catch(() => {});
        }

        const fgDone = await isForegroundComplete(currentUser.organization_id);
        console.info('[SyncBootstrap] isForegroundComplete =', fgDone);

        // Auto-reset any 'failed' queue records from previous sessions so they
        // get a fresh retry. Records fail permanently after 3 attempts in SyncQueue,
        // but if the failure was caused by a schema mismatch that is now fixed
        // (e.g. 'material_id' not found), resetting them lets them push cleanly.
        try {
          const failedRows = await db.select<{ n: number }>(
            `SELECT COUNT(*) as n FROM _sync_queue WHERE status = 'failed'`
          );
          const failedCount = failedRows[0]?.n ?? 0;
          if (failedCount > 0) {
            await db.execute(
              `UPDATE _sync_queue SET status = 'pending', attempts = 0, last_error = 'Auto-reset on startup' WHERE status = 'failed'`
            );
            console.info(`[SyncBootstrap] Auto-reset ${failedCount} failed queue record(s) to pending for retry.`);
          }
        } catch (resetErr) {
          console.warn('[SyncBootstrap] Could not auto-reset failed queue items:', resetErr);
        }

        if (fgDone) {
          if (cancelled) return;
          setPhase('done');
          // Hydrate now (no active InitialSync to contend with writes).
          // Fire-and-forget; the HYDRATE_COMPLETE_EVENT will trigger React state refresh.
          hydrateMemoryCacheFromSqlite(currentUser.organization_id);
          // Safe to start the recurring SyncEngine now — no concurrent writer.
          SyncEngine.start(currentUser.organization_id, SUPABASE_URL);
          if (isOnline()) {
            console.info('[SyncBootstrap] foreground already done — kicking off background phase');
            startBackgroundSync(currentUser);
          }
          return;
        }

        if (!isOnline()) {
          if (cancelled) return;
          console.warn('[SyncBootstrap] offline — skipping initial sync; user will see empty data until next online login');
          setPhase('skipped');
          hydrateMemoryCacheFromSqlite(currentUser.organization_id);
          SyncEngine.start(currentUser.organization_id, SUPABASE_URL);
          return;
        }

        if (cancelled) return;
        console.info('[SyncBootstrap] running foreground sync — modal should appear');
        setPhase('running');
        await runForegroundSync(currentUser);
        if (cancelled) return;
        console.info('[SyncBootstrap] foreground sync complete; hydrating memoryCache and starting SyncEngine');
        setPhase('done');
        // SyncEngine MUST start after foreground sync — otherwise its pulls
        // race with InitialSync's writes and SQLite returns "database is locked".
        SyncEngine.start(currentUser.organization_id, SUPABASE_URL);
        hydrateMemoryCacheFromSqlite(currentUser.organization_id);
        startBackgroundSync(currentUser);
      } catch (err) {
        console.error('[SyncBootstrap] Initial sync failed:', err);
        if (!cancelled) setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId, phase]); // Re-run if phase is explicitly reset to 'unchecked' via RESYNC_EVENT

  if (phase === 'running' || phase === 'error') {
    return (
      <InitialSyncModal
        onRetry={() => {
          if (!currentUser) return;
          setPhase('unchecked');
        }}
        onSkip={() => setPhase('skipped')}
      />
    );
  }

  return null;
};

export default SyncBootstrap;
