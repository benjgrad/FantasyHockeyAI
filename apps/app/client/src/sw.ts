/// <reference lib="webworker" />
/**
 * The service worker: receives pushes while the app is closed, and makes the app installable.
 * It caches nothing — a stale lineup or approval queue is worse than none.
 *
 * Built separately as `/sw.js` (see vite.config.ts); the server must serve it with
 * `Cache-Control: no-cache` so a fix reaches installed apps.
 */
import { NAVIGATE_MESSAGE, navigateTargetFor } from './push/swMessages';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

self.addEventListener('push', (event) => {
  // A push must always show something: a handler that shows nothing costs the permission.
  let data: PushPayload = { title: 'FantasyHockeyAI', body: '', url: '/', tag: 'fha' };
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
