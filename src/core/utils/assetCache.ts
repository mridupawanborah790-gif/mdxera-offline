/**
 * Offline asset cache — fetches remote image URLs, converts them to base64
 * data URLs, and stores them in localStorage. When the app is offline any
 * previously-cached asset is served from the local copy transparently.
 *
 * Keys are a short hash of the URL so the entry survives URL changes
 * without leaving orphaned entries.
 */

const PREFIX = 'mdxera_asset_';

function urlKey(url: string): string {
  // Simple deterministic key: prefix + last 80 chars of btoa
  return PREFIX + btoa(encodeURIComponent(url)).replace(/[^a-zA-Z0-9]/g, '').slice(-60);
}

/** Return the cached base64 data URL for a remote URL, or null if not cached. */
export function getCachedAsset(url: string): string | null {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;
  try {
    return localStorage.getItem(urlKey(url));
  } catch {
    return null;
  }
}

/**
 * If a cached copy exists return it, otherwise return the original URL.
 * Safe to call synchronously (no await needed) from render code.
 */
export function resolveAsset(url: string | undefined): string | undefined {
  if (!url) return url;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  return getCachedAsset(url) ?? url;
}

/**
 * Fetch a remote URL, convert to base64, persist in localStorage, and
 * return the base64 data URL. Resolves immediately if already cached.
 * Throws if the fetch fails (caller should swallow — this is best-effort).
 */
export async function cacheRemoteAsset(url: string): Promise<string> {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;

  const cached = getCachedAsset(url);
  if (cached) return cached;

  const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!response.ok) throw new Error(`Asset fetch failed: ${response.status} ${url}`);

  const blob = await response.blob();

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      try {
        localStorage.setItem(urlKey(url), base64);
      } catch {
        // localStorage quota exceeded — skip caching, still return the data
      }
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Cache a list of URLs in parallel (best-effort — individual failures are
 * swallowed so one broken URL doesn't abort the rest).
 */
export async function warmupAssets(urls: string[]): Promise<void> {
  await Promise.allSettled(
    urls
      .filter(u => u && !u.startsWith('data:') && !u.startsWith('blob:'))
      .map(cacheRemoteAsset)
  );
}
