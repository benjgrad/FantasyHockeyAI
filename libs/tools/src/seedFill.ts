import type {
  LeagueSettings,
  Player,
  Projection,
  SnapshotProjection,
  SnapshotValuation,
} from '@fha/core';
import {
  buildPlayerMap,
  goaliePriorProjection,
  primarySlot,
  replacementPrior,
  skaterPriorProjection,
  valuePlayers,
  type NhlPosition,
  type PriorProjection,
  type ReplacementPrior,
} from '@fha/model';
import type { NhlPlayerRow, Store } from '@fha/store';
import { seasonsAround } from './history.js';

/**
 * Values for players the seed never valued (D-035).
 *
 * The seed (`fha snapshot record`) values the draft pool, joined by the verified player map. A
 * call-up or a waiver add from outside that pool has no seed row, and every consumer (valueNow,
 * ModelInputs, the ROS lens) skips a player without one: he is invisible to pickups and trades.
 * This fills the gap, in code (P1):
 *
 * 1. **Map** him to an NHL id by exact name among `nhl_players` whose position fits his Yahoo
 *    eligibility, team breaking a tie (`buildPlayerMap`'s guard). An ambiguous or weak join stays
 *    unmapped and unvalued (P3): a wrong join is a confident, wrong value all season.
 * 2. **Project** him from his prior-season game logs, shrunk toward replacement level at his
 *    position; with no NHL games at all, replacement level is his projection.
 * 3. **Value** him with the same §12.2 valuation over the snapshot's players, shifted by the
 *    median gap between the seed's values and the recomputed ones at his position, so he lands on
 *    the seed's (market-calibrated) scale.
 *
 * Seeded players are returned exactly as the seed had them.
 */
export interface SeedValues {
  valuations: Record<string, SnapshotValuation>;
  projections: Record<string, SnapshotProjection>;
  /** playerKey → NHL id and how sure the join is. */
  ids: Map<string, { nhlId: number; confidence: number }>;
}

export interface FilledPlayer {
  playerKey: string;
  nhlId?: number;
  basis: PriorProjection['basis'];
}

export interface UnmappedName {
  playerKey: string;
  reason: 'ambiguous' | 'noMatch' | 'teamMismatch';
}

export interface SeedFill extends SeedValues {
  filled: FilledPlayer[];
  /** Players left without an NHL id, and why. `noMatch` ones still get the replacement prior. */
  unmapped: UnmappedName[];
}

export interface SeedFillInput {
  players: readonly Player[];
  seed: SeedValues;
  store: Store;
  settings: LeagueSettings;
  /** The snapshot date; its season is the current one, excluded from the prior. */
  date: string;
  /** Hand-resolved joins, playerKey → NHL id (`config/player-overrides.yaml`). */
  overrides?: Readonly<Record<string, number>>;
}

/** Players nearest replacement level that the replacement prior averages. */
const REPLACEMENT_REFERENCE = 10;
const FORWARD = new Set(['C', 'LW', 'RW', 'F', 'W']);

type Group = 'G' | 'D' | 'F' | 'P';

/** Which NHL positions a Yahoo player can be: goalie, defense, forward, or any skater. */
function groupOf(p: Player): Group {
  if (p.positionType === 'G') return 'G';
  const d = p.eligible.includes('D');
  const f = p.eligible.some((e) => FORWARD.has(e));
  if (d && !f) return 'D';
  if (f && !d) return 'F';
  return 'P';
}

function fits(group: Group, nhlPosition: string): boolean {
  if (group === 'G') return nhlPosition === 'G';
  if (nhlPosition === 'G') return false;
  if (group === 'D') return nhlPosition === 'D';
  if (group === 'F') return nhlPosition !== 'D';
  return true;
}

/** Name-join players to NHL ids, one at a time against the candidates their position allows. */
export function mapByName(
  players: readonly Player[],
  nhl: readonly NhlPlayerRow[],
  taken: ReadonlySet<number>,
  overrides: Readonly<Record<string, number>> = {},
): { ids: SeedValues['ids']; unmapped: UnmappedName[] } {
  const ids: SeedValues['ids'] = new Map();
  const unmapped: UnmappedName[] = [];
  const used = new Set(taken);
  for (const p of players) {
    const group = groupOf(p);
    const candidates = nhl.filter((n) => fits(group, n.position) && !used.has(n.nhlId));
    const r = buildPlayerMap([{ playerKey: p.playerKey, name: p.name, team: p.nhlTeam }], candidates, overrides);
    const m = r.mapped[0];
    if (m !== undefined) {
      ids.set(p.playerKey, { nhlId: m.nhlId, confidence: m.confidence });
      used.add(m.nhlId);
      continue;
    }
    const u = r.unmapped[0];
    if (u !== undefined) unmapped.push({ playerKey: p.playerKey, reason: u.reason });
  }
  return { ids, unmapped };
}

/** The valuation position for a filled player: his NHL position, else his Yahoo eligibility. */
function positionFor(p: Player, nhlPosition: string | undefined): string {
  if (p.positionType === 'G') return 'G';
  if (nhlPosition !== undefined && ['C', 'L', 'R', 'D'].includes(nhlPosition)) {
    return primarySlot(nhlPosition as NhlPosition);
  }
  return p.eligible.find((e) => ['C', 'LW', 'RW', 'D'].includes(e)) ?? 'C';
}

/** Replacement priors by valuation position, learned from the seed's own players. */
function replacementPriors(seed: SeedValues): Map<string, ReplacementPrior> {
  const ref = new Map<string, { vorp: number; gp: number; perGame: Record<string, number> }[]>();
  for (const [key, v] of Object.entries(seed.valuations)) {
    const pr = seed.projections[key];
    if (pr === undefined) continue;
    ref.set(v.position, [...(ref.get(v.position) ?? []), { vorp: v.vorp, gp: pr.gp, perGame: pr.perGame }]);
  }
  return new Map([...ref].map(([pos, rows]) => [pos, replacementPrior(rows, REPLACEMENT_REFERENCE)]));
}

