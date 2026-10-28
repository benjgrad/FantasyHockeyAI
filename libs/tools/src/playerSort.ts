import { z } from 'zod';
import type { Player } from '@fha/core';
import {
  SUPPORTED_CATEGORIES,
  goalieWindow,
  isRateCategory,
  skaterWindow,
  type GoalieWindow,
  type SkaterWindow,
} from '@fha/model';
import type { Store } from '@fha/store';
import { scoringCategories } from './derive.js';
import { fitLens, needWeights, playerFit } from './fit.js';
import { historyFor, seasonsAround } from './history.js';
import { rosLensView } from './valuationLens.js';
import type { PlayerValueNow } from './valueNow.js';
import { weekChanges } from './valueHistory.js';
import type { LeagueView } from './view.js';

/**
 * searchPlayers' sort (D-039): an ordered list of keys, each with its direction stated, so a
 * ranking is always what the agent asked for and never a default it did not choose. A key is a
 * named value (fit, CWA, VOLS, …) or a scored category on a stated basis (projected rest of
 * season per game, this season, per game this season, last 10 games). A player with no number
 * for a key always sinks below the ones that have one, whichever the direction.
 */
export const NAMED_SORT_KEYS = {
  fit: 'Fit score: rest-of-season adjusted VOLS plus the bonus for the categories that move our weekly win chances (as the Players page sorts)',
  value: 'preseason value',
  ros: 'rest-of-season VOLS',
  vofa: 'VOFA, over the best free agent at his position',
  cwa: 'CWA, categories a week he adds for us',
  win: 'ΔWin, change in P(win a typical week) with him',
  weekCwa: "Week CWA, this week's matchup",
  perGame: 'value per game played',
  delta7d: 'Δ7d, change in VOLS over 7 days',
  gp: 'games played this season',
  owned: '% owned on Yahoo',
} as const;
export type NamedSortKey = keyof typeof NAMED_SORT_KEYS;

export const STAT_BASES = {
  projected: 'projected per game for the rest of the season (per start for goalies)',
  season: 'this season so far, totals',
  seasonPerGame: 'this season so far, per game',
  last10: 'his last 10 games, totals',
} as const;
export type StatBasis = keyof typeof STAT_BASES;

const named = Object.keys(NAMED_SORT_KEYS) as [NamedSortKey, ...NamedSortKey[]];
const categories = [...SUPPORTED_CATEGORIES] as [string, ...string[]];

export const SortKey = z.object({
  by: z
    .enum([...named, ...categories] as [string, ...string[]])
    .describe(
      `A named value (${named.join(', ')}) or a scored category abbreviation (getLeagueContext lists this league's).`,
    ),
  order: z.enum(['desc', 'asc']).describe('desc: highest first. asc: lowest first (e.g. GAA, where lower is better).'),
  basis: z
    .enum(Object.keys(STAT_BASES) as [StatBasis, ...StatBasis[]])
    .optional()
    .describe(`Required when by is a category: ${Object.entries(STAT_BASES).map(([k, v]) => `${k} = ${v}`).join('; ')}.`),
});
export type SortKey = z.infer<typeof SortKey>;

export const SortSpec = z.array(SortKey).min(1).max(3);

const isNamed = (by: string): by is NamedSortKey => by in NAMED_SORT_KEYS;

/** The spec's problems against this league, or undefined when it is usable. */
export function sortProblem(view: LeagueView, spec: readonly SortKey[]): string | undefined {
  const scored = scoringCategories(view.settings);
  for (const k of spec) {
    if (isNamed(k.by)) {
      if (k.basis !== undefined) return `basis applies to a category, not to ${k.by}: drop it.`;
      continue;
    }
    if (!scored.includes(k.by)) return `${k.by} is not scored in this league. Categories: ${scored.join(', ')}.`;
    if (k.basis === undefined) return `Sorting by ${k.by} needs a basis: ${Object.keys(STAT_BASES).join(', ')}.`;
  }
  return undefined;
}

export function sortLabel(k: SortKey): string {
  const what = isNamed(k.by) ? NAMED_SORT_KEYS[k.by] : `${k.by} (${STAT_BASES[k.basis ?? 'projected']})`;
  return `${what}, ${k.order === 'desc' ? 'highest first' : 'lowest first'}`;
}

/** Column heading for a key's number in the result table. */
export function sortColumn(k: SortKey): string {
  if (k.by === 'fit') return 'fit score';
  return isNamed(k.by) ? k.by : `${k.by} ${k.basis ?? ''}`.trim();
}

