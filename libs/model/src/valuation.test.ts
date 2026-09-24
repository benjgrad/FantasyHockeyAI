import { beforeEach, describe, expect, it } from 'vitest';
import { cat, goalie, goaliePool, league, resetIds, skater, skaterPool, slot } from './fixtures.js';
import { UnsupportedCategoryError } from './categories.js';
import { valuePlayers } from './valuation.js';

beforeEach(() => {
  resetIds();
});

const byName = (r: ReturnType<typeof valuePlayers>, name: string) => {
  const v = r.valuations.find((x) => x.name === name);
  if (!v) throw new Error(`no valuation for ${name}`);
  return v;
};

/** §12.2 required test 1. */
describe('GAA sign', () => {
  it('should rate the lower GAA higher, because lower is better', () => {
    const good = goalie({ savePct: 0.92, starts: 50, gaa: 2.1, name: 'Low GAA' });
    const bad = goalie({ savePct: 0.92, starts: 50, gaa: 3.4, name: 'High GAA' });
    const res = valuePlayers({
      settings: league(),
      projections: [...skaterPool(60), ...goaliePool(20), good, bad],
    });

    expect(byName(res, 'Low GAA').z['GAA']).toBeGreaterThan(byName(res, 'High GAA').z['GAA'] ?? 0);
    expect(byName(res, 'Low GAA').value).toBeGreaterThan(byName(res, 'High GAA').value);
  });

  it('should give a below-average GAA a negative z and an above-average one a positive z', () => {
    const res = valuePlayers({
      settings: league(),
      projections: [
        ...skaterPool(40),
        ...goaliePool(20),
        goalie({ savePct: 0.92, starts: 50, gaa: 1.9, name: 'Elite' }),
        goalie({ savePct: 0.88, starts: 50, gaa: 4.2, name: 'Sieve' }),
      ],
    });
    expect(byName(res, 'Elite').z['GAA']).toBeGreaterThan(0);
    expect(byName(res, 'Sieve').z['GAA']).toBeLessThan(0);
  });
});

/** §12.2 required test 2 — the exact case named in the spec. */
describe('SV% volume weighting', () => {
  it('should rank .920 over 60 starts above .925 over 10 starts', () => {
    const workhorse = goalie({ savePct: 0.92, starts: 60, name: 'Workhorse' });
    const cameo = goalie({ savePct: 0.925, starts: 10, name: 'Cameo' });
    const res = valuePlayers({
      settings: league({
        categories: [cat('G', 'P'), cat('SV%', 'G', { kind: 'rate' })],
      }),
      projections: [...skaterPool(40), ...goaliePool(20, 0.898), workhorse, cameo],
    });

    expect(byName(res, 'Workhorse').z['SV%']).toBeGreaterThan(byName(res, 'Cameo').z['SV%'] ?? 0);
  });

  it('should scale a rate advantage with workload rather than ignoring volume', () => {
    const many = goalie({ savePct: 0.925, starts: 60, name: 'Many' });
    const few = goalie({ savePct: 0.925, starts: 20, name: 'Few' });
    const res = valuePlayers({
      settings: league({ categories: [cat('G', 'P'), cat('SV%', 'G', { kind: 'rate' })] }),
      projections: [...skaterPool(40), ...goaliePool(20, 0.898), many, few],
    });
    expect(byName(res, 'Many').z['SV%']).toBeGreaterThan(byName(res, 'Few').z['SV%'] ?? 0);
  });
});

/** §12.2 required test 3. */
describe('category weights', () => {
  it('should remove a category entirely when its weight is zero', () => {
    const projections = [...skaterPool(60), ...goaliePool(20)];
    const settings = league();
    const full = valuePlayers({ settings, projections });
    const punted = valuePlayers({ settings, projections, weights: { SOG: 0 } });

    const a = full.valuations[0];
    if (!a) throw new Error('no valuations');
    const b = punted.valuations.find((v) => v.nhlId === a.nhlId);
    if (!b) throw new Error('player vanished');

    // The z-scores are unchanged; only the contribution to value is dropped.
    expect(b.z['SOG']).toBeCloseTo(a.z['SOG'] ?? 0, 10);
    expect(b.value).toBeCloseTo(a.value - (a.z['SOG'] ?? 0), 10);
  });

  it('should double a category contribution when its weight is two', () => {
    const projections = [...skaterPool(60), ...goaliePool(20)];
    const settings = league();
    const base = valuePlayers({ settings, projections });
    const heavy = valuePlayers({ settings, projections, weights: { G: 2 } });
    const a = base.valuations[0];
    if (!a) throw new Error('no valuations');
    const b = heavy.valuations.find((v) => v.nhlId === a.nhlId);
    expect(b?.value).toBeCloseTo(a.value + (a.z['G'] ?? 0), 10);
  });
});

