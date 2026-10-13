import { DismissDecisionRequest, ExecuteDecisionRequest } from '@fha/api';
import { z } from 'zod';
import { confirmDone } from './confirmDone.js';
import { cardFor, listCards } from './decisionCard.js';
import { approvePlan, dismissPlan, executePlan, rejectPlan } from './decisions.js';
import { HttpError, readJson, sendJson } from './http.js';
import type { Route } from './router.js';
import { cardContext, type Services } from './services.js';
import { teamView } from './team.js';

/**
 * The Team page and the Decisions page (the approval queue plus history), and what Ben can do
 * with a card: execute it, dismiss it, or tell us he did it in Yahoo (D-015).
 */
const RejectBody = z.object({ reason: z.string().max(500).optional() });

export function teamRoutes(s: Services): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/team',
      auth: 'user',
      handle: async ({ res, user }) => {
        sendJson(res, 200, teamView(await s.league.forDisplay(user.id), s.now(), s.store));
      },
    },
    {
      method: 'GET',
      path: '/api/league/status',
      auth: 'user',
      handle: ({ res, user }) => {
        // A write made elsewhere (a daemon job, an approval timing out) is picked up here: the
        // pages poll this, and a rebuild started now lands while they watch.
        s.league.refreshIfChanged(user.id);
        sendJson(res, 200, s.league.status(user.id));
        return Promise.resolve();
      },
    },
    {
      method: 'POST',
      path: '/api/team/refresh',
      auth: 'user',
      handle: async ({ res, user }) => {
        sendJson(
          res,
          200,
          teamView(await s.league.get(user.id, { refresh: true }), s.now(), s.store),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/decisions',
      auth: 'user',
      handle: ({ res, url, user }) => {
        const which = url.searchParams.get('status') === 'all' ? 'all' : 'pending';
        sendJson(res, 200, { decisions: listCards(s.store, which, cardContext(s, user.id)) });
        return Promise.resolve();
      },
    },
    {
      method: 'GET',
      path: '/api/decisions/:planId',
      auth: 'user',
      handle: ({ res, params, user }) => {
        // One card by id, for a push's deep link: the list is capped, so searching it misses
        // older decisions.
        const card = cardFor(s.store, params['planId'] ?? '', cardContext(s, user.id));
        if (card === undefined) throw new HttpError(404, 'not_found', 'No such decision.');
        sendJson(res, 200, card);
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
        const card = await approvePlan(s.wiring, user.id, league, planId, cardContext(s, user.id));
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
        const card = rejectPlan(s.store, planId, body.reason, cardContext(s, user.id));
        s.log(`decision ${planId} rejected by user ${user.id}`);
        sendJson(res, 200, card);
      },
    },
    ...actionRoutes(s),
  ];
}

function actionRoutes(s: Services): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/decisions/:planId/execute',
      auth: 'user',
      handle: async ({ req, res, params, user }) => {
        await readJson(req, ExecuteDecisionRequest);
        const planId = params['planId'] ?? '';
        if (s.store.decisions.get(planId) === undefined) {
          throw new HttpError(404, 'not_found', 'No such plan.');
        }
        // Fresh from Yahoo: the plan is re-validated against it before any write (a free agent
        // taken since the proposal makes it invalid, not a failed POST).
        const league = await s.league.get(user.id, { refresh: true });
        const result = await executePlan(
          s.wiring,
          user.id,
          league,
          planId,
          cardContext(s, user.id),
        );
        // The roster may have changed: rebuild from Yahoo now, so the pages' status poll sees it
        // refreshing and refetches when it lands. (The pipeline has also marked it stale.)
        s.league.invalidate(user.id);
        s.league.refreshIfChanged(user.id);
        s.log(`decision ${planId} executed by user ${user.id} → ${result.outcome}`);
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      path: '/api/decisions/:planId/dismiss',
      auth: 'user',
      handle: async ({ req, res, params, user }) => {
        const body = await readJson(req, DismissDecisionRequest);
        const planId = params['planId'] ?? '';
        const result = dismissPlan(s.store, planId, body.reason, cardContext(s, user.id));
        s.log(`decision ${planId} dismissed by user ${user.id}`);
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      path: '/api/decisions/:planId/done',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const planId = params['planId'] ?? '';
        const result = await confirmDone(s, user.id, planId, cardContext(s, user.id));
        s.log(`decision ${planId} marked done by user ${user.id} → ${result.outcome}`);
        sendJson(res, 200, result);
      },
    },
  ];
}
