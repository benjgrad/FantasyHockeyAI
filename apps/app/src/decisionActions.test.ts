import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionActionResult, DecisionCard, DecisionList } from '@fha/api';
import type { Plan, PlanPayload, Player, Roster } from '@fha/core';
import { submitPlan } from '@fha/pipeline';
import { YahooWebAdapter, YahooWebWriter, type YahooPlayer } from '@fha/yahoo';
import { pipelineFor } from './decisions.js';
import { userPermissions } from './permissions.js';
import { FIXTURE, call, connected, startHarness, type Harness } from './testing.js';

/**
 * Every proposed decision is actionable (D-015), over HTTP with the real pipeline and a fake
 * Yahoo on the wire. Dry run is on throughout, as in production: "Do it" still executes the one
 * plan Ben chose. Nothing here reaches Yahoo.
 */
const FORM = readFileSync(
  new URL('../../../libs/yahoo/fixtures/web/addplayer-form.html', import.meta.url),
  'utf8',
);
const RESULT = JSON.parse(
  readFileSync(
    new URL('../../../libs/yahoo/fixtures/web/addplayer-result.json', import.meta.url),
    'utf8',
  ),
) as { location: string };
const LINEUP_FORM = readFileSync(
  new URL('../../../libs/yahoo/fixtures/web/editroster-form.html', import.meta.url),
  'utf8',
);

const KUEMPER = '477.p.5336';
const GUSTAVSSON = '477.p.7163';
const MACKINNON = '477.p.5980';

let h: Harness;
afterEach(async () => {
  await h.close();
});

let n = 0;
const plan = (payload: PlanPayload): Plan => ({
  planId: `da-${++n}`,
  runId: 'run-1',
  agent: 'waivers',
  sourceTool: payload.kind === 'lineup' ? 'proposeLineup' : 'proposeAddDrop',
  createdAt: '2026-09-29T16:30:00.000Z',
  rationale: 'test',
  payload,
});

function kuemper(): YahooPlayer {
  const snap = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { players: Player[] };
  const player = snap.players.find((p) => p.playerKey === KUEMPER);
  if (player === undefined) throw new Error('fixture lacks Kuemper');
  const detail = { onDisabledList: false, reserveEligible: [], hasRecentNotes: false, notes: [] };
  return { player, detail: { playerKey: KUEMPER, ...detail, undroppable: false } };
}

/** Connected, dry run on, with (or without) a fake Yahoo website adapter. */
async function setup(o: {
  writer: boolean;
  rosterAfter?: string[];
  slotsAfter?: Record<string, string>;
}) {
  h = await startHarness({ chat: false });
  const cookie = await connected(h);
  const userId = h.store.users.bySub('ben-sub')?.id ?? '';
  const perms = userPermissions(h.store, h.app.services.config.permissionsFile, userId);
  h.store.permissions.set(userId, { ...perms, dryRun: true }, 'test');
  const posts: string[] = [];
  if (o.writer) {
    const fetchImpl = ((url: string, init: RequestInit) => {
      const lineup = url.includes('?date=') || url.endsWith('/editroster');
      if (init.method === 'POST' && lineup) {
        posts.push(String(init.body));
        const headers = { 'content-type': 'application/json' };
        return Promise.resolve(new Response('{"errors":[]}', { status: 200, headers }));
      }
      if (lineup) return Promise.resolve(new Response(LINEUP_FORM, { status: 200 }));
      if (init.method === 'POST') {
        posts.push(String(init.body));
        const headers = { location: RESULT.location };
        return Promise.resolve(new Response(null, { status: 302, headers }));
      }
      return Promise.resolve(new Response(FORM, { status: 200 }));
    }) as typeof fetch;
    h.yahoo.writeAdapter = (credentials, leagueKey, teamKey, hooks) => {
      const writer = new YahooWebWriter({
        credentials,
        leagueKey,
        teamKey,
        fetchImpl,
        minIntervalMs: 0,
      });
      const keys = o.rosterAfter ?? [KUEMPER];
      const reader = {
        roster: (tk: string, date: string): Promise<Roster> =>
          Promise.resolve({
            teamKey: tk,
            date,
            entries: keys.map((k) => ({
              slot: o.slotsAfter?.[k] ?? 'BN',
              player: { playerKey: k, name: k, nhlTeam: 'X', eligible: ['G'], positionType: 'G' },
            })),
          }),
        transactions: () => Promise.resolve([]),
      };
      return new YahooWebAdapter({ ...hooks, writer, reader, teamKey, today: () => '2026-09-29' });
    };
  }
  const base = h.yahoo.reader;
  h.yahoo.reader = (c, l, t) => ({
    ...base(c, l, t),
    playersDetailed: (q) =>
      Promise.resolve(q.status === 'FA' && q.position === undefined ? [kuemper()] : []),
  });
  h.app.services.league.invalidate(userId);
  const league = await h.app.services.league.get(userId, { refresh: true });
  /** Propose as an agent would, with dry run on: the plan ends `dry_run`. */
  const propose = async (payload: PlanPayload) => {
    const p = plan(payload);
    const out = await submitPlan(p, pipelineFor(h.app.services.wiring, userId, league));
    expect(out.status).toBe('dry_run');
    return p.planId;
  };
  return { cookie, userId, posts, propose };
}

