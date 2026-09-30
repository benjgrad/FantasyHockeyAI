import { afterEach, describe, expect, it } from 'vitest';
import { HeadToHead, LeagueCompare } from '@fha/api';
import type { LeagueSnapshot } from '@fha/core';
import {
  LeagueView,
  MOCK_SETTINGS,
  competitionRanks,
  complementarity,
  leagueStrength,
  teamCategoryZ,
} from '@fha/tools';
import { leagueCompare } from './leagueCompare.js';
import { flipOrder, headToHead } from './leagueCompareH2H.js';
import { profileOf } from './leagueCompareProfile.js';
import { categoryStrength, discountedRoster } from './playersStrength.js';
import { call, connected, FIXTURE, startHarness, type Harness } from './testing.js';

/** The League comparison over the real scrubbed 2026-09-29 league (all eight rosters). */
const base = LeagueView.fromFile(FIXTURE, MOCK_SETTINGS);
const CATS = MOCK_SETTINGS.categories.map((c) => c.abbr);
const edited = (edit: (s: LeagueSnapshot) => void): LeagueView => {
  const snap = structuredClone(base.snap);
  edit(snap);
  return new LeagueView(snap, MOCK_SETTINGS);
};
const SLOW = { timeout: 60_000 };

describe('league strength', () => {
  const ls = leagueStrength(base);

  it('covers all eight teams, ours first and flagged, every scored category', () => {
    expect(ls.teams).toHaveLength(8);
    expect(ls.teams[0]?.isUs).toBe(true);
    expect(ls.teams.filter((t) => t.isUs)).toHaveLength(1);
    expect(ls.teams.map((t) => t.name)).toContain("Ben's Astonishing Team");
    for (const t of ls.teams) expect(t.categories.map((c) => c.cat)).toEqual(CATS);
  });

  it('ranks by competition order: ties share the better rank', () => {
    expect(competitionRanks([3, 5, 5, 1])).toEqual([3, 1, 1, 4]);
    expect(competitionRanks([2, 2, 2])).toEqual([1, 1, 1]);
  });

  it('gives us the same z and rank as the category-strength panel (same method)', () => {
    const panel = categoryStrength(base).categories;
    const us = ls.teams[0];
    for (const row of panel) {
      const cell = us?.categories.find((c) => c.cat === row.cat);
      expect(cell?.rank, row.cat).toBe(row.rank);
      expect(cell?.z ?? 0, row.cat).toBeCloseTo(row.z, 1);
    }
  });

  it('ranks GAA with lower is better: a better GAA rank goes with a lower weekly GAA', () => {
    const gaa = ls.teams.map((t) => t.categories.find((c) => c.cat === 'GAA'));
    const best = gaa.find((c) => c?.rank === 1);
    const worst = gaa.reduce((a, c) => ((c?.rank ?? 0) > (a?.rank ?? 0) ? c : a));
    expect(best?.weekly ?? 0).toBeLessThan(worst?.weekly ?? 0);
  });

  it('discounts every player by his availability, like the strength panel', () => {
    for (const t of base.snap.teams) {
      const panel = discountedRoster(base, t.teamKey);
      const z = teamCategoryZ(base, t.teamKey, CATS);
      for (const c of CATS) {
        expect(z[c], `${t.name} ${c}`).toBeCloseTo(
          panel.reduce((a, p) => a + (p.z[c] ?? 0), 0),
          6,
        );
      }
    }
    // Our best HIT player sent to the minors (NA) takes his whole HIT z with him.
    const top = [...base.roster().entries].sort(
      (a, b) =>
        (base.valuation(b.player.playerKey)?.z['HIT'] ?? 0) -
        (base.valuation(a.player.playerKey)?.z['HIT'] ?? 0),
    )[0];
    const key = top?.player.playerKey ?? '';
    const hurt = edited((s) => {
      const p = s.players.find((x) => x.playerKey === key);
      if (p) p.status = 'NA';
    });
    const before = teamCategoryZ(base, base.teamKey, ['HIT'])['HIT'] ?? 0;
    const after = teamCategoryZ(hurt, hurt.teamKey, ['HIT'])['HIT'] ?? 0;
    expect(after).toBeLessThan(before);
    expect(before - after).toBeCloseTo(base.valuation(key)?.z['HIT'] ?? 0, 6);
  });

  it('expected categories won head to head is the sum of the win probabilities', () => {
    expect(ls.versus).toHaveLength(7);
    for (const v of ls.versus) {
      const sum = Object.values(v.typical.probabilities).reduce((a, p) => a + p, 0);
      expect(v.typical.expectedWon).toBeCloseTo(sum, 9);
      expect(Object.keys(v.typical.probabilities)).toEqual(CATS);
      expect(v.thisWeek).not.toBeNull();
    }
  });

  it('complementarity is symmetric and zero between identical teams', () => {
    const a = { G: 1.2, A: -0.8, HIT: 0.3 };
    const b = { G: -1, A: 1.5, HIT: 0.3 };
    const ab = complementarity(a, b, ['G', 'A', 'HIT']);
    const ba = complementarity(b, a, ['G', 'A', 'HIT']);
    expect(ab.score).toBeCloseTo(ba.score, 12);
    // A: we need 0.8, they have 1.5; G: they need 1, we have 1.2.
    expect(ab.score).toBeCloseTo(0.8 * 1.5 + 1 * 1.2, 12);
    expect(complementarity(a, a, ['G', 'A', 'HIT']).score).toBe(0);
  });
});

