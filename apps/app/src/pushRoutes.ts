import { PushSubscribeRequest, PushUnsubscribeRequest } from '@fha/api';
import { HttpError, readJson, sendJson } from './http.js';
import type { Route } from './router.js';
import type { Services } from './services.js';

/** Web push: the VAPID key, subscribe and unsubscribe this browser, and a test push. */

export function pushRoutes(s: Services): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/push/vapid',
      auth: 'user',
      handle: ({ res }) => {
        // Null when the server has no VAPID keys: the client says push is off (contract).
        sendJson(res, 200, { publicKey: s.push.publicKey ?? null });
        return Promise.resolve();
      },
    },
    {
      method: 'POST',
      path: '/api/push/subscribe',
      auth: 'user',
      handle: async ({ req, res, user }) => {
        const sub = await readJson(req, PushSubscribeRequest);
        if (!sub.endpoint.startsWith('https://')) {
          throw new HttpError(400, 'invalid_request', 'endpoint must be https');
        }
        s.store.pushSubscriptions.upsert({
          endpoint: sub.endpoint,
          userId: user.id,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        });
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/push/unsubscribe',
      auth: 'user',
      handle: async ({ req, res, user }) => {
        const { endpoint } = await readJson(req, PushUnsubscribeRequest);
        // Only the owner's subscription: another user's endpoint is left alone.
        if (s.store.pushSubscriptions.forUser(user.id).some((x) => x.endpoint === endpoint)) {
          s.store.pushSubscriptions.remove(endpoint);
        }
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/push/test',
      auth: 'user',
      handle: async ({ res, user }) => {
        sendJson(res, 200, { sent: await s.push.test(user.id) });
      },
    },
  ];
}
