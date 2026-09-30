import type { ChatEvent } from '@fha/api';
import { RequestError } from '../api/client';
import {
  MAX_RECONNECTS,
  SeqTracker,
  backoffDelay,
  nextState,
  type StreamInput,
  type StreamState,
} from './resume';
import { readChatStream } from './sse';

/**
 * Follows one chat turn to its end across dropped connections. The first stream comes from
 * `open` (the `POST /api/chat` that started the turn, or a resume when reattaching); after a
 * drop it resumes from the last seq seen, with exponential backoff, de-duplicating by seq.
 *
 * `wake()` (the page became visible, the network came back) abandons the current attempt or
 * wait and reconnects at once: a phone that slept may hold a dead socket that never errors.
 *
 * It never starts a turn twice (P7): if the first request fails before the turn's id is known,
 * that error is thrown to the caller, not retried.
 */
export type Opener = (signal: AbortSignal) => Promise<Response>;

export interface FollowOptions {
  open: Opener;
  resume: (turnId: string, after: number, signal: AbortSignal) => Promise<Response>;
  /** Each new event once, in seq order. */
  onEvent: (event: ChatEvent) => void;
  onState?: (state: StreamState) => void;
  /** Aborting it detaches this client; the turn carries on on the server. */
  signal: AbortSignal;
  /** Already known when reattaching to a running turn. */
  turnId?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxReconnects?: number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class TurnFollower {
  turnId: string | undefined;
  state: StreamState = 'idle';
  private readonly seqs = new SeqTracker();
  private attempt: AbortController | undefined;
  private woken = false;

  constructor(private readonly o: FollowOptions) {
    this.turnId = o.turnId;
  }

  get lastSeq(): number {
    return this.seqs.last;
  }

  /** Reconnect now (if the turn is still being followed). */
  wake(): void {
    // Before the turn's id is known there is nothing to resume: let the first request finish.
    if (this.turnId === undefined) return;
    if (this.state !== 'streaming' && this.state !== 'reconnecting') return;
    this.woken = true;
    this.attempt?.abort();
  }

  private go(input: StreamInput): void {
    const next = nextState(this.state, input);
    if (next !== this.state) {
      this.state = next;
      this.o.onState?.(next);
    }
  }

  /** Follows the turn until it ends, is gone, is given up on, or this client detaches. */
  async run(): Promise<StreamState> {
    let failures = 0;
    let first = true;
    const max = this.o.maxReconnects ?? MAX_RECONNECTS;
    const sleep = this.o.sleep ?? defaultSleep;
    while (!this.o.signal.aborted) {
      const attempt = new AbortController();
      this.attempt = attempt;
      const onDetach = () => attempt.abort();
      this.o.signal.addEventListener('abort', onDetach);
      try {
        const outcome = await this.once(attempt.signal, first, () => (failures = 0));
        if (outcome === 'done') return this.state;
      } catch (error) {
        if (this.o.signal.aborted) break;
        if (first && this.turnId === undefined) throw error;
        if (error instanceof RequestError) {
          if (error.code === 'turn_gone' || error.status === 404) {
            this.go({ type: 'gone' });
            return this.state;
          }
          if (error.status === 401) throw error;
        }
      } finally {
        this.o.signal.removeEventListener('abort', onDetach);
        first = false;
      }
      if (this.o.signal.aborted) break;
      if (this.turnId === undefined) {
        // The turn's id never arrived, so there is nothing to resume.
        this.go({ type: 'drop' });
        this.go({ type: 'giveUp' });
        return this.state;
      }
      this.go({ type: 'drop' });
      if (this.woken) {
        this.woken = false;
        failures = 0;
        continue;
      }
      failures += 1;
      if (failures > max) {
        this.go({ type: 'giveUp' });
        return this.state;
      }
      const wait = new AbortController();
      this.attempt = wait;
      const stopWait = () => wait.abort();
      this.o.signal.addEventListener('abort', stopWait);
      await sleep(backoffDelay(failures), wait.signal);
      this.o.signal.removeEventListener('abort', stopWait);
      if (this.woken) {
        this.woken = false;
        failures = 0;
      }
    }
    this.go({ type: 'detach' });
    return this.state;
  }

  /** One connection: open (or resume), then read until the stream ends. */
  private async once(signal: AbortSignal, first: boolean, progressed: () => void) {
    const response =
      first || this.turnId === undefined
        ? await this.o.open(signal)
        : await this.o.resume(this.turnId, this.seqs.last, signal);
    this.go({ type: 'open' });
    if (!response.body) return 'dropped' as const;
    const { done } = await readChatStream(response.body, (event, seq) => {
      if (!this.seqs.accept(seq)) return;
      progressed();
      if (event.type === 'turn') this.turnId = event.turnId;
      this.o.onEvent(event);
      this.go({ type: 'event', done: event.type === 'done' });
    });
    return done ? ('done' as const) : ('dropped' as const);
  }
}
