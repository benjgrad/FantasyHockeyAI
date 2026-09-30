import { describe, expect, it } from 'vitest';
import { PlayerCard } from '@fha/api';
import type { LeagueSnapshot, Player } from '@fha/core';
import { LeagueView, MOCK_SETTINGS } from '@fha/tools';
import { HttpError } from './http.js';
import { buildCard, cardContext, categoriesFor } from './players.js';
import { compare, deltaOf, resolveCompareKeys } from './playersCompare.js';
import {
  categoryStrength,
  discountedRoster,
  labelFor,
  seasonShare,
  targetsFor,
  type StrengthRow,
} from './playersStrength.js';
import { FIXTURE, START } from './testing.js';

/** Cards, comparisons and category strength over the real scrubbed 2026-09-29 league. */
const base = LeagueView.fromFile(FIXTURE, MOCK_SETTINGS);
const edited = (edit: (s: LeagueSnapshot) => void): LeagueView => {
  const snap = structuredClone(base.snap);
  edit(snap);
  return new LeagueView(snap, MOCK_SETTINGS);
};
const named = (view: LeagueView, name: string): Player => {
  const p = view.snap.players.find((x) => x.name === name);
  if (p === undefined) throw new Error(`${name} not in fixture`);
  return p;
};
const valuedGoalies = (view: LeagueView): Player[] =>
  view.snap.players.filter((p) => p.positionType === 'G' && view.valuation(p.playerKey));
const JARVIS = 'Seth Jarvis';

