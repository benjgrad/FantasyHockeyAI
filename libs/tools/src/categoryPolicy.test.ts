import { describe, expect, it } from 'vitest';
import { openStore, type SeasonStrategyInsert, type Store } from '@fha/store';
import {
  applyStrategy,
  categoryPolicy,
  codeTargets,
  needWeights,
  TARGET_WEIGHT,
  weekOverlay,
} from './categoryPolicy.js';
import { codeNeedWeights, fitLens, playerFit } from './fit.js';
import { sortValues } from './playerSort.js';
import { mockView } from './testing.js';
import type { LeagueView } from './view.js';

const intent = { targets: ['SOG', 'A'], surplus: ['HIT', 'PIM'], punts: ['SHP'] };

const strategyFor = (view: LeagueView, over: Partial<SeasonStrategyInsert> = {}): SeasonStrategyInsert => ({
  leagueKey: view.snap.leagueKey,
  author: 'strategy',
  stance: 'contend',
  ...intent,
  principles: ['Trade from HIT/PIM for SOG'],
  rationale: 'test',
  reviewBy: '2026-11-09',
  ...over,
});

describe('applyStrategy: the one rule laying intent over code’s weights (D-041)', () => {
  const base = { SOG: 0.9, A: 1.6, HIT: 1.3, PIM: 0.2, SHP: 1.1, G: 1 };

  it('punts to 0, floors targets at 1.2, caps surplus at 1, leaves the rest alone', () => {
    expect(applyStrategy(base, intent)).toEqual({
      SOG: TARGET_WEIGHT,
      A: 1.6,
      HIT: 1,
      PIM: 0.2,
      SHP: 0,
      G: 1,
    });
  });

  it('ignores categories the league does not score, and never mutates its input', () => {
    const copy = { ...base };
    const out = applyStrategy(base, { targets: ['FOW'], surplus: [], punts: ['BLK'] });
    expect(out).toEqual(base);
    expect(base).toEqual(copy);
  });

  it('the week takes the punts only: a season target does not boost a locked week', () => {
    expect(weekOverlay(base, intent)).toEqual({ ...base, SHP: 0 });
  });
});

describe('codeTargets', () => {
  it('takes the heaviest weights at or above 1.2, at most four', () => {
    expect(codeTargets({ A: 1.1, G: 1.5, HIT: 1.3, W: 1.25, SOG: 2, PPP: 1.21 })).toEqual([
      'SOG',
      'G',
      'HIT',
      'W',
    ]);
  });

  it('falls back to the two heaviest when no weight stands out', () => {
    expect(codeTargets({ A: 1, G: 1.1, HIT: 0.9 })).toEqual(['G', 'A']);
  });
});

describe('categoryPolicy', () => {
  it("without a strategy: code's targets and weights, named as the audit's", () => {
    const view = mockView();
    const store = openStore(':memory:');
    const p = categoryPolicy(view, store);
    expect(p.source).toEqual({ kind: 'audit' });
    expect(p.weights).toEqual(p.codeWeights);
    expect(p.targets).toEqual(codeTargets(p.codeWeights));
    expect(p.punts).toEqual([]);
    for (const t of p.targets) expect(p.roles[t]).toBe('target');
  });

  it('with a strategy: its lists, roles and the overlaid weights', () => {
    const view = mockView();
    const store = openStore(':memory:');
    const v = store.seasonStrategy.add(strategyFor(view));
    const p = categoryPolicy(view, store);
    expect(p.source).toEqual({
      kind: 'strategy',
      id: v.id,
      author: 'strategy',
      createdAt: v.createdAt,
      reviewBy: '2026-11-09',
    });
    expect([p.targets, p.surplus, p.punts]).toEqual([intent.targets, intent.surplus, intent.punts]);
    expect(p.roles).toMatchObject({ SOG: 'target', HIT: 'surplus', SHP: 'punt', G: 'neutral' });
    expect(p.weights).toEqual(applyStrategy(codeNeedWeights(view, store), intent));
    expect(needWeights(view, store)).toEqual(p.weights);
  });

  it('picks up a new strategy version on the same view', () => {
    const view = mockView();
    const store = openStore(':memory:');
    store.seasonStrategy.add(strategyFor(view));
    expect(categoryPolicy(view, store).targets).toEqual(['SOG', 'A']);
    store.seasonStrategy.add(strategyFor(view, { targets: ['PPP'], punts: [] }));
    const p = categoryPolicy(view, store);
    expect(p.targets).toEqual(['PPP']);
    expect(p.weights['SHP']).toBe(p.codeWeights['SHP']);
  });

  it("says where the strategy and code's audit disagree", () => {
    const view = mockView();
    const store = openStore(':memory:');
    const code = categoryPolicy(view, store).targets;
    store.seasonStrategy.add(strategyFor(view, { targets: [], surplus: [], punts: [] }));
    const p = categoryPolicy(view, store);
    expect(p.disagreements.join(' ')).toContain(`The audit also rates ${code.join(', ')} highly.`);
  });
});

describe('the strategy reaches fit and the fit sort', () => {
  function puntedEffect(store: Store, view: LeagueView) {
    const lens = fitLens(view, store);
    const p = view.snap.players.find(
      (x) => x.positionType === 'P' && (lens.view.valuation(x.playerKey)?.z['SOG'] ?? 0) > 1,
    );
    if (p === undefined) throw new Error('fixture needs a strong-SOG skater');
    return { p, fit: () => playerFit(lens, needWeights(view, store), p).fit ?? NaN };
  }

  it('punting a category he is strong in lowers his fit, and the fit sort reads it', () => {
    const view = mockView();
    const store = openStore(':memory:');
    const { p, fit } = puntedEffect(store, view);
    const sortFit = () => sortValues({ view, store, now: undefined }, [{ by: 'fit', order: 'desc' }])(p)[0];
    const before = fit();
    const sortedBefore = sortFit();
    store.seasonStrategy.add(strategyFor(view, { targets: [], surplus: [], punts: ['SOG'] }));
    expect(needWeights(view, store)['SOG']).toBe(0);
    expect(fit()).toBeLessThan(before);
    expect(sortFit() ?? NaN).toBeLessThan(sortedBefore ?? NaN);
  });
});
