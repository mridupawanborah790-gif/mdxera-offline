/**
 * Hybrid (online + offline) authentication orchestrator.
 *
 * Decision flow for login:
 *   1. If `navigator.onLine === false` → go straight to offline path (bcrypt against SQLite cache).
 *   2. If online, try Supabase first.
 *      - On success → cache credentials locally for future offline use.
 *      - On AUTH error (wrong password, user not found) → re-throw, do NOT try offline.
 *      - On NETWORK error (fetch failed, timeout) → fall through to offline path.
 *
 * Signup, password reset, OTP verification, and password update all require
 * Supabase and throw a clear "offline" error when the network is unavailable.
 */
import { isOnline } from '@core/sync/networkMonitor';
import { supabase } from '@core/db/supabaseClient';
import {
  supabaseLogin,
  supabaseLogout,
  supabaseRefreshSession,
  supabaseRestoreSession,
  type SupabaseSession,
} from './supabaseAuth';
import {
  cacheOfflineCredentials,
  verifyOfflineCredentials,
  createLocalSession,
  verifyLocalSession,
  refreshCachedUserData,
  type LocalSession,
} from './offlineAuth';
import { syncOrgRoster, checkEmailKnown } from './rosterSync';
import type { RegisteredPharmacy } from '@core/types';

// ── Network-error classification ───────────────────────────────────────────

/**
 * Distinguish "user can't reach the server" from "user provided wrong credentials".
 * Used by login() to decide whether to fall through to offline verification.
 */
function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; code?: string; status?: number };
  const msg = (e.message ?? '').toLowerCase();
  if (
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('load failed')
  ) return true;
  if (e.name === 'AuthRetryableFetchError') return true;
  if (e.code && ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_NETWORK'].includes(e.code)) return true;
  if (e.status === 0) return true;
  return false;
}

// ── Persisted session store ────────────────────────────────────────────────
//
// Sessions are mirrored to TWO backends so they survive app close/reload in
// both the Tauri desktop build and the plain-browser build:
//
//   1. Tauri plugin-store (`auth/session.json`) — the original primary; survives
//      across reinstalls in the OS data dir.
//   2. localStorage         (`mdxera.auth.*`)    — the fallback; the only thing
//      available when running in a browser (no Tauri runtime). Without it,
//      `persistSession` was a no-op in browsers and the user was thrown back
//      to the login screen on every reload.
//
// Writes go to both; reads prefer Tauri's store and fall back to localStorage
// so the desktop flow is unchanged. Both are cleared on explicit logout.

async function getStore() {
  const { Store } = await import('@tauri-apps/plugin-store');
  // autoSave defaults to true in plugin-store v2; explicit option not accepted
  return Store.load('auth/session.json');
}

const LS_KEYS = {
  supabaseSession: 'mdxera.auth.supabaseSession',
  localSession:    'mdxera.auth.localSession',
  user:            'mdxera.auth.user',
} as const;

function lsAvailable(): boolean {
  try { return typeof window !== 'undefined' && !!window.localStorage; }
  catch { return false; }
}

function lsWrite(key: string, value: unknown | null): void {
  if (!lsAvailable()) return;
  try {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  } catch { /* quota / private-mode — non-fatal */ }
}

