// Parsers from Yahoo `format=json_f` responses to small domain types.
// Shapes verified against responses captured 2026-09-24 (test/fixtures). Where a shape could not
// be observed yet (e.g. roster entries before the draft), parsing is defensive and noted.
import { z } from 'zod';

// ---------- helpers ----------
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
/** json_f collections are arrays of single-key wrappers: [{player:{...}}, ...] */
function unwrap<T = Record<string, unknown>>(list: unknown, key: string): T[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (x as Record<string, unknown>)[key])
    .filter((x): x is T => x !== undefined && x !== null);
}
function content(body: unknown): Record<string, any> {
  const fc = (body as { fantasy_content?: Record<string, any> })?.fantasy_content;
  if (!fc) throw new Error('Response has no fantasy_content');
  return fc;
}

// ---------- domain types ----------
export const StatCategory = z.object({
  statId: z.number(),
  abbr: z.string(),
  name: z.string(),
  positionType: z.enum(['P', 'G']),
  higherIsBetter: z.boolean(),
  scored: z.boolean(), // enabled and not display-only
});
export type StatCategory = z.infer<typeof StatCategory>;

export interface RosterSlot {
  position: string;
  count: number;
  isStarting: boolean;
  positionType?: string;
}

export interface LeagueSettings {
  leagueKey: string;
  name: string;
  numTeams: number;
  scoringType: string;
  scoringLabel?: string;
  draftStatus: 'predraft' | 'drafting' | 'postdraft' | string;
  draftType?: string;
  draftTimeUtc?: string;
  draftPickSeconds?: number;
  lineupLock?: string; // weekly_deadline, e.g. "intraday" = per-game lock
  currentWeek?: number;
  startDate?: string;
  endDate?: string;
  waiverType?: string;
  waiverDays?: number;
  usesFaab: boolean;
  maxWeeklyAdds?: number;
  minGoalieGames?: number; // min_games_played
  tradeEndDate?: string;
  playoffStartWeek?: number;
  categories: StatCategory[];
  rosterSlots: RosterSlot[];
}

export interface Team {
  teamKey: string;
  teamId: string;
  name: string;
  mine: boolean;
  managers: string[];
  draftPosition?: number;
}

export interface Player {
  playerKey: string;
  playerId: string;
  name: string;
  nhlTeam?: string;
  primaryPosition?: string;
  eligible: string[];
  positionType?: string;
  status?: string; // injury/IR status when present
  adp?: number;
  percentDrafted?: number;
  percentOwned?: number;
  ownership?: string;
  selectedPosition?: string; // only in roster context
}

export interface DraftPick {
  pick: number;
  round: number;
  teamKey: string;
  playerKey?: string;
}

// ---------- parsers ----------
export function parseSettings(body: unknown): LeagueSettings {
  const lg = content(body).league;
  const s = lg.settings ?? {};
  const categories = unwrap<Record<string, any>>(s.stat_categories?.stats, 'stat').map((c) =>
    StatCategory.parse({
      statId: Number(c.stat_id),
      abbr: String(c.display_name ?? c.abbr),
      name: String(c.name),
      positionType: c.position_type === 'G' ? 'G' : 'P',
      higherIsBetter: String(c.sort_order) === '1',
      scored: String(c.enabled ?? '1') === '1' && String(c.is_only_display_stat ?? '0') !== '1',
    }),
  );
  const rosterSlots = unwrap<Record<string, any>>(s.roster_positions, 'roster_position').map(
    (p) => ({
      position: String(p.position),
      count: Number(p.count),
      isStarting: Number(p.is_starting_position) === 1,
      positionType: p.position_type,
    }),
  );
  const draftTime = num(s.draft_time);
  return {
    leagueKey: lg.league_key,
    name: lg.name,
    numTeams: Number(lg.num_teams),
    scoringType: s.scoring_type ?? lg.scoring_type,
    scoringLabel: s.scoring_label ?? lg.scoring_label,
    draftStatus: lg.draft_status,
    draftType: s.draft_type,
    draftTimeUtc: draftTime ? new Date(draftTime * 1000).toISOString() : undefined,
    draftPickSeconds: num(s.draft_pick_time),
    lineupLock: lg.weekly_deadline,
    currentWeek: num(lg.current_week),
    startDate: lg.start_date,
    endDate: lg.end_date,
    waiverType: s.waiver_type,
    waiverDays: num(s.waiver_time),
    usesFaab: String(s.uses_faab) === '1',
    maxWeeklyAdds: num(s.max_weekly_adds),
    minGoalieGames: num(s.min_games_played),
    tradeEndDate: s.trade_end_date,
    playoffStartWeek: num(s.playoff_start_week),
    categories,
    rosterSlots,
  };
}

