import { afterEach, describe, expect, it } from 'vitest';
import type { Permissions, Plan } from '@fha/core';
import { EVENT_KINDS } from '@fha/tools';
import { cardFor } from '../decisionCard.js';
import { userPermissions } from '../permissions.js';
import { cardContext } from '../services.js';
import { START, connected, startHarness, type Harness } from '../testing.js';
import { runAutoGrab, type AutoGrabRequest } from './autoGrab.js';
import { Daemon } from './daemon.js';

/**
 * Auto-grab end to end (D-016) against the fake Yahoo: the real pipeline, gate, cards and push
 * records; a fake write adapter that records what it would have sent. Nothing reaches Yahoo.
 */
const TROCHECK = '477.p.5431'; // a free agent on 2026-09-29, VORP ~1.56
const THEIRS = '477.l.48535.t.1';

let h: Harness;
let userId = '';
let sent: Plan[] = [];
let built = 0;

afterEach(async () => {
  await h.close();
});

async function setup(
  edit: (p: Permissions) => void = () => undefined,
  pool: { FA?: string[]; W?: string[] } = { FA: [TROCHECK] },
) {
  h = await startHarness({ chat: false });
  await connected(h);
  userId = h.store.users.bySub('ben-sub')?.id ?? '';
  const perms = structuredClone(
    userPermissions(h.store, h.app.services.config.permissionsFile, userId),
  );
  edit(perms);
  h.store.permissions.set(userId, perms, 'test');
  sent = [];
  built = 0;
  h.yahoo.writeAdapter = () => {
    built++;
    return {
      name: 'yahooWeb',
      execute: (plan) => {
        sent.push(plan);
        return Promise.resolve({ status: 'done', detail: 'Yahoo: added' });
      },
      verify: () => Promise.resolve(true),
    };
  };
  h.yahoo.pool = { FA: pool.FA ?? [], W: pool.W ?? [] };
  await h.app.services.league.get(userId, { refresh: true });
}

const back = (playerKey = TROCHECK): AutoGrabRequest => ({
  userId,
  playerKey,
  name: 'Vincent Trocheck',
  trigger: 'back',
});
const notices = () => h.store.notifications.unread(userId, 100);
const events = () =>
  h.store.events
    .recent(userId, '2000-01-01T00:00:00.000Z', [EVENT_KINDS.autoGrab])
    .map((e) => e.payload as { outcome: string; reason: string; gain: number | null });
const card = (planId: string) =>
  cardFor(h.store, planId, { ...cardContext(h.app.services, userId), now: START });