/** §12.2 required test 4. */
describe('replacement level', () => {
  it('should change when Util slots are added, because flex slots deepen a position', () => {
    const projections = [...skaterPool(120), ...goaliePool(30)];
    const noUtil = valuePlayers({ settings: league(), projections });
    const withUtil = valuePlayers({
      settings: league({
        rosterSlots: [
          slot('C', 2),
          slot('LW', 2),
          slot('RW', 2),
          slot('D', 4),
          slot('Util', 2),
          slot('G', 2),
          slot('BN', 4, false),
        ],
      }),
      projections,
    });

    expect(withUtil.replacement).not.toEqual(noUtil.replacement);
    // Extra flex slots go to the strongest position, pushing its replacement bar down.
    const dropped = (['C', 'LW', 'RW', 'D'] as const).some(
      (p) => (withUtil.replacement[p] ?? 0) < (noUtil.replacement[p] ?? 0),
    );
    expect(dropped).toBe(true);
  });

  it('should size the skater pool from teams times starting skater slots, Util included', () => {
    const res = valuePlayers({
      settings: league({
        numTeams: 10,
        rosterSlots: [
          slot('C', 2),
          slot('D', 2),
          slot('Util', 1),
          slot('G', 2),
          slot('BN', 3, false),
        ],
      }),
      projections: [...skaterPool(120), ...goaliePool(30)],
    });
    expect(res.skaterPoolSize).toBe(10 * 5);
    expect(res.goaliePoolSize).toBe(10 * 2);
  });
});

/** §12.2 required test 5. */
describe('pool iteration', () => {
  it('should converge within the iteration cap', () => {
    const res = valuePlayers({
      settings: league(),
      projections: [...skaterPool(200), ...goaliePool(60)],
    });
    expect(res.iterations).toBeLessThanOrEqual(8);
    expect(res.iterations).toBeGreaterThanOrEqual(1);
  });

  it('should be deterministic across repeated runs', () => {
    const projections = [...skaterPool(120), ...goaliePool(30)];
    const a = valuePlayers({ settings: league(), projections });
    const b = valuePlayers({ settings: league(), projections });
    expect(a.valuations.map((v) => v.nhlId)).toEqual(b.valuations.map((v) => v.nhlId));
  });
});

/** §12.2 required test 6. */
describe('multi-position players', () => {
  it('should value a player at his scarcest eligible position, the lowest replacement bar', () => {
    const settings = league({
      rosterSlots: [
        slot('C', 2),
        slot('LW', 2),
        slot('RW', 2),
        slot('D', 4),
        slot('Util', 2),
        slot('G', 2),
        slot('BN', 4, false),
      ],
    });
    const res = valuePlayers({
      settings,
      projections: [...skaterPool(150), ...goaliePool(30)],
    });

    const multi = res.valuations.find((v) => v.positionType === 'P' && v.position === 'LW');
    if (!multi) throw new Error('no LW found');

    const bars = ['LW', 'Util']
      .map((p) => res.replacement[p])
      .filter((x): x is number => x !== undefined);
    const lowest = Math.min(...bars, res.replacement[multi.position] ?? 0);
    expect(multi.vorp).toBeCloseTo(multi.value - lowest, 10);
    expect(res.replacement[multi.vorpPosition]).toBeCloseTo(lowest, 10);
  });
});

describe('unsupported categories', () => {
  it('should fail loudly naming the category rather than ignoring it', () => {
    expect(() =>
      valuePlayers({
        settings: league({ categories: [cat('G', 'P'), cat('FLURBS', 'P')] }),
        projections: skaterPool(20),
      }),
    ).toThrow(UnsupportedCategoryError);
  });

  it('should ignore display-only categories without complaining', () => {
    const settings = league({
      categories: [cat('G', 'P'), { ...cat('FLURBS', 'P'), isDisplayOnly: true }],
    });
    expect(() => valuePlayers({ settings, projections: skaterPool(20) })).not.toThrow();
  });
});

describe('degenerate inputs', () => {
  it('should score a constant category zero instead of producing NaN', () => {
    const flat = [
      skater('C', { G: 10, A: 10, SOG: 10, P: 20, name: 'a' } as Record<string, number>),
      skater('LW', { G: 10, A: 10, SOG: 10, P: 20 }),
      skater('RW', { G: 10, A: 10, SOG: 10, P: 20 }),
    ];
    const res = valuePlayers({ settings: league(), projections: flat });
    for (const v of res.valuations) {
      expect(Number.isFinite(v.value)).toBe(true);
      expect(Number.isFinite(v.vorp)).toBe(true);
    }
  });
});