function lsRead<T>(key: string): T | null {
  if (!lsAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch { return null; }
}

async function persistSession(data: {
  supabaseSession?: SupabaseSession | null;
  localSession?: LocalSession | null;
  user?: RegisteredPharmacy | null;
}): Promise<void> {
  // Always mirror to localStorage first — it's synchronous and never throws.
  if (data.supabaseSession !== undefined) lsWrite(LS_KEYS.supabaseSession, data.supabaseSession);
  if (data.localSession !== undefined)    lsWrite(LS_KEYS.localSession,    data.localSession);
  if (data.user !== undefined)            lsWrite(LS_KEYS.user,            data.user);

  // Then write to the Tauri store if we're running inside Tauri.
  try {
    const store = await getStore();
    if (data.supabaseSession !== undefined) await store.set('supabaseSession', data.supabaseSession);
    if (data.localSession !== undefined) await store.set('localSession', data.localSession);
    if (data.user !== undefined) await store.set('user', data.user);
  } catch { /* not running in Tauri context — localStorage already has it */ }
}

async function loadPersistedSession(): Promise<{
  supabaseSession: SupabaseSession | null;
  localSession: LocalSession | null;
  user: RegisteredPharmacy | null;
}> {
  // Prefer the Tauri store (it persists across browser-data wipes in the
  // desktop build), fall back to localStorage if it isn't available or has
  // no entry yet.
  let supabaseSession: SupabaseSession | null = null;
  let localSession: LocalSession | null = null;
  let user: RegisteredPharmacy | null = null;
  try {
    const store = await getStore();
    supabaseSession = (await store.get<SupabaseSession>('supabaseSession')) ?? null;
    localSession    = (await store.get<LocalSession>('localSession'))    ?? null;
    user            = (await store.get<RegisteredPharmacy>('user'))      ?? null;
  } catch { /* Tauri not available — fall through to localStorage */ }

  if (!supabaseSession) supabaseSession = lsRead<SupabaseSession>(LS_KEYS.supabaseSession);
  if (!localSession)    localSession    = lsRead<LocalSession>(LS_KEYS.localSession);
  if (!user)            user            = lsRead<RegisteredPharmacy>(LS_KEYS.user);

  return { supabaseSession, localSession, user };
}

async function clearPersistedSession(): Promise<void> {
  // Clear both stores so an explicit logout truly logs the user out.
  lsWrite(LS_KEYS.supabaseSession, null);
  lsWrite(LS_KEYS.localSession,    null);
  lsWrite(LS_KEYS.user,            null);
  try {
    const store = await getStore();
    await store.set('supabaseSession', null);
    await store.set('localSession', null);
    await store.set('user', null);
  } catch { /* ignore */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface AuthResult {
  user: RegisteredPharmacy;
  isOffline: boolean;
}

/**
 * Online-first login with offline fallback.
 * Throws auth errors (wrong password) but falls back to offline on network errors.
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  if (isOnline()) {
    try {
      const { user, session } = await supabaseLogin(email, password);
      await cacheOfflineCredentials(user, password);
      const localSession = await createLocalSession(user.id, user.email);
      await persistSession({ supabaseSession: session, localSession, user });

      // Pre-fetch voucher ranges so this device has numbers available offline.
      // Non-blocking: login should not stall on this.
      import('@core/voucher/voucherService')
        .then(({ warmupVoucherRanges }) => warmupVoucherRanges(user))
        .catch((err) => console.warn('[auth] voucher warmup failed:', err));

      // Sync the org's team_members so other accounts on this device get a
      // clear "needs first online login" message instead of "wrong password".
      syncOrgRoster(user).catch((err) =>
        console.warn('[auth] roster sync failed:', err)
      );

      return { user, isOffline: false };
    } catch (err) {
      if (!isNetworkError(err)) {
        // Real auth error (wrong password, user not found, account disabled) → propagate
        throw err;
      }
      // Network error → silently fall through to offline path
      console.warn('[auth] Online login failed with network error, trying offline:', err);
    }
  }

  // Offline path: verify bcrypt hash against local SQLite cache
  const result = await verifyOfflineCredentials(email, password);
  if (!result) {
    // Distinguish "account doesn't exist on this device" from "wrong password"
    const known = await checkEmailKnown(email);
    if (known === 'roster') {
      throw new Error(
        'This account exists for your organization, but has never logged in on this device. ' +
        'Please connect to the internet to complete the first-time setup, then it will work offline.'
      );
    }
    if (known === 'unknown') {
      throw new Error(
        isOnline()
          ? 'No account found for this email on this device. If this is a new account, please connect to the internet to log in first.'
          : 'No account found for this email on this device. Connect to the internet to log in for the first time.'
      );
    }
    // 'cached' → email is known but password didn't match
    throw new Error('Incorrect password.');
  }

  const localSession = await createLocalSession(result.user.id, result.user.email);
  await persistSession({ localSession, supabaseSession: null, user: result.user });
  return { user: result.user, isOffline: true };
}

/**
 * Signup requires Supabase — throws cleanly when offline.
 */
export async function signup(
  email: string,
  password: string,
  fullName: string,
  pharmacyName: string
): Promise<RegisteredPharmacy> {
  if (!isOnline()) {
    throw new Error('Internet connection required to create a new account.');
  }

  const orgId = crypto.randomUUID();
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        pharmacy_name: pharmacyName,
        role: 'owner',
        organization_id: orgId,
      },
    },
  });
  if (authError || !authData.user) {
    throw new Error(authError?.message ?? 'Signup failed');
  }

  // Insert profile row (handle_new_user trigger may do this, but we ensure it)
  const profileRow = {
    user_id: authData.user.id,
    organization_id: orgId,
    email,
    full_name: fullName,
    pharmacy_name: pharmacyName,
    role: 'owner',
    is_active: true,
  };
  await supabase.from('profiles').upsert(profileRow);

  const user: RegisteredPharmacy = {
    id: authData.user.id,
    user_id: authData.user.id,
    organization_id: orgId,
    email,
    full_name: fullName,
    pharmacy_name: pharmacyName,
    manager_name: '',
    address: '',
    mobile: '',
    role: 'owner',
    is_active: true,
  } as RegisteredPharmacy;

  // Cache for offline use on next login
  await cacheOfflineCredentials(user, password);
  return user;
}

