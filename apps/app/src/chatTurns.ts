import { randomUUID } from 'node:crypto';
import type { ChatEvent, ChatTurn } from '@fha/api';
import type { StoredAssistantMessage } from '@fha/agents';
import type { ChatTurnRecord, Store } from '@fha/store';

/**
 * Durable chat turns. A turn is started once and runs to completion on the server whatever the
 * browser does: an HTTP stream only *attaches* to it as a listener, and a disconnect only
 * detaches that listener. Only an explicit cancel or server shutdown aborts the model call.
 *
 * Every event gets a monotonically increasing `seq` and is kept in the turn's buffer, so a client
 * that lost its stream resumes by replaying the events after the last seq it saw — never by
 * running the turn again (P7: the turn may already have filed a plan).
 *
 * Finished turns stay in memory for {@link RETAIN_MS} (and at most {@link MAX_FINISHED_PER_USER}
 * per user) for late reconnects. A compact record (status, last seq) is kept in the store, so
 * after a restart the client learns the turn ended; the conversation's messages are the durable
 * record of what was said.
 */
export const RETAIN_MS = 30 * 60_000;
export const MAX_FINISHED_PER_USER = 10;
/** A client reconnecting right after the turn ended still counts as watching it. */
export const UNWATCHED_GRACE_MS = 5_000;
/** Finished turn records older than this are deleted from the store at startup. */
export const RECORD_RETAIN_MS = 30 * 24 * 60 * 60_000;
export const SHUTDOWN_WAIT_MS = 5_000;

export const INTERRUPTED = {
  code: 'interrupted',
  message:
    'The server restarted before this reply finished, so it was not completed. Nothing was re-run; any decision it filed is under Decisions.',
} as const;

export interface SeqEvent {
  seq: number;
  event: ChatEvent;
}

export interface TurnListener {
  event(e: SeqEvent): void;
  /** The turn finished; no more events will come. */
  end(): void;
}

/** Runs the agent once. Must emit its own `done`; one is added if it does not (P6). */
export type TurnRun = (
  emit: (e: ChatEvent) => void,
  signal: AbortSignal,
) => Promise<'ok' | 'failed'>;

export interface LiveTurn {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  status: 'running' | 'done' | 'failed';
  readonly events: SeqEvent[];
  readonly startedAt: string;
  finishedAt?: string;
  /** Cancelled by the user or by shutdown: nobody needs a push about it. */
  cancelled: boolean;
  /** A listener received the turn's `done`. */
  seenEnd: boolean;
}

interface Internal extends LiveTurn {
  listeners: Set<TurnListener>;
  abort: AbortController;
  settled: Promise<void>;
}

export interface ChatTurnsOptions {
  store: Store;
  now: () => Date;
  log: (line: string) => void;
  /** A turn ended and no client saw its end within the grace period. Must not throw. */
  onUnwatched: (turn: LiveTurn) => void;
  graceMs?: number;
  retainMs?: number;
  maxFinishedPerUser?: number;
}

export function turnSummary(t: LiveTurn): ChatTurn {
  return {
    turnId: t.id,
    conversationId: t.conversationId,
    status: t.status,
    lastSeq: t.events.length,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt ?? null,
  };
}

export function recordSummary(r: ChatTurnRecord): ChatTurn {
  return {
    turnId: r.id,
    conversationId: r.conversationId,
    status: r.status,
    lastSeq: r.lastSeq,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
  };
}

export class ChatTurns {
  private readonly turns = new Map<string, Internal>();

  constructor(private readonly o: ChatTurnsOptions) {}

  /**
   * At startup: every turn the store still calls running was cut off by the restart. Mark it
   * failed and, when the conversation ends on the user's message, store an assistant message
   * saying so. Never re-runs anything.
   */
  recover(): number {
    const cut = this.o.store.chatTurns.interruptRunning(INTERRUPTED.code);
    for (const t of cut) {
      const last = this.o.store.conversations.messages(t.conversationId, 1)[0];
      if (last?.role !== 'user') continue;
      const stored: StoredAssistantMessage = { text: '', tools: [], error: { ...INTERRUPTED } };
      this.o.store.conversations.append(t.conversationId, 'assistant', stored);
    }
    this.o.store.chatTurns.prune(new Date(this.o.now().getTime() - RECORD_RETAIN_MS));
    if (cut.length > 0) this.o.log(`chat: ${cut.length} turn(s) interrupted by the restart`);
    return cut.length;
  }

  /** The running turn of a conversation, if any: one at a time per conversation. */
  runningIn(conversationId: string): LiveTurn | undefined {
    for (const t of this.turns.values()) {
      if (t.conversationId === conversationId && t.status === 'running') return t;
    }
    return undefined;
  }

  /** Starts a turn; its first event is `turn`. The caller has checked ownership and conflicts. */
  start(p: { userId: string; conversationId: string; run: TurnRun }): LiveTurn {
    this.prune();
    const id = randomUUID();
    const rec = this.o.store.chatTurns.start({
      id,
      userId: p.userId,
      conversationId: p.conversationId,
    });
    const turn: Internal = {
      id,
      userId: p.userId,
      conversationId: p.conversationId,
      status: 'running',
      events: [],
      startedAt: rec.startedAt,
      cancelled: false,
      seenEnd: false,
      listeners: new Set(),
      abort: new AbortController(),
      settled: Promise.resolve(),
    };
    this.turns.set(id, turn);
    this.emit(turn, { type: 'turn', turnId: id, conversationId: p.conversationId });
    turn.settled = this.drive(turn, p.run);
    return turn;
  }

