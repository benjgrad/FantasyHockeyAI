import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LeagueSnapshot, type LeagueSettings, type Player } from '@fha/core';
import type { Store } from '@fha/store';
import { fillSeedGaps, type FilledPlayer, type UnmappedName } from '@fha/tools';
import { findSeed } from './valuations.js';

/**
 * Re-record the valuation seed (D-035): the weekly job that keeps the base values up with the
 * league's player pool.
 *
 * The seed is the newest `live-*.json` for the league in the snapshot directory (or the
 * configured one). This writes `live-<date>.json` next to it: today's snapshot, with
 *
 * - every value the old seed had, unchanged (players who left the pool keep their rows, so a
 *   player who comes back is still valued on the market-calibrated scale);
 * - every current player the old seed lacked, filled by `fillSeedGaps`: mapped by name to an NHL
 *   id, projected from his prior-season game logs (or at replacement level), valued on the
 *   seed's scale. Doubtful name joins stay unvalued (P3).
 *
 * Because `findSeed` takes the newest file, the next league rebuild values from the new seed
 * without a restart. Deterministic and idempotent: a second run the same day rewrites the same
 * bytes. Throws when there is no seed to build on; nothing is written then (P5).
 */
export interface ReseedDeps {
  store: Store;
  /** Today's live league snapshot (a league view's `snap`). Its own values are not trusted. */
  snapshot: LeagueSnapshot;
  settings: LeagueSettings;
  /** Where seeds live: `config.snapshotDir`. The new seed is written here. */
  snapshotDir: string;
  /** `config.valuationSnapshot`, when a seed is pinned. */
  explicit?: string;
  /** Hand-resolved name joins, playerKey → NHL id. */
  overrides?: Readonly<Record<string, number>>;
}

export interface ReseedResult {
  /** The seed written. */
  path: string;
  /** The seed it was built from. */
  from: string;
  players: number;
  valued: number;
  filled: FilledPlayer[];
  unmapped: UnmappedName[];
}

export function reseedValuations(d: ReseedDeps): ReseedResult {
  const from = d.explicit ?? findSeed(d.snapshotDir, d.snapshot.leagueKey);
  if (from === undefined) {
    throw new Error(
      `no recorded snapshot for ${d.snapshot.leagueKey} to re-seed from; run "fha snapshot record"`,
    );
  }
  const old = LeagueSnapshot.parse(JSON.parse(readFileSync(from, 'utf-8')));
  const ids = new Map(
    [...old.players, ...d.snapshot.players].flatMap((p) =>
      p.nhlId === undefined || old.valuations[p.playerKey] === undefined
        ? []
        : [[p.playerKey, { nhlId: p.nhlId, confidence: p.mapConfidence ?? 1 }] as const],
    ),
  );
  const fill = fillSeedGaps({
    players: d.snapshot.players,
    seed: { valuations: old.valuations, projections: old.projections, ids },
    store: d.store,
    settings: d.settings,
    date: d.snapshot.date,
    ...(d.overrides === undefined ? {} : { overrides: d.overrides }),
  });

  const players = mergePlayers(d.snapshot.players, old.players, fill.ids);
  const seed = LeagueSnapshot.parse({
    ...d.snapshot,
    players,
    valuations: fill.valuations,
    projections: fill.projections,
  });
  mkdirSync(d.snapshotDir, { recursive: true });
  const path = join(d.snapshotDir, `live-${d.snapshot.date}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(seed, null, 1)}\n`, 'utf-8');
  renameSync(tmp, path);
  return {
    path,
    from,
    players: players.length,
    valued: Object.keys(seed.valuations).length,
    filled: fill.filled,
    unmapped: fill.unmapped,
  };
}

/** Today's players with their NHL ids, then the old seed's players today's pool no longer holds. */
function mergePlayers(
  current: readonly Player[],
  old: readonly Player[],
  ids: ReadonlyMap<string, { nhlId: number; confidence: number }>,
): Player[] {
  const seen = new Set(current.map((p) => p.playerKey));
  const withIds = current.map((p) => {
    const id = ids.get(p.playerKey);
    return id === undefined ? p : { ...p, nhlId: id.nhlId, mapConfidence: id.confidence };
  });
  return [...withIds, ...old.filter((p) => !seen.has(p.playerKey))];
}
