import { describe, expect, it } from 'vitest';
import type { SkaterGame } from '@fha/nhl';
import { compareBy, type SortKey } from './playerSort.js';
import { testRun } from './testing.js';
import { searchPlayers } from './tools/league.js';

const game = (nhlId: number, name: string, gameDate: string, gameId: number, ppp: number): SkaterGame => ({
  nhlId, gameId, gameDate, season: '20262027', name, position: 'C', team: 'NJD', opponent: 'PHI',
  home: true, g: 0, a: ppp, pts: ppp, pm: 0, pim: 0, ppp, shp: 0, gwg: 0, sog: 2, hit: 0, blk: 0,
  fow: 0, toiS: 1000,
});

type Rows = { players: { name: string; sortedBy: Record<string, number | null> }[] };
const rowsOf = (r: Awaited<ReturnType<typeof searchPlayers.execute>>): Rows['players'] => {
  if (!r.ok) throw new Error(r.error);
  return (r.data as Rows).players;
};

describe('searchPlayers sort (D-039)', () => {
  it('requires a sort, each key with its order', () => {
    expect(searchPlayers.input.safeParse({ status: 'FA' }).success).toBe(false);
    expect(searchPlayers.input.safeParse({ sort: [{ by: 'cwa' }] }).success).toBe(false);
    expect(searchPlayers.input.safeParse({ sort: [] }).success).toBe(false);
    expect(searchPlayers.input.safeParse({ sort: [{ by: 'fit', order: 'desc' }] }).success).toBe(true);
  });

  it('refuses a category without a basis, a category the league does not score, and a stray basis', async () => {
    const { ctx } = testRun();
    const run = (sort: SortKey[]) => searchPlayers.execute({ sort, status: 'FA' }, ctx);
    const noBasis = await run([{ by: 'PPP', order: 'desc' }]);
    expect(!noBasis.ok && noBasis.error).toMatch(/needs a basis: projected, season/);
    const unscored = await run([{ by: 'FW', order: 'desc', basis: 'season' }]);
    expect(!unscored.ok && unscored.error).toMatch(/FW is not scored in this league/);
    const stray = await run([{ by: 'cwa', order: 'desc', basis: 'season' }]);
    expect(!stray.ok && stray.error).toMatch(/basis applies to a category/);
  });

  it('ranks by a projected category either way, and shows the key as a column', async () => {
    const { ctx } = testRun();
    const desc = rowsOf(await searchPlayers.execute({ sort: [{ by: 'PPP', basis: 'projected', order: 'desc' }], limit: 8 }, ctx));
    const values = desc.map((p) => p.sortedBy['PPP projected'] ?? -1);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    const asc = rowsOf(await searchPlayers.execute({ sort: [{ by: 'GAA', basis: 'projected', order: 'asc' }], position: 'G', limit: 5 }, ctx));
    const gaa = asc.map((p) => p.sortedBy['GAA projected'] ?? 99);
    expect(gaa).toEqual([...gaa].sort((a, b) => a - b));
    const s = await searchPlayers.execute({ sort: [{ by: 'PPP', basis: 'projected', order: 'desc' }], limit: 3 }, ctx);
    expect(s.ok && s.summary).toMatch(/by PPP \(projected per game.*\), highest first/);
    expect(s.ok && s.summary).toContain('PPP projected');
  });

  it("ranks by this season's games, and a player without games sinks either way", async () => {
    const { ctx, store } = testRun();
    const fas = rowsOf(await searchPlayers.execute({ sort: [{ by: 'value', order: 'desc' }], position: 'C', limit: 3 }, ctx));
    const [a, b] = fas.map((r) => ctx.view.snap.players.find((p) => p.name === r.name));
    if (a?.nhlId === undefined || b?.nhlId === undefined) throw new Error('fixture needs mapped centres');
    store.nhlGames.upsert({
      skaters: [
        game(a.nhlId, a.name, '2026-10-08', 1, 1),
        game(b.nhlId, b.name, '2026-10-08', 2, 2),
        game(b.nhlId, b.name, '2026-10-10', 3, 1),
      ],
      goalies: [],
    });
    for (const order of ['desc', 'asc'] as const) {
      const r = rowsOf(await searchPlayers.execute({ sort: [{ by: 'PPP', basis: 'season', order }], position: 'C', limit: 25 }, ctx));
      const named = r.map((x) => x.name);
      expect(named.slice(0, 2)).toEqual(order === 'desc' ? [b.name, a.name] : [a.name, b.name]);
      expect(r[2]?.sortedBy['PPP season']).toBeNull();
    }
    const perGame = rowsOf(await searchPlayers.execute({ sort: [{ by: 'PPP', basis: 'seasonPerGame', order: 'desc' }], position: 'C', limit: 2 }, ctx));
    expect(perGame.map((x) => x.sortedBy['PPP seasonPerGame'])).toEqual([1.5, 1]);
  });

  it('breaks ties in the first key by the second, in its own order', () => {
    const spec: SortKey[] = [
      { by: 'G', basis: 'season', order: 'desc' },
      { by: 'PIM', basis: 'season', order: 'asc' },
    ];
    const rows = [[2, 9], [3, 1], [2, 4], [undefined, 0]];
    expect(rows.sort(compareBy(spec))).toEqual([[3, 1], [2, 4], [2, 9], [undefined, 0]]);
  });

  it('sorts by fit, and every row carries it', async () => {
    const { ctx } = testRun();
    const r = rowsOf(await searchPlayers.execute({ sort: [{ by: 'fit', order: 'desc' }], limit: 6 }, ctx));
    const scores = r.map((p) => p.sortedBy['fit score'] ?? -99);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    const s = await searchPlayers.execute({ sort: [{ by: 'fit', order: 'desc' }], limit: 2 }, ctx);
    expect(s.ok && s.summary).toContain('| Fit |');
  });
});
