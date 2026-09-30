import { CLEAR_API_CACHE_MESSAGE } from '../push/swMessages';
import { resetStale } from './staleStore';

/** The prefix of the worker's API cache names (see sw.ts). */
export const API_CACHE_PREFIX = 'fha-api-';

/**
 * Drops every cached API response, so a signed-out (possibly shared) device keeps no team data.
 * Deletes from the page directly (awaitable before the sign-out redirect) and also tells the
 * worker, which owns the cache and would otherwise only learn at its next 401.
 */
export async function clearApiCache(): Promise<void> {
  resetStale();
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: CLEAR_API_CACHE_MESSAGE });
    if (typeof caches === 'undefined') return;
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith(API_CACHE_PREFIX)).map((n) => caches.delete(n)),
    );
  } catch {
    // Cache storage unavailable (private mode): there is nothing cached to clear.
  }
}
