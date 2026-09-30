import { afterEach, describe, expect, it } from 'vitest';
import type { Permissions, Plan } from '@fha/core';
import { submitPlan } from '@fha/pipeline';
import { cardFor } from '../decisionCard.js';
import { pipelineFor } from '../decisions.js';
import { userPermissions } from '../permissions.js';
import { cardContext } from '../services.js';
import { START, connected, startHarness, type Harness } from '../testing.js';
import { Daemon } from './daemon.js';

/**
 * Ask with timeout end to end (D-018) against the fake Yahoo: the real pipeline, gate, store,
 * daemon sweeper and push records, with a fake write adapter that records what it would send.
 */
const TROCHECK = '477.p.5431'; // a free agent on 2026-09-29
const MIN = 60_000;
const DUE = new Date(START.getTime() + 30 * MIN);

let h: Harness;
let d: Daemon;
let userId = '';
let sent: Plan[] = [];

afterEach(async () => {
  await d.stop();
  await h.close();
});

async function setup(edit: (p: Permissions) => void = () => undefined) {
  h = await startHarness({ chat: false });
  await connected(h);
  userId = h.store.users.bySub('ben-sub')?.id ?? '';
  const perms = structuredClone(
    userPermissions(h.store, h.app.services.config.permissionsFile, userId),
  );
  perms.dryRun = false;
  perms.protected.topNByVorp = 0;
  perms.plans.addDrop = { mode: 'askTimeout', limits: {} };
  edit(perms);
  h.store.permissions.set(userId, perms, 'test');
  sent = [];
  h.yahoo.writeAdapter = () => ({
    name: 'yahooWeb',
    execute: (plan) => {
      sent.push(plan);
      return Promise.resolve({ status: 'done', detail: 'Yahoo: added' });
    },
    verify: () => Promise.resolve(true),
  });
  h.yahoo.pool = { FA: [TROCHECK], W: [] };
  await h.app.services.league.get(userId, { refresh: true });
  d = new Daemon(h.app.services, { now: () => h.clock.now });
}

/** Propose "add Trocheck, drop our last bench skater" through the user's real pipeline. */
async function propose(): Promise<string> {
  const league = await h.app.services.league.get(userId);
  const drop = league.view
    .roster()
    .entries.filter((e) => e.slot === 'BN' && e.player.positionType === 'P')
    .at(-1)?.player.playerKey;
  const plan: Plan = {
    planId: `timed-${Math.random().toString(36).slice(2)}`,
    runId: h.store.runs.start('waivers'),
    agent: 'waivers',
    sourceTool: 'proposeAddDrop',
    createdAt: h.clock.now.toISOString(),
    rationale: 'Trocheck is back',
    payload: { kind: 'addDrop', add: TROCHECK, drop },
  };
  const out = await submitPlan(plan, pipelineFor(h.app.services.wiring, userId, league));
  expect(out.status).toBe('pending');
  return plan.planId;
}

const notices = () => h.store.notifications.unread(userId, 100);
const card = (planId: string) =>
  cardFor(h.store, planId, { ...cardContext(h.app.services, userId), now: h.clock.now });

