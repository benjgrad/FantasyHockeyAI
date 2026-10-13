/// <reference lib="webworker" />
/**
 * The service worker: receives pushes while the app is closed, keeps the app openable offline,
 * and shows the last-known read views (clearly marked) when the server can't be reached.
 *
 * Caching rules live in pwa/strategy.ts (which request gets which strategy) and
 * pwa/swHandlers.ts (how each strategy works). The short version: navigations and API reads
 * are network-first, so a deploy or a fresh lineup lands the moment the server answers; the
 * cache is only ever a fallback, and the page is told when it is looking at one. Writes,
 * streams, auth and settings are never touched.
 *
 * Built separately as `/sw.js` (see vite.config.ts), with this build's precache manifest
 * injected as `__FHA_PRECACHE__`. The server serves it `no-cache` so an update is always seen.
 */
import {
  CLEAR_API_CACHE_MESSAGE,
  NAVIGATE_MESSAGE,
  SKIP_WAITING_MESSAGE,
  navigateTargetFor,
} from './push/swMessages';
import type { PrecacheManifest } from './pwa/precache';
import { strategyFor } from './pwa/strategy';
import {
  deleteOldCaches,
  handleApi,
  handleNavigation,
  handleStatic,
  precache,
  type CacheNames,
} from './pwa/swHandlers';

declare const self: ServiceWorkerGlobalScope;
/** Injected at build time by the service-worker plugin in vite.config.ts. */
declare const __FHA_PRECACHE__: PrecacheManifest;

const PREFIX = 'fha-';
const NAMES: CacheNames = {
  shell: `${PREFIX}shell-${__FHA_PRECACHE__.version}`,
  api: `${PREFIX}api-${__FHA_PRECACHE__.version}`,
};

// No skipWaiting here: an update waits until the page's "Reload" (SKIP_WAITING_MESSAGE), so a
// running session never has its shell swapped underneath it. The very first install has no
// predecessor and activates at once.
self.addEventListener('install', (event) => {
  event.waitUntil(precache(__FHA_PRECACHE__.urls, NAMES));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only this build's caches survive: an old shell or an old-schema API copy is discarded.
      await deleteOldCaches(PREFIX, NAMES);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const strategy = strategyFor(
    {
      method: request.method,
      url: request.url,
      mode: request.mode,
      accept: request.headers.get('accept'),
    },
    self.location.origin,
  );
  if (strategy === 'navigation') event.respondWith(handleNavigation(request, NAMES));
  else if (strategy === 'api') event.respondWith(handleApi(request, NAMES));
  else if (strategy === 'static') event.respondWith(handleStatic(request, NAMES));
  // 'network': no respondWith — the browser handles it exactly as without a worker.
});

self.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type === SKIP_WAITING_MESSAGE) event.waitUntil(self.skipWaiting());
  else if (type === CLEAR_API_CACHE_MESSAGE) event.waitUntil(caches.delete(NAMES.api));
});

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

self.addEventListener('push', (event) => {
  // A push must always show something: a handler that shows nothing costs the permission.
  let data: PushPayload = { title: 'Hockey GM', body: '', url: '/', tag: 'fha' };
  try {
    if (event.data) data = { ...data, ...(event.data.json() as Partial<PushPayload>) };
  } catch {
    // Not JSON: keep the generic notification.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // Same tag collapses a newer notification onto an older one instead of stacking.
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: navigateTargetFor(data.url) ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target =
    navigateTargetFor((event.notification.data as { url?: unknown } | null)?.url) ?? '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        // Focus first, then route: a message lets the running app navigate without a reload.
        const focused = await client.focus();
        (focused ?? client).postMessage({ type: NAVIGATE_MESSAGE, url: target });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

export {};
