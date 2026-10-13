import { existsSync, readFileSync } from 'node:fs';
import { mockView } from '@fha/tools';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeagueSnapshot } from '@fha/core';
import type { FakeTurn } from '@fha/llm';
import {
  FIXTURE,
  GOOD_COOKIE,
  START,
  call,
  connected,
  startHarness,
  type Harness,
} from '../testing.js';
import { userPermissions } from '../permissions.js';
import { Daemon } from './daemon.js';
import { keepaliveDue } from './keepalive.js';
import { LockHeldError } from './lock.js';
import { firstGameFor, PREGAME_LEAD_MS } from './schedule.js';

const snap = LeagueSnapshot.parse(JSON.parse(readFileSync(FIXTURE, 'utf-8')));
const byKey = new Map(snap.players.map((p) => [p.playerKey, p]));
const RESERVE = new Set(['BN', 'IR', 'IR+', 'NA']);
/** A healthy starter on our roster in the recording. */
const starter = (snap.rosters[snap.teamKey] ?? [])
  .map((e) => ({ ...e, player: byKey.get(e.playerKey) }))
  .find((e) => !RESERVE.has(e.slot) && e.player !== undefined && e.player.status === undefined);
const OTHER = snap.teams.find((t) => t.teamKey !== snap.teamKey)?.teamKey ?? '';

const abstain: FakeTurn[] = [
  { toolUses: [{ name: 'abstain', input: { reason: 'test run' } }] },
  { text: 'Nothing to do.' },
];

let h: Harness;
let d: Daemon;
let userId = '';
let cookie = '';

const notices = (kind?: string) =>
  h.store.notifications.unread(userId, 100).filter((n) => kind === undefined || n.kind === kind);

beforeEach(async () => {
  h = await startHarness();
  cookie = await connected(h);
  userId = h.store.yahooConnections.list()[0]?.userId ?? '';
  await h.app.services.league.get(userId);
  d = new Daemon(h.app.services, { now: () => h.clock.now });
});

afterEach(async () => {
  await d.stop();
  await h.close();
});

describe('daemon: scheduler', () => {
  it('enqueues the slots that came due since the last pass, in New York time', async () => {
    await d.queue.stop(); // nothing runs; this test is about what came due
    h.clock.now = new Date('2026-09-29T09:59:00Z'); // 05:59 ET, a Tuesday
    const fresh = new Daemon(h.app.services, { now: () => h.clock.now });
    await fresh.queue.stop();
    h.clock.now = new Date('2026-09-29T13:01:00Z'); // 09:01 ET
    expect(fresh.tick().map((x) => x.slot.key)).toEqual([
      'refresh@2026-09-29#daily',
      'waivers@2026-09-29#daily',
      'digest@2026-09-29#daily',
    ]);
    expect(fresh.tick()).toEqual([]);
  });

  it("adds the pre-game lineup from the cached schedule of our players' teams", () => {
    const view = h.app.services.league.peek(userId)?.view;
    const teams = new Set(view?.roster().entries.map((e) => e.player.nhlTeam));
    const merged: string[] = [];
    let added = 0;
    for (const day of snap.schedule) {
      const slots = d.slotsFor(userId, day.date);
      const pregame = slots.find((s) => s.key.endsWith('#pregame'));
      const first = firstGameFor(snap.schedule, day.date, teams);
      if (first === undefined) {
        expect(pregame).toBeUndefined();
        continue;
      }
      const at = first.getTime() - PREGAME_LEAD_MS;
      // Within 20 minutes of the 10:00 or 16:30 run, that run covers it (still before puck drop).
      const near = slots.some(
        (s) => s !== pregame && s.job === 'lineup' && Math.abs(s.at.getTime() - at) < 20 * 60_000,
      );
      if (near) merged.push(day.date);
      else added++;
      expect(pregame?.at.getTime()).toBe(near ? undefined : at);
    }
    // Opening night: Carolina at 17:00 ET, so the 16:15 run folds into the 16:30 one.
    expect(merged).toContain('2026-09-29');
    expect(added).toBeGreaterThan(0);
  });
});

