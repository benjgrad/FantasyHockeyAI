import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { YahooFantasyClient } from '../src/client.js';
import {
  parseDraftResults,
  parseMyTeams,
  parsePlayers,
  parseRoster,
  parseSettings,
  parseTeams,
  parseTransactions,
} from '../src/parse.js';
import { cookieHeaderFor, describeSession, type StoredSession } from '../src/session.js';
import { CookieTransport, FixtureTransport, YahooAuthError } from '../src/transport.js';

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as {
    path: string;
    body: unknown;
  };

describe('parseSettings (league 477.l.48535, captured 2026-09-24)', () => {
  const s = parseSettings(fx('settings').body);

  it('should read the league format from the API instead of assuming it', () => {
    expect(s.numTeams).toBe(8);
    expect(s.scoringType).toBe('head');
    expect(s.scoringLabel).toBe('H2H Cat');
    expect(s.draftType).toBe('live');
    expect(s.draftPickSeconds).toBe(90);
    expect(s.lineupLock).toBe('intraday');
    expect(s.usesFaab).toBe(false);
    expect(s.maxWeeklyAdds).toBe(3);
  });

  it('should list exactly the scored categories and exclude display-only ones', () => {
    const scored = s.categories.filter((c) => c.scored).map((c) => c.abbr);
    expect(scored).toEqual([
      'G',
      'A',
      '+/-',
      'PIM',
      'PPP',
      'SHP',
      'GWG',
      'SOG',
      'HIT',
      'W',
      'GAA',
      'SV%',
      'SHO',
    ]);
    expect(s.categories.filter((c) => !c.scored).map((c) => c.abbr)).toEqual(['GA', 'SV', 'SA']);
  });

  it('should mark GAA as lower-is-better', () => {
    expect(s.categories.find((c) => c.abbr === 'GAA')?.higherIsBetter).toBe(false);
    expect(s.categories.find((c) => c.abbr === 'SV%')?.higherIsBetter).toBe(true);
  });

  it('should parse roster slots with starting flags', () => {
    expect(s.rosterSlots.map((r) => `${r.position}${r.count}`)).toEqual([
      'C2',
      'LW2',
      'RW2',
      'D4',
      'Util1',
      'G2',
      'BN4',
      'IR2',
    ]);
    expect(s.rosterSlots.filter((r) => r.isStarting).reduce((n, r) => n + r.count, 0)).toBe(13);
  });

  it('should convert the draft time to UTC ISO', () => {
    expect(s.draftTimeUtc).toBe('2026-09-25T01:00:00.000Z'); // 21:00 ET
  });
});

describe('other parsers', () => {
  it('should find my team among the league teams', () => {
    const teams = parseTeams(fx('teams').body);
    expect(teams).toHaveLength(8);
    expect(teams.filter((t) => t.mine).map((t) => t.teamKey)).toEqual(['477.l.48535.t.6']);
  });

  it('should discover league and team keys from the logged-in user', () => {
    const [game] = parseMyTeams(fx('user_teams').body);
    expect(game?.gameKey).toBe('477');
    expect(game?.teams[0]).toMatchObject({ teamKey: '477.l.48535.t.6', leagueKey: '477.l.48535' });
  });

  it('should parse players with eligibility, ADP and ownership', () => {
    const ps = parsePlayers(fx('players_avail').body);
    expect(ps).toHaveLength(25);
    expect(ps[0]).toMatchObject({
      playerKey: '477.p.6743',
      name: 'Connor McDavid',
      nhlTeam: 'EDM',
      eligible: ['C', 'Util'],
      adp: 1.5,
      percentOwned: 100,
      ownership: 'freeagents',
    });
  });

  it('should parse an empty pre-draft roster', () => {
    const r = parseRoster(fx('roster').body);
    expect(r).toMatchObject({ teamKey: '477.l.48535.t.6', date: '2026-09-24', editable: false });
    expect(r.players).toEqual([]);
  });

  it('should report predraft status with no picks', () => {
    const d = parseDraftResults(fx('draftresults').body);
    expect(d.draftStatus).toBe('predraft');
    expect(d.picks.filter((p) => p.playerKey)).toEqual([]);
  });

  it('should parse transactions with ISO timestamps', () => {
    const tx = parseTransactions(fx('transactions').body);
    expect(tx.length).toBeGreaterThan(0);
    expect(tx[0]?.at).toMatch(/Z$/);
  });
});

describe('YahooFantasyClient over fixtures', () => {
  it('should build the documented players path and paginate', async () => {
    const page = fx('players_avail');
    const calls: string[] = [];
    const t = { get: async (p: string) => (calls.push(p), page.body) };
    const c = new YahooFantasyClient(t);
    await c.players('477.l.48535', { status: 'A', sort: 'OR', out: ['draft_analysis'] }, 50);
    expect(calls).toEqual([
      '/league/477.l.48535/players;sort=OR;status=A;start=0;count=25;out=draft_analysis',
      '/league/477.l.48535/players;sort=OR;status=A;start=25;count=25;out=draft_analysis',
    ]);
  });

  it('should read settings through a FixtureTransport', async () => {
    const f = fx('settings');
    const c = new YahooFantasyClient(new FixtureTransport({ [f.path]: f.body }));
    expect((await c.settings('477.l.48535')).name).toBe('Method Fantasy League');
  });
});

describe('session cookies', () => {
  const session: StoredSession = {
    savedAt: '2026-09-24T00:00:00Z',
    cookies: [
      {
        name: 'T',
        value: 't',
        domain: '.yahoo.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
      },
      {
        name: 'Y',
        value: 'y',
        domain: '.yahoo.com',
        path: '/',
        expires: 4e9,
        httpOnly: false,
        secure: true,
      },
      {
        name: 'OLD',
        value: 'x',
        domain: '.yahoo.com',
        path: '/',
        expires: 1,
        httpOnly: false,
        secure: false,
      },
      {
        name: 'MAIL',
        value: 'm',
        domain: 'mail.yahoo.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
      },
    ],
  };

  it('should send only unexpired cookies that match the request host', () => {
    expect(
      cookieHeaderFor(session, 'https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/x'),
    ).toBe('T=t; Y=y');
  });

  it('should never include cookie values in the session summary', () => {
    expect(JSON.stringify(describeSession(session))).not.toMatch(/"t"|"y"|value/);
  });

  it('should treat an HTML (signed-out) response as an auth error', async () => {
    const fetchImpl = (async () =>
      new Response('<html>sign in</html>', { status: 200 })) as typeof fetch;
    const t = new CookieTransport({ session, fetchImpl, minIntervalMs: 0 });
    await expect(t.get('/league/x/settings')).rejects.toBeInstanceOf(YahooAuthError);
  });

  it('should treat 401 as an auth error', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const t = new CookieTransport({ session, fetchImpl, minIntervalMs: 0 });
    await expect(t.get('/league/x/settings')).rejects.toBeInstanceOf(YahooAuthError);
  });
});