describe('player card from the live fixture', () => {
  const c = cardContext(base, START);

  it('shows an injured player as out, with a return estimate and rest-of-season totals net of it', () => {
    const p = named(base, JARVIS);
    const card = PlayerCard.parse(buildCard(c, p));
    expect(card.owner.kind).toBe('us');
    expect(card.availability).toMatchObject({ status: 'IR-NR', playProb: 0, source: 'note' });
    expect(card.availability.expectedReturn).toMatch(/^2026-\d\d-\d\d$/);
    expect(card.availability.note).toContain('shoulder');
    const pr = base.projection(p.playerKey);
    expect(card.value?.gp).toBeLessThan(pr?.gp ?? 0);
    expect(card.value?.adjustedVorp).toBeLessThan(card.value?.vorp ?? 0);
    expect(card.reasons[0]).toMatch(/^Out: IR-NR/);
  });

  it('lists skater categories in scoring order, totals = per game × projected games, z from the snapshot', () => {
    const p = named(base, JARVIS);
    const card = buildCard(c, p);
    expect(card.categories.map((x) => x.cat)).toEqual([
      'G',
      'A',
      '+/-',
      'PIM',
      'PPP',
      'SHP',
      'GWG',
      'SOG',
      'HIT',
    ]);
    const sog = card.categories.find((x) => x.cat === 'SOG');
    const perGame = base.projection(p.playerKey)?.perGame['SOG'] ?? 0;
    expect(sog?.total).toBeCloseTo(perGame * (card.value?.gp ?? 0), 0);
    expect(sog?.z).toBeCloseTo(base.valuation(p.playerKey)?.z['SOG'] ?? NaN, 2);
  });

  it('gives a goalie only goalie categories, GAA flagged lower-is-better and rates left as rates', () => {
    const g = valuedGoalies(base)[0] as Player;
    const card = buildCard(c, g);
    expect(card.categories.map((x) => x.cat)).toEqual(['W', 'GAA', 'SV%', 'SHO']);
    expect(card.categories.find((x) => x.cat === 'GAA')?.lowerIsBetter).toBe(true);
    expect(card.categories.find((x) => x.cat === 'W')?.lowerIsBetter).toBe(false);
    expect(card.categories.find((x) => x.cat === 'SV%')?.total).toBeLessThan(1);
  });

  it('measures fit with the strength panel’s weights and names the targets he hits', () => {
    const strength = categoryStrength(base);
    const fa = base.snap.players.find(
      (p) => base.isFreeAgent(p.playerKey) && base.valuation(p.playerKey) && p.positionType === 'P',
    ) as Player;
    const card = buildCard(c, fa);
    expect(card.owner.kind).toBe('freeAgent');
    expect(card.fit.weights).toEqual(strength.weights);
    expect(card.fit.targets).toEqual(strength.targets);
    const z = base.valuation(fa.playerKey)?.z ?? {};
    expect(card.fit.targetHits).toEqual(strength.targets.filter((t) => (z[t] ?? 0) >= 0.5));
    expect(card.fit.score).toBeCloseTo((card.value?.adjustedVorp ?? 0) + (card.fit.fit ?? 0), 1);
  });

  it('round-trips through the contract', () => {
    const card = buildCard(c, named(base, JARVIS));
    expect(PlayerCard.parse(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  it('splits skater and goalie categories exactly', () => {
    expect([...categoriesFor(base, 'P'), ...categoriesFor(base, 'G')].sort()).toEqual(
      MOCK_SETTINGS.categories.map((x) => x.abbr).sort(),
    );
  });
});

describe('compare', () => {
  const c = cardContext(base, START);

  it('diffs two goalies with GAA judged lower-is-better', () => {
    const [a, b] = valuedGoalies(base) as [Player, Player];
    const res = compare(c, [a.playerKey, b.playerKey]);
    expect(res.base).toBe(a.playerKey);
    const d = res.deltas[0];
    expect(d?.comparable).toBe(true);
    const gaa = d?.byCat.find((x) => x.cat === 'GAA');
    const w = d?.byCat.find((x) => x.cat === 'W');
    expect(gaa?.delta).not.toBe(0);
    expect(gaa?.better).toBe((gaa?.delta ?? 0) < 0);
    expect(w?.better).toBe((w?.delta ?? 0) > 0);
    const cardA = res.players[0];
    const cardB = res.players[1];
    expect(d?.terms?.vorp).toBeCloseTo((cardB?.value?.vorp ?? 0) - (cardA?.value?.vorp ?? 0), 2);
  });

  it('never diffs a skater against a goalie', () => {
    const g = valuedGoalies(base)[0] as Player;
    const s = named(base, JARVIS);
    const res = compare(c, [s.playerKey, g.playerKey]);
    expect(res.deltas).toEqual([
      { playerKey: g.playerKey, comparable: false, byCat: [], terms: null },
    ]);
    expect(res.players[1]?.categories.map((x) => x.cat)).toEqual(['W', 'GAA', 'SV%', 'SHO']);
  });

  it('diffs relative to an explicit base, which must be one of the keys', () => {
    const [a, b, g] = valuedGoalies(base) as [Player, Player, Player];
    const res = compare(c, [a.playerKey, b.playerKey, g.playerKey], b.playerKey);
    expect(res.deltas.map((d) => d.playerKey)).toEqual([a.playerKey, g.playerKey]);
    expect(() => compare(c, [a.playerKey, b.playerKey], g.playerKey)).toThrow(HttpError);
  });

  it('flips `better` with the sign of the delta for a lower-is-better category', () => {
    const [a, b] = valuedGoalies(base) as [Player, Player];
    const ab = deltaOf(buildCard(c, b), buildCard(c, a)).byCat.find((x) => x.cat === 'GAA');
    const ba = deltaOf(buildCard(c, a), buildCard(c, b)).byCat.find((x) => x.cat === 'GAA');
    expect(ab?.better).toBe(!ba?.better);
  });

  it('resolves keys against the league index (P3): unknown keys are named, counts enforced', () => {
    const k = named(base, JARVIS).playerKey;
    const err = (() => {
      try {
        resolveCompareKeys(base, `${k},477.p.999999,nope`);
      } catch (e) {
        return e as HttpError;
      }
      return undefined;
    })();
    expect(err?.status).toBe(400);
    expect(err?.message).toContain('477.p.999999, nope');
    expect(() => resolveCompareKeys(base, k)).toThrow(/2 to 4/);
    expect(() => resolveCompareKeys(base, `${k},${k}`)).toThrow(/2 to 4/);
    const five = base.snap.players
      .slice(0, 5)
      .map((p) => p.playerKey)
      .join(',');
    expect(() => resolveCompareKeys(base, five)).toThrow(/2 to 4/);
  });
});

describe('category strength', () => {
  const s = categoryStrength(base);

  it('ranks our summed, availability-discounted z among all 8 teams', () => {
    expect(s.categories).toHaveLength(13);
    const sums = base.snap.teams.map((t) => ({
      teamKey: t.teamKey,
      a: discountedRoster(base, t.teamKey).reduce((n, v) => n + (v.z['A'] ?? 0), 0),
    }));
    const ours = sums.find((t) => t.teamKey === base.teamKey)?.a ?? NaN;
    const a = s.categories.find((r) => r.cat === 'A');
    expect(a?.of).toBe(8);
    expect(a?.z).toBeCloseTo(ours, 2);
    expect(a?.rank).toBe(1 + sums.filter((t) => t.a > ours).length);
    for (const r of s.categories) expect(r.rank).toBeGreaterThanOrEqual(1);
    for (const r of s.categories) expect(r.rank).toBeLessThanOrEqual(8);
  });

  it('lists weakest first: worst rank, then lowest z', () => {
    const rows = s.categories;
    for (let i = 1; i < rows.length; i++) {
      const [prev, cur] = [rows[i - 1] as StrengthRow, rows[i] as StrengthRow];
      expect(prev.rank > cur.rank || (prev.rank === cur.rank && prev.z <= cur.z)).toBe(true);
    }
    expect(s.targets.length).toBeGreaterThan(0);
    expect(s.targets.every((t) => (s.weights[t] ?? 0) >= 1.2)).toBe(true);
  });

  it('discounts an injured player: Jarvis healthy would add more SHP', () => {
    const jarvis = named(base, JARVIS);
    expect(seasonShare(base, jarvis)).toBeLessThan(1);
    const healthy = edited((snap) => {
      const p = snap.players.find((x) => x.playerKey === jarvis.playerKey);
      if (p !== undefined) delete p.status;
    });
    const shp = (v: LeagueView) =>
      categoryStrength(v).categories.find((r) => r.cat === 'SHP')?.z ?? NaN;
    const full = base.valuation(jarvis.playerKey)?.z['SHP'] ?? 0;
    const share = seasonShare(base, jarvis);
    expect(shp(healthy) - shp(base)).toBeCloseTo(full * (1 - share), 1);
  });

  it('labels by league rank, saturated past the cap', () => {
    expect(labelFor(7, 1, 8)).toBe('saturated');
    expect(labelFor(1, 1, 8)).toBe('strong');
    expect(labelFor(0, 4, 8)).toBe('average');
    expect(labelFor(-2, 7, 8)).toBe('weak');
  });

  it('targets the two worst categories when no weight stands out', () => {
    const row = (cat: string, weight: number): StrengthRow => ({
      cat,
      z: 0,
      rank: 1,
      of: 8,
      label: 'average',
      winProb: null,
      weight,
      lowerIsBetter: false,
    });
    expect(targetsFor([row('A', 1), row('G', 1), row('HIT', 1)])).toEqual(['A', 'G']);
    expect(targetsFor([row('A', 1.1), row('G', 1.5), row('HIT', 1.3)])).toEqual(['G', 'HIT']);
  });
});