describe('daemon: jobs', () => {
  it('refresh records a snapshot and a run; with Yahoo down it fails and notifies once a day', async () => {
    d.enqueue(userId, 'refresh', 'test');
    await d.queue.idle();
    expect(h.logs.some((l) => l.includes(`refresh for ${userId} → success`))).toBe(true);
    h.yahoo.down = true;
    h.clock.now = new Date(START.getTime() + 60_000);
    for (let i = 0; i < 2; i++) {
      d.enqueue(userId, 'refresh', 'test');
      await d.queue.idle();
    }
    const failed = notices('failed');
    expect(failed.map((n) => n.title)).toEqual(['The refresh job failed']);
    expect(failed[0]?.body).toContain('Yahoo could not be read');
  });

  it('the digest is a notification built from stored facts', async () => {
    d.enqueue(userId, 'digest', 'test');
    await d.queue.idle();
    const digest = notices('digest');
    expect(digest).toHaveLength(1);
    expect(digest[0]?.title).toBe('Daily digest, 2026-09-29');
    expect(digest[0]?.body).toContain('Yesterday: no moves.');
  });

  it('stats ingests yesterday’s NHL games once a day, whatever the number of users', async () => {
    const asked: string[] = [];
    h.app.services.pullGames = (q) => {
      asked.push(`${q.from}..${q.to}`);
      return Promise.resolve({ skaters: [], goalies: [] });
    };
    d.enqueue(userId, 'stats', 'test');
    await d.queue.idle();
    d.enqueue(userId, 'stats', 'again');
    await d.queue.idle();
    expect(asked.length).toBeGreaterThan(0);
    const firstRun = asked.length;
    expect(h.logs.join('\n')).toMatch(/stats for \S+ → success: NHL games/);
    expect(h.logs.join('\n')).toMatch(/stats for \S+ → noop: NHL games already ingested today/);
    expect(asked).toHaveLength(firstRun);
  });

  it('waivers with no adds left this week is a noop without a model run', async () => {
    const perms = userPermissions(h.store, h.app.services.config.permissionsFile, userId);
    const capped = { mode: 'allow' as const, limits: { maxPerWeek: 0 } };
    h.store.permissions.set(
      userId,
      { ...perms, plans: { ...perms.plans, addDrop: capped } },
      'test',
    );
    d.enqueue(userId, 'waivers', 'test');
    await d.queue.idle();
    expect(h.llm.fake?.bodies ?? []).toHaveLength(0);
    expect(h.logs.join('\n')).toMatch(
      /waivers for \S+ → noop: no adds left this week \(0 of 0 used\)/,
    );
  });

  it('the league review runs its agent with a scripted model and pushes its digest', async () => {
    h.llm.script.push(
      { toolUses: [{ name: 'getLeagueEvents', input: { sinceDays: 7 } }] },
      { text: 'Quiet week in the league.' },
    );
    d.enqueue(userId, 'leagueReview', 'test');
    await d.queue.idle();
    expect(notices('league').map((n) => [n.title, n.body])).toEqual([
      ['League this week', 'Quiet week in the league.'],
    ]);
    const tools = (h.llm.fake.bodies[0]?.tools ?? []).map((t) => (t as { name: string }).name);
    expect(tools).toContain('getLeagueEvents');
    expect(tools.some((t) => t.startsWith('propose'))).toBe(false);
  });
});

