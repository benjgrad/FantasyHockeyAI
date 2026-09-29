import { z } from 'zod';
import { HttpError, readJson, sendJson } from './http.js';
import { approvePlan, listCards, rejectPlan } from './decisions.js';
import type { Route } from './router.js';
import { namesFor, type Services } from './services.js';
import { teamView } from './team.js';

/** The Team page and the Decisions page (the approval queue plus history). */
const RejectBody = z.object({ reason: z.string().max(500).optional() });

export function teamRoutes(s: Services): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/team',
      auth: 'user',
      handle: async ({ res, user }) => {
        sendJson(res, 200, teamView(await s.league.get(user.id), s.now()));
      },
    },
    {
      method: 'POST',
      path: '/api/team/refresh',
      auth: 'user',
      handle: async ({ res, user }) => {
        sendJson(res, 200, teamView(await s.league.get(user.id, { refresh: true }), s.now()));
      },
    },
    {
      method: 'GET',
      path: '/api/decisions',
      auth: 'user',
      handle: ({ res, url, user }) => {
        const which = url.searchParams.get('status') === 'all' ? 'all' : 'pending';
        sendJson(res, 200, { decisions: listCards(s.store, which, namesFor(s, user.id)) });
        return Promise.resolve();
      },
    },
    {
      method: 'POST',
      path: '/api/decisions/:planId/approve',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const planId = params['planId'] ?? '';
        if (s.store.decisions.get(planId) === undefined) {
          throw new HttpError(404, 'not_found', 'No such plan.');
        }
        // The league must be readable before approving: an approval is never recorded by a
        // request that could not then validate and run the plan.
        const league = await s.league.get(user.id);
        const card = await approvePlan(s.wiring, user.id, league, planId);
        s.log(`decision ${planId} approved by user ${user.id} → ${card.status}`);
        sendJson(res, 200, card);
      },
    },
    {
      method: 'POST',
      path: '/api/decisions/:planId/reject',
      auth: 'user',
      handle: async ({ req, res, params, user }) => {
        const body = await readJson(req, RejectBody);
        const planId = params['planId'] ?? '';
        const card = rejectPlan(s.store, planId, body.reason, namesFor(s, user.id));
        s.log(`decision ${planId} rejected by user ${user.id}`);
        sendJson(res, 200, card);
      },
    },
  ];
}
