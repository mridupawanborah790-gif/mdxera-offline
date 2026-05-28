import { useEffect, useState } from 'react';
import { resolveAsset, cacheRemoteAsset } from '@core/utils/assetCache';
import { isOnline } from '@core/sync/networkMonitor';

/**
 * Returns a stable src string for an image URL that may be remote.
 * - Immediately returns the cached base64 copy if one exists (works offline).
 * - When online, fetches + caches in the background and upgrades src once done.
 * - If `url` is already a data: or blob: URL it is returned as-is.
 */
export function useOfflineAsset(url: string | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(() => resolveAsset(url));

  useEffect(() => {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
      setSrc(url);
      return;
    }

    // Serve cached copy immediately so there's no flash while fetching
    setSrc(resolveAsset(url));

    if (!isOnline()) return;

    let cancelled = false;
    cacheRemoteAsset(url)
      .then((base64) => { if (!cancelled) setSrc(base64); })
      .catch(() => { /* best-effort — keep showing whatever we had */ });

    return () => { cancelled = true; };
  }, [url]);

  return src;
}
