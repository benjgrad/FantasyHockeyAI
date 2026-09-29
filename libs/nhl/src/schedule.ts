import { NhlApiError, type FetchOptions } from './client.js';

/**
 * The NHL week schedule from `api-web.nhle.com/v1/schedule/{date}` (§11.2, U-05 verified).
 *
 * The response's `gameWeek` is seven days starting at the requested date. Team abbreviations
 * are converted to Yahoo's spelling here, because the league snapshot keys players by Yahoo's
 * `editorial_team_abbr`: a `TBL` game would never match a `TB` player and every Tampa skater
 * would silently show zero games this week.
 */
const BASE = 'https://api-web.nhle.com/v1';

/**
 * NHL → Yahoo abbreviations. Verified 2026-09-29 by diffing the 32 clubs in a live
 * `schedule/2026-09-29` response against Yahoo's pool: these four are the only differences.
 */
const NHL_TO_YAHOO: Readonly<Record<string, string>> = {
  LAK: 'LA',
  NJD: 'NJ',
  SJS: 'SJ',
  TBL: 'TB',
};
const YAHOO_TO_NHL: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NHL_TO_YAHOO).map(([n, y]) => [y, n]),
);

export function toYahooTeam(nhlAbbrev: string): string {
  return NHL_TO_YAHOO[nhlAbbrev] ?? nhlAbbrev;
}

export function toNhlTeam(yahooAbbrev: string): string {
  return YAHOO_TO_NHL[yahooAbbrev] ?? yahooAbbrev;
}

export interface ScheduledGame {
  /** Yahoo abbreviations. */
  home: string;
  away: string;
  startTimeUtc: string;
  /** 'FUT' | 'PRE' | 'LIVE' | 'CRIT' | 'FINAL' | 'OFF'. */
  gameState: string;
  gameId: number;
}

export interface ScheduleDay {
  date: string;
  games: ScheduledGame[];
}

/** Regular season and playoffs count toward fantasy; preseason and all-star games do not. */
const FANTASY_GAME_TYPES = new Set([2, 3]);
const NOT_PLAYED = new Set(['PPD', 'CNCL', 'SUSP']);

type Raw = Record<string, unknown>;
const rec = (v: unknown): Raw => (typeof v === 'object' && v !== null ? (v as Raw) : {});

function parseGame(g: Raw): ScheduledGame | undefined {
  if (!FANTASY_GAME_TYPES.has(Number(g.gameType))) return undefined;
  if (NOT_PLAYED.has(String(g.gameScheduleState ?? 'OK'))) return undefined;
  const home = rec(g.homeTeam).abbrev;
  const away = rec(g.awayTeam).abbrev;
  if (typeof home !== 'string' || typeof away !== 'string' || typeof g.startTimeUTC !== 'string') {
    return undefined;
  }
  return {
    home: toYahooTeam(home),
    away: toYahooTeam(away),
    startTimeUtc: g.startTimeUTC,
    gameState: String(g.gameState ?? ''),
    gameId: Number(g.id),
  };
}

export function parseScheduleWeek(body: unknown): ScheduleDay[] {
  const week = rec(body).gameWeek;
  if (!Array.isArray(week)) throw new Error('schedule response has no gameWeek array');
  return week.map((d) => {
    const day = rec(d);
    const games = Array.isArray(day.games) ? day.games : [];
    return {
      date: String(day.date),
      games: games.map((g) => parseGame(rec(g))).filter((g): g is ScheduledGame => g !== undefined),
    };
  });
}

/** Seven days of fantasy-relevant games starting at `date` (YYYY-MM-DD). */
export async function scheduleWeek(date: string, opts: FetchOptions = {}): Promise<ScheduleDay[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`expected YYYY-MM-DD, got ${date}`);
  const { timeoutMs = 15_000, fetchImpl = fetch } = opts;
  const url = `${BASE}/schedule/${date}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new NhlApiError(`NHL schedule returned ${res.status}`, url, res.status);
  return parseScheduleWeek(await res.json());
}
