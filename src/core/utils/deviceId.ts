/**
 * Persistent per-installation device ID.
 * Stored in tauri-plugin-store under config/device.json so it survives
 * across app launches but is unique to each installed copy of the app.
 *
 * Used by:
 *   - Voucher range reservation (so the server knows which device owns a range)
 *   - Future audit log entries (track which device performed each action)
 */

let _cached: string | null = null;

const safeRandomUUID = (): string => {
  if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

async function getStore() {
  const { Store } = await import('@tauri-apps/plugin-store');
  return Store.load('config/device.json');
}

/**
 * Returns a stable device ID, generating one on first call.
 * Works in Tauri (via plugin-store) and falls back to localStorage in browser.
 */
export async function getDeviceId(): Promise<string> {
  if (_cached) return _cached;

  // Try Tauri store first
  try {
    const store = await getStore();
    const existing = await store.get<string>('device_id');
    if (existing) {
      _cached = existing;
      return existing;
    }
    const fresh = safeRandomUUID();
    await store.set('device_id', fresh);
    await store.save();
    _cached = fresh;
    return fresh;
  } catch {
    // Browser/dev fallback
    const lsKey = 'mdxera_device_id';
    let id = localStorage.getItem(lsKey);
    if (!id) {
      id = safeRandomUUID();
      localStorage.setItem(lsKey, id);
    }
    _cached = id;
    return id;
  }
}
