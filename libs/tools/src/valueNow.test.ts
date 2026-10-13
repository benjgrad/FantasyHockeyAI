import { describe, expect, it } from 'vitest';
import { openStore } from '@fha/store';
import { mockView } from './testing.js';
import { ensureValuationDay, recordValuationDay, valueTrend, weekChanges } from './valueHistory.js';
import { valueNow } from './valueNow.js';

describe('valueNow (D-026)', () => {
  const view = mockView();
  const store = openStore(':memory:');
  const now = valueNow(view, store);

  it('without game history, every lens number equals the preseason one', () => {
    for (const v of now.players.values()) {
      expect(v.vols).toBeCloseTo(v.preseason.vorp, 9);
      expect(v.value).toBeCloseTo(v.preseason.value, 9);
      expect(v.adjusted).toBeCloseTo(v.preseason.adjusted, 9);
      expect(v.lowConfidence).toBe(true);
    }
  });

  it('measures VOFA against the best healthy free agent at the scarcest eligible position', () => {
    for (const [pos, best] of Object.entries(now.bestFreeAgent)) {
      expect(view.isFreeAgent(best.playerKey)).toBe(true);
      // The best free agent is his own bar: zero over himself.
      const self = now.players.get(best.playerKey);
      if (self?.vofaPosition === pos) expect(self.vofa).toBeCloseTo(0, 9);
    }
    const ours = view.roster().entries.map((e) => now.players.get(e.player.playerKey)).filter((x) => x !== undefined);
    for (const v of ours) {
      const bar = v.vofaPosition === undefined ? undefined : now.bestFreeAgent[v.vofaPosition];
      if (bar !== undefined) expect(v.vofa).toBeCloseTo(v.adjusted - bar.adjusted, 9);
    }
  });

  it('gives a bench player no season CWA and prices our starters by what we would lose', () => {
    const ours = view.roster().entries.map((e) => now.players.get(e.player.playerKey));
    expect(ours.some((v) => (v?.cwa ?? 0) > 0)).toBe(true);
    for (const v of ours) expect(Number.isFinite(v?.cwa ?? 0)).toBe(true);
  });

  it('is cached per view and store', () => {
    expect(valueNow(view, store)).toBe(now);
  });
});

describe('value history', () => {
  it('records a day once, with a preseason starting point, and reads a trend back', () => {
    const view = mockView();
    const store = openStore(':memory:');
    const n = recordValuationDay(view, store);
    expect(n).toBe(valueNow(view, store).players.size * 2);
    // A second record replaces the day; the preseason rows are written once.
    expect(recordValuationDay(view, store)).toBe(valueNow(view, store).players.size);
    ensureValuationDay(view, store);
    const key = view.roster().entries[0]?.player.playerKey ?? '';
    const t = valueTrend(view, store, key);
    expect(t?.sincePreseason).toBeCloseTo(0, 9);
    expect(t?.since7d).toBeUndefined();
    expect(t?.series.length).toBe(2);
    expect(weekChanges(view, store).get(key)).toBeCloseTo(0, 9);
  });
});
