import type { StrategyView } from '@fha/api';
import type { SeasonStrategy, Store } from '@fha/store';
import { auditSeason, objectiveOf, type LeagueView } from '@fha/tools';

/**
 * The season strategy for the Team page (D-034): the stored versions, newest first, each with
 * what changed from the one before, beside code's audit recomputed now. Read-only: the strategy
 * is changed by the weekly job or by asking chat, which both go through `proposeStrategy`.
 */
export const STRATEGY_HISTORY = 10;

const round = (n: number, dp = 3): number => Math.round(n * 10 ** dp) / 10 ** dp;

export function changesFrom(s: SeasonStrategy, prev: SeasonStrategy | undefined): string[] {
  if (prev === undefined) return [];
  const show = (x: string | readonly string[]) =>
    typeof x === 'string' ? x : x.length === 0 ? 'none' : x.join(', ');
  return (['stance', 'targets', 'surplus', 'punts'] as const)
    .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(s[k]))
    .map((k) => `${k} was ${show(prev[k])}`);
}

function audit(view: LeagueView, store: Store): StrategyView['audit'] {
  try {
    const a = auditSeason(view, store).audit;
    return {
      pWinWeek: round(a.pWinWeek),
      expectedCats: round(a.expectedCats, 2),
      categories: a.categories.map((c) => ({
        cat: c.category,
        pField: round(c.pField),
        weight: round(c.weight),
        stance: c.stance,
      })),
    };
  } catch {
    return null; // P9: the stored strategy still shows without the audit
  }
}

export function strategyView(view: LeagueView, store: Store): StrategyView {
  // One extra so the oldest shown still gets its "changed from" line.
  const rows = store.seasonStrategy.history(view.snap.leagueKey, STRATEGY_HISTORY + 1);
  return {
    versions: rows.slice(0, STRATEGY_HISTORY).map((s, i) => ({
      id: s.id,
      createdAt: s.createdAt,
      author: s.author,
      stance: s.stance,
      targets: s.targets,
      surplus: s.surplus,
      punts: s.punts,
      principles: s.principles,
      rationale: s.rationale,
      reviewBy: s.reviewBy ?? null,
      changes: changesFrom(s, rows[i + 1]),
    })),
    audit: audit(view, store),
    objective: objectiveOf(store),
  };
}
