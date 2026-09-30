import { useCallback, useEffect, useState } from 'react';
import { SKIP_WAITING_MESSAGE } from '../push/swMessages';

/**
 * The update flow. A new worker installs (precaching the new build) and then *waits*: taking
 * over a running page would swap the shell under it mid-session. The page notices the waiting
 * worker and offers "Reload"; tapping it tells the worker to skip waiting, and the page
 * reloads once the new worker controls it (`controllerchange`).
 *
 * An installed app on a phone is rarely closed, so the page also asks for an update check when
 * it comes back to the foreground, at most every CHECK_INTERVAL_MS.
 */
const CHECK_INTERVAL_MS = 30 * 60_000;

export interface UpdateState {
  readonly available: boolean;
  readonly apply: () => void;
}

/** A waiting worker is an *update* only when another worker already controls the page. */
function waitingUpdate(registration: ServiceWorkerRegistration): ServiceWorker | null {
  return registration.waiting && navigator.serviceWorker.controller ? registration.waiting : null;
}

function watch(
  registration: ServiceWorkerRegistration,
  onWaiting: (worker: ServiceWorker) => void,
): () => void {
  const found = () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      const waiting = waitingUpdate(registration);
      if (installing.state === 'installed' && waiting) onWaiting(waiting);
    });
  };
  registration.addEventListener('updatefound', found);
  let lastCheck = Date.now();
  const check = () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < CHECK_INTERVAL_MS) {
      return;
    }
    lastCheck = Date.now();
    void registration.update().catch(() => undefined);
  };
  document.addEventListener('visibilitychange', check);
  const timer = window.setInterval(check, CHECK_INTERVAL_MS);
  return () => {
    registration.removeEventListener('updatefound', found);
    document.removeEventListener('visibilitychange', check);
    window.clearInterval(timer);
  };
}

export function useServiceWorkerUpdate(): UpdateState {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void navigator.serviceWorker.ready.then((registration) => {
      if (cancelled) return;
      const already = waitingUpdate(registration);
      if (already) setWaiting(already);
      stop = watch(registration, setWaiting);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const apply = useCallback(() => {
    if (!waiting) return;
    // Reload only for the switch the user asked for; the very first install also fires
    // `controllerchange` (clients.claim) and must not reload the page.
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    });
    waiting.postMessage({ type: SKIP_WAITING_MESSAGE });
  }, [waiting]);

  return { available: waiting !== null, apply };
}
