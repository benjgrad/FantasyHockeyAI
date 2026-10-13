import type { Player, StatCategory, Transaction } from '@fha/core';
import type { NewEvent } from '@fha/store';
import {
  EVENT_KINDS,
  type GoalieStartingPayload,
  type MatchupUpdatePayload,
  type NewsPayload,
  type StatusChangedPayload,
  type TransactionPayload,
} from '@fha/tools';
import type { Matchup, PlayerDetail } from '@fha/yahoo';

/**
 * What the watchers saw → `events` rows. Pure: each function takes the new reading (and, for
 * players, what was seen last time) and returns the events to record plus the state to keep.
 *
 * Idempotence comes from the store: every event carries a `dedupeKey`, so a poll that re-reads
 * the same fact records nothing new. The first reading of a player is a baseline and raises no
 * event, so switching the daemon on does not flood Ben with a season of old news.
 */
export interface SeenPlayer {
  status: string | null;
  /** Newest note timestamp seen (ISO or YYYY-MM-DD). */
  lastNoteAt: string | null;
}
export type SeenPlayers = Record<string, SeenPlayer>;

export interface WatchedPlayer {
  player: Player;
  detail: PlayerDetail | undefined;
  ours: boolean;
  ownerTeamKey: string | null;
  /** Our roster slot, when he is ours. */
  slot: string | null;
  /** His team plays today; null when the schedule is unknown. */
  gameToday: boolean | null;
}

const noteAt = (n: { at?: string; date: string }): string => n.at ?? n.date;

function statusNote(d: PlayerDetail | undefined): string | null {
  const parts = [d?.statusFull, d?.injuryNote].filter((x): x is string => !!x);
  return parts.length === 0 ? null : parts.join(' · ');
}

function statusEvent(
  userId: string,
  date: string,
  w: WatchedPlayer,
  from: string | null,
): NewEvent {
  const to = w.player.status ?? null;
  const payload: StatusChangedPayload = {
    playerKey: w.player.playerKey,
    name: w.player.name,
    nhlTeam: w.player.nhlTeam || null,
    ownerTeamKey: w.ownerTeamKey,
    ours: w.ours,
    from,
    to,
    note: statusNote(w.detail),
    slot: w.slot,
    gameToday: w.gameToday,
  };
  return {
    userId,
    kind: EVENT_KINDS.statusChanged,
    subject: w.player.playerKey,
    payload,
    dedupeKey: `status:${userId}:${w.player.playerKey}:${from ?? 'ok'}>${to ?? 'ok'}:${date}`,
  };
}

function newsEvents(userId: string, w: WatchedPlayer, since: string | null): NewEvent[] {
  return (w.detail?.notes ?? [])
    .filter((n) => since === null || noteAt(n) > since)
    .sort((a, b) => noteAt(a).localeCompare(noteAt(b)))
    .map((n) => {
      const payload: NewsPayload = {
        playerKey: w.player.playerKey,
        name: w.player.name,
        ours: w.ours,
        noteId: n.id,
        at: noteAt(n),
        headline: n.headline,
        news: n.news ?? null,
      };
      return {
        userId,
        kind: EVENT_KINDS.news,
        subject: w.player.playerKey,
        payload,
        dedupeKey: `news:${userId}:${w.player.playerKey}:${n.id}`,
      };
    });
}

/**
 * Status changes and new notes since the last reading. Players no longer watched drop out of
 * the state; one who comes back is a fresh baseline.
 */
export function playerEvents(
  userId: string,
  date: string,
  prev: SeenPlayers | undefined,
  watched: readonly WatchedPlayer[],
): { events: NewEvent[]; state: SeenPlayers } {
  const events: NewEvent[] = [];
  const state: SeenPlayers = {};
  for (const w of watched) {
    const key = w.player.playerKey;
    const before = prev?.[key];
    const status = w.player.status ?? null;
    const newest = (w.detail?.notes ?? []).map(noteAt).sort().at(-1) ?? null;
    if (before !== undefined) {
      if (before.status !== status) events.push(statusEvent(userId, date, w, before.status));
      events.push(...newsEvents(userId, w, before.lastNoteAt));
    }
    const lastNoteAt =
      before?.lastNoteAt != null && (newest === null || before.lastNoteAt > newest)
        ? before.lastNoteAt
        : newest;
    state[key] = { status, lastNoteAt };
  }
  return { events, state };
}