export async function logout(): Promise<void> {
  if (isOnline()) {
    try { await supabaseLogout(); } catch { /* ignore */ }
  }
  await clearPersistedSession();
}

/** Online-only: trigger Supabase password-reset email. */
export async function requestPasswordReset(email: string): Promise<void> {
  if (!isOnline()) {
    throw new Error('Internet connection required to request a password reset.');
  }
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/`,
  });
  if (error) throw error;
}

/** Online-only: verify a recovery token (OTP or link hash). */
export async function verifyRecoveryToken(email: string, token: string): Promise<void> {
  if (!isOnline()) {
    throw new Error('Internet connection required to verify recovery token.');
  }
  const cleanToken = token.trim();
  const isOtp = /^\d{6}$/.test(cleanToken);
  if (isOtp) {
    const { error } = await supabase.auth.verifyOtp({ email, token: cleanToken, type: 'recovery' });
    if (error) throw error;
  } else {
    const { error } = await supabase.auth.verifyOtp({ token_hash: cleanToken, type: 'recovery' });
    if (error) throw error;
  }
}

/**
 * Online-only: update the user's password.
 * Also refreshes the local bcrypt cache so the new password works offline.
 */
export async function updatePassword(newPassword: string): Promise<void> {
  if (!isOnline()) {
    throw new Error('Internet connection required to change password.');
  }
  const { data: updated, error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;

  // Refresh the locally cached bcrypt hash with the new password
  const persisted = await loadPersistedSession();
  if (persisted.user && updated.user) {
    await cacheOfflineCredentials(persisted.user, newPassword);
  }
}

/**
 * Try to restore the previous session on app startup.
 * Returns the user if a valid session exists, or null if login is required.
 */
export async function restoreSession(): Promise<RegisteredPharmacy | null> {
  const { supabaseSession, localSession, user } = await loadPersistedSession();
  if (!user) return null;

  // Try to silently refresh the Supabase token if online
  if (isOnline()) {
    try {
      const refreshed = await supabaseRefreshSession();
      if (refreshed) {
        await persistSession({ supabaseSession: refreshed });
        await refreshCachedUserData(user.id, user);

        // Refresh the org roster on every successful online startup (non-blocking)
        syncOrgRoster(user).catch((err) =>
          console.warn('[auth] roster sync on restore failed:', err)
        );

        return user;
      }
      // Refresh returned null but didn't throw — fall through to local check
    } catch (err) {
      // Don't clear the persisted session on a non-network failure: a flaky
      // 4xx, a temporarily revoked refresh token, or a brief auth outage will
      // ask the user to log in again even though their LOCAL session token
      // (HMAC-signed, 100-year TTL) is still perfectly valid. Fall through to
      // the local check instead — if the local token validates we trust it,
      // and the next online startup will refresh the Supabase side cleanly.
      if (!isNetworkError(err)) {
        console.warn('[auth] Supabase refresh failed during restore — falling back to local session:', err);
      }
      // else: network error — keep going to local session check
    }
  }

  // Validate local session token (signed with device-specific HMAC secret)
  if (localSession && (await verifyLocalSession(localSession))) {
    return user;
  }

  // Fallback: trust a non-expired Supabase session blob even if refresh failed
  if (supabaseSession && supabaseSession.expiresAt * 1000 > Date.now()) {
    return user;
  }

  // No usable session anywhere — but DON'T clear here. Clearing was a holdover
  // from when this branch implied the server had revoked the session; with the
  // localStorage fallback we now hit this branch in benign cases too (e.g.
  // first-ever boot before any login). Leaving the entries alone is harmless
  // because they're nulls anyway, and an explicit logout already clears them.
  return null;
}

/**
 * Called when the app comes back online after being offline.
 * Silently upgrades a local session to a full Supabase session if possible.
 * Requires the user's password (typically prompted by the UI).
 */
export async function tryUpgradeToOnlineSession(
  email: string,
  password: string
): Promise<boolean> {
  if (!isOnline()) return false;
  try {
    const { user, session } = await supabaseLogin(email, password);
    await cacheOfflineCredentials(user, password);
    await persistSession({ supabaseSession: session, user });
    return true;
  } catch {
    return false;
  }
}

// Re-export for convenience
export { supabaseRestoreSession };
