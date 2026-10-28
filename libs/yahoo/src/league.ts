import {
  BENCH_POSITIONS,
  type LeagueSettings,
  type LeagueTeam,
  type StatCategory,
  type Transaction,
} from '@fha/core';
import { YahooShapeError } from './errors.js';
import {
  content,
  flag,
  isoFromUnix,
  num,
  obj,
  optObj,
  reqStr,
  str,
  unwrap,
  type Raw,
} from './raw.js';

/**
 * League-level parsers: settings, teams, transactions and the user's own teams.
 * Shapes verified against `json_f` responses from league 477.l.48535 (2026-09-24 and -29).
 */

/** Settings `LeagueSettings` has no room for, but that scheduling and limits depend on. */
export interface LeagueMeta {
  currentWeek?: number;
  startDate?: string;
  endDate?: string;
  /** Yahoo's "today" for the league, YYYY-MM-DD. */
  currentDate?: string;
  /** The date whose lineup is currently editable (U-02). */
  editKey?: string;
  /** `intraday` = each player locks at his own game start (U-09). */
  lineupDeadline?: string;
  maxWeeklyAdds?: number;
  waiverDays?: number;
  /** Goalie minimum games per week. */
  minGoalieGames?: number;
  tradeEndDate?: string;
  playoffStartWeek?: number;
  /** Where undrafted players go after the draft: 'W' (waivers) or 'FA'. */
  postDraftPlayers?: string;
  /** Which dropped players go through waivers: 'all', 'gametime', … [U] beyond 'all'. */
  waiverRule?: string;
}

const RATE = new Set(['GAA', 'SV%']);
const DRAFT_STATUSES = ['predraft', 'drafting', 'postdraft'] as const;

function parseCategory(c: Raw): StatCategory {
  const abbr = reqStr(c.display_name ?? c.abbr, 'stat.display_name');
  return {
    statId: Number(c.stat_id),
    abbr,
    positionType: str(c.position_type) === 'G' ? 'G' : 'P',
    higherIsBetter: str(c.sort_order) === '1',
    isDisplayOnly: str(c.enabled ?? '1') !== '1' || flag(c.is_only_display_stat),
    kind: RATE.has(abbr) ? 'rate' : 'count',
  };
}

function parseDraftStatus(v: unknown): LeagueSettings['draftStatus'] {
  const s = str(v);
  const hit = DRAFT_STATUSES.find((d) => d === s);
  if (hit === undefined) throw new YahooShapeError(`unknown draft_status ${String(s)}`);
  return hit;
}

export function parseSettings(body: unknown): { settings: LeagueSettings; meta: LeagueMeta } {
  const lg = obj(content(body).league, 'league');
  const s = obj(lg.settings, 'league.settings');
  const bench = new Set<string>(BENCH_POSITIONS);
  const settings: LeagueSettings = {
    leagueKey: reqStr(lg.league_key, 'league.league_key'),
    name: reqStr(lg.name, 'league.name'),
    numTeams: Number(lg.num_teams),
    scoringType: reqStr(s.scoring_type ?? lg.scoring_type, 'scoring_type'),
    categories: unwrap(optObj(s.stat_categories)?.stats, 'stat').map(parseCategory),
    rosterSlots: unwrap(s.roster_positions, 'roster_position').map((p) => {
      const position = reqStr(p.position, 'roster_position.position');
      const starting = p.is_starting_position;
      return {
        position,
        count: Number(p.count),
        isStarting: starting === undefined ? !bench.has(position) : flag(starting),
      };
    }),
    usesFaab: flag(s.uses_faab),
    draftStatus: parseDraftStatus(lg.draft_status),
    // Read through the website's backend with session cookies, not a developer app (D-005);
    // config/league.yaml labels that path 'browser', and so does this.
    source: 'browser',
    ...(str(s.waiver_type) === undefined ? {} : { waiverType: str(s.waiver_type) }),
  };
  return { settings, meta: parseMeta(lg, s) };
}

