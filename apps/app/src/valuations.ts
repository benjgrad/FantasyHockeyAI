import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LeagueSnapshot, type Player } from '@fha/core';
import type { Valued } from './snapshot.js';

/**
 * Where a live snapshot's valuations come from in the app.
 *
 * The valuation model (projections from cached NHL seasons, the market prior, calibration,
 * the verified Yahoo↔NHL player map) runs in the CLI (`fha snapshot record`), which writes
 * valuations keyed by playerKey into `data/snapshots/live-<date>.json`. Rebuilding that
 * pipeline inside the web server would duplicate ~500 lines of apps/gm for no gain: the
 * values change when projections are re-run, not when rosters change. So the app joins each
 * live player, by playerKey, to the newest recorded snapshot for the same league.
 *
 * A player the seed lacks (a call-up, a deep free agent) stays unvalued, which the tools show
 * honestly; a guessed value would be worse. No seed at all means no valuations, with a warning.
 */
export type Valuate = (players: readonly Player[]) => Valued;

/** The newest `live-*.json` directly under `dir` whose league matches, or undefined. */
export function findSeed(dir: string, leagueKey: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('live-') && f.endsWith('.json'))
    .sort()
    .reverse();
  for (const f of files) {
    const path = join(dir, f);
    try {
      const head = JSON.parse(readFileSync(path, 'utf-8')) as { leagueKey?: unknown };
      if (head.leagueKey === leagueKey) return path;
    } catch {
      // An unreadable file is skipped, not fatal (P9).
    }
  }
  return undefined;
}

export function seededValuate(seedPath: string): Valuate {
  const seed = LeagueSnapshot.parse(JSON.parse(readFileSync(seedPath, 'utf-8')));
  const ids = new Map(
    seed.players.flatMap((p) =>
      p.nhlId === undefined
        ? []
        : [[p.playerKey, { nhlId: p.nhlId, confidence: p.mapConfidence ?? 1 }] as const],
    ),
  );
  return (players) => {
    const out: Valued = { valuations: {}, projections: {}, ids: new Map() };
    for (const p of players) {
      const v = seed.valuations[p.playerKey];
      const pr = seed.projections[p.playerKey];
      const id = ids.get(p.playerKey);
      if (v !== undefined) out.valuations[p.playerKey] = v;
      if (pr !== undefined) out.projections[p.playerKey] = pr;
      if (id !== undefined) out.ids.set(p.playerKey, id);
    }
    return out;
  };
}

/**
 * The valuate function for a league: an explicit seed file if configured, else the newest
 * matching recording in `snapshotDir`. Throws when there is none; the builder turns that into
 * a warning and an unvalued snapshot.
 */
export function valuateFor(
  opts: { explicit: string | undefined; snapshotDir: string },
  leagueKey: string,
): Valuate {
  const path = opts.explicit ?? findSeed(opts.snapshotDir, leagueKey);
  if (path === undefined) {
    return () => {
      throw new Error(
        `no recorded snapshot for ${leagueKey} to take valuations from; run "fha snapshot record"`,
      );
    };
  }
  return seededValuate(path);
}