interface Projected {
  player: Player;
  position: string;
  prior: PriorProjection;
  nhlId?: number;
}

function project(
  p: Player,
  nhlId: number | undefined,
  nhl: ReadonlyMap<number, NhlPlayerRow>,
  i: SeedFillInput,
  priors: ReadonlyMap<string, ReplacementPrior>,
): Projected {
  const position = positionFor(p, nhlId === undefined ? undefined : nhl.get(nhlId)?.position);
  const opts = {
    season: seasonsAround(i.date).current,
    replacement: priors.get(position) ?? { gp: 0, perGame: {} },
  };
  const q = { to: i.date };
  const prior =
    p.positionType === 'G'
      ? goaliePriorProjection(nhlId === undefined ? [] : i.store.nhlGames.goalieGames(nhlId, q), opts)
      : skaterPriorProjection(nhlId === undefined ? [] : i.store.nhlGames.skaterGames(nhlId, q), opts);
  return { player: p, position, prior, ...(nhlId === undefined ? {} : { nhlId }) };
}

export function fillSeedGaps(i: SeedFillInput): SeedFill {
  const out: SeedFill = {
    valuations: { ...i.seed.valuations },
    projections: { ...i.seed.projections },
    ids: new Map(i.seed.ids),
    filled: [],
    unmapped: [],
  };
  const need = i.players.filter(
    (p) => i.seed.valuations[p.playerKey] === undefined || i.seed.projections[p.playerKey] === undefined,
  );
  if (need.length === 0) return out;

  const nhlRows = i.store.nhlGames.players();
  const taken = new Set([...i.seed.ids.values()].map((x) => x.nhlId));
  const joined = mapByName(
    need.filter((p) => !out.ids.has(p.playerKey)),
    nhlRows,
    taken,
    i.overrides,
  );
  for (const [k, id] of joined.ids) out.ids.set(k, id);
  out.unmapped = joined.unmapped;

  // Only a player nobody in the NHL data resembles is presumed new; a doubtful join stays unvalued.
  const doubtful = new Set(joined.unmapped.filter((u) => u.reason !== 'noMatch').map((u) => u.playerKey));
  const nhlById = new Map(nhlRows.map((r) => [r.nhlId, r]));
  const priors = replacementPriors(i.seed);
  const projected = need
    .filter((p) => !doubtful.has(p.playerKey))
    .map((p) => project(p, out.ids.get(p.playerKey)?.nhlId, nhlById, i, priors));
  for (const x of projected) {
    out.projections[x.player.playerKey] ??= x.prior.projection;
  }
  const valued = valueOnSeedScale(i, out, projected);
  for (const x of projected) {
    const v = valued.get(x.player.playerKey);
    if (v === undefined) continue;
    out.valuations[x.player.playerKey] ??= v;
    out.filled.push({
      playerKey: x.player.playerKey,
      ...(x.nhlId === undefined ? {} : { nhlId: x.nhlId }),
      basis: x.prior.basis,
    });
  }
  return out;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * §12.2 over every player with a projection, then each filled player's value moved by the
 * median (seed − recomputed) at his position: the seed was valued over the whole NHL and
 * calibrated against the market (D-010), the snapshot holds only Yahoo's players.
 */
function valueOnSeedScale(
  i: SeedFillInput,
  values: SeedValues,
  projected: readonly Projected[],
): Map<string, SnapshotValuation> {
  const fresh = new Map(projected.map((x) => [x.player.playerKey, x]));
  const keys: string[] = [];
  const projections: Projection[] = [];
  for (const p of i.players) {
    const pr = values.projections[p.playerKey];
    const position = fresh.get(p.playerKey)?.position ?? i.seed.valuations[p.playerKey]?.position;
    if (pr === undefined || position === undefined) continue;
    projections.push({
      nhlId: keys.length,
      name: p.name,
      team: p.nhlTeam,
      positionType: p.positionType,
      position,
      eligible: p.eligible.filter((e) => e !== 'Util' && e !== 'IR' && e !== 'IR+'),
      gp: pr.gp,
      perGame: pr.perGame,
      totals: pr.totals,
      volume: { shotsAgainst: pr.totals['SA'], toiMinutes: pr.totals['TOI'] },
      lowConfidence: false,
      notes: [],
    });
    keys.push(p.playerKey);
  }
  const computed = valuePlayers({ settings: i.settings, projections }).valuations;
  const gaps = new Map<string, { value: number[]; vorp: number[] }>();
  for (const v of computed) {
    const seed = i.seed.valuations[keys[v.nhlId] ?? ''];
    if (seed === undefined) continue;
    const g = gaps.get(v.position) ?? { value: [], vorp: [] };
    g.value.push(seed.value - v.value);
    g.vorp.push(seed.vorp - v.vorp);
    gaps.set(v.position, g);
  }
  const out = new Map<string, SnapshotValuation>();
  for (const v of computed) {
    const key = keys[v.nhlId] ?? '';
    const x = fresh.get(key);
    if (x === undefined) continue;
    const g = gaps.get(v.position);
    const value = v.value + median(g?.value ?? []);
    out.set(key, {
      value,
      vorp: v.vorp + median(g?.vorp ?? []),
      perGameValue: v.gp > 0 ? value / v.gp : 0,
      position: v.position,
      z: v.z,
      gp: v.gp,
      lowConfidence: x.prior.lowConfidence,
    });
  }
  return out;
}