describe('daemon: watchers and rules', () => {
  it('our starter newly out → an injury push and a lineup run; a re-poll adds nothing', async () => {
    expect(starter).toBeDefined();
    const key = starter?.playerKey ?? '';
    h.llm.script.push(...abstain, ...abstain); // lineup, and waivers if the roster is short
    expect(await d.pollOnce('players', userId)).toBe(0); // baseline
    h.yahoo.status.set(key, 'O');
    expect(await d.pollOnce('players', userId)).toBe(1);
    await d.queue.idle();
    expect(notices('injury').map((n) => n.title)).toEqual([`${starter?.player?.name ?? ''} is O`]);
    expect(h.logs.some((l) => l.includes(`lineup for ${userId} → noop`))).toBe(true);
    expect(await d.pollOnce('players', userId)).toBe(0);
    expect(h.store.events.unhandled(['player.status_changed'], 10)).toEqual([]);
  });

  it('an incoming trade offer runs the trades agent', async () => {
    h.llm.script.push(...abstain);
    h.yahoo.txs = [
      {
        transactionKey: `${snap.leagueKey}.pt.1`,
        type: 'pending_trade',
        timestamp: '2026-09-29T15:00:00.000Z',
        teamKey: OTHER,
        tradeeTeamKey: snap.teamKey,
        players: [],
      },
    ];
    expect(await d.pollOnce('transactions', userId)).toBe(1);
    await d.queue.idle();
    expect(h.logs.some((l) => l.includes(`trades for ${userId} → noop`))).toBe(true);
    expect(await d.pollOnce('transactions', userId)).toBe(0);
  });

  it('the scoreboard is read at most once an hour', async () => {
    h.yahoo.matchup = {
      week: 1,
      weekStart: '2026-09-29',
      weekEnd: '2026-10-05',
      status: 'midevent',
      isPlayoffs: false,
      teams: [
        { teamKey: snap.teamKey, name: 'Us', stats: { '1': 2 } },
        { teamKey: OTHER, name: 'Them', stats: { '1': 1 } },
      ],
      statWinners: [{ statId: 1, winnerTeamKey: snap.teamKey, tied: false }],
    };
    expect(await d.pollOnce('scoreboard', userId)).toBe(1);
    expect(await d.pollOnce('scoreboard', userId)).toBe(0);
    h.clock.now = new Date(START.getTime() + 3_600_000);
    expect(await d.pollOnce('scoreboard', userId)).toBe(1);
  });

  it('a Yahoo outage backs off without a push (P9)', async () => {
    h.yahoo.down = true;
    expect(await d.pollOnce('players', userId)).toBe(0);
    const reads = h.yahoo.reads.length;
    expect(await d.pollOnce('players', userId)).toBe(0); // still backing off: no read
    expect(h.yahoo.reads.length).toBe(reads);
    expect(notices()).toEqual([]);
    expect(h.logs.some((l) => l.includes('players watcher') && l.includes('retry in'))).toBe(true);
  });

  it('an expired session: one reconnect push, the user paused until reconnected', async () => {
    h.yahoo.expired = true;
    await d.pollOnce('players', userId);
    await d.pollOnce('transactions', userId);
    d.enqueue(userId, 'refresh', 'test');
    await d.queue.idle();
    expect(h.store.yahooConnections.get(userId)?.status).toBe('expired');
    expect(notices('failed').map((n) => n.title)).toEqual(['Reconnect Yahoo']);
    expect(d.users()).toEqual([]);

    h.yahoo.expired = false;
    h.clock.now = new Date(START.getTime() + 60_000);
    await call(h, '/api/settings/yahoo', {
      cookie,
      body: { T: GOOD_COOKIE, Y: 'good-cookie-value-Y' },
    });
    expect(d.users()).toEqual([userId]);
    // A later expiry of the new session notifies again.
    h.yahoo.expired = true;
    await d.pollOnce('players', userId);
    expect(notices('failed')).toHaveLength(2);
  });
});

