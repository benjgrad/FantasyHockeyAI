import { describe, expect, it } from 'vitest';
import { CategoryStrength, PlayerCard } from '@fha/api';
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
  type StrengthRow,
} from './playersStrength.js';
import { strategyView } from './strategyView.js';
import { openStore } from '@fha/store';
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

  it("reads the rest-of-season lens with the store: a hot season lifts our rank's z (D-040)", () => {
    const ours = base
      .roster()
      .entries.find((e) => e.player.positionType === 'P' && e.player.nhlId !== undefined)?.player;
    if (ours?.nhlId === undefined) throw new Error('fixture needs a mapped skater of ours');
    const store = openStore(':memory:');
    store.nhlGames.upsert({
      skaters: Array.from({ length: 9 }, (_, i) => ({
        nhlId: ours.nhlId ?? 0,
        gameId: 900 + i,
        gameDate: `2026-10-0${i + 1}`,
        season: '20262027',
        name: ours.name,
        position: 'C',
        team: 'NJD',
        opponent: 'PHI',
        home: true,
        g: 2,
        a: 2,
        pts: 4,
        pm: 2,
        pim: 2,
        ppp: 2,
        shp: 0,
        gwg: 1,
        sog: 9,
        hit: 4,
        blk: 1,
        fow: 5,
        toiS: 1300,
      })),
      goalies: [],
    });
    const later = edited((snap) => {
      snap.date = '2026-10-10';
    });
    const sog = (st: ReturnType<typeof categoryStrength>) =>
      st.categories.find((r) => r.cat === 'SOG')?.z ?? NaN;
    const now = categoryStrength(later, store);
    expect(now.lens.name).toBe('rest-of-season');
    expect(sog(now)).toBeGreaterThan(sog(categoryStrength(edited(() => undefined))));
    expect(categoryStrength(base).lens.name).toBe('preseason');
  });

  it('labels by league rank, saturated past the cap', () => {
    expect(labelFor(7, 1, 8)).toBe('saturated');
    expect(labelFor(1, 1, 8)).toBe('strong');
    expect(labelFor(0, 4, 8)).toBe('average');
    expect(labelFor(-2, 7, 8)).toBe('weak');
  });
});

describe('the season strategy is the targets everywhere (D-042, ticket "Inconsistent targets")', () => {
  // The Team page said "buy SOG, A, PPP · trade from HIT, PIM" while every card said
  // "Our targets: SOG, W, A, G": the cards read code's weights, not the stored strategy.
  const strategy = {
    leagueKey: base.snap.leagueKey,
    author: 'strategy',
    stance: 'contend' as const,
    targets: ['SOG', 'A', 'PPP'],
    surplus: ['HIT', 'PIM'],
    punts: ['SHP'],
    principles: ['Trade from HIT/PIM surplus for SOG'],
    rationale: 'test',
    reviewBy: undefined,
  };

  it('the panel, the card and the Team page show the same targets, from the strategy', () => {
    const store = openStore(':memory:');
    const v = store.seasonStrategy.add(strategy);
    const view = edited(() => undefined);
    const strength = categoryStrength(view, store);
    expect(strength.targets).toEqual(['SOG', 'A', 'PPP']);
    expect(strength.surplus).toEqual(['HIT', 'PIM']);
    expect(strength.punts).toEqual(['SHP']);
    expect(strength.source).toMatchObject({ kind: 'strategy', id: v.id });
    const fa = view.snap.players.find(
      (p) => view.isFreeAgent(p.playerKey) && view.valuation(p.playerKey) && p.positionType === 'P',
    ) as Player;
    const card = PlayerCard.parse(buildCard(cardContext(view, START, store), fa));
    expect(card.fit.targets).toEqual(['SOG', 'A', 'PPP']);
    expect(card.fit.surplus).toEqual(['HIT', 'PIM']);
    expect(card.fit.source).toMatchObject({ kind: 'strategy', id: v.id });
    expect(strategyView(view, store).versions[0]?.targets).toEqual(card.fit.targets);
  });

  it('weights fit by the strategy: punts count nothing, targets at least 1.2, surplus at most 1', () => {
    const store = openStore(':memory:');
    store.seasonStrategy.add(strategy);
    const strength = categoryStrength(
      edited(() => undefined),
      store,
    );
    const row = (cat: string) => strength.categories.find((r) => r.cat === cat) as StrengthRow;
    expect(row('SHP')).toMatchObject({ role: 'punt', weight: 0 });
    expect(row('SOG').role).toBe('target');
    expect(row('SOG').weight).toBeGreaterThanOrEqual(1.2);
    expect(row('HIT').role).toBe('surplus');
    expect(row('HIT').weight).toBeLessThanOrEqual(1);
    expect(strength.weights['SHP']).toBe(0);
  });

  it('shows a new strategy version at once on the same view (cache keyed on the version)', () => {
    const store = openStore(':memory:');
    store.seasonStrategy.add(strategy);
    const view = edited(() => undefined);
    expect(categoryStrength(view, store).targets).toEqual(['SOG', 'A', 'PPP']);
    store.seasonStrategy.add({ ...strategy, author: 'ben (chat)', targets: ['G', 'PPP'] });
    expect(categoryStrength(view, store).targets).toEqual(['G', 'PPP']);
  });

  it("names code's audit as the source when no strategy is recorded", () => {
    const store = openStore(':memory:');
    const strength = categoryStrength(
      edited(() => undefined),
      store,
    );
    expect(strength.source).toEqual({ kind: 'audit' });
    expect(strength.punts).toEqual([]);
    expect(strength.disagreements).toEqual([]);
    expect(strength.weights).toEqual(
      Object.fromEntries(strength.categories.map((r) => [r.cat, expect.any(Number)])),
    );
    for (const r of strength.categories) expect(r.weight).toBeCloseTo(r.codeWeight, 3);
  });

  it('round-trips the panel through the contract', () => {
    const store = openStore(':memory:');
    store.seasonStrategy.add(strategy);
    const s = categoryStrength(
      edited(() => undefined),
      store,
    );
    const body = {
      asOf: 'x',
      week: 1,
      categories: s.categories,
      weights: s.weights,
      targets: s.targets,
      surplus: s.surplus,
      punts: s.punts,
      source: s.source,
      disagreements: s.disagreements,
      weekWeights: null,
      weekWeightsSource: null,
    };
    expect(CategoryStrength.parse(JSON.parse(JSON.stringify(body)))).toEqual(body);
  });
});