describe('auto-grab: acting', () => {
  it('dry run on → an urgent proposal push to the actionable card, and no adapter call', async () => {
    await setup();
    const r = await runAutoGrab(h.app.services, back());
    expect(r.outcome).toBe('proposed');
    expect(r.reason).toBe('dry run is on');
    expect(built + sent.length).toBe(0);
    const plan = h.store.decisions.get(r.planId ?? '');
    expect(plan?.status).toBe('dry_run');
    expect(plan?.plan).toMatchObject({ agent: 'waivers', sourceTool: 'proposeAddDrop' });
    expect(plan?.plan.payload).toMatchObject({ kind: 'addDrop', add: TROCHECK });
    expect(plan?.rationale).toContain('Auto-grab (back from out)');
    const [n] = notices();
    expect(n).toMatchObject({
      kind: 'approval',
      title: 'Grab Vincent Trocheck now?',
      url: `/decisions/${r.planId ?? ''}`,
    });
    expect(n?.body).toMatch(/^\+\d+\.\d\d · (drop .+|open roster spot) — tap to act$/);
    expect(card(r.planId ?? '')?.actions).toEqual(['execute', 'dismiss', 'openInYahoo']);
  });

  it('ignoreDryRun → one adapter call, verified, recorded as autoGrab, and an executed push', async () => {
    await setup((p) => (p.autoGrab.ignoreDryRun = true));
    const r = await runAutoGrab(h.app.services, back());
    expect(r.outcome).toBe('executed');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ kind: 'addDrop', add: TROCHECK });
    expect(h.store.decisions.get(r.planId ?? '')?.status).toBe('executed');
    expect(h.store.approvals.get(r.planId ?? '')?.via).toBe('autoGrab');
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: 'executed' });
    expect(notices()[0]?.title).toMatch(/^Grabbed Vincent Trocheck( \(dropped .+\))?: \+\d/);
  });

  it('dry run off acts the same way, without ignoreDryRun', async () => {
    await setup((p) => (p.dryRun = false));
    expect((await runAutoGrab(h.app.services, back())).outcome).toBe('executed');
    expect(sent).toHaveLength(1);
  });

  it('a gate deny sends nothing: paused, the tool off, the kind denied', async () => {
    const denials: ((p: Permissions) => void)[] = [
      (p) => (p.paused = true),
      (p) => (p.tools.proposeAddDrop = false),
      (p) => (p.plans.addDrop = { mode: 'deny', limits: {} }),
    ];
    for (const deny of denials) {
      await setup((p) => {
        p.autoGrab.ignoreDryRun = true;
        deny(p);
      });
      const r = await runAutoGrab(h.app.services, back());
      expect(r.outcome).toBe('denied');
      expect(sent).toEqual([]);
      expect(notices()).toEqual([]);
      expect(h.store.decisions.get(r.planId ?? '')?.status).toBe('denied');
      await h.close();
    }
    await setup(); // afterEach closes one harness
  });

  it('the weekly add cap: no adds left → skipped before any plan', async () => {
    await setup((p) => {
      p.autoGrab.ignoreDryRun = true;
      p.plans.addDrop = { mode: 'allow', limits: { maxPerWeek: 0 } };
    });
    const r = await runAutoGrab(h.app.services, back());
    expect(r).toMatchObject({ outcome: 'skipped' });
    expect(r.reason).toContain('no adds left');
    expect(sent).toEqual([]);
  });

  it('an ask-listed or protected drop is never chosen; ask-listing the add waits for Ben', async () => {
    await setup((p) => {
      p.autoGrab.ignoreDryRun = true;
      p.players.ask = [TROCHECK];
    });
    const r = await runAutoGrab(h.app.services, back());
    expect(r.outcome).toBe('pending');
    expect(sent).toEqual([]);
    expect(notices()[0]).toMatchObject({ kind: 'approval', title: 'Grab Vincent Trocheck now?' });
  });

  it('below minGain → skipped with the numbers, recorded, no push', async () => {
    await setup((p) => (p.autoGrab.minGain = 50));
    const r = await runAutoGrab(h.app.services, back());
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toMatch(/^gain \d+\.\d\d < 50\.00$/);
    expect(events()[0]).toMatchObject({ outcome: 'skipped' });
    expect(notices()).toEqual([]);
  });

  it('never proposes the same grab twice', async () => {
    await setup();
    const first = await runAutoGrab(h.app.services, back());
    const again = await runAutoGrab(h.app.services, back());
    expect(again.outcome).toBe('skipped');
    expect(again.reason).toBe(`already proposed (${first.planId ?? ''})`);
    expect(notices()).toHaveLength(1);
  });

  it('auto-grab off → nothing evaluated', async () => {
    await setup((p) => (p.autoGrab.enabled = false));
    expect(await runAutoGrab(h.app.services, back())).toMatchObject({
      outcome: 'skipped',
      reason: 'auto-grab is off',
    });
  });

  it("another team's healthy drop → a waiver-claim card with the Yahoo link, never sent", async () => {
    await setup(() => undefined, {});
    const view = h.app.services.league.peek(userId)?.view;
    const star = view
      ?.roster(THEIRS)
      .entries.map((e) => e.player)
      .filter((p) => p.status === undefined)
      .sort(
        (a, b) =>
          (view.valuation(b.playerKey)?.vorp ?? 0) - (view.valuation(a.playerKey)?.vorp ?? 0),
      )[0];
    if (star === undefined) throw new Error('fixture lacks a healthy rival player');
    h.yahoo.dropped.add(star.playerKey);
    h.yahoo.pool.W = [star.playerKey];
    h.yahoo.details.set(star.playerKey, {
      ownership: { type: 'waivers', waiverDate: '2026-10-01' },
    });
    const perms = userPermissions(h.store, h.app.services.config.permissionsFile, userId);
    h.store.permissions.set(
      userId,
      { ...perms, dryRun: false, autoGrab: { ...perms.autoGrab, ignoreDryRun: true } },
      'test',
    );
    const r = await runAutoGrab(h.app.services, {
      userId,
      playerKey: star.playerKey,
      name: star.name,
      trigger: 'dropped',
    });
    expect(r.outcome).toBe('proposed');
    expect(r.reason).toBe('waiver claim: file it in Yahoo');
    expect(sent).toEqual([]);
    const plan = h.store.decisions.get(r.planId ?? '')?.plan;
    expect(plan).toMatchObject({ sourceTool: 'proposeWaiverClaim' });
    expect(plan?.payload).toMatchObject({ kind: 'waiverClaim', add: star.playerKey });
    expect(notices()[0]).toMatchObject({ kind: 'approval', title: `Claim ${star.name} now?` });
    expect(notices()[0]?.body).toContain('on waivers until 2026-10-01 — file a claim in Yahoo');
    const c = card(r.planId ?? '');
    expect(c?.actions).toEqual(['openInYahoo', 'done', 'dismiss']);
    expect(c?.yahooUrl).toContain(`/addplayer?apid=${star.playerKey.split('.p.')[1] ?? ''}`);
  });
});

describe('auto-grab: the daemon', () => {
  it('a watched injured free agent back from out is evaluated at once', async () => {
    await setup();
    h.yahoo.status.set(TROCHECK, 'IR');
    await h.app.services.league.get(userId, { refresh: true });
    const d = new Daemon(h.app.services, { now: () => h.clock.now });
    try {
      await d.pollOnce('players', userId); // baseline: Trocheck is IR
      h.yahoo.status.delete(TROCHECK);
      await d.pollOnce('players', userId);
      await d.queue.idle();
      const grabs = h.store.decisions
        .listByStatus('dry_run')
        .filter((x) => x.plan.payload.kind === 'addDrop' && x.plan.payload.add === TROCHECK);
      expect(grabs).toHaveLength(1);
      expect(notices().some((n) => n.title === 'Grab Vincent Trocheck now?')).toBe(true);
    } finally {
      await d.stop();
    }
  });
});