describe('League compare response', () => {
  it(
    'round-trips the contract, ranks partners by complementarity, classifies the profile',
    SLOW,
    async () => {
      const res = await leagueCompare(base);
      expect(LeagueCompare.parse(JSON.parse(JSON.stringify(res)))).toEqual(res);
      expect(await leagueCompare(base)).toBe(res); // cached per snapshot
      expect(res.teams[0]?.vsUs).toBeNull();
      for (const t of res.teams.slice(1)) {
        expect(t.vsUs).not.toBeNull();
        expect((t.vsUs?.ourExpectedWon ?? 0) + (t.vsUs?.theirExpectedWon ?? 0)).toBeCloseTo(13, 2);
      }
      const scores = res.partners.map((p) => p.complementarity);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      expect(res.partners).toHaveLength(7);
      expect(res.partners[0]?.reason).toMatch(/^They're /);
      const us = res.teams[0]?.categories ?? [];
      const strong = us
        .filter((c) => c.rank <= 2)
        .map((c) => c.cat)
        .sort();
      const weak = us
        .filter((c) => c.rank >= 7)
        .map((c) => c.cat)
        .sort();
      expect(res.profile.strengths.map((c) => c.cat).sort()).toEqual(strong);
      // On this fixture nothing of ours ranks 7th or 8th: the two worst-ranked stand in.
      expect(weak).toEqual([]);
      expect(res.profile.weaknessesRelative).toBe(true);
      const worst = [...us].sort((a, b) => b.rank - a.rank)[0];
      expect(res.profile.weaknesses).toHaveLength(2);
      expect(res.profile.weaknesses.map((c) => c.cat)).toContain(worst?.cat);
      expect(res.profile.weaknesses.every((w) => w.rank > 2)).toBe(true);
      for (const w of res.profile.weaknesses) {
        expect(w.fix).not.toBeNull();
        const fix = w.fix;
        if (fix?.route === 'FA') expect(fix.faGain ?? 0).toBeGreaterThanOrEqual(fix.tradeGain ?? 0);
        if (fix?.route === 'trade') expect(fix.tradeGain ?? 0).toBeGreaterThan(fix.faGain ?? 0);
      }
    },
  );
});

describe('profile classification', () => {
  it('strengths are ranks 1–2, weaknesses 7–8, each weakness with a fix route', () => {
    const us = leagueStrength(base).teams[0];
    if (us === undefined) throw new Error('no us');
    const ranks: Record<string, number> = { G: 1, A: 8, HIT: 7, SHP: 2, PPP: 6 };
    const fake = {
      ...us,
      categories: us.categories.map((c) => ({ ...c, rank: ranks[c.cat] ?? 4 })),
    };
    const p = profileOf(base, fake, 8, []);
    expect(p.strengths.map((c) => c.cat)).toEqual(['G', 'SHP']);
    expect(p.weaknesses.map((c) => c.cat).sort()).toEqual(['A', 'HIT']);
    expect(p.weaknessesRelative).toBe(false);
    for (const w of p.weaknesses) {
      // No trade ideas were given, so a fix can only be a free agent (or nothing).
      expect(['FA', 'none']).toContain(w.fix?.route);
      expect(w.fix?.tradeGain).toBeNull();
    }
  });
});

describe('head to head', () => {
  const partner = base.otherTeams().find((t) => t.name === 'DraftAndRun')?.teamKey ?? '';

  it('round-trips, sums win probs, lists only that partner’s trades', SLOW, () => {
    const h = headToHead(base, partner);
    expect(HeadToHead.parse(JSON.parse(JSON.stringify(h)))).toEqual(h);
    const sum = h.categories.reduce((a, c) => a + c.winProb, 0);
    expect(h.expectedWon.typical).toBeCloseTo(sum, 2);
    for (const c of h.categories) {
      expect(c.swing).toBe(c.winProb >= 0.35 && c.winProb <= 0.65);
      expect(c.ourTop.length).toBeLessThanOrEqual(3);
      expect(c.theirTop.every((p) => base.ownerOf(p.playerKey) === partner)).toBe(true);
    }
    expect(h.tradeIdeas.length).toBeGreaterThan(0);
    expect(h.tradeIdeas.length).toBeLessThanOrEqual(3);
    for (const idea of h.tradeIdeas) {
      expect(idea.partnerTeamKey).toBe(partner);
      expect(idea.give.every((p) => base.ownerOf(p.playerKey) === base.teamKey)).toBe(true);
      expect(idea.get.every((p) => base.ownerOf(p.playerKey) === partner)).toBe(true);
      expect(idea.ourGain).toBeGreaterThan(0);
      expect(idea.theirGain).toBeGreaterThanOrEqual(0);
    }
  });

  it('orders trailing categories by the smallest gap relative to spread', () => {
    const rows = [
      { cat: 'A', winProb: 0.2, gapSd: -0.84 },
      { cat: 'B', winProb: 0.45, gapSd: -0.12 },
      { cat: 'C', winProb: 0.8, gapSd: 0.84 },
      { cat: 'D', winProb: 0.3, gapSd: -0.52 },
    ];
    expect(flipOrder(rows)).toEqual(['B', 'D', 'A']);
  });

  it('refuses our own team and unknown keys', () => {
    expect(() => headToHead(base, base.teamKey)).toThrow(/No such other team/);
    expect(() => headToHead(base, 'nope')).toThrow(/No such other team/);
  });
});

describe('league compare routes', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('serves the comparison, 404s our own team, needs a session', SLOW, async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const res = await call(h, '/api/league/compare', { cookie });
    expect(res.status).toBe(200);
    expect(LeagueCompare.parse(await res.json()).teams).toHaveLength(8);
    const own = await call(h, `/api/league/compare/${base.teamKey}`, { cookie });
    expect(own.status).toBe(404);
    expect((await call(h, '/api/league/compare')).status).toBe(401);
  });
});
