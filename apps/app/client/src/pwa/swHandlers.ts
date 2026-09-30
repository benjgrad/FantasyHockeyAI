/**
 * The service worker's fetch strategies (the *which* is decided by strategy.ts; this is the
 * *how*). Runs only inside the worker; kept apart from sw.ts so each file has one job.
 */
import { markOffline, stampCachedAt } from './offlineData';
import { SHELL_URL } from './precache';

/** How long a navigation waits for the network before opening the cached shell. */
export const NAVIGATION_TIMEOUT_MS = 3_000;

/** A proxy answered but the app did not (restart, crash): treat as offline. */
const GATEWAY = new Set([502, 503, 504]);

export interface CacheNames {
  readonly shell: string;
  readonly api: string;
}

/** Resolves with `promise`, or rejects after `ms`. The loser's rejection is swallowed. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Network-first; the precached index.html (SPA shell) when the network fails or stalls. */
export async function handleNavigation(request: Request, names: CacheNames): Promise<Response> {
  const network = fetch(request);
  network.catch(() => undefined);
  const shell = await caches.match(SHELL_URL, { cacheName: names.shell });
  if (!shell) return network;
  try {
    const response = await withTimeout(network, NAVIGATION_TIMEOUT_MS);
    return GATEWAY.has(response.status) ? shell : response;
  } catch {
    return shell;
  }
}

async function cachedApi(request: Request, names: CacheNames): Promise<Response | undefined> {
  const cached = await caches.match(request, { cacheName: names.api });
  return cached ? markOffline(cached) : undefined;
}

/**
 * Network-first for a read view. A good response is stored (stamped with its fetch time); a
 * failed or gateway-error fetch is answered with the stored copy, marked offline. A 401 means
 * the session is gone, so whatever was cached for it is dropped.
 */
export async function handleApi(request: Request, names: CacheNames): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(request);
  } catch (error) {
    const fallback = await cachedApi(request, names);
    if (fallback) return fallback;
    throw error;
  }
  if (GATEWAY.has(response.status)) return (await cachedApi(request, names)) ?? response;
  if (response.status === 401) {
    await caches.delete(names.api);
  } else if (response.ok) {
    try {
      const cache = await caches.open(names.api);
      await cache.put(request, stampCachedAt(response.clone(), new Date()));
    } catch {
      // Quota or storage failure: the fresh response still goes to the page, just uncached.
    }
  }
  return response;
}

/**
 * Cache-first for the shell's files. A miss (a file added after install) is fetched and, if it
 * is a hashed asset, kept: its URL is its revision, so the copy can never go stale.
 */
export async function handleStatic(request: Request, names: CacheNames): Promise<Response> {
  const cached = await caches.match(request, { cacheName: names.shell });
  if (cached) return cached;
  const response = await fetch(request);
  const path = new URL(request.url).pathname;
  if (response.ok && response.type === 'basic' && path.startsWith('/assets/')) {
    const cache = await caches.open(names.shell);
    await cache.put(request, response.clone());
  }
  return response;
}

/** Precaches this build's files. `reload` skips the HTTP cache so no stale copy is baked in. */
export async function precache(urls: readonly string[], names: CacheNames): Promise<void> {
  const cache = await caches.open(names.shell);
  await cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' })));
}

/** Deletes every cache of ours except the current generation's. */
export async function deleteOldCaches(prefix: string, names: CacheNames): Promise<void> {
  const keep = new Set([names.shell, names.api]);
  const all = await caches.keys();
  await Promise.all(
    all.filter((n) => n.startsWith(prefix) && !keep.has(n)).map((n) => caches.delete(n)),
  );
}
