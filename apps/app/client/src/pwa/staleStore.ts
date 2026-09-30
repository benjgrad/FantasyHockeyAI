import { staleInfo, type HeaderReader } from './offlineData';

/**
 * Which API responses the page is currently showing from the worker's offline cache, per
 * request path. A fresh response for a path clears that path, so the "offline" banner goes
 * away by itself once TanStack Query refetches on reconnect.
 *
 * Module state rather than React state: `observeResponse` is called from the fetch layer
 * (api/client.ts), outside any component; components read it with useSyncExternalStore.
 */
const stale = new Map<string, Date>();
const listeners = new Set<() => void>();
let snapshot: Date | null = null;

function publish(): void {
  let oldest: Date | null = null;
  for (const at of stale.values()) if (oldest === null || at < oldest) oldest = at;
  if (oldest?.getTime() === snapshot?.getTime()) return;
  snapshot = oldest;
  for (const listener of listeners) listener();
}

/** Records whether the response for `path` came from the offline cache. */
export function observeResponse(path: string, headers: HeaderReader): void {
  const info = staleInfo(headers);
  if (info) stale.set(path, info.cachedAt);
  else if (!stale.delete(path)) return;
  publish();
}

export function subscribeStale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The oldest cached-at time among the responses currently on screen, or null when all fresh. */
export function oldestStale(): Date | null {
  return snapshot;
}

/** Forget everything (sign-out). */
export function resetStale(): void {
  stale.clear();
  publish();
}
