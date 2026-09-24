import type { Projection } from '@fha/core';
import type { GoalieSeason, SeasonPull, SkaterSeason } from '@fha/nhl';
import {
  GOALIE_CATEGORY_FIELDS,
  GOALIE_COUNTING_CATEGORIES,
  SKATER_CATEGORIES,
  SKATER_CATEGORY_FIELDS,
} from './categories.js';
import { mean } from './numeric.js';
import { primarySlot, type NhlPosition } from './positions.js';

/** Pre-season weights (§12.1): last, previous, the one before. */
export const PRESEASON_WEIGHTS = [0.5, 0.3, 0.2] as const;
export const SKATER_SHRINK_K = 20;
export const GOALIE_SHRINK_K = 12;
const FULL_SEASON_GAMES = 82;
/** Regulars (GP >= 60 last season) are floored at 70% of the schedule. */
const REGULAR_GP_FLOOR_SHARE = 0.7;
const REGULAR_GP_THRESHOLD = 60;
const LOW_CONFIDENCE_CAREER_GP = 10;
/**
 * A projection built from one season is a different animal from one built on three,
 * even when that season was a full 82 games: there is no evidence the rate repeats.
 * Rookies must be visibly flagged rather than ranked as though they were established.
 */
const MIN_SEASONS_FOR_CONFIDENCE = 2;

export interface ProjectionOptions {
  /** Seasons most recent first. Extra seasons beyond the weight list are ignored. */
  seasons: readonly SeasonPull[];
  weights?: readonly number[];
  /** Games left for a team. Pre-season this is the full schedule. */
  remainingTeamGames?: number;
  /** Sizes the provisional pool the positional shrinkage means are taken over. */
  skaterPoolSize: number;
  goaliePoolSize: number;
}

interface Weighted<T> {
  row: T;
  weight: number;
}

/** GP_eff = sum of w_s * GP_s (§12.1). */
function effectiveGames(entries: readonly Weighted<{ gp: number }>[]): number {
  return entries.reduce((n, e) => n + e.weight * e.row.gp, 0);
}

/**
 * Weighted per-game rate: sum(w * total) / sum(w * GP). Equivalent to the spec's
 * sum(w*GP*rate)/sum(w*GP) but avoids dividing by a zero GP per season.
 */
function weightedRate<T extends { gp: number }>(
  entries: readonly Weighted<T>[],
  total: (row: T) => number,
): number {
  const denom = effectiveGames(entries);
  if (denom === 0) return 0;
  return entries.reduce((a, e) => a + e.weight * total(e.row), 0) / denom;
}

/** Shrink a rate toward a positional mean (§12.1). */
export function shrink(rate: number, gpEff: number, positionalMean: number, k: number): number {
  if (gpEff + k === 0) return positionalMean;
  return (gpEff * rate + k * positionalMean) / (gpEff + k);
}

function weightedShare(
  entries: readonly Weighted<{ gp: number }>[],
  games: (row: { gp: number }) => number,
  scheduleGames: number,
): number {
  const wsum = entries.reduce((a, e) => a + e.weight, 0);
  if (wsum === 0 || scheduleGames === 0) return 0;
  return entries.reduce((a, e) => a + e.weight * (games(e.row) / scheduleGames), 0) / wsum;
}

function group<T extends { nhlId: number }>(
  seasons: readonly SeasonPull[],
  weights: readonly number[],
  pick: (p: SeasonPull) => readonly T[],
): Map<number, Weighted<T>[]> {
  const out = new Map<number, Weighted<T>[]>();
  seasons.forEach((pull, i) => {
    const weight = weights[i];
    if (weight === undefined) return;
    for (const row of pick(pull)) {
      const list = out.get(row.nhlId) ?? [];
      list.push({ row, weight });
      out.set(row.nhlId, list);
    }
  });
  return out;
}

interface SkaterDraft {
  id: number;
  latest: SkaterSeason;
  gpEff: number;
  rawRates: Record<string, number>;
  gpProj: number;
  careerGp: number;
  seasonsPlayed: number;
}

