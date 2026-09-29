import { existsSync, readFileSync } from 'node:fs';
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
import { Daemon } from './daemon.js';
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
