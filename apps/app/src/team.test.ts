import { afterEach, describe, expect, it } from 'vitest';
import { StrategyView, TeamView } from '@fha/api';
import { call, connected, startHarness, type Harness } from './testing.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('team page: the matchup opponent', () => {
  it("is Yahoo's scoreboard opponent when the scoreboard can be read, not the league order", async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const before = TeamView.parse(await (await call(h, '/api/team', { cookie })).json());
    const snap = h.app.services.league.peek(h.store.yahooConnections.list()[0]?.userId ?? '');
    const others = snap?.view.otherTeams() ?? [];
    // The league-order stand-in for this week; pick any other team as the real opponent.
    const real = others.find((t) => t.name !== before.opponent);
    expect(real).toBeDefined();
    h.yahoo.matchup = {
      week: snap?.view.snap.week ?? 1,
      weekStart: '2026-09-29',
      weekEnd: '2026-10-05',
      status: 'preevent',
      isPlayoffs: false,
      teams: [
        { teamKey: snap?.view.teamKey ?? '', name: 'Us', stats: {} },
        { teamKey: real?.teamKey ?? '', name: real?.name ?? '', stats: {} },
      ],
      statWinners: [],
    };
    const after = TeamView.parse(
      await (await call(h, '/api/team/refresh', { method: 'POST', cookie })).json(),
    );
    expect(after.opponent).toBe(real?.name);
  });

  it('falls back to the league order when the scoreboard is unavailable (P9)', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const team = TeamView.parse(await (await call(h, '/api/team', { cookie })).json());
    expect(team.opponent).not.toBeNull();
    expect(h.logs.some((l) => l.includes('scoreboard has no opponent'))).toBe(true);
  });
});

describe('team page: the season strategy (D-034)', () => {
  it('shows the audit before any version, then versions newest first with what changed', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const empty = StrategyView.parse(await (await call(h, '/api/strategy', { cookie })).json());
    expect(empty.versions).toEqual([]);
    expect(empty.objective).toBe('winWeek');
    expect(empty.audit?.categories).toHaveLength(13);

    const snap = h.app.services.league.peek(h.store.yahooConnections.list()[0]?.userId ?? '');
    const leagueKey = snap?.view.snap.leagueKey ?? '';
    const base = {
      leagueKey,
      author: 'strategy',
      stance: 'contend' as const,
      targets: ['SOG', 'A'],
      surplus: ['HIT'],
      punts: [],
      principles: ['No adds for HIT alone.'],
      rationale: 'HIT is won nearly every week.',
      reviewBy: undefined,
    };
    h.store.seasonStrategy.add(base);
    h.store.seasonStrategy.add({ ...base, author: 'ben (chat)', targets: ['SOG', 'PPP'] });
    const got = StrategyView.parse(await (await call(h, '/api/strategy', { cookie })).json());
    expect(got.versions.map((v) => v.author)).toEqual(['ben (chat)', 'strategy']);
    expect(got.versions[0]?.changes).toEqual(['targets was SOG, A']);
    expect(got.versions[1]?.changes).toEqual([]);
  });
});