export function parseTeams(body: unknown): Team[] {
  return unwrap<Record<string, any>>(content(body).league.teams, 'team').map((t) => ({
    teamKey: t.team_key,
    teamId: String(t.team_id),
    name: t.name,
    mine: Number(t.is_owned_by_current_login) === 1,
    managers: unwrap<Record<string, any>>(t.managers, 'manager').map((m) => String(m.nickname)),
    draftPosition: num(t.draft_position),
  }));
}

export function parsePlayer(p: Record<string, any>): Player {
  const sel = p.selected_position;
  return {
    playerKey: p.player_key,
    playerId: String(p.player_id),
    name: p.name?.full ?? String(p.name),
    nhlTeam: p.editorial_team_abbr,
    primaryPosition: p.primary_position,
    eligible: unwrap<string>(p.eligible_positions, 'position').map(String), // [{position:"C"},...]
    positionType: p.position_type,
    status: p.status ?? undefined,
    adp: num(p.draft_analysis?.average_pick),
    percentDrafted: num(p.draft_analysis?.percent_drafted),
    percentOwned: num(p.percent_owned?.value),
    ownership: p.ownership?.ownership_type,
    // Roster context (unverified pre-draft): selected_position is {coverage_type,date,position,...}
    selectedPosition: sel
      ? String(Array.isArray(sel) ? sel[0]?.position : sel.position)
      : undefined,
  };
}

export function parsePlayers(body: unknown): Player[] {
  const fc = content(body);
  const holder = fc.league ?? fc.team ?? fc.game;
  return unwrap<Record<string, any>>(holder?.players, 'player').map(parsePlayer);
}

export function parseRoster(body: unknown): {
  teamKey: string;
  date?: string;
  editable: boolean;
  players: Player[];
} {
  const team = content(body).team;
  return {
    teamKey: team.team_key,
    date: team.roster?.date,
    editable: Number(team.roster?.is_editable) === 1,
    players: unwrap<Record<string, any>>(team.roster?.players, 'player').map(parsePlayer),
  };
}

export function parseDraftResults(body: unknown): { draftStatus: string; picks: DraftPick[] } {
  const lg = content(body).league;
  return {
    draftStatus: lg.draft_status,
    picks: unwrap<Record<string, any>>(lg.draft_results, 'draft_result').map((d) => ({
      pick: Number(d.pick),
      round: Number(d.round),
      teamKey: d.team_key,
      playerKey: d.player_key || undefined, // empty before the pick is made
    })),
  };
}

export function parseMyTeams(
  body: unknown,
): {
  gameKey: string;
  season: string;
  teams: { teamKey: string; name: string; leagueKey: string }[];
}[] {
  const user = unwrap<Record<string, any>>(content(body).users, 'user')[0];
  return unwrap<Record<string, any>>(user?.games, 'game').map((g) => ({
    gameKey: String(g.game_key),
    season: String(g.season),
    teams: unwrap<Record<string, any>>(g.teams, 'team').map((t) => ({
      teamKey: t.team_key,
      name: t.name,
      leagueKey: String(t.team_key).split('.t.')[0]!,
    })),
  }));
}

export interface Transaction {
  key: string;
  type: string;
  status: string;
  at: string;
}
export function parseTransactions(body: unknown): Transaction[] {
  return unwrap<Record<string, any>>(content(body).league.transactions, 'transaction').map((t) => ({
    key: t.transaction_key,
    type: t.type,
    status: t.status,
    at: new Date(Number(t.timestamp) * 1000).toISOString(),
  }));
}
