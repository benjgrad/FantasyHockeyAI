import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LeagueSnapshot, type LeagueSettings, type Player } from '@fha/core';
import type { Store } from '@fha/store';
import { fillSeedGaps } from '@fha/tools';
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
 * A player the seed lacks (a call-up, a deep free agent) is filled from his game logs when the
 * store is available (D-035, `fillSeedGaps`): mapped by name, projected from his prior seasons or
 * at replacement level, valued on the seed's scale. A doubtful name join stays unvalued, which the
 * tools show honestly; a guessed identity would be worse. No seed at all means no valuations,
 * with a warning.
 */
export interface ValuateContext {
  settings: LeagueSettings;
  /** The snapshot date; its season is the one the prior excludes. */
  date: string;
  warn?: (message: string) => void;
}

export type Valuate = (players: readonly Player[], ctx?: ValuateContext) => Valued;

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

export function seededValuate(seedPath: string, fill?: { store: Store }): Valuate {
  const seed = LeagueSnapshot.parse(JSON.parse(readFileSync(seedPath, 'utf-8')));
  const ids = new Map(
    seed.players.flatMap((p) =>
      p.nhlId === undefined
        ? []
        : [[p.playerKey, { nhlId: p.nhlId, confidence: p.mapConfidence ?? 1 }] as const],
    ),
  );
  return (players, ctx) => {
    const base = seededValues(seed, ids, players);
    if (fill === undefined || ctx === undefined) return base;
    try {
      const r = fillSeedGaps({
        players,
        seed: base,
        store: fill.store,
        settings: ctx.settings,
        date: ctx.date,
      });
      return { valuations: r.valuations, projections: r.projections, ids: r.ids };
    } catch (e) {
      // The seed alone is still a usable snapshot (P9).
      ctx.warn?.(`filling unseeded players failed: ${e instanceof Error ? e.message : String(e)}`);
      return base;
    }
  };
}

function seededValues(
  seed: LeagueSnapshot,
  ids: ReadonlyMap<string, { nhlId: number; confidence: number }>,
  players: readonly Player[],
): Valued {
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
}

/**
 * The valuate function for a league: an explicit seed file if configured, else the newest
 * matching recording in `snapshotDir`. Throws when there is none; the builder turns that into
 * a warning and an unvalued snapshot.
 */
export function valuateFor(
  opts: { explicit: string | undefined; snapshotDir: string; store?: Store },
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
  return seededValuate(path, opts.store === undefined ? undefined : { store: opts.store });
}
