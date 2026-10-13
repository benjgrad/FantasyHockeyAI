import { z } from 'zod';
import { getGameRows, type FetchOptions } from './client.js';

/**
 * Per-game stats (D-025): one row per player per game from the stats REST reports with
 * `isGame=true` [V 2026-10-02]. Four reports, merged by (player, game): skater summary (G, A,
 * +/-, PIM, PPP, SHP, GWG, SOG, TOI), skater realtime (hits, blocks), skater faceoffs (wins), and
 * goalie summary. Every Yahoo category is covered; nothing here is a rate the caller cannot
 * rebuild (goalie SV% and GAA come from saves, shots against, goals against and minutes).
 */
export const SkaterGame = z.object({
  nhlId: z.number().int(),
  gameId: z.number().int(),
  gameDate: z.string(),
  season: z.string(),
  name: z.string(),
  position: z.string(),
  team: z.string(),
  opponent: z.string(),
  home: z.boolean(),
  g: z.number(),
  a: z.number(),
  pts: z.number(),
  pm: z.number(),
  pim: z.number(),
  ppp: z.number(),
  shp: z.number(),
  gwg: z.number(),
  sog: z.number(),
  hit: z.number(),
  blk: z.number(),
  fow: z.number(),
  toiS: z.number(),
});
export type SkaterGame = z.infer<typeof SkaterGame>;

export const GoalieGame = z.object({
  nhlId: z.number().int(),
  gameId: z.number().int(),
  gameDate: z.string(),
  season: z.string(),
  name: z.string(),
  team: z.string(),
  opponent: z.string(),
  home: z.boolean(),
  started: z.boolean(),
  w: z.number(),
  l: z.number(),
  otl: z.number(),
  ga: z.number(),
  sa: z.number(),
  sv: z.number(),
  so: z.number(),
  toiS: z.number(),
});
export type GoalieGame = z.infer<typeof GoalieGame>;

export interface GamesPull {
  skaters: SkaterGame[];
  goalies: GoalieGame[];
}

interface Common {
  playerId: number;
  gameId: number;
  gameDate: string;
  teamAbbrev: string;
  opponentTeamAbbrev: string;
  homeRoad: string;
}
interface SummaryRow extends Common {
  skaterFullName: string;
  positionCode: string;
  goals: number;
  assists: number;
  points: number;
  plusMinus: number;
  penaltyMinutes: number;
  ppPoints: number;
  shPoints: number;
  gameWinningGoals: number;
  shots: number;
  timeOnIcePerGame: number;
}
interface RealtimeRow extends Common {
  hits: number;
  blockedShots: number;
}
interface FaceoffRow extends Common {
  totalFaceoffWins: number;
}
interface GoalieRow extends Common {
  goalieFullName: string;
  gamesStarted: number;
  wins: number;
  losses: number;
  otLosses: number;
  goalsAgainst: number;
  shotsAgainst: number;
  saves: number;
  shutouts: number;
  timeOnIce: number;
}

const n = (v: number | null | undefined): number => (typeof v === 'number' ? v : 0);
const key = (r: { playerId: number; gameId: number }) => `${r.playerId}:${r.gameId}`;

/** Merge the four reports' rows into game rows. Pure, so it is tested on recorded fixtures. */
export function mergeGames(
  season: string,
  r: {
    summary: SummaryRow[];
    realtime: RealtimeRow[];
    faceoffs: FaceoffRow[];
    goalies: GoalieRow[];
  },
): GamesPull {
  const hits = new Map(r.realtime.map((x) => [key(x), x]));
  const fos = new Map(r.faceoffs.map((x) => [key(x), x]));
  const skaters = r.summary.map((s): SkaterGame => ({
    nhlId: s.playerId,
    gameId: s.gameId,
    gameDate: s.gameDate,
    season,
    name: s.skaterFullName,
    position: s.positionCode,
    team: s.teamAbbrev,
    opponent: s.opponentTeamAbbrev,
    home: s.homeRoad === 'H',
    g: n(s.goals),
    a: n(s.assists),
    pts: n(s.points),
    pm: n(s.plusMinus),
    pim: n(s.penaltyMinutes),
    ppp: n(s.ppPoints),
    shp: n(s.shPoints),
    gwg: n(s.gameWinningGoals),
    sog: n(s.shots),
    hit: n(hits.get(key(s))?.hits),
    blk: n(hits.get(key(s))?.blockedShots),
    fow: n(fos.get(key(s))?.totalFaceoffWins),
    toiS: n(s.timeOnIcePerGame),
  }));
  const goalies = r.goalies.map((g): GoalieGame => ({
    nhlId: g.playerId,
    gameId: g.gameId,
    gameDate: g.gameDate,
    season,
    name: g.goalieFullName,
    team: g.teamAbbrev,
    opponent: g.opponentTeamAbbrev,
    home: g.homeRoad === 'H',
    started: n(g.gamesStarted) > 0,
    w: n(g.wins),
    l: n(g.losses),
    otl: n(g.otLosses),
    ga: n(g.goalsAgainst),
    sa: n(g.shotsAgainst),
    sv: n(g.saves),
    so: n(g.shutouts),
    toiS: n(g.timeOnIce),
  }));
  return { skaters, goalies };
}

/** Regular-season games of `season` from `from` to `to` (inclusive dates). Keep it to ~a month. */
export async function pullGames(
  q: { season: string; from: string; to: string },
  opts: FetchOptions = {},
): Promise<GamesPull> {
  const cayenne = `seasonId=${q.season} and gameTypeId=2 and gameDate>="${q.from}" and gameDate<="${q.to}"`;
  // One report at a time: the API rate-limits bursts (429 seen backfilling, 2026-10-02).
  const o = { attempts: 5, ...opts };
  const summary = await getGameRows<SummaryRow>('skater/summary', cayenne, o);
  const realtime = await getGameRows<RealtimeRow>('skater/realtime', cayenne, o);
  const faceoffs = await getGameRows<FaceoffRow>('skater/faceoffwins', cayenne, o);
  const goalies = await getGameRows<GoalieRow>('goalie/summary', cayenne, o);
  return mergeGames(q.season, { summary, realtime, faceoffs, goalies });
}
