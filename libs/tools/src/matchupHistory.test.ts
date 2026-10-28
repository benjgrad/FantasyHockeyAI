import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStore, type ArchiveKind } from '@fha/store';
import { missedStarts, missedTotals } from './lineupRetro.js';
import { loadHistory, resultsOf, standingsOf } from './matchupHistory.js';
import { testRun, type TestRun } from './testing.js';
import { getMatchupHistory } from './tools/history.js';

/**
 * D-038 on the real league: weeks 1-3 as Yahoo scored them (recorded 2026-10-25), with week 3's
 * counted lines for us and our opponent and our seven days, read on the 10-24 snapshot.
 */
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/league/${name}`, import.meta.url));
const ROWS = JSON.parse(readFileSync(fixture('archive-2026-10-25.json'), 'utf-8')) as {
  kind: ArchiveKind;
  week: number;
  ref: string;
  body: unknown;
}[];
const L = '477.l.48535';
const US = '477.l.48535.t.6';

let run: TestRun;

beforeAll(() => {
  const store = openStore(':memory:');
  for (const r of ROWS) store.matchupArchive.put({ leagueKey: L, ...r });
  run = testRun({
    agent: 'strategy',
    store,
    snapshotPath: fixture('live-2026-10-24.json'),
  });
});

describe('standings from the archive', () => {
  it('match Yahoo’s: we are 24-12-3 on categories after three weeks', () => {
    const h = loadHistory(run.store, L);
    const s = standingsOf(h.weeks);
    expect(s[0]?.categories).toEqual({ w: 24, l: 12, t: 3 }); // Yahoo's leader, 10-25
    expect(s.find((x) => x.teamKey === US)?.categories).toEqual({ w: 24, l: 12, t: 3 });
    expect(s.map((x) => x.categories.w + x.categories.l + x.categories.t)).toEqual(
      Array.from({ length: 8 }, () => 39),
    );
  });

  it('week 3: we lost 6-7 to "I drop my best players"', () => {
    const h = loadHistory(run.store, L);
    const r = resultsOf(h.weeks[2]!).find((x) => x.teamKey === US);
    expect(r).toMatchObject({ opponentKey: '477.l.48535.t.2', outcome: 'L' });
    expect([r?.won.length, r?.lost.length]).toEqual([6, 7]);
  });
});

describe('missed starts', () => {
  it('counts a benched player only where a seat he fits sat idle', () => {
    const h = loadHistory(run.store, L);
    const missed = missedStarts(h.days);
    for (const m of missed) {
      const day = h.days.find((d) => d.date === m.date);
      const idle = day?.players.find((p) => p.name === m.idle);
      expect(Object.keys(idle?.stats ?? { x: 1 })).toEqual([]);
      expect(day?.players.find((p) => p.playerKey === m.playerKey)?.eligible).toContain(m.seat);
    }
    const totals = missedTotals(missed, ['G', 'SOG', 'SV%']);
    expect(totals['SV%']).toBeUndefined();
  });
});

describe('getMatchupHistory', () => {
  it('without a week: standings and our weeks', async () => {
    const r = await getMatchupHistory.execute({}, run.ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.summary).toContain('Standings over weeks 1, 2, 3');
    expect(r.summary).toContain("Ben's Astonishing Team (us) | 24-12-3");
  });

  it('week 3: the score by category, both sides’ lines, and our missed starts', async () => {
    const r = await getMatchupHistory.execute({ week: 3 }, run.ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.summary).toContain("Ben's Astonishing Team vs I drop my best players: L 6-7-0");
    expect(r.summary).toContain('Missed starts (7 days archived)');
    expect(r.summary).toContain('Nico Hischier');
  });

  it('refuses an unknown team and points the current week at getMatchup', async () => {
    const bad = await getMatchupHistory.execute({ team: '477.l.48535.t.99' }, run.ctx);
    expect(bad.ok).toBe(false);
    const now = await getMatchupHistory.execute({ week: 4 }, run.ctx);
    expect(!now.ok && now.error).toContain('getMatchup');
  });
});