const card = async (cookie: string, planId: string) =>
  DecisionCard.parse(await (await call(h, `/api/decisions/${planId}`, { cookie })).json());
const act = (cookie: string, planId: string, action: string, body: unknown = {}) =>
  call(h, `/api/decisions/${planId}/${action}`, { cookie, body });

describe('a dry-run proposal is actionable', () => {
  it('offers Do it with the exact confirm sentence and a Yahoo link, and pushes the proposal', async () => {
    const { cookie, propose } = await setup({ writer: true });
    const planId = await propose({ kind: 'addDrop', add: KUEMPER, drop: GUSTAVSSON });
    expect(await card(cookie, planId)).toMatchObject({
      status: 'dry_run',
      actions: ['execute', 'dismiss', 'openInYahoo'],
      confirmText: 'Add Darcy Kuemper and drop Filip Gustavsson in Yahoo?',
      yahooUrl: 'https://hockey.fantasysports.yahoo.com/hockey/48535/addplayer?apid=5336',
    });
    const pending = DecisionList.parse(
      await (await call(h, '/api/decisions?status=pending', { cookie })).json(),
    );
    expect(pending.decisions.map((d) => d.planId)).toEqual([planId]);
    const notes = h.store.notifications.unread(h.store.users.bySub('ben-sub')?.id ?? '', 10);
    expect(notes[0]).toMatchObject({
      kind: 'approval',
      title: 'New proposal',
      body: 'Proposed: add Darcy Kuemper, drop Filip Gustavsson — tap to review',
      url: `/decisions/${planId}`,
    });
  });

  it('Do it executes in Yahoo once, even with dry run on; a second tap is refused', async () => {
    const { cookie, userId, posts, propose } = await setup({ writer: true });
    const planId = await propose({ kind: 'addDrop', add: KUEMPER, drop: GUSTAVSSON });

    expect((await act(cookie, planId, 'execute', {})).status).toBe(400);
    expect(posts).toEqual([]);

    const res = await act(cookie, planId, 'execute', { confirm: true });
    expect(res.status).toBe(200);
    const result = DecisionActionResult.parse(await res.json());
    expect(result).toMatchObject({
      outcome: 'executed',
      card: { status: 'executed', actions: [] },
    });
    expect(posts).toEqual(['stage=3&crumb=CRUMB_REDACTED&stat1=P&stat2=P&apid=5336&dpid=7163']);
    expect(h.store.approvals.get(planId)).toMatchObject({ status: 'approved', via: 'web' });

    const again = await act(cookie, planId, 'execute', { confirm: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('not_actionable');
    expect(posts).toHaveLength(1);
    // Dry run stays on for everything else.
    const perms = userPermissions(h.store, h.app.services.config.permissionsFile, userId);
    expect(perms.dryRun).toBe(true);
  });

  it('Do it on a lineup saves it in Yahoo once and confirms it from the roster', async () => {
    const { cookie, posts, propose } = await setup({
      writer: true,
      rosterAfter: [MACKINNON],
      slotsAfter: { [MACKINNON]: 'C' },
    });
    const planId = await propose({
      kind: 'lineup',
      date: '2026-10-01',
      moves: [{ playerKey: MACKINNON, slot: 'C' }],
    });
    expect((await card(cookie, planId)).actions).toEqual(['execute', 'dismiss', 'openInYahoo']);
    const result = DecisionActionResult.parse(
      await (await act(cookie, planId, 'execute', { confirm: true })).json(),
    );
    expect(result).toMatchObject({ outcome: 'executed', card: { status: 'executed' } });
    expect(posts).toHaveLength(1);
    const body = Object.fromEntries(new URLSearchParams(posts[0]));
    // The harness's league fills BN, so MacKinnon goes to C; everyone else is posted where
    // Yahoo's form has him (which slots change is covered in libs/yahoo).
    expect(body).toMatchObject({ '5980': 'C', '6777': 'C', '9118': 'G', date: '2026-10-01' });
    expect(Object.keys(body)).toHaveLength(24);
    expect((await act(cookie, planId, 'execute', { confirm: true })).status).toBe(409);
    expect(posts).toHaveLength(1);
  });

  it('a write Yahoo accepted but the roster does not show is reported unverified', async () => {
    const { cookie, propose } = await setup({ writer: true, rosterAfter: [GUSTAVSSON] });
    const planId = await propose({ kind: 'addDrop', add: KUEMPER, drop: GUSTAVSSON });
    const result = DecisionActionResult.parse(
      await (await act(cookie, planId, 'execute', { confirm: true })).json(),
    );
    expect(result).toMatchObject({ outcome: 'unverified', card: { status: 'unverified' } });
    expect(result.card.actions).toEqual(['openInYahoo', 'done']);
  });

  it('a pause since the proposal still wins: denied, nothing sent, still actionable', async () => {
    const { cookie, userId, posts, propose } = await setup({ writer: true });
    const planId = await propose({ kind: 'addDrop', add: KUEMPER, drop: GUSTAVSSON });
    const perms = userPermissions(h.store, h.app.services.config.permissionsFile, userId);
    h.store.permissions.set(userId, { ...perms, paused: true }, 'test');
    const result = DecisionActionResult.parse(
      await (await act(cookie, planId, 'execute', { confirm: true })).json(),
    );
    expect(result.outcome).toBe('denied');
    expect(result.message).toMatch(/paused/);
    expect(result.card.status).toBe('dry_run');
    expect(posts).toEqual([]);
  });

  it('dismiss drops a proposal once', async () => {
    const { cookie, propose } = await setup({ writer: true });
    const planId = await propose({ kind: 'addDrop', add: KUEMPER, drop: GUSTAVSSON });
    const result = DecisionActionResult.parse(
      await (await act(cookie, planId, 'dismiss', { reason: 'not now' })).json(),
    );
    expect(result).toMatchObject({
      outcome: 'dismissed',
      card: { status: 'rejected', actions: [], result: 'not now' },
    });
    expect((await act(cookie, planId, 'dismiss')).status).toBe(409);
    expect((await act(cookie, planId, 'execute', { confirm: true })).status).toBe(409);
    expect((await act(cookie, 'nope', 'dismiss')).status).toBe(404);
  });
});

describe('a move Ben makes by hand', () => {
  it('without a Yahoo writer, an add is Open in Yahoo / I did it, and unconfirmed stays put', async () => {
    const { cookie, propose } = await setup({ writer: false });
    const planId = await propose({ kind: 'addDrop', add: KUEMPER, drop: GUSTAVSSON });
    const before = await card(cookie, planId);
    expect(before.actions).toEqual(['openInYahoo', 'done', 'dismiss']);
    expect((await act(cookie, planId, 'execute', { confirm: true })).status).toBe(409);
    const result = DecisionActionResult.parse(await (await act(cookie, planId, 'done')).json());
    expect(result.outcome).toBe('notConfirmed');
    expect(result.message).toMatch(/Yahoo doesn't show it yet/);
    expect(result.card.status).toBe('dry_run');
  });

  it('a claim Ben filed in Yahoo says so, and stays open until it processes (Phase 5)', async () => {
    const { cookie, propose } = await setup({ writer: false });
    const planId = await propose({ kind: 'waiverClaim', add: KUEMPER, drop: GUSTAVSSON });
    const team = h.store.yahooConnections.list()[0]?.teamKey ?? '';
    h.yahoo.txs = [
      {
        transactionKey: `477.l.48535.w.c.6_5336_7163`,
        type: 'waiver',
        timestamp: '',
        teamKey: team,
        players: [
          { playerKey: KUEMPER, toTeamKey: team },
          { playerKey: GUSTAVSSON, fromTeamKey: team },
        ],
        status: 'pending',
      },
    ];
    const result = DecisionActionResult.parse(await (await act(cookie, planId, 'done')).json());
    expect(result.outcome).toBe('notConfirmed');
    expect(result.message).toMatch(/Yahoo shows your claim filed/);
    expect(result.message).toMatch(/processes when he clears waivers/);
    expect(result.card.status).toBe('dry_run');
  });

  it('a lineup Ben set is marked executed only once a fresh roster read shows it', async () => {
    const { cookie, propose } = await setup({ writer: false });
    // MacKinnon is at C in the recorded roster, so a fresh read confirms this lineup.
    const planId = await propose({
      kind: 'lineup',
      date: '2026-09-29',
      moves: [{ playerKey: MACKINNON, slot: 'C' }],
    });
    const before = await card(cookie, planId);
    expect(before.actions).toEqual(['openInYahoo', 'done', 'dismiss']);
    expect(before.yahooUrl).toBe('https://hockey.fantasysports.yahoo.com/hockey/48535/6');
    expect(before.confirmText).toBe('Set your 2026-09-29 lineup in Yahoo: Nathan MacKinnon to C?');
    const reads = h.yahoo.reads.length;
    const result = DecisionActionResult.parse(await (await act(cookie, planId, 'done')).json());
    expect(h.yahoo.reads.length).toBeGreaterThan(reads);
    expect(result).toMatchObject({
      outcome: 'confirmed',
      card: { status: 'executed', actions: [] },
    });
    expect((await act(cookie, planId, 'done')).status).toBe(409);
  });
});
