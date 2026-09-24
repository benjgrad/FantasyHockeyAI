// Read-only Yahoo Fantasy client. Deliberately has NO write methods: writes (lineups, add/drops,
// trades, draft picks) go through a separate, gated executor in the real system.
import {
  parseDraftResults,
  parseMyTeams,
  parsePlayers,
  parseRoster,
  parseSettings,
  parseTeams,
  parseTransactions,
  type Player,
} from './parse.js';
import type { YahooTransport } from './transport.js';

export type PlayerStatusFilter = 'A' | 'FA' | 'W' | 'T' | 'K';
export interface PlayerQuery {
  status?: PlayerStatusFilter;
  position?: string;
  sort?: string; // OR (overall rank), AR (actual rank), NAME, or a stat_id
  search?: string;
  out?: string[]; // extra sub-resources, e.g. ['draft_analysis','percent_owned','ownership']
}

export class YahooFantasyClient {
  constructor(private readonly t: YahooTransport) {}

  async myNhlTeams() {
    return parseMyTeams(await this.t.get('/users;use_login=1/games;game_keys=nhl/teams'));
  }
  async settings(leagueKey: string) {
    return parseSettings(await this.t.get(`/league/${leagueKey}/settings`));
  }
  async teams(leagueKey: string) {
    return parseTeams(await this.t.get(`/league/${leagueKey}/teams`));
  }
  async roster(teamKey: string, date: string) {
    return parseRoster(await this.t.get(`/team/${teamKey}/roster;date=${date}`));
  }
  async draftResults(leagueKey: string) {
    return parseDraftResults(await this.t.get(`/league/${leagueKey}/draftresults`));
  }
  async transactions(leagueKey: string) {
    return parseTransactions(await this.t.get(`/league/${leagueKey}/transactions`));
  }

  /** One page (Yahoo caps pages at 25). */
  async playersPage(
    leagueKey: string,
    q: PlayerQuery,
    start: number,
    count = 25,
  ): Promise<Player[]> {
    const parts = [`start=${start}`, `count=${Math.min(count, 25)}`];
    if (q.status) parts.unshift(`status=${q.status}`);
    if (q.position) parts.unshift(`position=${q.position}`);
    if (q.sort) parts.unshift(`sort=${q.sort}`);
    if (q.search) parts.unshift(`search=${encodeURIComponent(q.search)}`);
    if (q.out?.length) parts.push(`out=${q.out.join(',')}`);
    return parsePlayers(await this.t.get(`/league/${leagueKey}/players;${parts.join(';')}`));
  }

  /** Paginates until `limit` players or an empty page. */
  async players(leagueKey: string, q: PlayerQuery, limit = 300): Promise<Player[]> {
    const all: Player[] = [];
    for (let start = 0; start < limit; start += 25) {
      const page = await this.playersPage(leagueKey, q, start, Math.min(25, limit - start));
      all.push(...page);
      if (page.length < 25) break;
    }
    return all;
  }
}
