import type {
  LeagueReader,
  LeagueSettings,
  LeagueTeam,
  Player,
  PlayerQuery,
  Roster,
  TeamKey,
  Transaction,
} from '@fha/core';
import { parseMyTeams, parseSettings, parseTeams, parseTransactions } from './league.js';
import type { LeagueMeta, MyTeam } from './league.js';
import { parsePlayers, type YahooPlayer } from './players.js';
import { parseRoster, type RosterRead } from './roster.js';
import { parseRosterStats, type RosterStats } from './rosterStats.js';
import { matchupFor, parseScoreboard, type Matchup, type Scoreboard } from './scoreboard.js';
import { sessionFromCredentials, type StoredSession, type YahooCredentials } from './session.js';
import { CookieTransport, type OnCookies, type YahooTransport } from './transport.js';

/** Yahoo caps collection pages at 25. */
export const PAGE = 25;
const PLAYER_OUT = ['percent_owned', 'ownership', 'player_notes'];

export interface YahooPlayerQuery extends PlayerQuery {
  /** 'OR' preseason overall rank, 'AR' actual rank, 'NAME', or a stat id. */
  sort?: string;
  /** With sort 'AR': the window it ranks over ('season', 'lastweek', 'lastmonth', …). */
  sortType?: string;
  start?: number;
}

/**
 * `LeagueReader` over Yahoo's live league, through the website session (D-005).
 *
 * League and team come from the constructor, which the caller fills from config or the user's
 * stored connection, never from a tool argument (P8). Every method is a GET; this class has no
 * way to change Yahoo. The `*Detailed` methods return what `LeagueReader`'s lean types drop:
 * status text, injury notes, the notes feed, ownership and waiver dates.
 */
export class WebSessionReader implements LeagueReader {
  constructor(
    private readonly t: YahooTransport,
    readonly leagueKey: string,
    readonly teamKey: TeamKey,
  ) {
    if (!teamKey.startsWith(`${leagueKey}.t.`)) {
      throw new Error(`team ${teamKey} is not in league ${leagueKey}`);
    }
  }

  async settings(): Promise<LeagueSettings> {
    return (await this.settingsAndMeta()).settings;
  }

  async settingsAndMeta(): Promise<{ settings: LeagueSettings; meta: LeagueMeta }> {
    return parseSettings(await this.t.get(`/league/${this.leagueKey}/settings`));
  }

  async teams(): Promise<LeagueTeam[]> {
    return (await this.teamsWithOwner()).map((t) => ({
      teamKey: t.teamKey,
      name: t.name,
      ...(t.managerNickname === undefined ? {} : { managerNickname: t.managerNickname }),
      ...(t.waiverPriority === undefined ? {} : { waiverPriority: t.waiverPriority }),
    }));
  }

  async teamsWithOwner(): Promise<(LeagueTeam & { mine: boolean })[]> {
    return parseTeams(await this.t.get(`/league/${this.leagueKey}/teams`));
  }

  async roster(teamKey: TeamKey, date: string): Promise<Roster> {
    return (await this.rosterDetailed(teamKey, date)).roster;
  }

  /** One request per team: roster slots plus notes and ownership percentage. */
  async rosterDetailed(teamKey: TeamKey, date: string): Promise<RosterRead> {
    assertDate(date);
    const path = `/team/${teamKey}/roster;date=${date}/players;out=player_notes,percent_owned`;
    return parseRoster(await this.t.get(path), date);
  }

  async players(q: PlayerQuery): Promise<Player[]> {
    return (await this.playersDetailed(q)).map((p) => p.player);
  }

  /** Paginates 25 at a time until `limit` (default 25) or a short page. */
  async playersDetailed(q: YahooPlayerQuery): Promise<YahooPlayer[]> {
    const limit = q.limit ?? PAGE;
    const all: YahooPlayer[] = [];
    for (let start = q.start ?? 0; all.length < limit; start += PAGE) {
      const count = Math.min(PAGE, limit - all.length);
      const page = parsePlayers(await this.t.get(playersPath(this.leagueKey, q, start, count)));
      all.push(...page);
      if (page.length < count) break;
    }
    return all;
  }

  /** Notes and status for specific players, 25 keys per request. */
  async playersByKey(keys: readonly string[]): Promise<YahooPlayer[]> {
    const out: YahooPlayer[] = [];
    for (let i = 0; i < keys.length; i += PAGE) {
      const batch = keys.slice(i, i + PAGE).join(',');
      const path = `/league/${this.leagueKey}/players;player_keys=${batch};out=${PLAYER_OUT.join(',')}`;
      out.push(...parsePlayers(await this.t.get(path)));
    }
    return out;
  }

