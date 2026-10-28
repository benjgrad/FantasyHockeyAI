import {
  ArchivedProjection,
  ArchivedTeamDay,
  ArchivedTeamWeek,
  ArchivedWeek,
  type TeamKey,
} from '@fha/core';
import type { z } from 'zod';
import { categoryValue, starterCounts, strategyAudit } from '@fha/model';
import type { Store } from '@fha/store';
import { scoringCategories } from './derive.js';
import { currentMatchup, currentSides } from './modelInputs.js';
import type { LeagueView } from './view.js';

/**
 * Past matchups (D-038): the finished weeks the daemon archived from Yahoo, read back for
 * retrospectives. Everything here is computed from the archive; a row that no longer parses is
 * skipped, not guessed (P5). Records count categories, the way this league ranks (W-L-T per
 * category, 13 a week), and matchups, a week won by taking more categories than the opponent.
 */
export interface History {
  weeks: ArchivedWeek[];
  teamWeeks: ArchivedTeamWeek[];
  days: ArchivedTeamDay[];
  projections: ArchivedProjection[];
}

function parsed<T>(rows: readonly { body: unknown }[], schema: z.ZodType<T>): T[] {
  return rows.flatMap((r) => {
    const p = schema.safeParse(r.body);
    return p.success ? [p.data] : [];
  });
}

export function loadHistory(store: Store, leagueKey: string): History {
  const a = store.matchupArchive;
  return {
    weeks: parsed(a.list(leagueKey, 'week'), ArchivedWeek),
    teamWeeks: parsed(a.list(leagueKey, 'teamWeek'), ArchivedTeamWeek),
    days: parsed(a.list(leagueKey, 'teamDay'), ArchivedTeamDay),
    projections: parsed(a.list(leagueKey, 'projection'), ArchivedProjection),
  };
}

export interface Record3 {
  w: number;
  l: number;
  t: number;
}

/** One team's result in one week. */
export interface WeekResult {
  week: number;
  teamKey: TeamKey;
  opponentKey: TeamKey;
  won: string[];
  lost: string[];
  tied: string[];
  outcome: 'W' | 'L' | 'T';
  us: Record<string, number>;
  them: Record<string, number>;
}

export function resultsOf(w: ArchivedWeek): WeekResult[] {
  return w.matchups.flatMap((m) =>
    m.teams.flatMap((t) => {
      const o = m.teams.find((x) => x.teamKey !== t.teamKey);
      if (o === undefined) return [];
      const cats = Object.keys(m.winners);
      const won = cats.filter((c) => m.winners[c] === t.teamKey);
      const lost = cats.filter((c) => m.winners[c] === o.teamKey);
      const tied = cats.filter((c) => m.winners[c] === 'tie');
      const outcome: WeekResult['outcome'] =
        won.length > lost.length ? 'W' : won.length < lost.length ? 'L' : 'T';
      return [
        {
          week: w.week,
          teamKey: t.teamKey,
          opponentKey: o.teamKey,
          won,
          lost,
          tied,
          outcome,
          us: t.stats,
          them: o.stats,
        },
      ];
    }),
  );
}

export interface StandingRow {
  teamKey: TeamKey;
  categories: Record3;
  matchups: Record3;
  /** Category win share, ties counting half: how Yahoo ranks this league. */
  pct: number;
}

/** Standings over the archived weeks, best first. */
export function standingsOf(weeks: readonly ArchivedWeek[]): StandingRow[] {
  const by = new Map<TeamKey, StandingRow>();
  for (const r of weeks.flatMap(resultsOf)) {
    const s = by.get(r.teamKey) ?? {
      teamKey: r.teamKey,
      categories: { w: 0, l: 0, t: 0 },
      matchups: { w: 0, l: 0, t: 0 },
      pct: 0,
    };
    s.categories.w += r.won.length;
    s.categories.l += r.lost.length;
    s.categories.t += r.tied.length;
    s.matchups[r.outcome === 'W' ? 'w' : r.outcome === 'L' ? 'l' : 't'] += 1;
    by.set(r.teamKey, s);
  }
  const rows = [...by.values()];
  for (const s of rows) {
    const n = s.categories.w + s.categories.l + s.categories.t;
    s.pct = n === 0 ? 0 : (s.categories.w + s.categories.t / 2) / n;
  }
  return rows.sort((a, b) => b.pct - a.pct || b.matchups.w - a.matchups.w);
}

/** How often a team won each category across the archived weeks. */
export function categoryRecord(
  weeks: readonly ArchivedWeek[],
  teamKey: TeamKey,
): Map<string, Record3> {
  const out = new Map<string, Record3>();
  for (const r of weeks.flatMap(resultsOf).filter((x) => x.teamKey === teamKey)) {
    const bump = (cats: string[], k: keyof Record3) => {
      for (const c of cats) {
        const s = out.get(c) ?? { w: 0, l: 0, t: 0 };
        s[k] += 1;
        out.set(c, s);
      }
    };
    bump(r.won, 'w');
    bump(r.lost, 'l');
    bump(r.tied, 't');
  }
  return out;
}

/**
 * What the model expects of this week's matchup now: the record the archive keeps, so a week can
 * later be judged against what we expected of it. Undefined without an opponent.
 */
export function weekProjection(
  view: LeagueView,
  source: ArchivedProjection['source'],
): ArchivedProjection | undefined {
  const m = currentMatchup(view);
  const sides = currentSides(view);
  if (m === undefined || sides === undefined) return undefined;
  const cats = scoringCategories(view.settings);
  const audit = strategyAudit(sides.us, [sides.them], cats, starterCounts(view.settings));
  return {
    week: view.snap.week,
    teamKey: view.teamKey,
    opponentKey: m.opponent.teamKey,
    source,
    asOf: view.snap.recordedAt,
    categories: cats.map((c) => ({
      category: c,
      us: categoryValue(m.us, c),
      them: categoryValue(m.them, c),
      pWin: m.plan.probabilities[c] ?? 0.5,
    })),
    expectedWon: m.plan.expectedWon,
    pWinWeek: audit.pWinWeek,
  };
}
