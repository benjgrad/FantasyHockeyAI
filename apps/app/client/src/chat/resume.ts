/**
 * The pure parts of reconnecting to a chat turn: seq de-duplication, the backoff schedule and
 * the stream's state machine. The turn runs on the server regardless; reconnecting only
 * replays the events this client missed, never runs the turn again (P7).
 */

/** Accepts each seq once, in increasing order: a replay after reconnecting may overlap. */
export class SeqTracker {
  last = 0;

  /** True when the event is new. An event without a seq (an old server) is always accepted. */
  accept(seq: number | undefined): boolean {
    if (seq === undefined) return true;
    if (seq <= this.last) return false;
    this.last = seq;
    return true;
  }
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 15_000;
/** Consecutive failed reconnects before giving up; any event received resets the count. */
export const MAX_RECONNECTS = 10;

/** Delay before reconnect attempt `attempt` (1-based): 0.5 s, 1 s, 2 s, … capped at 15 s. */
export function backoffDelay(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

export type StreamState =
  | 'idle'
  | 'streaming'
  | 'reconnecting'
  /** `done` arrived. */
  | 'done'
  /** The server dropped the turn's events (finished long ago, or a restart): reload history. */
  | 'gone'
  /** Gave up reconnecting; the turn may still be running on the server. */
  | 'lost'
  /** This client stopped watching (left the chat); the turn carries on. */
  | 'detached';

export type StreamInput =
  | { type: 'open' }
  | { type: 'event'; done: boolean }
  /** The stream broke or ended without `done`. */
  | { type: 'drop' }
  | { type: 'giveUp' }
  | { type: 'gone' }
  | { type: 'detach' };

const TERMINAL = new Set<StreamState>(['done', 'gone', 'lost', 'detached']);

export function isTerminal(s: StreamState): boolean {
  return TERMINAL.has(s);
}

export function nextState(s: StreamState, input: StreamInput): StreamState {
  if (isTerminal(s)) return s;
  switch (input.type) {
    case 'detach':
      return 'detached';
    case 'gone':
      return 'gone';
    case 'open':
      return 'streaming';
    case 'event':
      return input.done ? 'done' : 'streaming';
    case 'drop':
      return 'reconnecting';
    case 'giveUp':
      return s === 'reconnecting' ? 'lost' : s;
  }
}
