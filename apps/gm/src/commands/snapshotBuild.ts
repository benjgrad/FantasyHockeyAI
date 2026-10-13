import type {
  LeagueSettings,
  LeagueSnapshot,
  LeagueTeam,
  Player,
  TeamKey,
  Transaction,
} from '@fha/core';
import type { ScheduleDay } from '@fha/nhl';
import type {
  LeagueMeta,
  PlayerDetail,
  RosterRead,
  YahooPlayer,
  YahooPlayerQuery,
} from '@fha/yahoo';
import type { ValuedPlayers } from './snapshotValue.js';

/**
 * Build a live `LeagueSnapshot` (§20.4) from Yahoo reads, the NHL schedule and our valuations.
 *
 * Every source is injected, so this is tested with fakes and the CLI supplies the real ones.
 * Yahoo's league reads are required: without rosters there is no snapshot. The schedule,
 * transactions and valuations degrade (P9): a warning, an empty section, and the recording
 * still happens, because a snapshot missing its schedule is still far better than the mock.
 */
export interface LiveLeagueSource {
  settingsAndMeta(): Promise<{ settings: LeagueSettings; meta: LeagueMeta }>;
  teams(): Promise<LeagueTeam[]>;
  rosterDetailed(teamKey: TeamKey, date: string): Promise<RosterRead>;
  playersDetailed(q: YahooPlayerQuery): Promise<YahooPlayer[]>;
  transactions(q: { type?: Transaction['type']; teamKey?: TeamKey }): Promise<Transaction[]>;
}

export interface SnapshotInputs {
  source: LiveLeagueSource;
  leagueKey: string;
  teamKey: TeamKey;
  date: string;
  recordedAt: string;
  schedule: (date: string) => Promise<ScheduleDay[]>;
  valuate: (players: readonly Player[]) => ValuedPlayers;
  /** Free agents to include, by Yahoo rank (default 200: 175 overall, 25 goalies). */
  freeAgents?: number;
  warn: (message: string) => void;
}

export interface SnapshotResult {
  snapshot: LeagueSnapshot;
  settings: LeagueSettings;
  meta: LeagueMeta;
  details: Map<string, PlayerDetail>;
  stats: {
    rostered: number;
    freeAgents: number;
    valued: number;
    nameJoined: number;
    unvalued: number;
  };
}

export async function buildLiveSnapshot(i: SnapshotInputs): Promise<SnapshotResult> {
  const { settings, meta } = await i.source.settingsAndMeta();
  const teams = await i.source.teams();
  if (!teams.some((t) => t.teamKey === i.teamKey)) {
    throw new Error(`team ${i.teamKey} is not in ${i.leagueKey}; check config/league.yaml`);
  }
  const players = new Map<string, Player>();
  const details = new Map<string, PlayerDetail>();
  const rosters: LeagueSnapshot['rosters'] = {};
  for (const t of teams) {
    const r = await i.source.rosterDetailed(t.teamKey, i.date);
    rosters[t.teamKey] = r.roster.entries.map((e) => ({
      playerKey: e.player.playerKey,
      slot: e.slot,
    }));
    for (const e of r.roster.entries) players.set(e.player.playerKey, e.player);
    for (const [k, d] of r.details) details.set(k, d);
  }
  const rostered = players.size;
  for (const y of await freeAgentPool(i.source, i.freeAgents ?? 200)) {
    if (players.has(y.player.playerKey)) continue;
    players.set(y.player.playerKey, y.player);
    details.set(y.player.playerKey, y.detail);
  }

  const transactions = await readTransactions(i);
  const schedule = await readSchedule(i);
  const valued = valueOrEmpty(i, [...players.values()]);
  const withIds = [...players.values()].map((p) => {
    const id = valued.ids.get(p.playerKey);
    return id === undefined ? p : { ...p, nhlId: id.nhlId, mapConfidence: id.confidence };
  });

  const snapshot: LeagueSnapshot = {
    recordedAt: i.recordedAt,
    source: 'yahoo',
    leagueKey: i.leagueKey,
    teamKey: i.teamKey,
    date: i.date,
    week: meta.currentWeek ?? 1,
    teams: teams.map((t) => ({
      teamKey: t.teamKey,
      name: t.name,
      ...(t.managerNickname === undefined ? {} : { managerNickname: t.managerNickname }),
    })),
    players: withIds,
    rosters,
    schedule,
    transactions,
    valuations: valued.valuations,
    projections: valued.projections,
    news: newsByPlayer(details, players),
  };
  return {
    snapshot,
    settings,
    meta,
    details,
    stats: {
      rostered,
      freeAgents: players.size - rostered,
      valued: Object.keys(valued.valuations).length,
      nameJoined: valued.nameJoined,
      unvalued: players.size - Object.keys(valued.valuations).length,
    },
  };
}