function buildSkaterDrafts(
  grouped: Map<number, Weighted<SkaterSeason>[]>,
  remainingTeamGames: number,
): SkaterDraft[] {
  const drafts: SkaterDraft[] = [];
  for (const [id, entries] of grouped) {
    // entries are pushed most-recent-first because `seasons` is ordered that way
    const latest = entries[0]?.row;
    if (!latest) continue;
    const gpEff = effectiveGames(entries);
    const rawRates: Record<string, number> = {};
    for (const abbr of SKATER_CATEGORIES) {
      const field = SKATER_CATEGORY_FIELDS[abbr];
      rawRates[abbr] = weightedRate(entries, (r) => r[field]);
    }
    const share = weightedShare(entries, (r) => r.gp, FULL_SEASON_GAMES);
    let gpProj = Math.min(remainingTeamGames, Math.round(share * remainingTeamGames));
    if (latest.gp >= REGULAR_GP_THRESHOLD) {
      gpProj = Math.max(gpProj, Math.round(REGULAR_GP_FLOOR_SHARE * remainingTeamGames));
    }
    drafts.push({
      id,
      latest,
      gpEff,
      rawRates,
      gpProj,
      careerGp: entries.reduce((n, e) => n + e.row.gp, 0),
      seasonsPlayed: entries.filter((e) => e.row.gp > 0).length,
    });
  }
  return drafts;
}

/** Why a projection is untrustworthy, as text for the cheat sheet and the draft board. */
function confidenceNotes(careerGp: number, seasonsPlayed: number): string[] {
  const notes: string[] = [];
  if (careerGp < LOW_CONFIDENCE_CAREER_GP) {
    notes.push(`only ${careerGp} career GP in the sampled seasons`);
  }
  if (seasonsPlayed < MIN_SEASONS_FOR_CONFIDENCE) {
    notes.push(
      seasonsPlayed === 1
        ? 'one season of data: rate is unproven, treat the rank as provisional'
        : 'no season data: value cannot be projected',
    );
  }
  return notes;
}

/**
 * Positional means over a provisional pool (§12.1). The pool is the top
 * `poolSize` by provisional projected production, so the shrinkage target is a
 * startable-player baseline rather than a league-wide average that includes callups.
 */
function positionalMeans(
  drafts: readonly SkaterDraft[],
  poolSize: number,
): Map<string, Record<string, number>> {
  const provisional = [...drafts]
    .sort((a, b) => (b.rawRates['P'] ?? 0) * b.gpProj - (a.rawRates['P'] ?? 0) * a.gpProj)
    .slice(0, Math.max(1, poolSize));

  const byPos = new Map<string, SkaterDraft[]>();
  for (const d of provisional) {
    const slot = primarySlot(d.latest.position as NhlPosition);
    byPos.set(slot, [...(byPos.get(slot) ?? []), d]);
  }
  const out = new Map<string, Record<string, number>>();
  for (const [slot, members] of byPos) {
    const means: Record<string, number> = {};
    for (const abbr of SKATER_CATEGORIES) {
      means[abbr] = mean(members.map((m) => m.rawRates[abbr] ?? 0));
    }
    out.set(slot, means);
  }
  // Fall back to the whole provisional pool for a position with no representative.
  const overall: Record<string, number> = {};
  for (const abbr of SKATER_CATEGORIES) {
    overall[abbr] = mean(provisional.map((m) => m.rawRates[abbr] ?? 0));
  }
  out.set('*', overall);
  return out;
}

export function projectSkaters(opts: ProjectionOptions): Projection[] {
  const weights = opts.weights ?? PRESEASON_WEIGHTS;
  const remaining = opts.remainingTeamGames ?? FULL_SEASON_GAMES;
  const grouped = group(opts.seasons, [...weights], (p) => p.skaters);
  const drafts = buildSkaterDrafts(grouped, remaining);
  const means = positionalMeans(drafts, opts.skaterPoolSize);

  return drafts.map((d) => {
    const slot = primarySlot(d.latest.position as NhlPosition);
    const m = means.get(slot) ?? means.get('*') ?? {};
    const perGame: Record<string, number> = {};
    const totals: Record<string, number> = {};
    for (const abbr of SKATER_CATEGORIES) {
      const r = shrink(d.rawRates[abbr] ?? 0, d.gpEff, m[abbr] ?? 0, SKATER_SHRINK_K);
      perGame[abbr] = r;
      totals[abbr] = r * d.gpProj;
    }
    const notes = confidenceNotes(d.careerGp, d.seasonsPlayed);
    return {
      nhlId: d.id,
      name: d.latest.name,
      positionType: 'P' as const,
      position: slot,
      team: d.latest.team,
      gp: d.gpProj,
      perGame,
      totals,
      volume: {},
      lowConfidence: notes.length > 0,
      notes,
    };
  });
}

