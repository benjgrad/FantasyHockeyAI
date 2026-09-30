import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@fha/llm';
import {
  EVENT_KINDS,
  autoGrabLine,
  getLeagueEvents,
  notableReason,
  type AutoGrabPayload,
} from './tools/leagueEvents.js';
import { testRun } from './testing.js';

function summary<T>(r: ToolResult<T>): string {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.summary ?? '';
}

/** The best-valued player on another team, and the rank-1 key overall. */
function rivalStar(ctx: ReturnType<typeof testRun>['ctx']) {
  const { view } = ctx;
  const ranked = Object.entries(view.snap.valuations).sort((a, b) => b[1].value - a[1].value);
  const star = ranked.find(([k]) => {
    const owner = view.ownerOf(k);
    return owner !== undefined && owner !== view.teamKey && view.player(k)?.status === undefined;
  });
  if (star === undefined) throw new Error('no rival star in the mock league');
  return { key: star[0], owner: view.ownerOf(star[0]) ?? '', name: view.player(star[0])?.name ?? '' };
}

describe('getLeagueEvents', () => {
  it('lists the week of events, notable moves first, and the latest matchup reading', async () => {
    const { ctx, store } = testRun({ agent: 'leagueReview' });
    const user = store.users.upsertBySub('sub-1');
    const star = rivalStar(ctx);
    store.events.record({
      userId: user.id,
      kind: EVENT_KINDS.statusChanged,
      subject: star.key,
      payload: {
        playerKey: star.key,
        name: star.name,
        nhlTeam: 'XXX',
        ownerTeamKey: star.owner,
        ours: false,
        from: null,
        to: 'IR',
        note: 'Lower body',
        slot: null,
        gameToday: null,
      },
    });
    store.events.record({
      userId: user.id,
      kind: EVENT_KINDS.transaction,
      subject: 'tx.1',
      payload: {
        transactionKey: 'tx.1',
        type: 'drop',
        timestamp: '2026-10-12T20:00:00.000Z',
        teamKey: star.owner,
        tradeeTeamKey: null,
        players: [{ playerKey: star.key, name: star.name, fromTeamKey: star.owner, toTeamKey: null }],
      },
    });
    for (const n of [1, 2]) {
      store.events.record({
        userId: user.id,
        kind: EVENT_KINDS.matchupUpdate,
        payload: {
          week: 1,
          opponentTeamKey: star.owner,
          opponentName: 'Them',
          us: { G: n },
          them: { G: 0 },
          winning: n === 2 ? ['G', 'A'] : ['G'],
          losing: [],
        },
      });
    }
    store.events.record({ userId: user.id, kind: EVENT_KINDS.news, payload: { broken: true } });
    const s = summary(await getLeagueEvents.execute({ sinceDays: 7 }, { ...ctx, userId: user.id }));
    expect(s).toContain(`rival's ${star.name}`);
    expect(s).toContain('was dropped to free agency');
    expect(s).toContain('winning 2 (G, A)');
    expect(s).toContain(`${star.name} (${star.key}`);
    expect(s).toContain('→ free agency');
    expect(s).not.toContain('broken');
  });

  it('refuses without a user for the run (P8: never from the model)', async () => {
    const { ctx } = testRun({ agent: 'leagueReview' });
    const r = await getLeagueEvents.execute({ sinceDays: 7 }, ctx);
    expect(r.ok).toBe(false);
  });

  it('a healthy-to-out change for our own player or a bench nobody is not notable', () => {
    const { ctx } = testRun();
    const star = rivalStar(ctx);
    const base = {
      playerKey: star.key,
      name: star.name,
      nhlTeam: null,
      ownerTeamKey: star.owner,
      ours: false,
      from: null,
      to: 'O',
      note: null,
      slot: null,
      gameToday: null,
    };
    const kind = EVENT_KINDS.statusChanged;
    expect(notableReason(ctx.view, { kind, payload: base })).toContain('is now O');
    expect(notableReason(ctx.view, { kind, payload: { ...base, ours: true } })).toBeUndefined();
    expect(notableReason(ctx.view, { kind, payload: { ...base, from: 'IR' } })).toBeUndefined();
    expect(notableReason(ctx.view, { kind, payload: { ...base, to: 'DTD' } })).toBeUndefined();
  });
});

describe('auto-grab in the league review (D-016)', () => {
  const skipped: AutoGrabPayload = {
    playerKey: '477.p.1',
    name: 'Seth Jarvis',
    trigger: 'back',
    outcome: 'skipped',
    kind: 'add',
    drop: '477.p.2',
    dropName: 'Nico Hischier',
    gain: 0.8,
    required: 1.5,
    reason: 'gain 0.80 < 1.50',
    planId: null,
  };

  it('says what was considered and why it was skipped, or what was done', () => {
    expect(autoGrabLine(skipped)).toBe(
      'considered Seth Jarvis (drop Nico Hischier): skipped, gain 0.80 < 1.50',
    );
    expect(autoGrabLine({ ...skipped, outcome: 'executed', gain: 2.4 })).toBe(
      'grabbed Seth Jarvis (drop Nico Hischier): +2.40',
    );
  });

  it('getLeagueEvents lists auto-grab evaluations', async () => {
    const { ctx, store } = testRun({ agent: 'leagueReview' });
    const user = store.users.upsertBySub('sub-1');
    store.events.record({ userId: user.id, kind: EVENT_KINDS.autoGrab, payload: skipped });
    const out = summary(await getLeagueEvents.execute({ sinceDays: 7 }, { ...ctx, userId: user.id }));
    expect(out).toContain('auto-grab considered Seth Jarvis (drop Nico Hischier): skipped, gain 0.80 < 1.50');
  });
});
