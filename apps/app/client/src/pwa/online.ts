import { useSyncExternalStore } from 'react';
import { RequestError } from '../api/client';

/**
 * Connectivity as the browser reports it. `navigator.onLine === false` is reliable (no
 * network at all); `true` only means "some network", so a down server still shows up as a
 * request error and, for read views, as the stale-data banner.
 */
function subscribe(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}

export const OFFLINE_MUTATION_MESSAGE =
  'You’re offline — nothing was sent. Try again when you’re back online.';

/**
 * The error a mutation fails with when started offline, or null to let it run. Failing at
 * once is the point: a paused mutation looks like a hung button, and a write queued for later
 * could land after the moment it was meant for (a lineup for a game that has started).
 */
export function offlineMutationError(online: boolean): RequestError | null {
  return online ? null : new RequestError(0, 'offline', OFFLINE_MUTATION_MESSAGE);
}
