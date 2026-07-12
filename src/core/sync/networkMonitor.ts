type NetworkListener = (online: boolean) => void;

const listeners = new Set<NetworkListener>();
let _isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

function notify(online: boolean) {
  _isOnline = online;
  listeners.forEach((fn) => fn(online));
}

if (typeof window !== 'undefined') {
  const getEffectiveStatus = (onlineEvent: boolean) => {
    const mode = localStorage.getItem('networkMode') || 'auto';
    if (mode === 'online') return true;
    if (mode === 'offline') return false;
    return onlineEvent;
  };
  window.addEventListener('online', () => notify(getEffectiveStatus(true)));
  window.addEventListener('offline', () => notify(getEffectiveStatus(false)));
}

/** Subscribe to network status changes. Returns an unsubscribe function. */
export function onNetworkChange(fn: NetworkListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isOnline(): boolean {
  return _isOnline;
}

/**
 * Verify actual connectivity by pinging the Supabase REST endpoint.
 * Falls back to navigator.onLine if the request fails to send at all.
 *
 * Sends the anon apikey so Supabase replies 200 instead of 401 — without it,
 * every 30-second sync cycle spams DevTools with a red 401 line that looks
 * alarming but is harmless.
 */
// `||` (not `??`) so an empty-string env var still falls back to the
// hardcoded anon key. Otherwise networkMonitor sends no apikey and Supabase
// returns 401 (which we'd misread as "server unreachable").
const SUPABASE_ANON_KEY =
  ((import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY) ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNibG1ia2dvaWVmcXp5a2prc2dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE2Nzg2ODIsImV4cCI6MjA3NzI1NDY4Mn0.wK5E6TVZCavAqLrbZeyfgdToGyETRnQAbm5PPaAVlFw';

export async function checkConnectivity(supabaseUrl: string): Promise<boolean> {
  const mode = localStorage.getItem('networkMode') || 'auto';
  if (mode === 'offline') return false;
  try {
    const headers: Record<string, string> = {};
    if (SUPABASE_ANON_KEY) {
      headers.apikey = SUPABASE_ANON_KEY;
      headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
    }
    // The bare /rest/v1/ endpoint returns 401 even with a valid apikey.
    // A real table endpoint with limit=0 returns 200 (empty list) and is
    // the cheapest possible call. Using `profiles` because every Supabase
    // project has it.
    const res = await fetch(`${supabaseUrl}/rest/v1/profiles?select=user_id&limit=0`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}