function parseMeta(lg: Raw, s: Raw): LeagueMeta {
  const meta: Record<string, string | number | undefined> = {
    currentWeek: num(lg.current_week),
    startDate: str(lg.start_date),
    endDate: str(lg.end_date),
    currentDate: str(lg.current_date),
    editKey: str(lg.edit_key),
    lineupDeadline: str(lg.weekly_deadline),
    maxWeeklyAdds: num(s.max_weekly_adds),
    waiverDays: num(s.waiver_time),
    minGoalieGames: num(s.min_games_played),
    tradeEndDate: str(s.trade_end_date),
    playoffStartWeek: num(s.playoff_start_week),
    postDraftPlayers: str(s.post_draft_players),
    waiverRule: str(s.waiver_rule),
  };
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) as LeagueMeta;
}

export function parseTeamRaw(t: Raw): LeagueTeam & { mine: boolean } {
  const manager = unwrap(t.managers, 'manager')[0];
  const nickname = str(manager?.nickname);
  const priority = num(t.waiver_priority);
  return {
    teamKey: reqStr(t.team_key, 'team.team_key'),
    name: reqStr(t.name, 'team.name'),
    mine: flag(t.is_owned_by_current_login),
    ...(nickname === undefined ? {} : { managerNickname: nickname }),
    ...(priority === undefined || priority < 1 ? {} : { waiverPriority: priority }),
  };
}

export function parseTeams(body: unknown): (LeagueTeam & { mine: boolean })[] {
  return unwrap(obj(content(body).league, 'league').teams, 'team').map(parseTeamRaw);
}

const TX_TYPES: ReadonlySet<string> = new Set([
  'add',
  'drop',
  'add/drop',
  'trade',
  'pending_trade',
  'waiver',
]);

/** `transaction_data` is an object in json_f, but tolerate the array form too. */
function txData(p: Raw): Raw | undefined {
  const d = p.transaction_data;
  return Array.isArray(d) ? optObj(d[0]) : optObj(d);
}

function parseTransaction(t: Raw): Transaction | undefined {
  const type = str(t.type);
  if (type === undefined || !TX_TYPES.has(type)) return undefined; // e.g. 'commish'
  const players = unwrap(t.players, 'player').map((p) => {
    const d = txData(p);
    const from = str(d?.source_team_key);
    const to = str(d?.destination_team_key);
    return {
      playerKey: reqStr(p.player_key, 'transaction.player.player_key'),
      ...(from === undefined ? {} : { fromTeamKey: from }),
      ...(to === undefined ? {} : { toTeamKey: to }),
    };
  });
  const first = players[0];
  const teamKey =
    str(t.trader_team_key) ??
    str(t.waiver_team_key) ??
    (type === 'drop' ? first?.fromTeamKey : (first?.toTeamKey ?? first?.fromTeamKey));
  const tradee = str(t.tradee_team_key);
  const status = str(t.status);
  return {
    transactionKey: reqStr(t.transaction_key, 'transaction.transaction_key'),
    type: type as Transaction['type'],
    timestamp: isoFromUnix(t.timestamp) ?? '',
    players,
    ...(teamKey === undefined ? {} : { teamKey }),
    ...(tradee === undefined ? {} : { tradeeTeamKey: tradee }),
    ...(status === undefined ? {} : { status }),
  };
}

/** Transactions of the types the domain models; commissioner edits and the like are skipped. */
export function parseTransactions(body: unknown): Transaction[] {
  const lg = obj(content(body).league, 'league');
  return unwrap(lg.transactions, 'transaction')
    .map(parseTransaction)
    .filter((t): t is Transaction => t !== undefined);
}

export interface MyTeam {
  gameKey: string;
  season: string;
  teamKey: string;
  leagueKey: string;
  name: string;
}

/** `/users;use_login=1/games;game_keys=nhl/teams`: validates a connection and lists leagues. */
export function parseMyTeams(body: unknown): MyTeam[] {
  const user = unwrap(content(body).users, 'user')[0];
  return unwrap(user?.games, 'game').flatMap((g) =>
    unwrap(g.teams, 'team').map((t) => {
      const teamKey = reqStr(t.team_key, 'team.team_key');
      return {
        gameKey: reqStr(g.game_key, 'game.game_key'),
        season: str(g.season) ?? '',
        teamKey,
        leagueKey: teamKey.split('.t.')[0] ?? teamKey,
        name: str(t.name) ?? teamKey,
      };
    }),
  );
}
