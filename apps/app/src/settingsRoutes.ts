import { z } from 'zod';
import {
  NotificationPrefs as PrefsContract,
  PermissionsUpdate,
  YahooConnectRequest,
  YahooSelectTeamRequest,
} from '@fha/api';
import type { Player } from '@fha/core';
import { matchPlayer, normalizeName, type Candidate } from '@fha/model';
import type { NotificationPrefs } from '@fha/store';
import { HttpError, readJson, sendJson } from './http.js';
import { permissionsView, updatePermissions } from './permissions.js';
import type { Route } from './router.js';
import { meView, type Services } from './services.js';
import { connectYahoo, selectYahooTeam } from './yahoo.js';

/**
 * Settings: the Yahoo connection, permissions (with a safe player search for the locked and
 * ask lists), and notification preferences.
 */
export function settingsRoutes(s: Services): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/settings/yahoo',
      auth: 'user',
      handle: async ({ req, res, user }) => {
        // The body holds the cookies: parsed here, never logged, never echoed back.
        const body = await readJson(req, YahooConnectRequest);
        const teams = await connectYahoo(
          { store: s.store, secretKey: s.config.secretKey, yahoo: s.yahoo, log: s.log },
          user.id,
          { T: body.T.trim(), Y: body.Y.trim() },
        );
        s.league.invalidate(user.id);
        sendJson(res, 200, { teams });
      },
    },
    {
      method: 'POST',
      path: '/api/settings/yahoo/team',
      auth: 'user',
      handle: async ({ req, res, user }) => {
        const choice = await readJson(req, YahooSelectTeamRequest);
        await selectYahooTeam(
          { store: s.store, secretKey: s.config.secretKey, yahoo: s.yahoo },
          user.id,
          choice,
        );
        s.league.invalidate(user.id);
        s.store.events.record({
          userId: user.id,
          kind: 'yahoo.team_selected',
          subject: choice.teamKey,
        });
        sendJson(res, 200, meView(s, user));
      },
    },
    {
      method: 'DELETE',
      path: '/api/settings/yahoo',
      auth: 'user',
      handle: ({ res, user }) => {
        s.store.yahooConnections.remove(user.id);
        s.league.invalidate(user.id);
        s.store.events.record({ userId: user.id, kind: 'yahoo.disconnected' });
        sendJson(res, 200, meView(s, user));
        return Promise.resolve();
      },
    },
    {
      method: 'GET',
      path: '/api/settings/permissions',
      auth: 'user',
      handle: ({ res, user }) => {
        sendJson(
          res,
          200,
          permissionsView(s.store, s.config.permissionsFile, user.id, s.league.peek(user.id)?.view),
        );
        return Promise.resolve();
      },
    },
    {
      method: 'PUT',
      path: '/api/settings/permissions',
      auth: 'user',
      handle: async ({ req, res, user }) => {
        const body = await readJson(req, PermissionsUpdate);
        updatePermissions(s.store, s.config.permissionsFile, user.id, body.permissions);
        s.log(`permissions changed by user ${user.id}`);
        sendJson(
          res,
          200,
          permissionsView(s.store, s.config.permissionsFile, user.id, s.league.peek(user.id)?.view),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/players/search',
      auth: 'user',
      handle: async ({ res, url, user }) => {
        const q = (url.searchParams.get('q') ?? '').trim();
        if (q.length < 2 || q.length > 80) {
          throw new HttpError(400, 'invalid_request', 'q must be 2 to 80 characters');
        }
        const { view } = await s.league.get(user.id);
        sendJson(res, 200, { players: searchPlayers(view.snap.players, q) });
      },
    },
    {
      method: 'GET',
      path: '/api/settings/notifications',
      auth: 'user',
      handle: ({ res, user }) => {
        sendJson(res, 200, toContract(s.push.prefs(user.id)));
        return Promise.resolve();
      },
    },
    {
      method: 'PUT',
      path: '/api/settings/notifications',
      auth: 'user',
      handle: async ({ req, res, user }) => {
        const body = await readJson(req, PrefsContract);
        let saved: NotificationPrefs;
        try {
          saved = s.store.notificationPrefs.set(user.id, {
            kinds: body.kinds,
            ...(body.quietHours === null ? {} : { quietHours: body.quietHours }),
          });
        } catch (err) {
          const detail =
            err instanceof z.ZodError
              ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
              : 'invalid preferences';
          throw new HttpError(400, 'invalid_request', detail);
        }
        sendJson(res, 200, toContract(saved));
      },
    },
    {
      method: 'GET',
      path: '/api/notifications',
      auth: 'user',
      handle: ({ res, user }) => {
        const notifications = s.store.notifications.unread(user.id, 50).map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body ?? null,
          url: n.url ?? null,
          createdAt: n.createdAt,
          readAt: n.readAt ?? null,
        }));
        sendJson(res, 200, { notifications });
        return Promise.resolve();
      },
    },
  ];
}

function toContract(p: NotificationPrefs): {
  kinds: Record<string, boolean>;
  quietHours: NotificationPrefs['quietHours'] | null;
} {
  return { kinds: p.kinds, quietHours: p.quietHours ?? null };
}

const MAX_RESULTS = 10;

/**
 * P3: the search returns candidates and never picks one. An exact or single fuzzy match is still
 * returned as a list of one for the user to confirm; an ambiguous name returns every match; no
 * match returns the nearest names plus any whose name contains the query.
 */
export function searchPlayers(
  players: readonly Player[],
  q: string,
): { playerKey: string; name: string; team: string; positions: string }[] {
  const pool: Candidate[] = players.map((p, i) => ({
    nhlId: i,
    name: p.name,
    position: p.eligible.join(','),
    team: p.nhlTeam,
  }));
  const m = matchPlayer(q, pool);
  const hits =
    m.kind === 'exact' || m.kind === 'fuzzy'
      ? [m.candidate]
      : m.kind === 'ambiguous'
        ? m.candidates
        : [
            ...pool.filter((c) => normalizeName(c.name).includes(normalizeName(q))),
            ...m.best.filter((b) => b.score >= 0.8).map((b) => b.candidate),
          ];
  const seen = new Set<number>();
  return hits
    .filter((c) => !seen.has(c.nhlId) && seen.add(c.nhlId))
    .slice(0, MAX_RESULTS)
    .flatMap((c) => {
      const p = players[c.nhlId];
      return p === undefined
        ? []
        : [
            {
              playerKey: p.playerKey,
              name: p.name,
              team: p.nhlTeam,
              positions: p.eligible.join(','),
            },
          ];
    });
}
