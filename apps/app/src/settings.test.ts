import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Me, NotificationPrefs, PermissionsView, TeamView, YahooConnectResponse } from '@fha/api';
import { resolveStatic } from './static.js';
import {
  BAD_COOKIE,
  GOOD_COOKIE,
  call,
  connected,
  signIn,
  startHarness,
  type Harness,
} from './testing.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;
const noCookieInLogs = () => {
  for (const line of h.logs) {
    expect(line).not.toContain(GOOD_COOKIE);
    expect(line).not.toContain(BAD_COOKIE);
  }
};

describe('Settings → Connect Yahoo Fantasy', () => {
  it('validates live, stores only ciphertext, lists teams, and never logs the cookies', async () => {
    const { cookie } = await signIn(h);
    const res = await call(h, '/api/settings/yahoo', {
      cookie,
      body: { T: GOOD_COOKIE, Y: 'good-cookie-value-Y' },
    });
    expect(res.status).toBe(200);
    const body = YahooConnectResponse.parse(await res.json());
    expect(body.teams).toEqual([
      expect.objectContaining({
        leagueKey: '477.l.48535',
        teamKey: '477.l.48535.t.6',
        leagueName: 'Method Fantasy League',
      }),
    ]);
    const userId = h.store.users.bySub('ben-sub')?.id ?? '';
    const conn = h.store.yahooConnections.get(userId);
    expect(conn?.status).toBe('connected');
    expect(conn?.cookiesEnc).not.toContain(GOOD_COOKIE);
    expect(JSON.stringify(body)).not.toContain(GOOD_COOKIE);
    noCookieInLogs();
  });

  it('refuses cookies Yahoo rejects, stores nothing, and never logs them', async () => {
    const { cookie } = await signIn(h);
    const res = await call(h, '/api/settings/yahoo', {
      cookie,
      body: { T: BAD_COOKIE, Y: BAD_COOKIE },
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('yahoo_invalid_credentials');
    expect(text).not.toContain(BAD_COOKIE);
    expect(h.store.yahooConnections.get(h.store.users.bySub('ben-sub')?.id ?? '')).toBeUndefined();
    noCookieInLogs();
  });

  it('team selection must be one of the account’s own teams (P8), then shows in /api/me', async () => {
    const { cookie } = await signIn(h);
    await call(h, '/api/settings/yahoo', {
      cookie,
      body: { T: GOOD_COOKIE, Y: 'good-cookie-value-Y' },
    });
    const wrong = await call(h, '/api/settings/yahoo/team', {
      cookie,
      body: { leagueKey: '477.l.1', teamKey: '477.l.1.t.1' },
    });
    expect(wrong.status).toBe(400);
    const ok = await call(h, '/api/settings/yahoo/team', {
      cookie,
      body: { leagueKey: '477.l.48535', teamKey: '477.l.48535.t.6' },
    });
    const me = Me.parse(await ok.json());
    expect(me.yahoo).toMatchObject({ status: 'connected', teamKey: '477.l.48535.t.6' });
    const del = Me.parse(
      await (await call(h, '/api/settings/yahoo', { method: 'DELETE', cookie })).json(),
    );
    expect(del.yahoo.status).toBe('none');
  });
});

describe('the league runtime', () => {
  it('without a connection the team page is 409 yahoo_not_connected', async () => {
    const { cookie } = await signIn(h);
    const res = await call(h, '/api/team', { cookie });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('yahoo_not_connected');
  });

  it('builds the team view from the live league', async () => {
    const cookie = await connected(h);
    const res = await call(h, '/api/team', { cookie });
    expect(res.status).toBe(200);
    const team = TeamView.parse(await res.json());
    expect(team.teamName).toBe("Ben's Astonishing Team");
    expect(team.source).toBe('yahoo');
    expect(team.roster).toHaveLength(19);
    const hellebuyck = team.roster.find((r) => r.name === 'Connor Hellebuyck');
    expect(hellebuyck?.availability).toMatchObject({ status: 'NA', playProb: 0 });
    expect(team.health.join(' ')).toContain('Hellebuyck');
    expect(team.categories.map((c) => c.cat)).toContain('HIT');
    const me = Me.parse(await (await call(h, '/api/me', { cookie })).json());
    expect(me.yahoo.teamName).toBe("Ben's Astonishing Team");
  });

  it('an expired Yahoo session marks the connection expired and answers 409 reconnect', async () => {
    const cookie = await connected(h);
    h.yahoo.expired = true;
    const res = await call(h, '/api/team/refresh', { method: 'POST', cookie });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('yahoo_reconnect_required');
    const me = Me.parse(await (await call(h, '/api/me', { cookie })).json());
    expect(me.yahoo.status).toBe('expired');
  });
});

describe('Settings → Permissions', () => {
  it('seeds from config/permissions.yaml on first read', async () => {
    const { cookie } = await signIn(h);
    const view = PermissionsView.parse(
      await (await call(h, '/api/settings/permissions', { cookie })).json(),
    );
    expect(view.permissions['dryRun']).toBe(true);
    expect(view.tools.map((t) => t.name)).toContain('proposeLineup');
    expect(view.updatedAt).not.toBeNull();
  });

  it('PUT validates with core Permissions, stores, and records a permissions.changed event', async () => {
    const cookie = await connected(h);
    await call(h, '/api/team', { cookie }); // names for the locked list come from the league
    const bad = await call(h, '/api/settings/permissions', {
      method: 'PUT',
      cookie,
      body: { permissions: { dryRun: 'yes' } },
    });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('invalid_permissions');
    const unknownKey = await call(h, '/api/settings/permissions', {
      method: 'PUT',
      cookie,
      body: { permissions: { widen: true } },
    });
    expect(unknownKey.status).toBe(400);

    const current = PermissionsView.parse(
      await (await call(h, '/api/settings/permissions', { cookie })).json(),
    );
    const next = {
      ...current.permissions,
      paused: true,
      players: { locked: ['477.p.5980'], ask: [] },
    };
    const res = await call(h, '/api/settings/permissions', {
      method: 'PUT',
      cookie,
      body: { permissions: next },
    });
    expect(res.status).toBe(200);
    const view = PermissionsView.parse(await res.json());
    expect(view.permissions['paused']).toBe(true);
    expect(view.players).toEqual([
      { playerKey: '477.p.5980', name: 'Nathan MacKinnon', team: 'COL', positions: 'C,Util' },
    ]);
    const userId = h.store.users.bySub('ben-sub')?.id ?? '';
    const events = h.store.events.recent(userId, '2000-01-01T00:00:00.000Z', [
      'permissions.changed',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      before: { paused: false },
      after: { paused: true },
    });
    const me = Me.parse(await (await call(h, '/api/me', { cookie })).json());
    expect(me.paused).toBe(true);
  });

  it('player search returns candidates and never auto-picks', async () => {
    const cookie = await connected(h);
    const res = await call(h, '/api/players/search?q=hellebuyck', { cookie });
    const { players } = (await res.json()) as { players: { name: string; playerKey: string }[] };
    expect(players.map((p) => p.name)).toEqual(['Connor Hellebuyck']);
    const fuzzy = (await (await call(h, '/api/players/search?q=Filip', { cookie })).json()) as {
      players: { name: string }[];
    };
    expect(fuzzy.players.map((p) => p.name).sort()).toEqual(['Filip Forsberg', 'Filip Gustavsson']);
    expect((await call(h, '/api/players/search?q=x', { cookie })).status).toBe(400);
  });
});

describe('Settings → Notifications', () => {
  it('defaults every kind on, and validates quiet hours', async () => {
    const { cookie } = await signIn(h);
    const prefs = NotificationPrefs.parse(
      await (await call(h, '/api/settings/notifications', { cookie })).json(),
    );
    expect(prefs.kinds['approval']).toBe(true);
    expect(prefs.quietHours).toBeNull();
    const bad = await call(h, '/api/settings/notifications', {
      method: 'PUT',
      cookie,
      body: {
        kinds: { digest: false },
        quietHours: { start: '25:00', end: '07:00', tz: 'America/Toronto' },
      },
    });
    expect(bad.status).toBe(400);
    const good = await call(h, '/api/settings/notifications', {
      method: 'PUT',
      cookie,
      body: {
        kinds: { digest: false },
        quietHours: { start: '22:00', end: '07:00', tz: 'America/Toronto' },
      },
    });
    expect(NotificationPrefs.parse(await good.json()).quietHours?.start).toBe('22:00');
  });
});

describe('static path guard', () => {
  it('never resolves outside the client dir', () => {
    expect(resolveStatic(`${h.dir}/client`, '/../secret.txt')).toBeUndefined();
    expect(resolveStatic(`${h.dir}/client`, '/%2e%2e/secret.txt')).toBeUndefined();
    expect(resolveStatic(`${h.dir}/client`, '/sw.js')).toBe(`${h.dir}/client/sw.js`);
  });
});
