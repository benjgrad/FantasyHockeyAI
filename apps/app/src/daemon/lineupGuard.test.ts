import { afterEach, describe, expect, it } from 'vitest';
import type { Permissions, Plan } from '@fha/core';
import { userPermissions } from '../permissions.js';
import { connected, startHarness, type Harness } from '../testing.js';
import { Daemon } from './daemon.js';
import { executeJob } from './jobs.js';

/**
 * The lineup guard (D-044) end to end against the fake Yahoo, on opening night 2026-09-29
 * (Aho and Zadorov play; every other starter's team is idle). Seth Jarvis (CAR, LW/RW) sits on
 * the bench as IR-NR; made healthy, he plays while the LW, RW and Util starters do not: the
 * shape of 2026-11-07, when Wilson sat on the bench on a day he played.
 */
const JARVIS = '477.p.8653';
const DATE = '2026-09-29';

let h: Harness;
let userId = '';
let sent: Plan[] = [];

afterEach(async () => {
  await h.close();
});

async function setup(
  edit: (p: Permissions) => void = () => undefined,
  opts: { chat?: boolean } = {},
): Promise<void> {
  h = await startHarness({ chat: opts.chat ?? false });
  await connected(h);
  userId = h.store.users.bySub('ben-sub')?.id ?? '';
  const perms = structuredClone(
    userPermissions(h.store, h.app.services.config.permissionsFile, userId),
  );
  edit(perms);
  h.store.permissions.set(userId, perms, 'test');
  sent = [];
  h.yahoo.writeAdapter = () => ({
    name: 'yahooWeb',
    execute: (plan) => {
      sent.push(plan);
      return Promise.resolve({ status: 'done', detail: 'Yahoo saved the lineup.' });
    },
    verify: () => Promise.resolve(true),
  });
  await h.app.services.league.get(userId, { refresh: true });
}

const jarvisPlays = () => h.yahoo.status.set(JARVIS, undefined);
const guard = () =>
  executeJob(
    { s: h.app.services, now: () => h.clock.now },
    userId,
    'lineupGuard',
    new AbortController().signal,
  );
const notices = () => h.store.notifications.unread(userId, 100);
const lineupPlans = () =>
  h.store.decisions
    .listByStatus(
      'proposed',
      'pending',
      'approved',
      'dry_run',
      'executed',
      'rejected',
      'invalid',
      'unverified',
    )
    .filter((d) => d.plan.payload.kind === 'lineup');

describe('lineup guard (D-044)', () => {
  it('a lineup that starts everyone who plays is verified, with no plan and no write', async () => {
    await setup((p) => (p.dryRun = false));
    const out = await guard();
    expect(out.status).toBe('success');
    expect(out.summary).toMatch(/^verified 2026-09-29: \d+ of 13 seats start players who play/);
    expect(lineupPlans()).toEqual([]);
    expect(sent).toEqual([]);
    // Hellebuyck (NA) in G with no goalie who plays: a warning worth one push.
    expect(notices().map((n) => n.title)).toEqual(['Lineup check']);
    await guard();
    expect(notices()).toHaveLength(1);
  });

  it('a lost start with lineups allowed and dry run off: the solver lineup is sent, and verified', async () => {
    await setup((p) => (p.dryRun = false));
    jarvisPlays();
    const out = await guard();
    expect(out.status).toBe('success');
    expect(sent).toHaveLength(1);
    const payload = sent[0]?.payload;
    expect(payload?.kind === 'lineup' && payload.date).toBe(DATE);
    const moved =
      payload?.kind === 'lineup' ? payload.moves.find((m) => m.playerKey === JARVIS) : undefined;
    expect(['LW', 'RW', 'Util']).toContain(moved?.slot);
    expect(sent[0]?.rationale).toMatch(
      /^Lineup guard \(code, D-044\): .*Seth Jarvis .* sits at BN but plays/,
    );
    expect(notices()[0]).toMatchObject({ kind: 'executed' });
    expect(notices()[0]?.title).toMatch(/^Lineup fixed: .*Seth Jarvis→(LW|RW|Util)/);
  });

  it('with dry run on: a card Ben can Do, and an urgent push, but no write', async () => {
    await setup((p) => (p.dryRun = true));
    jarvisPlays();
    const out = await guard();
    expect(out.status).toBe('partial');
    expect(sent).toEqual([]);
    expect(lineupPlans().map((d) => d.status)).toEqual(['dry_run']);
    expect(notices()[0]).toMatchObject({ kind: 'approval', title: 'Your lineup is losing starts' });
  });

  it('retires an earlier lineup plan still waiting for Ben, which would block the fix', async () => {
    await setup((p) => (p.dryRun = false));
    jarvisPlays();
    const stale: Plan = {
      planId: 'stale-1000',
      runId: 'r-1000',
      agent: 'lineup',
      sourceTool: 'proposeLineup',
      createdAt: h.clock.now.toISOString(),
      rationale: 'the 10:00 run',
      payload: { kind: 'lineup', date: DATE, moves: [{ playerKey: '477.p.6777', slot: 'BN' }] },
    };
    h.store.decisions.insert(stale, { status: 'pending', gate: 'ask' });
    h.store.approvals.request(stale.planId, undefined, undefined, userId);
    const out = await guard();
    expect(out.status).toBe('success');
    expect(out.summary).toContain('retired 1 open lineup plan(s)');
    expect(h.store.decisions.get('stale-1000')?.status).toBe('rejected');
    expect(sent).toHaveLength(1);
  });

  it('a date the loaded schedule does not cover: one push, no plan, no write (P5)', async () => {
    await setup((p) => (p.dryRun = false));
    h.clock.now = new Date('2027-02-10T17:00:00.000Z');
    const out = await guard();
    expect(out.status).toBe('partial');
    expect(out.summary).toMatch(
      /^unverifiable 2027-02-10: The NHL schedule for 2027-02-10 is not loaded/,
    );
    expect(lineupPlans()).toEqual([]);
    expect(notices().map((n) => n.title)).toEqual(["Can't verify today's lineup"]);
  });

  it('Yahoo unreadable: the run fails, saying the lineup is unverified', async () => {
    await setup((p) => (p.dryRun = false));
    h.yahoo.down = true;
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const out = await guard();
    expect(out.status).toBe('failed');
    expect(out.summary).toMatch(/today's lineup is unverified/);
    expect(sent).toEqual([]);
  });

  it('with no model configured, the lineup job still ends with the guard fixing the lineup', async () => {
    await setup((p) => (p.dryRun = false), { chat: false });
    jarvisPlays();
    const d = new Daemon(h.app.services, { now: () => h.clock.now });
    d.enqueue(userId, 'lineup', 'lineup@2026-09-29#am');
    await d.queue.idle();
    expect(h.logs.some((l) => /lineup for \S+ → noop: no model configured/.test(l))).toBe(true);
    expect(h.logs.some((l) => /lineupGuard for \S+ → success/.test(l))).toBe(true);
    expect(sent).toHaveLength(1);
    await d.stop();
  });
});