/**
 * Free agents by Yahoo's overall rank, plus goalies separately (an overall list is mostly
 * skaters), plus everyone on waivers and last week's best free agents — the players an add can
 * actually reach.
 */
async function freeAgentPool(src: LiveLeagueSource, n: number): Promise<YahooPlayer[]> {
  const goalies = Math.min(25, Math.floor(n / 8));
  return [
    ...(await src.playersDetailed({ status: 'FA', sort: 'OR', limit: n - goalies })),
    ...(await src.playersDetailed({ status: 'FA', position: 'G', sort: 'OR', limit: goalies })),
    ...(await src.playersDetailed({ status: 'W', sort: 'OR', limit: 25 })),
    // Early-season risers a preseason rank leaves out (D-032).
    ...(await src.playersDetailed({ status: 'FA', sort: 'AR', sortType: 'lastweek', limit: 50 })),
  ];
}

async function readTransactions(i: SnapshotInputs): Promise<Transaction[]> {
  const out: Transaction[] = [];
  const reads: [string, () => Promise<Transaction[]>][] = [
    ['league transactions', () => i.source.transactions({})],
    ['pending trades', () => i.source.transactions({ type: 'pending_trade' })],
    ['pending waiver claims', () => i.source.transactions({ type: 'waiver' })],
  ];
  for (const [what, read] of reads) {
    try {
      out.push(...(await read()));
    } catch (e) {
      i.warn(`${what} unavailable: ${errText(e)}`);
    }
  }
  const seen = new Set<string>();
  return out.filter((t) => !seen.has(t.transactionKey) && seen.add(t.transactionKey));
}

async function readSchedule(i: SnapshotInputs): Promise<LeagueSnapshot['schedule']> {
  try {
    const days = await i.schedule(i.date);
    return days.map((d) => ({
      date: d.date,
      games: d.games.map((g) => ({ home: g.home, away: g.away, startTimeUtc: g.startTimeUtc })),
    }));
  } catch (e) {
    i.warn(`NHL schedule unavailable, recording without it: ${errText(e)}`);
    return [];
  }
}

function valueOrEmpty(i: SnapshotInputs, players: readonly Player[]): ValuedPlayers {
  try {
    return i.valuate(players);
  } catch (e) {
    i.warn(`valuations unavailable, recording without them: ${errText(e)}`);
    return { valuations: {}, projections: {}, ids: new Map(), nameJoined: 0, unmapped: [] };
  }
}

/** Status first (it is what decides playability), then the notes feed, newest first. */
export function newsLines(d: PlayerDetail, status: string | undefined): string[] {
  const lines: string[] = [];
  if (status !== undefined) {
    const parts = [status, d.statusFull, d.injuryNote].filter((x): x is string => !!x);
    lines.push(`Status: ${parts.join(' · ')}`);
  }
  const notes = [...d.notes].sort((a, b) => (b.at ?? b.date).localeCompare(a.at ?? a.date));
  for (const n of notes) {
    const body = [n.news, n.advice ? `Advice: ${n.advice}` : undefined].filter(Boolean).join(' ');
    const by = n.provider === undefined ? '' : ` (${n.provider})`;
    lines.push(`${n.date} ${n.headline}${body ? ` — ${body}` : ''}${by}`);
  }
  if (d.ownership?.waiverDate !== undefined)
    lines.push(`On waivers until ${d.ownership.waiverDate}`);
  return lines;
}

function newsByPlayer(
  details: Map<string, PlayerDetail>,
  players: Map<string, Player>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, d] of details) {
    const lines = newsLines(d, players.get(key)?.status);
    if (lines.length > 0) out[key] = lines;
  }
  return out;
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
