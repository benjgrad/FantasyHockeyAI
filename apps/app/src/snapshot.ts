import type { LeagueSettings, LeagueSnapshot, Player, Transaction } from '@fha/core';
import type { ScheduleDay } from '@fha/nhl';
import type { LeagueMeta, PlayerDetail, YahooPlayer } from '@fha/yahoo';
import type { LiveLeagueSource } from './yahoo.js';

/**
 * A live `LeagueSnapshot` for one user's league, from Yahoo reads, the NHL schedule and our
 * valuations.
 *
 * This mirrors `apps/gm/src/commands/snapshotBuild.ts#buildLiveSnapshot` (an app cannot import
 * another app). When a third consumer appears, move both into a lib. The degradation rules are
 * the same (P9): Yahoo's league reads are required; the schedule, transactions and valuations
 * each degrade to an empty section with a warning.
 */
export interface Valued {
  valuations: LeagueSnapshot['valuations'];
  projections: LeagueSnapshot['projections'];
  /** playerKey → NHL id and how sure the join is. */
  ids: Map<string, { nhlId: number; confidence: number }>;
}

export interface SnapshotInputs {
  source: LiveLeagueSource;
  leagueKey: string;
  teamKey: string;
  date: string;
  recordedAt: string;
  schedule: (date: string) => Promise<ScheduleDay[]>;
  valuate: (players: readonly Player[]) => Valued;
  freeAgents?: number;
  warn: (message: string) => void;
}

export interface BuiltSnapshot {
  snapshot: LeagueSnapshot;
  settings: LeagueSettings;
  meta: LeagueMeta;
}

export async function buildSnapshot(i: SnapshotInputs): Promise<BuiltSnapshot> {
  const { settings, meta } = await i.source.settingsAndMeta();
  const teams = await i.source.teams();
  if (!teams.some((t) => t.teamKey === i.teamKey)) {
    throw new Error(`team ${i.teamKey} is not in league ${i.leagueKey}`);
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
  for (const y of await freeAgentPool(i.source, i.freeAgents ?? 200)) {
    if (players.has(y.player.playerKey)) continue;
    players.set(y.player.playerKey, y.player);
    details.set(y.player.playerKey, y.detail);
  }
  const valued = valueOrEmpty(i, [...players.values()]);
  const opponent = await readOpponent(i, teams);
  const snapshot: LeagueSnapshot = {
    recordedAt: i.recordedAt,
    source: 'yahoo',
    leagueKey: i.leagueKey,
    teamKey: i.teamKey,
    date: i.date,
    week: meta.currentWeek ?? 1,
    ...(opponent === undefined ? {} : { opponentTeamKey: opponent }),
    teams: teams.map((t) => ({
      teamKey: t.teamKey,
      name: t.name,
      ...(t.managerNickname === undefined ? {} : { managerNickname: t.managerNickname }),
    })),
    players: [...players.values()].map((p) => {
      const id = valued.ids.get(p.playerKey);
      return id === undefined ? p : { ...p, nhlId: id.nhlId, mapConfidence: id.confidence };
    }),
    rosters,
    schedule: await readSchedule(i),
    transactions: await readTransactions(i),
    valuations: valued.valuations,
    projections: valued.projections,
    news: newsByPlayer(details, players),
  };
  return { snapshot, settings, meta };
}

/** Free agents by overall rank, goalies separately, and everyone on waivers. */
async function freeAgentPool(src: LiveLeagueSource, n: number): Promise<YahooPlayer[]> {
  const goalies = Math.min(25, Math.floor(n / 8));
  return [
    ...(await src.playersDetailed({ status: 'FA', sort: 'OR', limit: n - goalies })),
    ...(await src.playersDetailed({ status: 'FA', position: 'G', sort: 'OR', limit: goalies })),
    ...(await src.playersDetailed({ status: 'W', sort: 'OR', limit: 25 })),
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

/**
 * This week's real opponent from Yahoo's scoreboard. Without it the tools fall back to the
 * league order (a stand-in), so a failure here degrades with a warning (P9).
 */
async function readOpponent(
  i: SnapshotInputs,
  teams: readonly { teamKey: string }[],
): Promise<string | undefined> {
  try {
    const m = await i.source.ourMatchup();
    const other = m?.teams.find((t) => t.teamKey !== i.teamKey)?.teamKey;
    if (other !== undefined && teams.some((t) => t.teamKey === other)) return other;
    i.warn('scoreboard has no opponent for us this week; using the league order');
  } catch (e) {
    i.warn(`scoreboard unavailable: ${errText(e)}`);
  }
  return undefined;
}

async function readSchedule(i: SnapshotInputs): Promise<LeagueSnapshot['schedule']> {
  try {
    return (await i.schedule(i.date)).map((d) => ({
      date: d.date,
      games: d.games.map((g) => ({ home: g.home, away: g.away, startTimeUtc: g.startTimeUtc })),
    }));
  } catch (e) {
    i.warn(`NHL schedule unavailable: ${errText(e)}`);
    return [];
  }
}

function valueOrEmpty(i: SnapshotInputs, players: readonly Player[]): Valued {
  try {
    return i.valuate(players);
  } catch (e) {
    i.warn(`valuations unavailable: ${errText(e)}`);
    return { valuations: {}, projections: {}, ids: new Map() };
  }
}

/** Status first (it decides playability), then the notes feed, newest first. */
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

/** Class and message: Yahoo and NHL errors here carry paths and statuses, never cookies. */
function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