  private async drive(turn: Internal, run: TurnRun): Promise<void> {
    let status: 'ok' | 'failed';
    try {
      status = await run((e) => this.emit(turn, e), turn.abort.signal);
    } catch (err) {
      status = 'failed';
      const message = err instanceof Error ? err.message : String(err);
      this.emit(turn, { type: 'error', code: 'turn_exception', message });
    }
    if (turn.events.at(-1)?.event.type !== 'done') this.emit(turn, { type: 'done' });
    this.finish(turn, status === 'ok' ? 'done' : 'failed');
  }

  private emit(turn: Internal, event: ChatEvent): void {
    if (turn.status !== 'running') return;
    const e = { seq: turn.events.length + 1, event };
    turn.events.push(e);
    for (const l of turn.listeners) l.event(e);
    if (event.type === 'done' && turn.listeners.size > 0) turn.seenEnd = true;
  }

  private finish(turn: Internal, status: 'done' | 'failed'): void {
    turn.status = status;
    turn.finishedAt = this.o.now().toISOString();
    const errorCode = turn.events.find((e) => e.event.type === 'error')?.event;
    try {
      this.o.store.chatTurns.finish(
        turn.id,
        status,
        turn.events.length,
        errorCode?.type === 'error' ? errorCode.code : undefined,
      );
    } catch (err) {
      // The reply already reached the conversation; only the compact record is stale (P9).
      this.o.log(`chat: turn record not saved (${err instanceof Error ? err.name : 'error'})`);
    }
    for (const l of turn.listeners) l.end();
    turn.listeners.clear();
    if (turn.cancelled || turn.seenEnd) return;
    const timer = setTimeout(() => {
      if (!turn.seenEnd) this.o.onUnwatched(turn);
    }, this.o.graceMs ?? UNWATCHED_GRACE_MS);
    timer.unref();
  }

  /**
   * Replays every event after `after`, then streams live ones. Returns the detach function.
   * A finished turn replays and ends at once.
   */
  attach(turn: LiveTurn, after: number, listener: TurnListener): () => void {
    const t = this.turns.get(turn.id);
    if (t === undefined) {
      listener.end();
      return () => undefined;
    }
    for (const e of t.events) {
      if (e.seq <= after) continue;
      listener.event(e);
      if (e.event.type === 'done') t.seenEnd = true;
    }
    if (t.status !== 'running') {
      listener.end();
      return () => undefined;
    }
    t.listeners.add(listener);
    return () => t.listeners.delete(listener);
  }

  /** The user's turn still in memory; another user's is indistinguishable from none. */
  get(turnId: string, userId: string): LiveTurn | undefined {
    this.prune();
    const t = this.turns.get(turnId);
    return t?.userId === userId ? t : undefined;
  }

  list(userId: string, status: 'running' | 'all'): LiveTurn[] {
    this.prune();
    return [...this.turns.values()].filter(
      (t) => t.userId === userId && (status === 'all' || t.status === 'running'),
    );
  }

  /** Aborts the model call. The turn then ends normally, with its `error` and `done`. */
  cancel(turnId: string, userId: string): LiveTurn | undefined {
    const t = this.turns.get(turnId);
    if (t?.userId !== userId) return undefined;
    if (t.status === 'running') {
      t.cancelled = true;
      t.abort.abort(new Error('cancelled by the user'));
    }
    return t;
  }

  /** Server shutdown: abort every running turn and wait (bounded) for each to store its end. */
  async shutdown(waitMs = SHUTDOWN_WAIT_MS): Promise<void> {
    const running = [...this.turns.values()].filter((t) => t.status === 'running');
    for (const t of running) {
      t.cancelled = true;
      t.abort.abort(new Error('server shutting down'));
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, waitMs);
      timer.unref();
    });
    await Promise.race([Promise.all(running.map((t) => t.settled)), timeout]);
    clearTimeout(timer);
  }

  /** Drops finished turns past their retention, and the oldest beyond the per-user cap. */
  private prune(): void {
    const cutoff = this.o.now().getTime() - (this.o.retainMs ?? RETAIN_MS);
    const cap = this.o.maxFinishedPerUser ?? MAX_FINISHED_PER_USER;
    const finishedByUser = new Map<string, Internal[]>();
    for (const t of this.turns.values()) {
      if (t.status === 'running' || t.finishedAt === undefined) continue;
      if (Date.parse(t.finishedAt) < cutoff) {
        this.turns.delete(t.id);
        continue;
      }
      finishedByUser.set(t.userId, [...(finishedByUser.get(t.userId) ?? []), t]);
    }
    for (const list of finishedByUser.values()) {
      // Map order is insertion order, so the first ones are the oldest.
      for (const t of list.slice(0, Math.max(0, list.length - cap))) this.turns.delete(t.id);
    }
  }
}