describe('ask with timeout: the sweeper (D-018)', () => {
  it('pushes "happens unless you reject", then executes once at the due time, not before', async () => {
    await setup();
    const planId = await propose();
    expect(notices()[0]).toMatchObject({
      kind: 'approval',
      title: 'Happens unless you reject',
      planId,
    });
    expect(notices()[0]?.body).toMatch(/^Will add Vincent Trocheck, drop .+ at 1:00 PM unless/);
    expect(card(planId)?.autoApproveAt).toBe(DUE.toISOString());

    h.clock.now = new Date(DUE.getTime() - 1000);
    expect(await d.sweepOnce()).toEqual([]);
    expect(sent).toEqual([]);

    h.clock.now = DUE;
    expect((await d.sweepOnce()).map((r) => r.status)).toEqual(['executed']);
    h.clock.now = new Date(DUE.getTime() + MIN);
    expect(await d.sweepOnce()).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(h.store.approvals.get(planId)).toMatchObject({ status: 'approved', via: 'timeout' });
    expect(h.store.decisions.get(planId)?.status).toBe('executed');
    const done = notices().find((n) => n.kind === 'executed');
    expect(done?.title).toMatch(/^Done: add Vincent Trocheck, drop .+ \(no reply by 1:00 PM\)$/);
    expect(card(planId)?.autoApproveAt).toBeNull();
  });

  it('sends one reminder about 10 minutes before a 30-minute timer runs out', async () => {
    await setup();
    const planId = await propose();
    h.clock.now = new Date(START.getTime() + 19 * MIN);
    await d.sweepOnce();
    expect(notices().filter((n) => n.title.startsWith('Soon:'))).toEqual([]);
    h.clock.now = new Date(START.getTime() + 21 * MIN);
    await d.sweepOnce();
    h.clock.now = new Date(START.getTime() + 22 * MIN);
    await d.sweepOnce();
    const soon = notices().filter((n) => n.title.startsWith('Soon:'));
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({ kind: 'approval', planId });
    expect(soon[0]?.body).toBe('Happens at 1:00 PM unless you reject — tap to review');
  });

  it('a reject before the time → it never executes', async () => {
    await setup();
    const planId = await propose();
    expect(h.store.approvals.decide(planId, 'rejected', 'web')).toBe('ok');
    h.clock.now = DUE;
    expect(await d.sweepOnce()).toEqual([]);
    expect(sent).toEqual([]);
    expect(h.store.decisions.get(planId)?.status).toBe('rejected');
  });

  it('dry run on → it stays pending, one "waiting for you" push, no Yahoo write', async () => {
    await setup((p) => (p.dryRun = true));
    const planId = await propose();
    h.clock.now = DUE;
    expect((await d.sweepOnce()).map((r) => r.status)).toEqual(['held']);
    h.clock.now = new Date(DUE.getTime() + MIN);
    expect((await d.sweepOnce()).map((r) => r.status)).toEqual(['held']);
    expect(sent).toEqual([]);
    expect(h.store.decisions.get(planId)?.status).toBe('pending');
    const waiting = notices().filter((n) => n.title.startsWith('Waiting for you'));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.body).toMatch(/Dry run is on, so it did not happen at 1:00 PM/);
  });

  it('a lock added since → denied at the re-gate, the reason on the plan and in a push', async () => {
    await setup();
    const planId = await propose();
    const drop = h.store.decisions.get(planId)?.plan.payload;
    const perms = userPermissions(h.store, h.app.services.config.permissionsFile, userId);
    if (drop?.kind !== 'addDrop' || drop.drop === undefined) throw new Error('no drop');
    h.store.permissions.set(
      userId,
      { ...perms, players: { ...perms.players, locked: [drop.drop] } },
      'test',
    );
    h.clock.now = DUE;
    expect((await d.sweepOnce()).map((r) => r.status)).toEqual(['denied']);
    expect(sent).toEqual([]);
    expect(h.store.decisions.get(planId)?.status).toBe('denied');
    expect(JSON.stringify(h.store.decisions.get(planId)?.result)).toMatch(/locked player/);
    const refused = notices().find((n) => n.title.startsWith("Didn't do"));
    expect(refused?.body).toMatch(/^Not allowed any more: locked player/);
  });

  it('quiet hours when it is proposed → the timer starts when they end, and the card says so', async () => {
    await setup();
    h.store.notificationPrefs.set(userId, {
      kinds: {},
      quietHours: { start: '12:00', end: '14:00', tz: 'America/New_York' },
    });
    const planId = await propose();
    // 12:30 ET is quiet until 14:00 ET (18:00Z); the 30-minute timer starts then.
    expect(card(planId)?.autoApproveAt).toBe('2026-09-29T18:30:00.000Z');
    expect(card(planId)?.gateReasons.join(' ')).toMatch(/quiet hours delayed .* 2:00 PM/);
    expect(notices()[0]?.body).toMatch(
      /at 2:30 PM unless you reject .*\(moved past your quiet hours\)$/,
    );
  });
});