  /**
   * Pending trades and waiver claims are per team in Yahoo (`team_key` is required), so those
   * two types are fetched for a team (ours by default); the rest come from the league feed.
   */
  async transactions(q: { type?: Transaction['type']; teamKey?: TeamKey }): Promise<Transaction[]> {
    if (q.type === 'pending_trade' || q.type === 'waiver') {
      const tk = q.teamKey ?? this.teamKey;
      const path = `/league/${this.leagueKey}/transactions;types=${q.type};team_key=${tk}`;
      return parseTransactions(await this.t.get(path));
    }
    const all = parseTransactions(await this.t.get(`/league/${this.leagueKey}/transactions`));
    return all.filter(
      (t) =>
        (q.type === undefined || t.type === q.type) &&
        (q.teamKey === undefined || t.teamKey === q.teamKey || t.tradeeTeamKey === q.teamKey),
    );
  }

  async scoreboard(week?: number): Promise<Scoreboard> {
    const suffix = week === undefined ? '' : `;week=${week}`;
    return parseScoreboard(await this.t.get(`/league/${this.leagueKey}/scoreboard${suffix}`));
  }

  /**
   * A team's players with the stats Yahoo counted for it in week `week` (active seats only), or
   * with each player's NHL line and seat on `date` (see `RosterStats`).
   */
  async rosterStats(
    teamKey: TeamKey,
    at: { week: number } | { date: string },
  ): Promise<RosterStats> {
    if ('week' in at) {
      const w = at.week;
      return parseRosterStats(
        await this.t.get(`/team/${teamKey}/roster;week=${w}/players/stats;type=week;week=${w}`),
      );
    }
    assertDate(at.date);
    const d = at.date;
    return parseRosterStats(
      await this.t.get(`/team/${teamKey}/roster;date=${d}/players/stats;type=date;date=${d}`),
    );
  }

  /** Our H2H matchup for the week (the current one by default). */
  async ourMatchup(week?: number): Promise<Matchup | undefined> {
    return matchupFor(await this.scoreboard(week), this.teamKey);
  }

  /** The signed-in user's NHL teams: how a new connection is validated and a league picked. */
  async myTeams(): Promise<MyTeam[]> {
    return parseMyTeams(await this.t.get('/users;use_login=1/games;game_keys=nhl/teams'));
  }
}

export function playersPath(
  leagueKey: string,
  q: YahooPlayerQuery,
  start: number,
  count: number,
): string {
  const parts: string[] = [];
  if (q.status !== undefined) parts.push(`status=${q.status}`);
  if (q.position !== undefined) parts.push(`position=${q.position}`);
  if (q.sort !== undefined) parts.push(`sort=${q.sort}`);
  if (q.sortType !== undefined) parts.push(`sort_type=${q.sortType}`);
  if (q.search !== undefined) parts.push(`search=${encodeURIComponent(q.search)}`);
  parts.push(`start=${start}`, `count=${Math.min(count, PAGE)}`, `out=${PLAYER_OUT.join(',')}`);
  return `/league/${leagueKey}/players;${parts.join(';')}`;
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`expected YYYY-MM-DD, got ${date}`);
}

export interface WebSessionReaderOptions {
  /** Pasted T and Y cookies, or a full stored session (the CLI's file). */
  credentials: YahooCredentials | StoredSession;
  leagueKey: string;
  teamKey: TeamKey;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  /** Wraps the live transport, e.g. to record responses (§20.4). */
  wrap?: (t: YahooTransport) => YahooTransport;
  /** Cookies Yahoo rotated, to persist (D-033). */
  onCookies?: OnCookies;
}

export function createWebSessionReader(o: WebSessionReaderOptions): WebSessionReader {
  const session =
    'cookies' in o.credentials ? o.credentials : sessionFromCredentials(o.credentials);
  const live = new CookieTransport({
    session,
    ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
    ...(o.minIntervalMs === undefined ? {} : { minIntervalMs: o.minIntervalMs }),
    ...(o.onCookies === undefined ? {} : { onCookies: o.onCookies }),
  });
  return new WebSessionReader(o.wrap ? o.wrap(live) : live, o.leagueKey, o.teamKey);
}
