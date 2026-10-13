import { z } from 'zod';
import { isOut } from '@fha/model';
import type { EventRecord } from '@fha/store';
import { defineTool, fail, ok } from '../context.js';
import type { LeagueView } from '../view.js';

/**
 * The event vocabulary the daemon's watchers write (plan Phase 6) and `getLeagueEvents` reads.
 * One set of schemas for both sides, so a watcher and the league-review agent cannot drift.
 * Payloads are parsed on read; an event whose payload no longer parses is skipped, not guessed.
 */
export const EVENT_KINDS = {
  statusChanged: 'player.status_changed',
  news: 'player.news',
  transaction: 'league.transaction',
  tradeOffered: 'trade.offered',
  goalieStarting: 'goalie.starting',
  matchupUpdate: 'matchup.update',
  /** The daemon considered grabbing a player at once (D-016): what it did, or why not. */
  autoGrab: 'autoGrab.evaluated',
} as const;

export const StatusChangedPayload = z.object({
  playerKey: z.string(),
  name: z.string(),
  nhlTeam: z.string().nullable(),
  ownerTeamKey: z.string().nullable(),
  ours: z.boolean(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  note: z.string().nullable(),
  /** Our roster slot when he is ours. */
  slot: z.string().nullable(),
  /** His team plays today; null when the schedule is unknown. */
  gameToday: z.boolean().nullable(),
});
export type StatusChangedPayload = z.infer<typeof StatusChangedPayload>;

export const NewsPayload = z.object({
  playerKey: z.string(),
  name: z.string(),
  ours: z.boolean(),
  noteId: z.string(),
  at: z.string(),
  headline: z.string(),
  news: z.string().nullable(),
});
export type NewsPayload = z.infer<typeof NewsPayload>;

export const TransactionPayload = z.object({
  transactionKey: z.string(),
  type: z.string(),
  timestamp: z.string(),
  teamKey: z.string().nullable(),
  tradeeTeamKey: z.string().nullable(),
  players: z.array(
    z.object({
      playerKey: z.string(),
      name: z.string().nullable(),
      fromTeamKey: z.string().nullable(),
      toTeamKey: z.string().nullable(),
    }),
  ),
});
export type TransactionPayload = z.infer<typeof TransactionPayload>;

/** [U] Yahoo's `starting_status.is_starting`: recorded as a hint, never acted on alone. */
export const GoalieStartingPayload = z.object({
  playerKey: z.string(),
  name: z.string(),
  date: z.string(),
  isStarting: z.boolean(),
  /** One of ours, and his slot at the reading (D-029); absent on events before then. */
  ours: z.boolean().optional(),
  slot: z.string().nullable().optional(),
});
export type GoalieStartingPayload = z.infer<typeof GoalieStartingPayload>;

export const MatchupUpdatePayload = z.object({
  week: z.number(),
  opponentTeamKey: z.string(),
  opponentName: z.string(),
  /** Category totals by abbreviation, as Yahoo's scoreboard reports them. */
  us: z.record(z.string(), z.number()),
  them: z.record(z.string(), z.number()),
  /** Categories each side is winning right now; the rest are tied. */
  winning: z.array(z.string()),
  losing: z.array(z.string()),
});
export type MatchupUpdatePayload = z.infer<typeof MatchupUpdatePayload>;

export const AUTO_GRAB_OUTCOMES = [
  'skipped',
  'denied',
  'proposed',
  'pending',
  'executed',
  'unverified',
  'failed',
] as const;

export const AutoGrabPayload = z.object({
  playerKey: z.string(),
  name: z.string(),
  /** What set it off: a free agent back from out, or another team's drop. */
  trigger: z.enum(['back', 'dropped']),
  outcome: z.enum(AUTO_GRAB_OUTCOMES),
  kind: z.enum(['add', 'waiverClaim']).nullable(),
  drop: z.string().nullable(),
  dropName: z.string().nullable(),
  /** Net rest-of-season VORP gain, and the bar it had to clear. */
  gain: z.number().nullable(),
  required: z.number().nullable(),
  /** One line: why it was skipped, or what happened. */
  reason: z.string(),
  planId: z.string().nullable(),
});
export type AutoGrabPayload = z.infer<typeof AutoGrabPayload>;

/** "considered X: skipped, gain 0.80 < 1.50" — for the league review and the digest. */
export function autoGrabLine(p: AutoGrabPayload): string {
  const drop = p.dropName === null ? '' : ` (drop ${p.dropName})`;
  const gain = p.gain === null ? '' : ` +${p.gain.toFixed(2)}`;
  switch (p.outcome) {
    case 'executed':
      return `grabbed ${p.name}${drop}:${gain}`;
    case 'proposed':
    case 'pending':
      return `proposed grabbing ${p.name}${drop}:${gain}, waiting for you`;
    default:
      return `considered ${p.name}${drop}: ${p.outcome}, ${p.reason}`;
  }
}

/** Rank by season value (1 = best) among every valued player in the snapshot. */
function valueRanks(view: LeagueView): Map<string, number> {
  return new Map(
    Object.entries(view.snap.valuations)
      .sort((a, b) => b[1].value - a[1].value)
      .map(([k], i) => [k, i + 1]),
  );
}

/** "A top-N player" for the notable-move rules. */
export const NOTABLE_RANK = 100;

/**
 * Why a league event deserves the weekly review's attention, or undefined: a top-100 player
 * dropped into the free-agent pool, or a rival's top-100 player newly out. Pure over the view.
 */
export function notableReason(
  view: LeagueView,
  e: Pick<EventRecord, 'kind' | 'payload'>,
  ranks: Map<string, number> = valueRanks(view),
): string | undefined {
  const top = (k: string) => (ranks.get(k) ?? Infinity) <= NOTABLE_RANK;
  if (e.kind === EVENT_KINDS.transaction) {
    const p = TransactionPayload.safeParse(e.payload);
    if (!p.success) return undefined;
    const dropped = p.data.players.find(
      (x) => x.fromTeamKey !== null && x.toTeamKey === null && top(x.playerKey),
    );
    return dropped === undefined
      ? undefined
      : `${dropped.name ?? dropped.playerKey} (rank ${ranks.get(dropped.playerKey)}) was dropped to free agency`;
  }
  if (e.kind === EVENT_KINDS.statusChanged) {
    const p = StatusChangedPayload.safeParse(e.payload);
    if (!p.success || p.data.ours || p.data.ownerTeamKey === null) return undefined;
    if (!isOut(p.data.to ?? undefined) || isOut(p.data.from ?? undefined)) return undefined;
    return top(p.data.playerKey)
      ? `rival's ${p.data.name} (rank ${ranks.get(p.data.playerKey)}) is now ${p.data.to}`
      : undefined;
  }
  return undefined;
}

function teamName(view: LeagueView, key: string | null): string {
  if (key === null) return 'free agency';
  return view.snap.teams.find((t) => t.teamKey === key)?.name ?? key;
}

/** One line per event; undefined when the payload does not parse. */
export function eventLine(view: LeagueView, e: EventRecord): string | undefined {
  const day = e.createdAt.slice(0, 10);
  switch (e.kind) {
    case EVENT_KINDS.statusChanged: {
      const p = StatusChangedPayload.safeParse(e.payload);
      if (!p.success) return undefined;
      const who = p.data.ours ? 'ours' : teamName(view, p.data.ownerTeamKey);
      const note = p.data.note === null ? '' : `: ${p.data.note}`;
      return `${day} status ${p.data.name} (${p.data.playerKey}, ${who}) ${p.data.from ?? 'healthy'} → ${p.data.to ?? 'healthy'}${note}`;
    }
    case EVENT_KINDS.news: {
      const p = NewsPayload.safeParse(e.payload);
      if (!p.success) return undefined;
      return `${day} news ${p.data.name} (${p.data.playerKey}${p.data.ours ? ', ours' : ''}): ${p.data.headline}`;
    }
    case EVENT_KINDS.transaction:
    case EVENT_KINDS.tradeOffered: {
      const p = TransactionPayload.safeParse(e.payload);
      if (!p.success) return undefined;
      const moves = p.data.players
        .map(
          (x) =>
            `${x.name ?? x.playerKey} (${x.playerKey}) ${teamName(view, x.fromTeamKey)} → ${teamName(view, x.toTeamKey)}`,
        )
        .join('; ');
      const label = e.kind === EVENT_KINDS.tradeOffered ? 'trade offered to us' : p.data.type;
      return `${p.data.timestamp.slice(0, 10) || day} ${label}: ${moves}`;
    }
    case EVENT_KINDS.autoGrab: {
      const p = AutoGrabPayload.safeParse(e.payload);
      return p.success ? `${day} auto-grab ${autoGrabLine(p.data)}` : undefined;
    }
    case EVENT_KINDS.goalieStarting: {
      const p = GoalieStartingPayload.safeParse(e.payload);
      if (!p.success) return undefined;
      return `${p.data.date} goalie hint ${p.data.name}: Yahoo says ${p.data.isStarting ? 'starting' : 'not starting'} (unverified meaning)`;
    }
    default:
      return undefined;
  }
}

function matchupLine(e: EventRecord | undefined): string | undefined {
  const p = MatchupUpdatePayload.safeParse(e?.payload);
  if (!p.success) return undefined;
  const { winning, losing } = p.data;
  return `Week ${p.data.week} vs ${p.data.opponentName} (Yahoo scoreboard, ${e?.createdAt ?? ''}): winning ${winning.length} (${winning.join(', ') || '-'}), losing ${losing.length} (${losing.join(', ') || '-'}).`;
}

const LEAGUE_KINDS = Object.values(EVENT_KINDS);
const MAX_LINES = 150;

export const getLeagueEvents = defineTool({
  name: 'getLeagueEvents',
  description:
    "What changed in the league over the last N days (default 7), as the watchers recorded it: adds, drops and trades by every team, trade offers to us, player status changes and news, goalie-start hints, and the latest scoreboard reading of our matchup. Notable moves (a top-100 player dropped, a rival's top-100 player newly out) are listed first.",
  input: z.object({ sinceDays: z.number().int().min(1).max(14).default(7) }),
  risk: 'read',
  execute: (input, ctx) => {
    // P8: whose events these are comes from the run, never from the model.
    if (ctx.userId === undefined) {
      return Promise.resolve(fail('No user for this run, so no league events. Call abstain.', false));
    }
    const days = input.sinceDays ?? 7;
    const since = new Date(Date.parse(ctx.now) - days * 86_400_000).toISOString();
    const events = ctx.store.events.recent(ctx.userId, since, LEAGUE_KINDS);
    const ranks = valueRanks(ctx.view);
    const notable = events.flatMap((e) => notableReason(ctx.view, e, ranks) ?? []);
    const lines = events
      .filter((e) => e.kind !== EVENT_KINDS.matchupUpdate)
      .flatMap((e) => eventLine(ctx.view, e) ?? []);
    const matchup = matchupLine(events.filter((e) => e.kind === EVENT_KINDS.matchupUpdate).at(-1));
    const shown = lines.slice(-MAX_LINES);
    const summary = [
      `League events since ${since.slice(0, 10)} (${events.length} recorded).`,
      notable.length === 0 ? 'Notable: none.' : `Notable:\n${notable.map((n) => `- ${n}`).join('\n')}`,
      matchup ?? 'No scoreboard reading of our matchup recorded.',
      shown.length === lines.length ? '' : `Showing the latest ${MAX_LINES} of ${lines.length}.`,
      ...shown,
    ]
      .filter((l) => l !== '')
      .join('\n');
    return Promise.resolve(ok({ since, notable, matchup: matchup ?? null, events: shown }, summary));
  },
});