describe('daemon: what is watched, visibly (D-027)', () => {
  it("the Activity API lists the players followed with why, and each watcher's last run", async () => {
    await d.pollOnce('players', userId);
    const res = await call(h, '/api/activity', { cookie });
    expect(res.status).toBe(200);
    const v = (await res.json()) as {
      players: { reasons: string[] }[];
      watchers: { name: string; last: { ok: boolean } | null }[];
      rules: unknown[];
    };
    expect(v.players.some((p) => p.reasons.includes('our roster'))).toBe(true);
    expect(v.watchers.find((w) => w.name === 'players')?.last?.ok).toBe(true);
    expect(v.watchers.find((w) => w.name === 'goalies')?.last).toBeNull();
    expect(v.rules.length).toBeGreaterThan(5);
  });

  it('lists every agent with its schedule, triggers, tools and permissions (D-028)', async () => {
    const v = (await (await call(h, '/api/activity', { cookie })).json()) as {
      agents: {
        name: string;
        schedule: string[];
        triggers: string[];
        tools: string[];
        may: string[];
      }[];
    };
    const names = v.agents.map((a) => a.name);
    expect(names).toEqual(['lineup', 'waivers', 'trades', 'matchup', 'leagueReview', 'assistant']);
    const lineup = v.agents.find((a) => a.name === 'lineup');
    expect(lineup?.schedule.some((x) => x.includes('10:00'))).toBe(true);
    expect(lineup?.triggers.some((x) => x.includes('IR-eligible'))).toBe(true);
    expect(lineup?.tools).toContain('proposeLineup');
    expect(lineup?.may.some((x) => x.startsWith('lineup: '))).toBe(true);
    expect(v.agents.find((a) => a.name === 'leagueReview')?.may).toEqual([
      'read only: proposes nothing',
    ]);
  });

  it('shows players an agent follows, polls them, and lets Ben stop one', async () => {
    const mock = mockView();
    const key = mock.snap.players.find((p) => mock.isFreeAgent(p.playerKey))?.playerKey;
    expect(key).toBeDefined();
    h.store.watchList.add({
      userId,
      playerKey: key ?? '',
      reason: 'trade target',
      addedBy: 'trades',
      expiresAt: new Date(h.clock.now.getTime() + 86_400_000).toISOString(),
    });
    await d.pollOnce('players', userId);
    const v = (await (await call(h, '/api/activity', { cookie })).json()) as {
      followed: { playerKey: string }[];
      players: { playerKey: string; reasons: string[] }[];
    };
    expect(v.followed.map((f) => f.playerKey)).toEqual([key]);
    expect(v.players.find((p) => p.playerKey === key)?.reasons).toContain(
      'followed by trades: trade target',
    );
    const del = await call(h, `/api/activity/watch/${encodeURIComponent(key ?? '')}`, {
      cookie,
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(h.store.watchList.active(userId, h.clock.now.toISOString())).toEqual([]);
  });
});

describe('daemon: an expiry found outside a job', () => {
  it('is announced by the sweeper once per session (a "Do it" found it on 2026-10-02)', async () => {
    h.store.yahooConnections.markStatus(userId, 'expired', 'Yahoo session expired or signed out');
    await d.sweepOnce();
    await d.sweepOnce();
    expect(notices('failed').map((n) => n.title)).toEqual(['Reconnect Yahoo']);
  });
});

describe('daemon: website keepalive (D-033)', () => {
  it('checks the site when due, not again within six hours, and again before a lineup', async () => {
    d.queueKeepalives();
    await d.queue.idle();
    expect(h.yahoo.siteChecks).toBe(1);
    expect(h.store.yahooConnections.get(userId)?.siteOkAt).toBe(START.toISOString());
    h.clock.now = new Date(START.getTime() + 30 * 60_000);
    d.queueKeepalives();
    await d.queue.idle();
    expect(h.yahoo.siteChecks).toBe(1);
    h.clock.now = new Date(START.getTime() + 6 * 3_600_000);
    d.queueKeepalives();
    await d.queue.idle();
    expect(h.yahoo.siteChecks).toBe(2);
    expect(keepaliveDue(0, 50 * 60_000, 100 * 60_000)).toBe(true); // a lineup within the hour
    expect(keepaliveDue(0, 50 * 60_000, 200 * 60_000)).toBe(false);
  });

  it('a refused site: expired by the website, one push, and API reads do not clear it', async () => {
    h.yahoo.siteDead = true;
    d.queueKeepalives();
    await d.queue.idle();
    expect(h.store.yahooConnections.get(userId)).toMatchObject({
      status: 'expired',
      expiredBy: 'site',
    });
    expect(notices('failed').map((n) => n.title)).toEqual(['Reconnect Yahoo']);
    await h.app.services.league.get(userId, { refresh: true }).catch(() => undefined);
    h.store.yahooConnections.markStatus(userId, 'connected');
    expect(h.store.yahooConnections.get(userId)?.status).toBe('expired');
    await d.sweepOnce();
    expect(notices('failed')).toHaveLength(1);

    // The keepalive revives it once Yahoo takes the session again, and a later expiry notifies.
    h.yahoo.siteDead = false;
    h.clock.now = new Date(START.getTime() + 6 * 3_600_000);
    d.queueKeepalives();
    await d.queue.idle();
    expect(h.store.yahooConnections.get(userId)?.status).toBe('connected');
    await d.sweepOnce();
    h.yahoo.siteDead = true;
    h.clock.now = new Date(START.getTime() + 12 * 3_600_000);
    d.queueKeepalives();
    await d.queue.idle();
    expect(notices('failed')).toHaveLength(2);
  });

  it('Yahoo down: no expiry and no push (P9)', async () => {
    h.yahoo.down = true;
    d.queueKeepalives();
    await d.queue.idle();
    expect(h.store.yahooConnections.get(userId)?.status).toBe('connected');
    expect(notices('failed')).toEqual([]);
  });
});

describe('daemon: start and stop', () => {
  it('holds the lock while running; a second daemon is refused; stop releases it', async () => {
    const lock = join(h.dir, 'data', 'fha.lock');
    d.start(lock);
    expect(readFileSync(lock, 'utf-8').trim()).toBe(String(process.pid));
    const second = new Daemon(h.app.services, { now: () => h.clock.now });
    expect(() => second.start(lock)).toThrow(LockHeldError);
    await d.stop();
    expect(existsSync(lock)).toBe(false);
  });
});
