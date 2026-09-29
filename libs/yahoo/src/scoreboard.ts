import { content, flag, num, obj, optObj, reqStr, str, unwrap, type Raw } from './raw.js';

/**
 * The weekly scoreboard: every H2H matchup, with each side's category totals by stat id.
 * Values are numbers where Yahoo gives one; before any game is played they are absent.
 */
export interface MatchupTeam {
  teamKey: string;
  name: string;
  /** Category totals keyed by Yahoo stat id (U-06: ids are stable across seasons). */
  stats: Record<string, number>;
  points?: number;
  remainingGames?: number;
  liveGames?: number;
  completedGames?: number;
}

export interface Matchup {
  week: number;
  weekStart: string;
  weekEnd: string;
  /** 'preevent' | 'midevent' | 'postevent'. */
  status: string;
  isPlayoffs: boolean;
  teams: MatchupTeam[];
  statWinners: { statId: number; winnerTeamKey?: string; tied: boolean }[];
}

export interface Scoreboard {
  week: number;
  matchups: Matchup[];
}

function parseSide(t: Raw): MatchupTeam {
  const stats: Record<string, number> = {};
  for (const s of unwrap(optObj(t.team_stats)?.stats, 'stat')) {
    const v = num(s.value);
    const id = str(s.stat_id);
    if (v !== undefined && id !== undefined) stats[id] = v;
  }
  const remaining = optObj(optObj(t.team_remaining_games)?.total);
  const opt = {
    points: num(optObj(t.team_points)?.total),
    remainingGames: num(remaining?.remaining_games),
    liveGames: num(remaining?.live_games),
    completedGames: num(remaining?.completed_games),
  };
  return {
    teamKey: reqStr(t.team_key, 'team.team_key'),
    name: str(t.name) ?? '',
    stats,
    ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)),
  };
}

function parseMatchup(m: Raw): Matchup {
  return {
    week: Number(m.week),
    weekStart: reqStr(m.week_start, 'matchup.week_start'),
    weekEnd: reqStr(m.week_end, 'matchup.week_end'),
    status: str(m.status) ?? '',
    isPlayoffs: flag(m.is_playoffs),
    teams: unwrap(m.teams, 'team').map(parseSide),
    statWinners: unwrap(m.stat_winners, 'stat_winner').map((w) => {
      const winner = str(w.winner_team_key);
      return {
        statId: Number(w.stat_id),
        tied: flag(w.is_tied),
        ...(winner === undefined ? {} : { winnerTeamKey: winner }),
      };
    }),
  };
}

export function parseScoreboard(body: unknown): Scoreboard {
  const lg = obj(content(body).league, 'league');
  const sb = obj(lg.scoreboard, 'league.scoreboard');
  return { week: Number(sb.week), matchups: unwrap(sb.matchups, 'matchup').map(parseMatchup) };
}

/** The matchup a team plays in, if it has one this week. */
export function matchupFor(sb: Scoreboard, teamKey: string): Matchup | undefined {
  return sb.matchups.find((m) => m.teams.some((t) => t.teamKey === teamKey));
}