/** Decimals to print a key's number with. */
export function sortDigits(k: SortKey): number {
  if (k.by === 'SV%') return 3;
  if (k.by === 'cwa' || k.by === 'weekCwa' || k.by === 'win' || k.by === 'perGame') return 3;
  if (isNamed(k.by)) return k.by === 'gp' || k.by === 'owned' ? 0 : 2;
  if (k.by === 'GAA' || k.basis === 'projected' || k.basis === 'seasonPerGame') return 2;
  return 0;
}

export interface SortInputs {
  view: LeagueView;
  store: Store;
  now: ReadonlyMap<string, PlayerValueNow> | undefined;
}

type Window = { kind: 'skater'; w: SkaterWindow } | { kind: 'goalie'; w: GoalieWindow };

function goalieStat(w: GoalieWindow, cat: string): number | undefined {
  const out: Record<string, number> = {
    W: w.wins,
    SHO: w.shutouts,
    SV: w.saves,
    GA: w.goalsAgainst,
    GS: w.starts,
    'SV%': w.svPct,
    GAA: w.gaa,
  };
  return out[cat];
}

/**
 * Computes each key's number for a player, reading his game history once per window. Built per
 * search, so the histories it reads are dropped with it.
 */
export function sortValues(inputs: SortInputs, spec: readonly SortKey[]) {
  const { view, store, now } = inputs;
  const windows = new Map<string, Window | null>();
  const { current } = seasonsAround(view.snap.date);
  const windowOf = (p: Player, basis: 'season' | 'last10'): Window | undefined => {
    const id = `${p.playerKey}|${basis}`;
    if (!windows.has(id)) {
      const q = basis === 'season' ? { season: current, to: view.snap.date } : { to: view.snap.date, last: 10 };
      const h = historyFor(view, store, p.playerKey, q);
      windows.set(
        id,
        h === undefined || h.games.length === 0
          ? null
          : h.kind === 'skater'
            ? { kind: 'skater', w: skaterWindow(basis, h.games) }
            : { kind: 'goalie', w: goalieWindow(basis, h.games) },
      );
    }
    return windows.get(id) ?? undefined;
  };
  let weights: Record<string, number> | undefined;
  let d7: ReadonlyMap<string, number> | undefined;
  const stat = (p: Player, cat: string, basis: StatBasis): number | undefined => {
    if (basis === 'projected') return rosLensView(view, store).view.projection(p.playerKey)?.perGame[cat];
    const win = windowOf(p, basis === 'last10' ? 'last10' : 'season');
    if (win === undefined) return undefined;
    if (win.kind === 'goalie') {
      const v = goalieStat(win.w, cat);
      return v === undefined || basis !== 'seasonPerGame' || isRateCategory(cat) || win.w.gp === 0 ? v : v / win.w.gp;
    }
    return basis === 'seasonPerGame' ? win.w.perGame[cat] : win.w.totals[cat];
  };
  const one = (p: Player, k: SortKey): number | undefined => {
    const lens = now?.get(p.playerKey);
    switch (k.by) {
      case 'fit':
        return playerFit(fitLens(view, store), (weights ??= needWeights(view, store)), p).score ?? undefined;
      case 'value':
        return view.valuation(p.playerKey)?.value;
      case 'ros':
        return lens?.vols;
      case 'vofa':
        return lens?.vofa;
      case 'cwa':
        return lens?.cwa;
      case 'win':
        return lens?.dWin;
      case 'weekCwa':
        return lens?.weekCwa;
      case 'perGame':
        return lens?.perGameValue ?? view.valuation(p.playerKey)?.perGameValue;
      case 'delta7d':
        try {
          return (d7 ??= weekChanges(view, store)).get(p.playerKey);
        } catch {
          return undefined; // no value history: the key is blank, not a crash (P9)
        }
      case 'gp':
        return lens?.gpCurrent;
      case 'owned':
        return p.percentOwned;
      default:
        return stat(p, k.by, k.basis ?? 'projected');
    }
  };
  return (p: Player): (number | undefined)[] =>
    spec.map((k) => {
      const v = one(p, k);
      return v !== undefined && Number.isFinite(v) ? v : undefined;
    });
}

/** Compare two players' key vectors under the spec: blanks last, then each key in turn. */
export function compareBy(spec: readonly SortKey[]) {
  return (a: readonly (number | undefined)[], b: readonly (number | undefined)[]): number => {
    for (let i = 0; i < spec.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x === undefined || y === undefined) {
        if (x !== y) return x === undefined ? 1 : -1;
        continue;
      }
      if (x !== y) return spec[i]?.order === 'asc' ? x - y : y - x;
    }
    return 0;
  };
}
