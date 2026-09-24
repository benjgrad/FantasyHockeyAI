// Service worker: exists to receive push while the page is closed, and to make the app
// installable. It deliberately does not cache API responses — a stale draft board is worse
// than no board.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'FHA Draft', body: 'You are on the clock.', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* keep the defaults rather than dropping the notification */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: 'fha-pick',
      renotify: true,
      requireInteraction: true,
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(url);
    }),
  );
});
