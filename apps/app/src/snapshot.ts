import type { LeagueSettings, LeagueSnapshot, Player, StatCategory, Transaction } from '@fha/core';
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
  /** Players outside the free-agent reads to carry anyway: the user's watch list (D-032). */
  extraKeys?: readonly string[];
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
  const pool = [
    ...(await freeAgentPool(i.source, i.freeAgents ?? 200)),
    ...(await recentFreeAgents(i)),
    ...(await extraPlayers(i, players)),
  ];
  for (const y of pool) {
    if (players.has(y.player.playerKey)) continue;
    players.set(y.player.playerKey, y.player);
    details.set(y.player.playerKey, y.detail);
  }
  const valued = valueOrEmpty(i, [...players.values()]);
  const { opponent, matchup } = await readMatchup(i, teams, settings.categories);
  const snapshot: LeagueSnapshot = {
    recordedAt: i.recordedAt,
    source: 'yahoo',
    leagueKey: i.leagueKey,
    teamKey: i.teamKey,
    date: i.date,
    week: meta.currentWeek ?? 1,
    ...(opponent === undefined ? {} : { opponentTeamKey: opponent }),
    ...(matchup === undefined ? {} : { matchup }),
    rules: rulesOf(meta),
    teams: teams.map((t) => ({
      teamKey: t.teamKey,
      name: t.name,
      ...(t.managerNickname === undefined ? {} : { managerNickname: t.managerNickname }),
    })),
    players: [...players.values()].map((p) => {
      const id = valued.ids.get(p.playerKey);
      const withDetail = { ...p, ...playerExtras(details.get(p.playerKey)) };
      return id === undefined
        ? withDetail
        : { ...withDetail, nhlId: id.nhlId, mapConfidence: id.confidence };
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

/** The league's rules the agents need (D-029), from Yahoo's settings. */
function rulesOf(meta: LeagueMeta): NonNullable<LeagueSnapshot['rules']> {
  return {
    ...(meta.minGoalieGames === undefined ? {} : { minGoalieGames: meta.minGoalieGames }),
    ...(meta.tradeEndDate === undefined ? {} : { tradeEndDate: meta.tradeEndDate }),
    ...(meta.playoffStartWeek === undefined ? {} : { playoffStartWeek: meta.playoffStartWeek }),
    ...(meta.waiverDays === undefined ? {} : { waiverDays: meta.waiverDays }),
    ...(meta.maxWeeklyAdds === undefined ? {} : { maxWeeklyAdds: meta.maxWeeklyAdds }),
    ...(meta.startDate === undefined ? {} : { seasonStart: meta.startDate }),
    ...(meta.endDate === undefined ? {} : { seasonEnd: meta.endDate }),
  };
}

/** What a player's Yahoo detail adds to the lean Player (D-029): waivers, droppable, IR seats. */
function playerExtras(d: PlayerDetail | undefined): Partial<Player> {
  if (d === undefined) return {};
  const waivers = d.ownership?.type === 'waivers';
  return {
    ...(waivers ? { onWaivers: true } : {}),
    ...(waivers && d.ownership?.waiverDate !== undefined
      ? { waiverDate: d.ownership.waiverDate }
      : {}),
    ...(d.undroppable ? { undroppable: true } : {}),
    ...(d.reserveEligible.length > 0 ? { reserveEligible: d.reserveEligible } : {}),
    ...(d.injuryNote === undefined ? {} : { injuryNote: d.injuryNote }),
  };
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

/**
 * Free agents by Yahoo's actual rank over the last week: early-season risers that a preseason
 * rank leaves out of the pool (D-032). Optional, so a failure only warns (P9).
 */
export const RECENT_FREE_AGENTS = 50;
async function recentFreeAgents(i: SnapshotInputs): Promise<YahooPlayer[]> {
  try {
    return await i.source.playersDetailed({
      status: 'FA',
      sort: 'AR',
      sortType: 'lastweek',
      limit: RECENT_FREE_AGENTS,
    });
  } catch (e) {
    i.warn(`recent free agents unavailable: ${errText(e)}`);
    return [];
  }
}

/** The extra keys not already read (rostered or in the pool), by key; a failure only warns. */
async function extraPlayers(
  i: SnapshotInputs,
  have: ReadonlyMap<string, Player>,
): Promise<YahooPlayer[]> {
  const keys = [...new Set(i.extraKeys ?? [])].filter((k) => !have.has(k));
  if (keys.length === 0) return [];
  try {
    return await i.source.playersByKey(keys);
  } catch (e) {
    i.warn(`watched players unavailable: ${errText(e)}`);
    return [];
  }
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
 * This week's real opponent and live totals from Yahoo's scoreboard. Without them the tools
 * fall back to the league order (a stand-in) and a projection-only week, so a failure here
 * degrades with a warning (P9). Totals are keyed by category abbreviation, display-only goalie
 * volume included, so the matchup model can rebuild SV% and GAA from volume.
 */
async function readMatchup(
  i: SnapshotInputs,
  teams: readonly { teamKey: string }[],
  categories: readonly StatCategory[],
): Promise<{ opponent?: string; matchup?: LeagueSnapshot['matchup'] }> {
  try {
    // One read gives every matchup; fall back to ours alone where the source cannot.
    const board = i.source.scoreboard === undefined ? undefined : await i.source.scoreboard();
    const m =
      board === undefined
        ? await i.source.ourMatchup()
        : board.matchups.find((x) => x.teams.some((t) => t.teamKey === i.teamKey));
    const other = m?.teams.find((t) => t.teamKey !== i.teamKey)?.teamKey;
    if (m === undefined || other === undefined || !teams.some((t) => t.teamKey === other)) {
      i.warn('scoreboard has no opponent for us this week; using the league order');
      return {};
    }
    const abbr = new Map(categories.map((c) => [String(c.statId), c.abbr]));
    const byAbbr = (stats: Record<string, number>) =>
      Object.fromEntries(
        Object.entries(stats).flatMap(([id, v]) => {
          const a = abbr.get(id);
          return a === undefined ? [] : [[a, v]];
        }),
      );
    const opt = (k: string, v: number | undefined) => (v === undefined ? {} : { [k]: v });
    return {
      opponent: other,
      matchup: {
        week: m.week,
        status: m.status,
        weekStart: m.weekStart,
        weekEnd: m.weekEnd,
        sides: m.teams.map((t) => ({
          teamKey: t.teamKey,
          stats: byAbbr(t.stats),
          ...opt('completedGames', t.completedGames),
          ...opt('liveGames', t.liveGames),
          ...opt('remainingGames', t.remainingGames),
        })),
        ...(board === undefined
          ? {}
          : {
              league: board.matchups.flatMap((x) =>
                x.teams.map((t) => {
                  const opp = x.teams.find((o) => o.teamKey !== t.teamKey)?.teamKey;
                  const won = (k: string | undefined) =>
                    x.statWinners
                      .filter((w) => !w.tied && w.winnerTeamKey === k)
                      .flatMap((w) => abbr.get(String(w.statId)) ?? []);
                  return {
                    teamKey: t.teamKey,
                    ...(opp === undefined ? {} : { opponentKey: opp }),
                    stats: byAbbr(t.stats),
                    winning: won(t.teamKey),
                    losing: won(opp),
                  };
                }),
              ),
            }),
      },
    };
  } catch (e) {
    i.warn(`scoreboard unavailable: ${errText(e)}`);
    return {};
  }
}

/**
 * Two weeks of schedule from the snapshot date: the rest of this week for the matchup, and the
 * next for 7- and 14-day player forecasts (D-025). The second week is best effort.
 */
async function readSchedule(i: SnapshotInputs): Promise<LeagueSnapshot['schedule']> {
  const toSlots = (days: Awaited<ReturnType<SnapshotInputs['schedule']>>) =>
    days.map((d) => ({
      date: d.date,
      games: d.games.map((g) => ({ home: g.home, away: g.away, startTimeUtc: g.startTimeUtc })),
    }));
  let first: LeagueSnapshot['schedule'];
  try {
    first = toSlots(await i.schedule(i.date));
  } catch (e) {
    i.warn(`NHL schedule unavailable: ${errText(e)}`);
    return [];
  }
  const last = first.at(-1)?.date;
  if (last === undefined) return first;
  const next = new Date(`${last}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  try {
    const more = toSlots(await i.schedule(next.toISOString().slice(0, 10)));
    const seen = new Set(first.map((d) => d.date));
    return [...first, ...more.filter((d) => !seen.has(d.date))];
  } catch (e) {
    i.warn(`next week's NHL schedule unavailable: ${errText(e)}`);
    return first;
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