interface GoalieDraft {
  id: number;
  latest: GoalieSeason;
  gsEff: number;
  rawPerStart: Record<string, number>;
  gsProj: number;
  careerGp: number;
  seasonsPlayed: number;
}

export function projectGoalies(opts: ProjectionOptions): Projection[] {
  const weights = opts.weights ?? PRESEASON_WEIGHTS;
  const remaining = opts.remainingTeamGames ?? FULL_SEASON_GAMES;
  const grouped = group(opts.seasons, [...weights], (p) => p.goalies);

  const drafts: GoalieDraft[] = [];
  for (const [id, entries] of grouped) {
    const latest = entries[0]?.row;
    if (!latest) continue;
    // Goalie rates are per *start*, not per appearance.
    const asStarts = entries.map((e) => ({ row: { ...e.row, gp: e.row.gs }, weight: e.weight }));
    const gsEff = effectiveGames(asStarts);
    const rawPerStart: Record<string, number> = {};
    for (const abbr of GOALIE_COUNTING_CATEGORIES) {
      const field = GOALIE_CATEGORY_FIELDS[abbr];
      rawPerStart[abbr] = weightedRate(asStarts, (r) => r[field]);
    }
    rawPerStart['SA'] = weightedRate(asStarts, (r) => r.shotsAgainst);
    rawPerStart['TOI'] = weightedRate(asStarts, (r) => r.toiMinutes);
    const share = weightedShare(asStarts, (r) => r.gp, FULL_SEASON_GAMES);
    drafts.push({
      id,
      latest,
      gsEff,
      rawPerStart,
      gsProj: Math.min(remaining, share * remaining),
      careerGp: entries.reduce((n, e) => n + e.row.gp, 0),
      seasonsPlayed: entries.filter((e) => e.row.gs > 0).length,
    });
  }

  const poolSize = Math.max(1, opts.goaliePoolSize);
  const pool = [...drafts]
    .sort((a, b) => (b.rawPerStart['W'] ?? 0) * b.gsProj - (a.rawPerStart['W'] ?? 0) * a.gsProj)
    .slice(0, poolSize);
  const poolMeans: Record<string, number> = {};
  for (const key of [...GOALIE_COUNTING_CATEGORIES, 'SA', 'TOI']) {
    poolMeans[key] = mean(pool.map((p) => p.rawPerStart[key] ?? 0));
  }

  return drafts.map((d) => {
    const perGame: Record<string, number> = {};
    const totals: Record<string, number> = {};
    for (const key of [...GOALIE_COUNTING_CATEGORIES, 'SA', 'TOI']) {
      const r = shrink(d.rawPerStart[key] ?? 0, d.gsEff, poolMeans[key] ?? 0, GOALIE_SHRINK_K);
      perGame[key] = r;
      totals[key] = r * d.gsProj;
    }
    const saProj = totals['SA'] ?? 0;
    const toiProj = totals['TOI'] ?? 0;
    const gaProj = totals['GA'] ?? 0;
    const savesProj = totals['SV'] ?? 0;
    // Rate categories come from the projected volumes, not from averaging a ratio.
    totals['SV%'] = saProj > 0 ? savesProj / saProj : 0;
    totals['GAA'] = toiProj > 0 ? (gaProj * 60) / toiProj : 0;
    perGame['SV%'] = totals['SV%'];
    perGame['GAA'] = totals['GAA'];

    const notes = confidenceNotes(d.careerGp, d.seasonsPlayed);
    return {
      nhlId: d.id,
      name: d.latest.name,
      positionType: 'G' as const,
      position: 'G',
      team: d.latest.team,
      gp: d.gsProj,
      perGame,
      totals,
      volume: { shotsAgainst: saProj, toiMinutes: toiProj },
      lowConfidence: notes.length > 0,
      notes,
    };
  });
}

export function projectAll(opts: ProjectionOptions): Projection[] {
  return [...projectSkaters(opts), ...projectGoalies(opts)];
}
