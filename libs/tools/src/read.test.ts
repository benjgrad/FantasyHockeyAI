import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@fha/llm';
import { evaluateTrade, getPendingTrades } from './tools/trades.js';
import { getLeagueContext, getPlayers, getTeamRoster, searchPlayers } from './tools/league.js';
import { getMatchup } from './tools/matchup.js';
import { getLineupSuggestion, getRoster, getRosterHealth } from './tools/roster.js';
import { getGoalieStarts, getNews, getSchedule } from './tools/schedule.js';
import { evaluateTradeKeys, remainingWeekLine } from './modelInputs.js';
import { mockView, testRun } from './testing.js';

const MAKAR = '477.p.7519';
const OURS_IN_PENDING = '477.p.6744';
const THEIRS_IN_PENDING = '477.p.7899';

function summary<T>(r: ToolResult<T>): string {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.summary ?? '';
}

describe('read tools over the mock league', () => {
  it('getLeagueContext names the categories, slots, week and limits', async () => {
    const { ctx } = testRun();
    const s = summary(await getLeagueContext.execute({}, ctx));
    expect(s).toContain('week 1');
    expect(s).toContain('Categories: G, A, +/-, PIM, PPP, SHP, GWG, SOG, HIT, W, GAA, SV%, SHO');
    expect(s).toContain('Adds this week: 0 used of 3');
    expect(s).toContain('Our team: Our Team');
    expect(s).toContain('dry run');
  });

  it('getRoster shows slot, status, game, lock and value per player', async () => {
    const { ctx } = testRun();
    const r = await getRoster.execute({}, ctx);
    const s = summary(r);
    expect(s.split('\n')).toHaveLength(1 + 1 + 17); // title, header, 17 players
    const makar = s.split('\n').find((l) => l.startsWith(MAKAR)) ?? '';
    expect(makar).toContain('Cale Makar');
    expect(makar).toMatch(/\| D \| O \|/);
    expect(makar).toMatch(/no$|\| no \|/);
  });

  it('getRoster marks a player locked once his game has started', async () => {
    const { ctx } = testRun({ now: '2026-10-14T03:00:00.000Z' });
    const s = summary(await getRoster.execute({ date: '2026-10-13' }, ctx));
    expect(s).toContain('LOCKED');
  });

  it('getRoster refuses a date outside the schedule with an instruction', async () => {
    const { ctx } = testRun();
    const r = await getRoster.execute({ date: '2027-01-01' }, ctx);
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(!r.ok && r.error).toContain('2026-10-13 to 2026-10-19');
  });

  it('getPlayers batches details with projections', async () => {
    const { ctx } = testRun();
    const s = summary(await getPlayers.execute({ playerKeys: [MAKAR, THEIRS_IN_PENDING] }, ctx));
    expect(s).toContain('Cale Makar');
    expect(s).toContain('Mock Team 2');
    expect(s).toMatch(/SOG \d/);
  });

  it('getPlayers refuses an unknown key with an instruction, not a guess (P3)', async () => {
    const { ctx } = testRun();
    const r = await getPlayers.execute({ playerKeys: [MAKAR, '477.p.99999999'] }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Unknown playerKey\(s\): 477\.p\.99999999\. Use only playerKeys/);
  });

  it('searchPlayers lists only free agents, best value first, within the limit', async () => {
    const { ctx } = testRun();
    const r = await searchPlayers.execute({ position: 'D', status: 'FA', sort: 'value', limit: 5 }, ctx);
    if (!r.ok) throw new Error(r.error);
    const values = r.data.players.map((p) => p.value ?? 0);
    expect(r.data.players).toHaveLength(5);
    expect(r.data.players.every((p) => p.owner === 'free agent')).toBe(true);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(r.summary).toContain('free agent');
  });

  it('searchPlayers separates waivers (a claim, with the clear date) from free agents (D-029)', async () => {
    const { ctx } = testRun({
      edit: (snap) => {
        const owned = new Set(Object.values(snap.rosters).flat().map((e) => e.playerKey));
        const fa = snap.players.find((p) => !owned.has(p.playerKey) && p.positionType === 'P');
        if (fa) Object.assign(fa, { onWaivers: true, waiverDate: '2026-10-15', name: 'Waiver Guy' });
      },
    });
    const w = summary(await searchPlayers.execute({ status: 'W', sort: 'value', limit: 5 }, ctx));
    expect(w).toMatch(/Waiver Guy.*waivers until 2026-10-15/);
    const f = summary(await searchPlayers.execute({ status: 'FA', sort: 'value', limit: 25, query: 'Waiver Guy' }, ctx));
    expect(f).toMatch(/no players match/);
  });

  it('searchPlayers matches names without accents or case', async () => {
    const { ctx } = testRun({
      edit: (snap) => {
        const owned = new Set(Object.values(snap.rosters).flat().map((e) => e.playerKey));
        const fa = snap.players.find((p) => !owned.has(p.playerKey) && p.positionType === 'P');
        if (fa) Object.assign(fa, { name: 'Nils Höglander' });
      },
    });
    const s = summary(await searchPlayers.execute({ status: 'FA', sort: 'value', limit: 5, query: 'HOGLANDER' }, ctx));
    expect(s).toContain('Nils Höglander');
  });

  it('getSchedule counts games per team and per rostered player', async () => {
    const { ctx } = testRun();
    const s = summary(await getSchedule.execute({ from: '2026-10-13', to: '2026-10-19' }, ctx));
    expect(s).toContain('Games per NHL team');
    expect(s).toMatch(/Cale Makar \d/);
  });

  it('getGoalieStarts reports unknown when nothing reported, never a pretend confirmation', async () => {
    const { ctx } = testRun();
    const r = await getGoalieStarts.execute({ date: '2026-10-13' }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.goalies).toHaveLength(2);
    expect(r.data.goalies.every((g) => ['unknown', 'noGame', 'out'].includes(g.start))).toBe(true);
    expect(r.summary).toContain('unknown = no report yet');
    for (const g of r.data.goalies.filter((x) => x.start === 'unknown')) {
      expect(g.evidence[0]).toMatch(/no report yet/);
      expect(g.pStart).toBeLessThan(1);
    }
  });

  it('getNews gives status and says when nothing is recorded', async () => {
    const { ctx } = testRun({ edit: (s) => (s.news[MAKAR] = ['Upper-body injury, out 2 weeks']) });
    const s = summary(await getNews.execute({ playerKeys: [MAKAR, OURS_IN_PENDING] }, ctx));
    expect(s).toContain('Cale Makar [O]: Upper-body injury, out 2 weeks');
    expect(s).toContain('no news recorded');
  });

  it('getMatchup projects every category against the derived opponent with weights', async () => {
    const { ctx } = testRun({ agent: 'matchup' });
    const r = await getMatchup.execute({}, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.opponent).toBe('Mock Team 1');
    expect(r.data.categories).toHaveLength(13);
    for (const c of r.data.categories) {
      expect(c.pWin).toBeGreaterThanOrEqual(0);
      expect(c.pWin).toBeLessThanOrEqual(1);
      expect([0.3, 1, 1.5]).toContain(c.suggestedWeight);
    }
    expect(r.summary).toContain('Expected categories won');
    expect(await getMatchup.execute({ week: 5 }, ctx)).toMatchObject({ ok: false });
  });

  it('getTeamRoster resolves a team by name and lists names on a miss', async () => {
    const { ctx } = testRun({ agent: 'trades' });
    expect(summary(await getTeamRoster.execute({ teamName: 'mock team 2' }, ctx))).toContain(
      THEIRS_IN_PENDING,
    );
    const miss = await getTeamRoster.execute({ teamName: 'Nope FC' }, ctx);
    expect(!miss.ok && miss.error).toContain('"Mock Team 1"');
    const own = await getTeamRoster.execute({ teamName: 'Our Team' }, ctx);
    expect(!own.ok && own.error).toContain('use getRoster');
  });

  it('getPendingTrades shows the incoming offer from our side', async () => {
    const { ctx } = testRun({ agent: 'trades' });
    const r = await getPendingTrades.execute({}, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.trades).toEqual([
      expect.objectContaining({
        transactionKey: '477.l.48535.pt.1',
        direction: 'incoming',
        partner: 'Mock Team 2',
        weGive: [OURS_IN_PENDING],
        weGet: [THEIRS_IN_PENDING],
      }),
    ]);
  });

  it('evaluateTrade scores both sides and checks ownership', async () => {
    const { ctx } = testRun({ agent: 'trades' });
    const input = { partnerTeamName: 'Mock Team 2', give: [OURS_IN_PENDING], get: [THEIRS_IN_PENDING] };
    const r = await evaluateTrade.execute(input, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(Number.isFinite(r.data.deltaUs)).toBe(true);
    expect(r.summary).toContain('Trade with Mock Team 2');
    const wrong = await evaluateTrade.execute({ ...input, get: [MAKAR] }, ctx);
    expect(!wrong.ok && wrong.error).toContain("not on Mock Team 2's roster");
  });

  it('getLineupSuggestion moves the out starter to the free IR seat, not the bench', async () => {
    // Both IR seats are empty in the mock roster and O is IR-eligible, so the solver's
    // IR-first rule frees his roster spot (previously this accepted BN as well).
    const { ctx } = testRun();
    const s = summary(await getLineupSuggestion.execute({ date: '2026-10-13' }, ctx));
    expect(s).toMatch(/Cale Makar D→IR/);
  });
});

describe('availability in the read tools (draft-night flaw 4)', () => {
  it('getRoster shows each player’s availability with an expected return', async () => {
    const { ctx } = testRun();
    const r = await getRoster.execute({}, ctx);
    if (!r.ok) throw new Error(r.error);
    const makar = r.data.players.find((p) => p.playerKey === MAKAR);
    expect(makar).toMatchObject({ status: 'O', playProb: 0, expectedReturn: '2026-10-23' });
    expect(makar?.availability).toBe('O, out ~10 days, back ~2026-10-23 (default estimate)');
    expect(r.summary).toContain('O, out ~10 days');
  });

  it('getPlayers and getNews carry the availability label', async () => {
    const { ctx } = testRun();
    const p = await getPlayers.execute({ playerKeys: [MAKAR, OURS_IN_PENDING] }, ctx);
    if (!p.ok) throw new Error(p.error);
    expect(p.data[0]?.availability).toContain('O, out ~10 days');
    expect(p.data[1]?.availability).toBe('healthy');
    const n = summary(await getNews.execute({ playerKeys: [MAKAR] }, ctx));
    expect(n).toContain('availability: O, out ~10 days');
  });

  it('getRosterHealth flags the out starters and the IR moves that free their spots', async () => {
    const { ctx } = testRun();
    const r = await getRosterHealth.execute({ date: '2026-10-13' }, ctx);
    if (!r.ok) throw new Error(r.error);
    const out = r.data.unplayableStarters.filter((u) => u.reason.startsWith('O'));
    expect(out.map((u) => u.playerKey).sort()).toEqual(['477.p.3637', MAKAR].sort());
    expect(r.data.irMovesAvailable.map((m) => m.to)).toEqual(['IR', 'IR']);
    expect(r.summary).toContain('Cale Makar (477.p.7519) starts at D but will not play');
    expect(r.summary).toContain('can move D → IR');
  });

  it('getRosterHealth refuses a date outside the schedule', async () => {
    const { ctx } = testRun();
    expect(await getRosterHealth.execute({ date: '2027-01-01' }, ctx)).toMatchObject({ ok: false });
  });
});

describe('availability in the model inputs', () => {
  const setStatus = (key: string, status: string) => (snap: { players: { playerKey: string; status?: string }[] }) => {
    const p = snap.players.find((x) => x.playerKey === key);
    if (p) p.status = status;
  };

  it('takes a DTD starter’s expected missed game off our weekly line', () => {
    const healthy = mockView();
    const dtd = mockView(setStatus(OURS_IN_PENDING, 'DTD'));
    const sog = (v: typeof healthy) =>
      remainingWeekLine(v, v.teamKey, v.snap.date).counts['SOG'] ?? 0;
    expect(sog(dtd)).toBeLessThan(sog(healthy));
  });

  it('values an out player in a trade by the share of the season he plays', () => {
    const e = evaluateTradeKeys(mockView(), '477.l.48535.t.102', [MAKAR], [THEIRS_IN_PENDING]);
    expect(e.reasons.join(' ')).toMatch(/Cale Makar is expected to play \d+% of the remaining season/);
  });
});
