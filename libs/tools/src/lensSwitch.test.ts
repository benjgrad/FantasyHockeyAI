import { describe, expect, it } from 'vitest';
import { Permissions } from '@fha/core';
import type { SkaterGame } from '@fha/nhl';
import { gateStateFor } from './gateState.js';
import { lensesFor } from './lensSwitch.js';
import { shadowReport } from './shadowReport.js';
import { testRun } from './testing.js';
import { rosLensView } from './valuationLens.js';

describe('shadow, then switch (D-026)', () => {
  it('uses preseason by default, and the lens of a lens is itself', () => {
    const run = testRun({ agent: 'lineup' });
    const perms = Permissions.parse({});
    const l = lensesFor(run.ctx.view, run.store, perms, 'lineup');
    expect(l.lens).toBe('preseason');
    expect(l.active).toBe(run.ctx.view);
    const ros = rosLensView(run.ctx.view, run.store).view;
    expect(l.other).toBe(ros);
    expect(rosLensView(ros, run.store).view).toBe(ros);
    const on = lensesFor(run.ctx.view, run.store, Permissions.parse({ valueLens: { lineup: 'rest-of-season' } }), 'lineup');
    expect(on.active).toBe(ros);
    expect(on.other).toBe(run.ctx.view);
  });

  it('records a protected-list disagreement once a day, and nothing when the lenses agree', () => {
    const run = testRun({ agent: 'waivers' });
    const perms = Permissions.parse({ protected: { topNByVorp: 3 } });
    gateStateFor(run.ctx.view, run.store, perms);
    // No game history: both lenses rank identically.
    expect(run.store.lensShadow.since('2000-01-01')).toEqual([]);

    // Our 4th-best player has a monster start: the rest-of-season lens protects him.
    const view = run.ctx.view;
    const ranked = view
      .roster()
      .entries.map((e) => e.player)
      .filter((p) => p.positionType === 'P' && p.nhlId !== undefined)
      .sort((a, b) => (view.valuation(b.playerKey)?.vorp ?? 0) - (view.valuation(a.playerKey)?.vorp ?? 0));
    const riser = ranked[3];
    expect(riser).toBeDefined();
    if (riser === undefined) return;
    const games: SkaterGame[] = Array.from({ length: 30 }, (_, i) => ({
      nhlId: riser.nhlId ?? 0, gameId: 9000 + i, gameDate: `2026-${i < 15 ? '10' : '11'}-${String((i % 15) + 1).padStart(2, '0')}`,
      season: '20262027', name: riser.name, position: 'C', team: 'NJD', opponent: 'PHI', home: true,
      g: 3, a: 3, pts: 6, pm: 3, pim: 2, ppp: 3, shp: 1, gwg: 1, sog: 9, hit: 5, blk: 3, fow: 10, toiS: 1500,
    }));
    const run2 = testRun({ agent: 'waivers' });
    run2.store.nhlGames.upsert({ skaters: games, goalies: [] });
    const g1 = gateStateFor(run2.ctx.view, run2.store, perms);
    gateStateFor(run2.ctx.view, run2.store, perms);
    expect(g1.protectedKeys).not.toContain(riser.playerKey);
    const rows = run2.store.lensShadow.since('2000-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe('protected');
    expect(rows[0]?.summary).toContain(riser.name);
    expect(shadowReport(run2.store, '2000-01-01', run2.ctx.view).counts['protected']).toBe(1);
  });
});
