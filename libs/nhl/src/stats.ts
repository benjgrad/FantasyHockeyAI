import { currentTeam, getReport, type FetchOptions } from './client.js';
import type { GoalieSeason, SeasonPull, SkaterSeason } from './rows.js';

interface SummaryRow {
  playerId: number;
  skaterFullName: string;
  positionCode: string;
  teamAbbrevs: string;
  gamesPlayed: number;
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
interface RealtimeRow {
  playerId: number;
  hits: number;
  blockedShots: number;
}
interface FaceoffRow {
  playerId: number;
  totalFaceoffWins: number;
}
interface GoalieRow {
  playerId: number;
  goalieFullName: string;
  teamAbbrevs: string;
  gamesPlayed: number;
  gamesStarted: number;
  wins: number;
  losses: number;
  goalsAgainst: number;
  goalsAgainstAverage: number;
  savePct: number;
  saves: number;
  shotsAgainst: number;
  shutouts: number;
  timeOnIce: number;
}

const num = (v: number | null | undefined): number => (typeof v === 'number' ? v : 0);

/** Yahoo/NHL position codes are C, L, R, D. Anything else is a data problem, not a silent default. */
function skaterPosition(code: string): 'C' | 'L' | 'R' | 'D' {
  if (code === 'C' || code === 'L' || code === 'R' || code === 'D') return code;
  throw new Error(`unexpected NHL positionCode ${JSON.stringify(code)}`);
}

/**
 * Pull one season and merge the reports into per-player rows.
 *
 * Four requests: skater summary (which already carries PIM, SHP and GWG), skater
 * realtime (hits, blocks), skater faceoffs, and goalie summary.
 */
export async function pullSeason(seasonId: string, opts: FetchOptions = {}): Promise<SeasonPull> {
  const [summary, realtime, faceoffs, goalies] = await Promise.all([
    getReport<SummaryRow>('skater/summary', seasonId, opts),
    getReport<RealtimeRow>('skater/realtime', seasonId, opts),
    getReport<FaceoffRow>('skater/faceoffwins', seasonId, opts),
    getReport<GoalieRow>('goalie/summary', seasonId, opts),
  ]);

  const hitsById = new Map(realtime.data.map((r) => [r.playerId, r]));
  const foById = new Map(faceoffs.data.map((r) => [r.playerId, r]));

  const skaters: SkaterSeason[] = summary.data.map((r) => {
    const rt = hitsById.get(r.playerId);
    const fo = foById.get(r.playerId);
    return {
      nhlId: r.playerId,
      name: r.skaterFullName,
      position: skaterPosition(r.positionCode),
      team: currentTeam(r.teamAbbrevs),
      seasonId,
      gp: num(r.gamesPlayed),
      goals: num(r.goals),
      assists: num(r.assists),
      points: num(r.points),
      plusMinus: num(r.plusMinus),
      pim: num(r.penaltyMinutes),
      ppp: num(r.ppPoints),
      shp: num(r.shPoints),
      gwg: num(r.gameWinningGoals),
      sog: num(r.shots),
      hits: num(rt?.hits),
      blocks: num(rt?.blockedShots),
      faceoffWins: num(fo?.totalFaceoffWins),
      toiPerGame: num(r.timeOnIcePerGame),
    };
  });

  const goalieRows: GoalieSeason[] = goalies.data.map((r) => ({
    nhlId: r.playerId,
    name: r.goalieFullName,
    team: currentTeam(r.teamAbbrevs),
    seasonId,
    gp: num(r.gamesPlayed),
    gs: num(r.gamesStarted),
    wins: num(r.wins),
    losses: num(r.losses),
    goalsAgainst: num(r.goalsAgainst),
    gaa: num(r.goalsAgainstAverage),
    savePct: num(r.savePct),
    saves: num(r.saves),
    shotsAgainst: num(r.shotsAgainst),
    shutouts: num(r.shutouts),
    toiMinutes: num(r.timeOnIce) / 60,
  }));

  return { seasonId, fetchedAt: new Date().toISOString(), skaters, goalies: goalieRows };
}

/** The three seasons §12.1 weights, most recent first. */
export function recentSeasons(startYear: number, count = 3): string[] {
  return Array.from({ length: count }, (_, i) => {
    const y = startYear - i;
    return `${y}${y + 1}`;
  });
}
