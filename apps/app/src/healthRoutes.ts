import { sendJson } from './http.js';
import type { Route } from './router.js';
import type { Services } from './services.js';

/**
 * The deploy's health and smoke check (D-043): `deploy/ci-deploy.sh` waits for this to name the
 * commit it just released. Public, so it says only that the process is up and which commit it
 * runs: no daemon, Yahoo or user state.
 */
export function healthRoutes(s: Services): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/health',
      auth: 'public',
      handle: ({ res }) => {
        sendJson(res, 200, { ok: true, sha: s.config.gitSha });
        return Promise.resolve();
      },
    },
  ];
}