function txPayload(t: Transaction, name: (k: string) => string | undefined): TransactionPayload {
  return {
    transactionKey: t.transactionKey,
    type: t.type,
    timestamp: t.timestamp,
    teamKey: t.teamKey ?? null,
    tradeeTeamKey: t.tradeeTeamKey ?? null,
    players: t.players.map((p) => ({
      playerKey: p.playerKey,
      name: name(p.playerKey) ?? null,
      fromTeamKey: p.fromTeamKey ?? null,
      toTeamKey: p.toTeamKey ?? null,
    })),
  };
}

/**
 * League adds, drops and trades → `league.transaction`; a pending trade proposed *to* us →
 * `trade.offered`. Pending waiver claims and our own outgoing offers are not league news.
 */
export function transactionEvents(
  userId: string,
  teamKey: string,
  txs: readonly Transaction[],
  name: (k: string) => string | undefined,
): NewEvent[] {
  return txs.flatMap((t): NewEvent[] => {
    if (t.type === 'waiver') return [];
    if (t.type === 'pending_trade') {
      if (t.tradeeTeamKey !== teamKey) return [];
      return [
        {
          userId,
          kind: EVENT_KINDS.tradeOffered,
          subject: t.transactionKey,
          payload: txPayload(t, name),
          dedupeKey: `trade:${userId}:${t.transactionKey}`,
        },
      ];
    }
    return [
      {
        userId,
        kind: EVENT_KINDS.transaction,
        subject: t.transactionKey,
        payload: txPayload(t, name),
        dedupeKey: `tx:${userId}:${t.transactionKey}`,
      },
    ];
  });
}

/** Yahoo's goalie starting flag, when present [U]: recorded as a hint, one per goalie and value a day. */
export function goalieEvents(
  userId: string,
  date: string,
  goalies: readonly {
    player: Player;
    detail: PlayerDetail | undefined;
    ours?: boolean;
    slot?: string | null;
  }[],
): NewEvent[] {
  return goalies.flatMap(({ player, detail, ours, slot }) => {
    const isStarting = detail?.isStartingGoalie;
    if (isStarting === undefined) return [];
    const payload: GoalieStartingPayload = {
      playerKey: player.playerKey,
      name: player.name,
      date,
      isStarting,
      ...(ours === undefined ? {} : { ours }),
      ...(slot === undefined ? {} : { slot }),
    };
    return [
      {
        userId,
        kind: EVENT_KINDS.goalieStarting,
        subject: player.playerKey,
        payload,
        dedupeKey: `goalie:${userId}:${player.playerKey}:${date}:${String(isStarting)}`,
      },
    ];
  });
}

/** Our matchup's category totals, by abbreviation, at most one reading an hour. */
export function matchupEvent(
  userId: string,
  teamKey: string,
  m: Matchup,
  categories: readonly StatCategory[],
  hourKey: string,
): NewEvent | undefined {
  const us = m.teams.find((t) => t.teamKey === teamKey);
  const them = m.teams.find((t) => t.teamKey !== teamKey);
  if (us === undefined || them === undefined) return undefined;
  const scored = categories.filter((c) => !c.isDisplayOnly);
  const abbr = new Map(scored.map((c) => [String(c.statId), c.abbr]));
  const byAbbr = (stats: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(stats).flatMap(([id, v]) => {
        const a = abbr.get(id);
        return a === undefined ? [] : [[a, v]];
      }),
    );
  const result = (winner: string | undefined) =>
    m.statWinners
      .filter((w) => !w.tied && w.winnerTeamKey === winner)
      .flatMap((w) => abbr.get(String(w.statId)) ?? []);
  const payload: MatchupUpdatePayload = {
    week: m.week,
    opponentTeamKey: them.teamKey,
    opponentName: them.name,
    us: byAbbr(us.stats),
    them: byAbbr(them.stats),
    winning: result(us.teamKey),
    losing: result(them.teamKey),
  };
  return {
    userId,
    kind: EVENT_KINDS.matchupUpdate,
    subject: `week-${m.week}`,
    payload,
    dedupeKey: `matchup:${userId}:w${m.week}:${hourKey}`,
  };
}
