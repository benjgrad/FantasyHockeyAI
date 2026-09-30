import { HttpError, sendJson } from './http.js';
import { buildCard, cardContext } from './players.js';
import { compare, resolveCompareKeys } from './playersCompare.js';
import { listPlayers, parseListQuery } from './playersList.js';
import { playersInPlan } from './playersInPlans.js';
import { categoryStrength, weekWeights } from './playersStrength.js';
import type { Route } from './router.js';
import type { Services } from './services.js';
import { scoringCategories } from '@fha/tools';

/**
 * Player cards, comparisons, the free-agent browser and category strength.
 *
 * Read-only: nothing here writes to Yahoo or the store. The league (and so the team whose needs
 * `fit` measures) comes from the user's stored connection, never from the request (P8), and every
 * playerKey in a request is resolved against that league's index before use (P3).
 */
export function playerRoutes(s: Services): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/players',
      auth: 'user',
      handle: async ({ res, url, user }) => {
        const { view } = await s.league.get(user.id);
        const q = parseListQuery(url.searchParams, scoringCategories(view.settings));
        sendJson(res, 200, listPlayers(cardContext(view, s.now()), q));
      },
    },
    {
      method: 'GET',
      path: '/api/players/:playerKey',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const { view } = await s.league.get(user.id);
        const p = view.player(params['playerKey'] ?? '');
        if (p === undefined)
          throw new HttpError(404, 'not_found', 'No such player in your league.');
        sendJson(res, 200, buildCard(cardContext(view, s.now()), p));
      },
    },
    {
      method: 'GET',
      path: '/api/compare',
      auth: 'user',
      handle: async ({ res, url, user }) => {
        const { view } = await s.league.get(user.id);
        const keys = resolveCompareKeys(view, url.searchParams.get('keys'));
        const base = url.searchParams.get('base') ?? undefined;
        sendJson(res, 200, compare(cardContext(view, s.now()), keys, base));
      },
    },
    {
      method: 'GET',
      path: '/api/decisions/:planId/players',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const d = s.store.decisions.get(params['planId'] ?? '');
        if (d === undefined) throw new HttpError(404, 'not_found', 'No such decision.');
        const { view } = await s.league.get(user.id);
        sendJson(res, 200, { players: playersInPlan(view, d.plan) });
      },
    },
    {
      method: 'GET',
      path: '/api/team/categories',
      auth: 'user',
      handle: async ({ res, user }) => {
        const { view } = await s.league.get(user.id);
        const strength = categoryStrength(view);
        const week = weekWeights(view, s.store);
        sendJson(res, 200, {
          asOf: view.snap.recordedAt,
          week: view.snap.week,
          categories: strength.categories,
          weights: strength.weights,
          targets: strength.targets,
          weekWeights: week.weights,
          weekWeightsSource: week.source,
        });
      },
    },
  ];
}
