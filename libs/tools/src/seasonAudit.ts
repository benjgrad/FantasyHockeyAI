import { marginalWeights, starterCounts, strategyAudit, type StrategyAudit } from '@fha/model';
import type { Store } from '@fha/store';
import { scoringCategories } from './derive.js';
import { typicalWeekLine } from './leagueCompare.js';
import { ROS_LENS, rosLensView } from './valuationLens.js';
import type { LeagueView } from './view.js';

/**
 * The season half of the strategy audit (D-034), apart from `strategy.ts` so the value family
 * (`valueNow`) can take its weights without a cycle.
 */
export type AuditScope = 'season' | 'week';

export interface LeagueAudit {
  scope: AuditScope;
  lens: string;
  asOf: string;
  /** Who the line was measured against: the league field, or this week's opponent. */
  against: { teamKey: string; name: string; pWinWeek: number; expectedCats: number }[];
  audit: StrategyAudit;
}

/** Our typical week against every other team's typical week, on the in-season lens. */
export function auditSeason(view: LeagueView, store: Store): LeagueAudit {
  const lens = rosLensView(view, store).view;
  const cats = scoringCategories(view.settings);
  const others = view.otherTeams();
  const audit = strategyAudit(
    typicalWeekLine(lens, view.teamKey),
    others.map((t) => typicalWeekLine(lens, t.teamKey)),
    cats,
    starterCounts(view.settings),
  );
  return {
    scope: 'season',
    lens: ROS_LENS,
    asOf: view.snap.date,
    against: others.map((t, i) => ({
      teamKey: t.teamKey,
      name: t.name,
      pWinWeek: audit.opponents[i]?.pWinWeek ?? 0.5,
      expectedCats: audit.opponents[i]?.expectedCats ?? 0,
    })),
    audit,
  };
}

const weightCache = new WeakMap<LeagueView, Record<string, number>>();

/**
 * The season's marginal category weights on a lens view: what our starters and releases are
 * chosen by (D-034). Computed once per view; equal weights if the audit cannot be built (P9).
 */
export function seasonWeights(lens: LeagueView): Record<string, number> | undefined {
  const hit = weightCache.get(lens);
  if (hit !== undefined) return hit;
  try {
    const cats = scoringCategories(lens.settings);
    const audit = strategyAudit(
      typicalWeekLine(lens, lens.teamKey),
      lens.otherTeams().map((t) => typicalWeekLine(lens, t.teamKey)),
      cats,
      starterCounts(lens.settings),
    );
    const w = marginalWeights(audit);
    weightCache.set(lens, w);
    return w;
  } catch {
    return undefined;
  }
}
