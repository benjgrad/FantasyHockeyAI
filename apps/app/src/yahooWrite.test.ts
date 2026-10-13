import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Plan, PlanPayload, Player, Roster } from '@fha/core';
import { submitPlan } from '@fha/pipeline';
import { YahooWebAdapter, YahooWebWriter, type YahooPlayer } from '@fha/yahoo';
import { pipelineFor } from './decisions.js';
import { userPermissions } from './permissions.js';
import { FIXTURE, connected, startHarness, type Harness } from './testing.js';

/**
 * The Yahoo write wiring end to end, with a fake Yahoo on the wire: the real pipeline, gate,
 * writer and adapter; the recorded add/drop form and 302. Nothing here reaches Yahoo.
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
) as { status: number; location: string };

const KUEMPER = '477.p.5336';
const DROP = '477.p.7163';

let h: Harness;

function kuemper(): YahooPlayer {
  const snap = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { players: Player[] };
  const player = snap.players.find((p) => p.playerKey === KUEMPER);
  if (player === undefined) throw new Error('fixture lacks Kuemper');
  return {
    player,
    detail: {
      playerKey: KUEMPER,
      onDisabledList: false,
      reserveEligible: [],
      hasRecentNotes: false,
      notes: [],
      undroppable: false,
    },
  };
}
afterEach(async () => {
  await h.close();
});

let n = 0;
const plan = (payload: PlanPayload): Plan => ({
  planId: `yw-${++n}`,
  runId: 'run-1',
  agent: 'waivers',
  sourceTool: payload.kind === 'lineup' ? 'proposeLineup' : 'proposeAddDrop',
  createdAt: '2026-09-29T16:30:00.000Z',
  rationale: 'test',
  payload,
});

/** Connect, give the fake Yahoo a write adapter over a scripted fetch, set dry run. */
async function setup(dryRun: boolean, rosterAfter: string[] | 'unchanged') {
  h = await startHarness({ chat: false });
  await connected(h);
  const userId = h.store.users.bySub('ben-sub')?.id ?? '';
  const perms = userPermissions(h.store, h.app.services.config.permissionsFile, userId);
  h.store.permissions.set(userId, { ...perms, dryRun }, 'test');
  const posts: string[] = [];
  const built: string[] = [];
  const fetchImpl = ((_url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      posts.push(String(init.body));
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: RESULT.location } }),
      );
    }
    return Promise.resolve(new Response(FORM, { status: 200 }));
  }) as typeof fetch;
  h.yahoo.writeAdapter = (credentials, leagueKey, teamKey, hooks) => {
    built.push(teamKey);
    const writer = new YahooWebWriter({
      credentials,
      leagueKey,
      teamKey,
      fetchImpl,
      minIntervalMs: 0,
    });
    const reader = {
      roster: (tk: string, date: string): Promise<Roster> => {
        const keys = rosterAfter === 'unchanged' ? [DROP] : rosterAfter;
        return Promise.resolve({
          teamKey: tk,
          date,
          entries: keys.map((k) => ({
            slot: 'BN',
            player: { playerKey: k, name: k, nhlTeam: 'X', eligible: ['G'], positionType: 'G' },
          })),
        });
      },
      transactions: () => Promise.resolve([]),
    };
    return new YahooWebAdapter({ ...hooks, writer, reader, teamKey, today: () => '2026-09-29' });
  };
  // The fake's free-agent pool is empty; offer Kuemper as a free agent, as he was that day.
  const base = h.yahoo.reader;
  h.yahoo.reader = (c, l, t) => ({
    ...base(c, l, t),
    playersDetailed: (q) =>
      Promise.resolve(q.status === 'FA' && q.position === undefined ? [kuemper()] : []),
  });
  h.app.services.league.invalidate(userId);
  const league = await h.app.services.league.get(userId, { refresh: true });
  const pipeline = pipelineFor(h.app.services.wiring, userId, league);
  return { userId, posts, built, pipeline };
}

describe('Yahoo add/drop through the pipeline', () => {
  it('should never build or call the Yahoo writer while dry run is on', async () => {
    const { posts, built, pipeline } = await setup(true, [KUEMPER]);
    const out = await submitPlan(plan({ kind: 'addDrop', add: KUEMPER, drop: DROP }), pipeline);
    expect(out).toMatchObject({ status: 'dry_run' });
    expect(pipeline.adapter.name).toBe('dryRun');
    expect(built).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('should execute when dry run is off and mark it executed once the roster shows it', async () => {
    const { userId, posts, built, pipeline } = await setup(false, [KUEMPER]);
    expect(pipeline.adapter.name).toBe('yahooWeb');
    expect(h?.app.services.league.status(userId).stale).toBe(false);
    const p = plan({ kind: 'addDrop', add: KUEMPER, drop: DROP });
    const out = await submitPlan(p, pipeline);
    // The write changed the roster: the snapshot read before it is stale now (2026-10-05).
    expect(h?.app.services.league.status(userId).stale).toBe(true);
    expect(out).toMatchObject({ status: 'executed', detail: 'Yahoo: added Darcy Kuemper' });
    expect(built).toEqual(['477.l.48535.t.6']);
    expect(posts).toEqual(['stage=3&crumb=CRUMB_REDACTED&stat1=P&stat2=P&apid=5336&dpid=7163']);
    expect(h.store.decisions.get(p.planId)?.status).toBe('executed');
  });

  it('should mark it unverified when Yahoo said yes but the roster does not show it', async () => {
    const { posts, pipeline } = await setup(false, 'unchanged');
    const p = plan({ kind: 'addDrop', add: KUEMPER, drop: DROP });
    const out = await submitPlan(p, pipeline);
    expect(out).toMatchObject({ status: 'unverified' });
    expect(posts).toHaveLength(1);
    expect(h.store.decisions.get(p.planId)?.status).toBe('unverified');
  });

  it('should hand an unobserved kind (a waiver claim) to Ben as a push rather than guess', async () => {
    const { posts, pipeline } = await setup(false, [KUEMPER]);
    const out = await submitPlan(plan({ kind: 'waiverClaim', add: KUEMPER, drop: DROP }), pipeline);
    expect(out).toMatchObject({ status: 'needsHuman' });
    expect(posts).toEqual([]);
    // The same "ACTION NEEDED (<plan>): …" line the Manual adapter sends, so it becomes a push.
    expect(out).toMatchObject({
      detail: expect.stringMatching(/^ACTION NEEDED \(yw-\d+\): do this in Yahoo/),
    });
  });

  it('should send a lineup to Yahoo, and fail closed when the page lacks the lineup form', async () => {
    const { posts, pipeline } = await setup(false, [KUEMPER]);
    const out = await submitPlan(
      plan({
        kind: 'lineup',
        date: '2026-10-03',
        moves: [
          { playerKey: '477.p.4471', slot: 'BN' },
          { playerKey: '477.p.8653', slot: 'Util' },
        ],
      }),
      pipeline,
    );
    // This fake Yahoo serves the add/drop page for every GET: no roster-edit form, no POST.
    expect(out).toMatchObject({ status: 'failed' });
    expect(posts).toEqual([]);
  });

  it('should fall back to Manual when the Yahoo connection has expired', async () => {
    const { userId } = await setup(false, [KUEMPER]);
    const league = await h.app.services.league.get(userId);
    h.store.yahooConnections.markStatus(userId, 'expired', 'test');
    expect(pipelineFor(h.app.services.wiring, userId, league).adapter.name).toBe('manual');
  });
});
