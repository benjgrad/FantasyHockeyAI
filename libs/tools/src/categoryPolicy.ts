import type { CategoryStance, StrategyAudit } from '@fha/model';
import type { SeasonStrategy, Store } from '@fha/store';
import { scoringCategories } from './derive.js';
import { codeNeedWeights, fitLens, type FitLensName } from './fit.js';
import { seasonAuditOn } from './seasonAudit.js';
import type { LeagueView } from './view.js';

/**
 * The category policy (D-041): what we want from each scored category, in one place. Code's
 * weights are the measurement (P1, D-034); the stored season strategy is the intent, laid over
 * them by one deterministic rule (`applyStrategy`). Every preference surface (fit and its score,
 * targets and target hits, the strength panel, the fit sorts, the week's punts) reads this, so
 * the Team page's strategy and the player cards cannot disagree.
 *
 * Deliberately not read by the audit, ΔWin%, CWA, pickups, auto-grab or the trade search: they
 * are what the strategy is derived from, and feeding it back would let it grade itself.
 */

export type CategoryRole = 'target' | 'surplus' | 'punt' | 'neutral';

export type PolicySource =
  | { kind: 'strategy'; id: number; author: string; createdAt: string; reviewBy: string | null }
  /** No stored strategy: code's own targets, named so (P9). */
  | { kind: 'audit' };

/** The intent half of a strategy: which categories to buy, trade from and stop competing in. */
export interface CategoryIntent {
  targets: readonly string[];
  surplus: readonly string[];
  punts: readonly string[];
}

export interface CategoryPolicy {
  source: PolicySource;
  targets: string[];
  surplus: string[];
  punts: string[];
  roles: Record<string, CategoryRole>;
  /** Code's need weights before intent (1 neutral). */
  codeWeights: Record<string, number>;
  /** What every fit is computed with: `codeWeights` under `applyStrategy`. */
  weights: Record<string, number>;
  /** Where the strategy and today's audit disagree; empty without a strategy. */
  disagreements: string[];
  /** The lens the weights and every fit read players from (D-040). */
  lens: { view: LeagueView; name: FitLensName };
}

/** Most categories named as code's targets at once: "targeting everything" targets nothing. */
export const MAX_TARGETS = 4;
/** A code weight at or above this is a target; a strategy target is floored at it (1 neutral). */
export const TARGET_WEIGHT = 1.2;
/** A surplus category is weighted at most this: we are trading it away, not buying it. */
export const SURPLUS_WEIGHT_CAP = 1;

/** Punt → 0, target → at least TARGET_WEIGHT, surplus → at most SURPLUS_WEIGHT_CAP. Pure. */
export function applyStrategy(
  base: Readonly<Record<string, number>>,
  intent: CategoryIntent,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(base).map(([cat, w]) => {
      if (intent.punts.includes(cat)) return [cat, 0];
      if (intent.targets.includes(cat)) return [cat, Math.max(w, TARGET_WEIGHT)];
      if (intent.surplus.includes(cat)) return [cat, Math.min(w, SURPLUS_WEIGHT_CAP)];
      return [cat, w];
    }),
  );
}

/**
 * The week's overlay: punts only. A season target does not boost a week we may already have
 * locked; the week's own ΔP(win) weights decide that.
 */
export function weekOverlay(
  base: Readonly<Record<string, number>>,
  intent: Pick<CategoryIntent, 'punts'>,
): Record<string, number> {
  return applyStrategy(base, { targets: [], surplus: [], punts: intent.punts });
}

/** Code's targets: the heaviest weights at or above TARGET_WEIGHT; when none, the two heaviest. */
export function codeTargets(weights: Readonly<Record<string, number>>): string[] {
  const byWeight = Object.entries(weights).sort((a, b) => b[1] - a[1]);
  const heavy = byWeight.filter(([, w]) => w >= TARGET_WEIGHT).slice(0, MAX_TARGETS);
  return (heavy.length > 0 ? heavy : byWeight.slice(0, 2)).map(([c]) => c);
}

/** The league's current stored strategy, or undefined (none yet, or no store). */
export function currentStrategy(view: LeagueView, store?: Store): SeasonStrategy | undefined {
  return store?.seasonStrategy.current(view.snap.leagueKey);
}

function stances(audit: StrategyAudit | undefined): Record<string, CategoryStance> {
  return Object.fromEntries((audit?.categories ?? []).map((c) => [c.category, c.stance]));
}

function disagreementsOf(
  intent: CategoryIntent,
  stance: Record<string, CategoryStance>,
  codeTop: readonly string[],
): string[] {
  const out: string[] = [];
  for (const t of intent.targets) {
    if (stance[t] === 'saturated' || stance[t] === 'lost') {
      out.push(`Strategy targets ${t}, which the audit now calls ${stance[t]}.`);
    }
  }
  for (const s of intent.surplus) {
    if (stance[s] !== undefined && stance[s] !== 'saturated') {
      out.push(`Strategy trades from ${s}, which the audit calls ${stance[s]}, not saturated.`);
    }
  }
  const named = new Set([...intent.targets, ...intent.surplus, ...intent.punts]);
  const unnamed = codeTop.filter((c) => !named.has(c));
  if (unnamed.length > 0) out.push(`The audit also rates ${unnamed.join(', ')} highly.`);
  return out;
}

function sourceOf(s: SeasonStrategy): PolicySource {
  return {
    kind: 'strategy',
    id: s.id,
    author: s.author,
    createdAt: s.createdAt,
    reviewBy: s.reviewBy ?? null,
  };
}

/**
 * The policy for our team now: the current stored strategy over code's weights, or code's own
 * targets when there is none. Not cached: the strategy can change under a view (chat records a
 * version), and everything heavy beneath it (lens, weights, audit) is cached per view.
 */
export function categoryPolicy(view: LeagueView, store?: Store): CategoryPolicy {
  const cats = scoringCategories(view.settings);
  const lens = fitLens(view, store);
  const codeWeights = codeNeedWeights(view, store);
  const audit = lens.name === 'rest-of-season' ? seasonAuditOn(lens.view) : undefined;
  const stance = stances(audit);
  const codeTop = codeTargets(codeWeights);
  const s = currentStrategy(view, store);
  const known = (xs: readonly string[]) => xs.filter((c) => cats.includes(c));
  const intent: CategoryIntent =
    s === undefined
      ? {
          targets: codeTop,
          surplus: cats.filter((c) => stance[c] === 'saturated' && !codeTop.includes(c)),
          punts: [],
        }
      : { targets: known(s.targets), surplus: known(s.surplus), punts: known(s.punts) };
  const roles = Object.fromEntries(
    cats.map((c): [string, CategoryRole] => [
      c,
      intent.punts.includes(c)
        ? 'punt'
        : intent.targets.includes(c)
          ? 'target'
          : intent.surplus.includes(c)
            ? 'surplus'
            : 'neutral',
    ]),
  );
  return {
    source: s === undefined ? { kind: 'audit' } : sourceOf(s),
    targets: [...intent.targets],
    surplus: [...intent.surplus],
    punts: [...intent.punts],
    roles,
    codeWeights,
    weights: s === undefined ? codeWeights : applyStrategy(codeWeights, intent),
    disagreements: s === undefined ? [] : disagreementsOf(intent, stance, codeTop),
    lens,
  };
}

/** The need weights every fit is computed with: code's, with the season strategy over them. */
export function needWeights(view: LeagueView, store?: Store): Record<string, number> {
  return categoryPolicy(view, store).weights;
}
