import { describe, expect, it, vi } from 'vitest';
import { fx } from '../fixtures/load.js';
import { createWebSessionReader, playersPath, WebSessionReader } from './reader.js';
import { FixtureTransport } from './transport.js';

const LEAGUE = '477.l.48535';
const TEAM = '477.l.48535.t.6';

function recorded(): FixtureTransport {
  const names = [
    'settings',
    'teams',
    'roster-t6',
    'players-fa',
    'players-w',
    'transactions',
    'pending-trades',
    'scoreboard',
  ];
  return new FixtureTransport(Object.fromEntries(names.map((n) => [fx(n).path, fx(n).body])));
}

describe('WebSessionReader over recorded responses', () => {
  const t = recorded();
  const reader = new WebSessionReader(t, LEAGUE, TEAM);

  it('should implement LeagueReader: settings, teams, roster', async () => {
    expect((await reader.settings()).numTeams).toBe(8);
    expect((await reader.teams()).map((x) => x.teamKey)).toContain(TEAM);
    expect((await reader.teams()).find((x) => x.teamKey === TEAM)?.waiverPriority).toBe(8);
    const roster = await reader.roster(TEAM, '2026-09-29');
    expect(roster.entries.find((e) => e.player.name === 'Filip Gustavsson')?.slot).toBe('BN');
  });

  it('should read free agents and waivers with the documented query order', async () => {
    const fa = await reader.playersDetailed({ status: 'FA', sort: 'OR', limit: 25 });
    expect(fa).toHaveLength(25);
    const w = await reader.players({ status: 'W', sort: 'OR' } as never);
    expect(w.length).toBeGreaterThan(0);
  });

  it('should fetch pending trades per team, ours by default', async () => {
    expect(await reader.transactions({ type: 'pending_trade' })).toEqual([]);
    expect(t.requested).toContain(
      `/league/${LEAGUE}/transactions;types=pending_trade;team_key=${TEAM}`,
    );
  });

  it('should filter the league feed by type and team', async () => {
    expect(await reader.transactions({ type: 'add', teamKey: TEAM })).toHaveLength(2);
    expect(await reader.transactions({ type: 'drop' })).toEqual([]);
  });

  it('should find our matchup on the scoreboard', async () => {
    const m = await reader.ourMatchup();
    expect(m?.weekEnd).toBe('2026-10-04');
  });
});

describe('WebSessionReader paging and identity', () => {
  const page = (n: number, from = 0) => ({
    fantasy_content: {
      league: {
        players: Array.from({ length: n }, (_, i) => ({
          player: {
            player_key: `477.p.${from + i}`,
            name: { full: `P ${from + i}` },
            editorial_team_abbr: 'TOR',
            position_type: 'P',
            eligible_positions: [{ position: 'C' }],
          },
        })),
      },
    },
  });

  it('should page 25 at a time and stop on a short page', async () => {
    const t = new FixtureTransport({
      [playersPath(LEAGUE, { status: 'FA' }, 0, 25)]: page(25),
      [playersPath(LEAGUE, { status: 'FA' }, 25, 25)]: page(10, 25),
    });
    const ps = await new WebSessionReader(t, LEAGUE, TEAM).players({ status: 'FA', limit: 60 });
    expect(ps).toHaveLength(35);
    expect(t.requested).toHaveLength(2);
  });

  it('should ask for only what is left on the last page', () => {
    expect(playersPath(LEAGUE, { status: 'FA', search: 'Jack Hughes' }, 25, 5)).toBe(
      `/league/${LEAGUE}/players;status=FA;search=Jack%20Hughes;start=25;count=5;out=percent_owned,ownership,player_notes`,
    );
  });

  it('should ask for a ranking window with sort_type', () => {
    expect(playersPath(LEAGUE, { status: 'FA', sort: 'AR', sortType: 'lastweek' }, 0, 25)).toBe(
      `/league/${LEAGUE}/players;status=FA;sort=AR;sort_type=lastweek;start=0;count=25;out=percent_owned,ownership,player_notes`,
    );
  });

  it('should refuse a team outside the league (identity comes from config, P8)', () => {
    expect(() => new WebSessionReader(recorded(), LEAGUE, '477.l.1.t.6')).toThrow(/not in league/);
  });

  it('should reject a malformed roster date before any request', async () => {
    const t = recorded();
    await expect(new WebSessionReader(t, LEAGUE, TEAM).roster(TEAM, '9/29')).rejects.toThrow();
    expect(t.requested).toEqual([]);
  });
});

describe('createWebSessionReader', () => {
  it('should send only the pasted T and Y cookies, with GET, to the read host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(fx('teams').body)));
    const reader = createWebSessionReader({
      credentials: { T: 'tval', Y: 'yval' },
      leagueKey: LEAGUE,
      teamKey: TEAM,
      fetchImpl,
      minIntervalMs: 0,
    });
    await reader.teams();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/league/${LEAGUE}/teams?format=json_f`,
    );
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).cookie).toBe('T=tval; Y=yval');
  });
});
