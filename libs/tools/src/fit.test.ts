import { describe, expect, it } from 'vitest';
import type { SkaterGame } from '@fha/nhl';
import { openStore } from '@fha/store';
import { fitLens, needWeights, playerFit } from './fit.js';
import { mockView } from './testing.js';

const hot = (nhlId: number, name: string, i: number): SkaterGame => ({
  nhlId, gameId: 900 + i, gameDate: `2026-10-0${(i % 9) + 1}`, season: '20262027', name,
  position: 'C', team: 'NJD', opponent: 'PHI', home: true, g: 2, a: 2, pts: 4, pm: 2, pim: 2,
  ppp: 2, shp: 0, gwg: 1, sog: 8, hit: 4, blk: 1, fow: 5, toiS: 1300,
});

describe('fit on the rest-of-season lens (D-040)', () => {
  it("moves with this season's games, and says which lens it read", () => {
    const view = mockView();
    const p = view.snap.players.find((x) => x.positionType === 'P' && x.nhlId !== undefined && view.isFreeAgent(x.playerKey));
    if (p?.nhlId === undefined) throw new Error('fixture needs a mapped free-agent skater');
    const quiet = openStore(':memory:');
    const before = playerFit(fitLens(view, quiet), needWeights(view, quiet), p);
    const busy = openStore(':memory:');
    busy.nhlGames.upsert({ skaters: Array.from({ length: 9 }, (_, i) => hot(p.nhlId ?? 0, p.name, i)), goalies: [] });
    const v2 = mockView();
    const after = playerFit(fitLens(v2, busy), needWeights(v2, busy), p);
    expect(after.lens).toBe('rest-of-season');
    expect(after.score ?? 0).toBeGreaterThan(before.score ?? 0);
    expect(after.z['SOG'] ?? 0).toBeGreaterThan(before.z['SOG'] ?? 0);
  });

  it('without a store, reads the preseason values and names them', () => {
    const view = mockView();
    const p = view.snap.players.find((x) => x.positionType === 'P' && view.valuation(x.playerKey) !== undefined);
    if (p === undefined) throw new Error('fixture needs a valued skater');
    const lens = fitLens(view);
    expect(lens).toEqual({ view, name: 'preseason' });
    const f = playerFit(lens, needWeights(view), p);
    expect(f.lens).toBe('preseason');
    expect(f.z).toEqual(view.valuation(p.playerKey)?.z);
  });
});
