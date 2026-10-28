import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeagueSnapshot } from '@fha/core';
import { EVENT_KINDS } from '@fha/tools';
import { FIXTURE, START, connected, startHarness, type Harness } from '../testing.js';
import { Daemon } from './daemon.js';
import { PULL_HOURS, pullSlots } from './schedule.js';

/**
 * 4a of the 10-24 review: the Yahoo snapshot is pulled hourly through the job queue, a watcher
 * that sees a real change invalidates it and queues a pull, and the stats ingest invalidates it,
 * so values recompute on the day's news and games rather than once at 06:00.
 */
const snap = LeagueSnapshot.parse(JSON.parse(readFileSync(FIXTURE, 'utf-8')));

let h: Harness;
let d: Daemon;
let userId = '';

beforeEach(async () => {
  h = await startHarness();
  await connected(h);
  userId = h.store.yahooConnections.list()[0]?.userId ?? '';
  await h.app.services.league.get(userId);
  d = new Daemon(h.app.services, { now: () => h.clock.now });
});

afterEach(async () => {
  await d.stop();
  await h.close();
});

const later = (min: number) => new Date(START.getTime() + min * 60_000);
const runs = (status?: string) =>
  h.logs.filter(
    (l) =>
      l.includes(`pull for ${userId} →`) && (status === undefined || l.includes(`→ ${status}`)),
  );

describe('pull schedule', () => {
  it('runs hourly from 09:00 to 01:00 New York time', () => {
    expect(PULL_HOURS).toEqual([0, 1, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    const slots = pullSlots('2026-10-24');
    expect(slots.map((s) => s.key).slice(0, 3)).toEqual([
      'pull@2026-10-24#00',
      'pull@2026-10-24#01',
      'pull@2026-10-24#09',
    ]);
    expect(slots[2]?.at.toISOString()).toBe('2026-10-24T13:00:00.000Z'); // 09:00 EDT
  });

  it('the scheduler enqueues the pulls with the day’s other slots', async () => {
    await d.queue.stop();
    h.clock.now = new Date('2026-09-29T09:59:00Z'); // 05:59 ET
    const fresh = new Daemon(h.app.services, { now: () => h.clock.now });
    await fresh.queue.stop();
    h.clock.now = new Date('2026-09-29T14:01:00Z'); // 10:01 ET
    const keys = fresh.tick().map((x) => x.slot.key);
    expect(keys).toContain('pull@2026-09-29#09');
    expect(keys).toContain('pull@2026-09-29#10');
  });
});

describe('pull job', () => {
  it('a scheduled pull rebuilds the snapshot and records the day’s values', async () => {
    const before = h.app.services.league.peek(userId)?.builtAt ?? 0;
    h.clock.now = later(5);
    d.enqueue(userId, 'pull', 'pull@2026-09-29#13');
    await d.queue.idle();
    expect(h.app.services.league.peek(userId)?.builtAt).toBeGreaterThan(before);
    expect(runs('success')[0]).toMatch(/snapshot \d{4}-\d{2}-\d{2} pulled; .*value rows/);
  });

  it('a triggered pull on a fresh, unchanged snapshot is a noop', async () => {
    d.enqueue(userId, 'pull', 'watcher: test');
    await d.queue.idle();
    expect(runs('noop')[0]).toMatch(/already fresh/);
  });

  it('Yahoo down: the pull fails without a push, and backs off', async () => {
    h.yahoo.down = true;
    h.clock.now = later(5);
    d.enqueue(userId, 'pull', 'pull@2026-09-29#13');
    await d.queue.idle();
    expect(runs('failed')[0]).toMatch(/Yahoo could not be read/);
    h.clock.now = later(65);
    d.enqueue(userId, 'pull', 'pull@2026-09-29#14');
    await d.queue.idle();
    h.clock.now = later(125);
    const reads = h.yahoo.reads.length;
    d.enqueue(userId, 'pull', 'pull@2026-09-29#15');
    await d.queue.idle();
    expect(runs('noop').at(-1)).toMatch(/backing off/);
    expect(h.yahoo.reads.length).toBe(reads); // no Yahoo read while backing off
    expect(h.store.notifications.unread(userId, 100).filter((n) => n.kind === 'failed')).toEqual(
      [],
    );
    // The stale flag reaches the view the agents read (4b).
    expect(h.app.services.league.peek(userId)?.view.freshness.stale?.reason).toBe(
      'yahoo_unavailable',
    );
  });
});

describe('triggers', () => {
  it('a league transaction invalidates the snapshot and queues a pull ahead of the rules', async () => {
    const before = h.app.services.league.peek(userId)?.builtAt ?? 0;
    h.clock.now = later(2);
    h.store.events.record({
      userId,
      kind: EVENT_KINDS.transaction,
      subject: `${snap.leagueKey}.tr.1`,
      payload: {
        transactionKey: `${snap.leagueKey}.tr.1`,
        type: 'add',
        players: [],
      },
      dedupeKey: 'tx-1',
    });
    await d.processEvents();
    expect(h.app.services.league.status(userId).stale).toBe(true);
    await d.queue.idle();
    expect(runs('success')).toHaveLength(1);
    expect(h.app.services.league.peek(userId)?.builtAt).toBeGreaterThan(before);
  });

  it('news alone changes nothing', async () => {
    h.store.events.record({
      userId,
      kind: EVENT_KINDS.news,
      subject: 'x',
      payload: { playerKey: 'x', name: 'X', items: [] },
      dedupeKey: 'news-1',
    });
    await d.processEvents();
    expect(h.app.services.league.status(userId).stale).toBe(false);
    await d.queue.idle();
    expect(runs()).toEqual([]);
  });

  it('the stats ingest invalidates every connected league', async () => {
    h.app.services.pullGames = () => Promise.resolve({ skaters: [], goalies: [] });
    d.enqueue(userId, 'stats', 'test');
    await d.queue.idle();
    expect(h.app.services.league.status(userId).stale).toBe(true);
  });
});
