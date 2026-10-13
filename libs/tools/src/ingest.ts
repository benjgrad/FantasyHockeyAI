import type { GamesPull } from '@fha/nhl';
import type { Store } from '@fha/store';

/**
 * Pulling game-level history into the store (D-025): a backfill by season and a daily catch-up.
 * Windows are at most a calendar month (the per-game report returns a whole window per request;
 * a month is ~8k rows). Re-pulled games replace their rows, so running twice is harmless.
 */
export type PullGames = (q: { season: string; from: string; to: string }) => Promise<GamesPull>;

export interface IngestDeps {
  store: Store;
  pull: PullGames;
  log: (line: string) => void;
  /** Pause between monthly windows, to stay under the API's rate limit. Default 0. */
  pauseMs?: number;
}

/** The NHL season a date belongs to: "20262027" from September 2026 to August 2027. */
export function seasonOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 9 ? y : y - 1;
  return `${start}${start + 1}`;
}

/** The regular season's outer bounds: September 1 to June 30. */
export function seasonBounds(season: string): { from: string; to: string } {
  const y = Number(season.slice(0, 4));
  return { from: `${y}-09-01`, to: `${y + 1}-06-30` };
}

/** Calendar-month windows covering `from`..`to` (inclusive dates). */
export function monthWindows(from: string, to: string): [string, string][] {
  const out: [string, string][] = [];
  let start = from;
  while (start <= to) {
    const [y, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    out.push([start, last < to ? last : to]);
    start = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  return out;
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Pull a season's games between two dates (default: the whole season so far). */
export async function ingestSeason(
  deps: IngestDeps,
  season: string,
  range: { from?: string; to?: string } = {},
): Promise<{ skaters: number; goalies: number; windows: number }> {
  const b = seasonBounds(season);
  const from = range.from ?? b.from;
  const to = range.to !== undefined && range.to < b.to ? range.to : b.to;
  let skaters = 0;
  let goalies = 0;
  const windows = monthWindows(from, to);
  for (const [a, z] of windows) {
    const pull = await deps.pull({ season, from: a, to: z });
    const n = deps.store.nhlGames.upsert(pull);
    skaters += n.skaters;
    goalies += n.goalies;
    deps.log(`nhl games ${season} ${a}..${z}: ${n.skaters} skater, ${n.goalies} goalie rows`);
    if (deps.pauseMs !== undefined && deps.pauseMs > 0) {
      await new Promise((r) => setTimeout(r, deps.pauseMs));
    }
  }
  const prev = deps.store.nhlGames.lastDate(season);
  if (prev === undefined || to > prev) deps.store.nhlGames.setLastDate(season, to);
  return { skaters, goalies, windows: windows.length };
}

/**
 * The daily catch-up: the current season from the day before the last one ingested (late stat
 * corrections) through yesterday. A season never ingested starts from its beginning.
 */
export async function ingestDaily(
  deps: IngestDeps,
  today: string,
): Promise<{ season: string; from: string; to: string; skaters: number; goalies: number }> {
  const to = dayBefore(today);
  const season = seasonOf(to);
  const last = deps.store.nhlGames.lastDate(season);
  const from = last === undefined ? seasonBounds(season).from : dayBefore(last);
  const r = await ingestSeason(deps, season, { from, to });
  return { season, from, to, skaters: r.skaters, goalies: r.goalies };
}
