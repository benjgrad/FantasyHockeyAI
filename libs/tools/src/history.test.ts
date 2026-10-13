import { describe, expect, it } from 'vitest';
import { openStore } from '@fha/store';
import type { SkaterGame } from '@fha/nhl';
import { formFor, historyFor, nhlIdFor } from './history.js';
import { mockView } from './testing.js';

const game = (nhlId: number, name: string, gameDate: string, gameId: number, g = 0): SkaterGame => ({
  nhlId, gameId, gameDate, season: gameDate >= '2026-09-01' ? '20262027' : '20252026', name,
  position: 'C', team: 'NJD', opponent: 'PHI', home: true, g, a: 0, pts: g, pm: 0, pim: 0, ppp: 0,
  shp: 0, gwg: 0, sog: 2, hit: 0, blk: 0, fow: 0, toiS: 1000,
});

describe('player history', () => {
  it('maps by the snapshot id, and builds form and the in-season lens from stored games', () => {
    const view = mockView();
    const p = view.roster().entries.find((e) => e.player.nhlId !== undefined && e.player.positionType === 'P')?.player;
    const store = openStore(':memory:');
    const id = p?.nhlId ?? 0;
    store.nhlGames.upsert({
      skaters: Array.from({ length: 30 }, (_, i) => game(id, p?.name ?? '', `2025-12-${String((i % 28) + 1).padStart(2, '0')}`, i + 1, i % 2)),
      goalies: [],
    });
    expect(nhlIdFor(view, store, p?.playerKey ?? '')).toBe(id);
    expect(historyFor(view, store, p?.playerKey ?? '')?.games).toHaveLength(30);
    const f = formFor(view, store, p?.playerKey ?? '', '2026-10-13');
    expect(f?.kind).toBe('skater');
    if (f?.kind !== 'skater') return;
    expect(f.form.windows.find((w) => w.label === 'season 20252026')?.gp).toBe(30);
    expect(f.inSeason.gpCurrent).toBe(0);
    expect(f.preseason).toBeDefined();
  });

  it('maps an unmapped player only on an exact, unique name (team breaks a tie)', () => {
    const view = mockView((snap) => {
      const p = snap.players.find((x) => x.positionType === 'P');
      if (p) delete p.nhlId;
    });
    const p = view.snap.players.find((x) => x.positionType === 'P' && x.nhlId === undefined);
    const store = openStore(':memory:');
    expect(nhlIdFor(view, store, p?.playerKey ?? '')).toBeUndefined();
    store.nhlGames.upsert({ skaters: [game(777, p?.name ?? '', '2026-10-01', 1)], goalies: [] });
    expect(nhlIdFor(view, store, p?.playerKey ?? '')).toBe(777);
    store.nhlGames.upsert({ skaters: [{ ...game(778, p?.name ?? '', '2026-10-01', 2), team: 'ZZZ' }], goalies: [] });
    // Two players share the name now: only the one on his Yahoo team is accepted, if any.
    const resolved = nhlIdFor(view, store, p?.playerKey ?? '');
    expect([777, undefined]).toContain(resolved);
  });
});
