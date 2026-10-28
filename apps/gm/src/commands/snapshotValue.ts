import type {
  Player,
  Projection,
  SnapshotProjection,
  SnapshotValuation,
  Valuation,
} from '@fha/core';
import { buildPlayerMap } from '@fha/model';

/**
 * Join live Yahoo players to our valuations (§10.5), keyed by playerKey for the snapshot.
 *
 * The verified player map (`data/yahoo/player-map.json`) is authoritative. A live player it
 * lacks — a call-up, a waiver add who was outside the draft pool — gets one attempt at the
 * name join, against NHL ids nobody in the map already holds. A weak or ambiguous join leaves
 * him without a valuation: an unvalued player is visible and honest, a wrongly joined one
 * carries a confident, wrong value for the whole season.
 */
export interface Ranking {
  valuations: readonly Valuation[];
  projections: readonly Projection[];
  /**
   * Every projected NHL player, not only the mapped pool the valuations cover: the name join's
   * candidates. A player joined outside the pool gets his NHL id and no value here; the app fills
   * his value from his game logs (D-035). Absent, the join falls back to the valuations.
   */
  candidates?: readonly { nhlId: number; name: string; team: string; position: string }[];
}

export interface ValuedPlayers {
  valuations: Record<string, SnapshotValuation>;
  projections: Record<string, SnapshotProjection>;
  /** playerKey → NHL id and how sure the join is. */
  ids: Map<string, { nhlId: number; confidence: number }>;
  nameJoined: number;
  unmapped: string[];
}

export function valueLivePlayers(
  players: readonly Player[],
  ranking: Ranking,
  map: ReadonlyMap<string, number>,
  overrides: Readonly<Record<string, number>> = {},
): ValuedPlayers {
  const ids = new Map<string, { nhlId: number; confidence: number }>();
  const missing: Player[] = [];
  for (const p of players) {
    const nhlId = map.get(p.playerKey);
    if (nhlId === undefined) missing.push(p);
    else ids.set(p.playerKey, { nhlId, confidence: 1 });
  }

  const taken = new Set(map.values());
  const candidates = (ranking.candidates ?? ranking.valuations)
    .filter((v) => !taken.has(v.nhlId))
    .map((v) => ({ nhlId: v.nhlId, name: v.name, team: v.team, position: v.position }));
  const joined = buildPlayerMap(
    missing.map((p) => ({ playerKey: p.playerKey, name: p.name, team: p.nhlTeam })),
    candidates,
    overrides,
  );
  for (const m of joined.mapped) ids.set(m.playerKey, { nhlId: m.nhlId, confidence: m.confidence });

  const byVal = new Map(ranking.valuations.map((v) => [v.nhlId, v]));
  const byProj = new Map(ranking.projections.map((p) => [p.nhlId, p]));
  const valuations: Record<string, SnapshotValuation> = {};
  const projections: Record<string, SnapshotProjection> = {};
  for (const [key, { nhlId }] of ids) {
    const v = byVal.get(nhlId);
    const pr = byProj.get(nhlId);
    if (v !== undefined) valuations[key] = toSnapshotValuation(v);
    if (pr !== undefined) projections[key] = { gp: pr.gp, perGame: pr.perGame, totals: pr.totals };
  }
  return {
    valuations,
    projections,
    ids,
    nameJoined: joined.mapped.length,
    unmapped: joined.unmapped.map((u) => u.playerKey),
  };
}

function toSnapshotValuation(v: Valuation): SnapshotValuation {
  return {
    value: v.value,
    vorp: v.vorp,
    perGameValue: v.perGameValue,
    position: v.position,
    z: v.z,
    gp: v.gp,
    lowConfidence: v.lowConfidence,
  };
}
