import { YahooShapeError } from './errors.js';
import { parsePlayer } from './players.js';
import { content, num, obj, optObj, reqStr, str, unwrap, type Raw } from './raw.js';

/**
 * A team's roster with each player's stats for one week or one day (verified 2026-10-25).
 *
 * The two coverages mean different things. A **week** (`roster;week=N/players/stats;type=week`)
 * gives the stats Yahoo *counted* for the team: games in an active seat only, so the players sum
 * to the team's line. A **day** (`roster;date=D/players/stats;type=date`) gives the player's real
 * NHL line that day whatever his seat, with `slot` saying where he sat; an idle player's stats
 * arrive as '-' and are left out, so an empty `stats` means he did not play.
 */
export interface RosterStatsPlayer {
  playerKey: string;
  name: string;
  /** Selected position: 'C', 'Util', 'BN', 'IR', …; on a week read, the slot on its first day. */
  slot: string;
  /** Eligible playing positions (reserve slots excluded). */
  eligible: string[];
  positionType: 'P' | 'G';
  /** Keyed by Yahoo stat id. */
  stats: Record<string, number>;
}

export type RosterStatsCoverage = { type: 'week'; week: number } | { type: 'date'; date: string };

export interface RosterStats {
  teamKey: string;
  coverage: RosterStatsCoverage;
  players: RosterStatsPlayer[];
}

function statsOf(p: Raw): {
  coverage: RosterStatsCoverage | undefined;
  stats: Record<string, number>;
} {
  const ps = optObj(p.player_stats);
  const stats: Record<string, number> = {};
  for (const s of unwrap(ps?.stats, 'stat')) {
    const id = str(s.stat_id);
    const v = num(s.value);
    if (id !== undefined && v !== undefined) stats[id] = v;
  }
  const type = str(ps?.coverage_type);
  const coverage: RosterStatsCoverage | undefined =
    type === 'week'
      ? { type, week: Number(ps?.week) }
      : type === 'date'
        ? { type, date: reqStr(ps?.date, 'player_stats.date') }
        : undefined;
  return { coverage, stats };
}

export function parseRosterStats(body: unknown): RosterStats {
  const team = obj(content(body).team, 'team');
  const list = optObj(team.roster)?.players ?? team.players;
  let coverage: RosterStatsCoverage | undefined;
  const players = unwrap(list, 'player').map((raw) => {
    const { player, detail } = parsePlayer(raw);
    const s = statsOf(raw);
    coverage ??= s.coverage;
    return {
      playerKey: player.playerKey,
      name: player.name,
      slot: detail.selectedPosition ?? 'BN',
      eligible: player.eligible,
      positionType: player.positionType,
      stats: s.stats,
    };
  });
  if (coverage === undefined)
    throw new YahooShapeError('roster stats: no player_stats coverage in the response');
  return { teamKey: reqStr(team.team_key, 'team.team_key'), coverage, players };
}
