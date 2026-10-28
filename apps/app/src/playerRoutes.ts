import { HttpError, sendJson } from './http.js';
import { buildCard, cardContext } from './players.js';
import { compare, resolveCompareKeys } from './playersCompare.js';
import { findOutsidePool } from './playersFind.js';
import { listPlayers, parseListQuery } from './playersList.js';
import { formFlags, playerFormView, seasonForecastView } from './playerForm.js';
import { playersInPlan } from './playersInPlans.js';
import { categoryStrength, weekWeights } from './playersStrength.js';
import type { Route } from './router.js';
import type { Services } from './services.js';
import { ensureValuationDay, scoringCategories } from '@fha/tools';

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
        const { view } = await s.league.forDisplay(user.id);
        const q = parseListQuery(url.searchParams, scoringCategories(view.settings));
        // Today's value row, if the refresh job has not written it yet (D-026). Best effort.
        try {
          ensureValuationDay(view, s.store);
        } catch (err) {
          s.log(`value history not recorded: ${err instanceof Error ? err.message : String(err)}`);
        }
        const list = listPlayers(cardContext(view, s.now(), s.store), q);
        if (list.total === 0) {
          const { found, notes } = await findOutsidePool(s, user.id, view, q);
          list.notes.push(...notes);
          if (found.length > 0) list.found = found;
        }
        // Form only for the rows on screen: each is a few indexed reads.
        const players = list.players.map((r) => ({
          ...r,
          form: formFlags(view, s.store, r.playerKey),
        }));
        sendJson(res, 200, { ...list, players });
      },
    },
    {
      method: 'GET',
      path: '/api/players/:playerKey',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const { view } = await s.league.forDisplay(user.id);
        const p = view.player(params['playerKey'] ?? '');
        if (p === undefined)
          throw new HttpError(404, 'not_found', 'No such player in your league.');
        sendJson(res, 200, buildCard(cardContext(view, s.now(), s.store), p));
      },
    },
    {
      method: 'GET',
      path: '/api/players/:playerKey/form',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const { view } = await s.league.forDisplay(user.id);
        const key = params['playerKey'] ?? '';
        if (view.player(key) === undefined) {
          throw new HttpError(404, 'not_found', 'No such player in your league.');
        }
        sendJson(res, 200, playerFormView(view, s.store, key));
      },
    },
    {
      method: 'GET',
      path: '/api/league/forecast',
      auth: 'user',
      handle: async ({ res, user }) => {
        const { view } = await s.league.forDisplay(user.id);
        sendJson(res, 200, seasonForecastView(view, s.store));
      },
    },
    {
      method: 'GET',
      path: '/api/compare',
      auth: 'user',
      handle: async ({ res, url, user }) => {
        const { view } = await s.league.forDisplay(user.id);
        const keys = resolveCompareKeys(view, url.searchParams.get('keys'));
        const base = url.searchParams.get('base') ?? undefined;
        sendJson(res, 200, compare(cardContext(view, s.now(), s.store), keys, base));
      },
    },
    {
      method: 'GET',
      path: '/api/decisions/:planId/players',
      auth: 'user',
      handle: async ({ res, params, user }) => {
        const d = s.store.decisions.get(params['planId'] ?? '');
        if (d === undefined) throw new HttpError(404, 'not_found', 'No such decision.');
        const { view } = await s.league.forDisplay(user.id);
        sendJson(res, 200, { players: playersInPlan(view, d.plan) });
      },
    },
    {
      method: 'GET',
      path: '/api/team/categories',
      auth: 'user',
      handle: async ({ res, user }) => {
        const { view } = await s.league.forDisplay(user.id);
        const strength = categoryStrength(view, s.store);
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
