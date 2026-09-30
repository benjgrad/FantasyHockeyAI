import type { ChatEvent } from '@fha/api';
import { describe, expect, it } from 'vitest';
import { RequestError } from '../api/client';
import { TurnFollower, type FollowOptions } from './follow';
import type { StreamState } from './resume';

const TURN = 'id: 1\ndata: {"type":"turn","turnId":"T","conversationId":"C"}\n\n';
const text = (seq: number, delta: string) =>
  `id: ${seq}\ndata: ${JSON.stringify({ type: 'text', delta })}\n\n`;
const done = (seq: number) => `id: ${seq}\ndata: {"type":"done"}\n\n`;

/** A response streaming `chunks`, then closing — or, with `fail`, breaking like a dropped socket. */
function body(chunks: string[], fail = false): Response {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        const next = queue.shift();
        if (next !== undefined) c.enqueue(encoder.encode(next));
        else if (fail) c.error(new TypeError('network error'));
        else c.close();
      },
    }),
  );
}

function harness(over: Partial<FollowOptions> & Pick<FollowOptions, 'open'>) {
  const events: ChatEvent[] = [];
  const states: StreamState[] = [];
  const sleeps: number[] = [];
  const resumes: [string, number][] = [];
  const detach = new AbortController();
  const f = new TurnFollower({
    resume: () => Promise.reject(new Error('unexpected resume')),
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
    signal: detach.signal,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...over,
    ...(over.resume === undefined
      ? {}
      : {
          resume: (id: string, after: number, signal: AbortSignal) => {
            resumes.push([id, after]);
            return over.resume?.(id, after, signal) ?? Promise.reject(new Error('no resume'));
          },
        }),
  });
  return { f, events, states, sleeps, resumes, detach };
}

describe('TurnFollower', () => {
  it('after a drop, resumes from the last seq with backoff and de-duplicates the overlap', async () => {
    let calls = 0;
    const h = harness({
      open: () => Promise.resolve(body([TURN, text(2, 'Hel')], true)),
      resume: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new RequestError(0, 'offline', 'offline'));
        // The server replays from `after`; an overlap is harmless.
        return Promise.resolve(body([text(2, 'Hel'), text(3, 'lo'), done(4)]));
      },
    });
    expect(await h.f.run()).toBe('done');
    expect(h.events.map((e) => e.type)).toEqual(['turn', 'text', 'text', 'done']);
    expect(h.resumes).toEqual([
      ['T', 2],
      ['T', 2],
    ]);
    expect(h.sleeps).toEqual([500, 1000]);
    expect(h.states).toEqual(['streaming', 'reconnecting', 'streaming', 'done']);
  });

  it('a stream that ends without done while the turn runs reconnects rather than ending', async () => {
    const h = harness({
      open: () => Promise.resolve(body([TURN])),
      resume: () => Promise.resolve(body([text(2, 'ok'), done(3)])),
    });
    expect(await h.f.run()).toBe('done');
    expect(h.resumes).toEqual([['T', 1]]);
  });

  it('a refused first request is thrown, never retried (P7)', async () => {
    let opens = 0;
    const h = harness({
      open: () => {
        opens += 1;
        return Promise.reject(new RequestError(409, 'turn_in_progress', 'busy'));
      },
    });
    await expect(h.f.run()).rejects.toMatchObject({ code: 'turn_in_progress' });
    expect(opens).toBe(1);
  });

  it('a turn whose events were dropped is gone', async () => {
    const h = harness({
      open: () => Promise.resolve(body([TURN], true)),
      resume: () => Promise.reject(new RequestError(410, 'turn_gone', 'gone')),
    });
    expect(await h.f.run()).toBe('gone');
  });

  it('gives up after the reconnect budget, reporting lost', async () => {
    const h = harness({
      open: () => Promise.resolve(body([TURN], true)),
      resume: () => Promise.reject(new RequestError(0, 'offline', 'offline')),
      maxReconnects: 3,
    });
    expect(await h.f.run()).toBe('lost');
    expect(h.sleeps).toEqual([500, 1000, 2000]);
  });

  it('wake() abandons a hung stream and reconnects at once', async () => {
    let hung: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const h = harness({
      open: (signal) => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            hung = c;
            c.enqueue(encoder.encode(TURN));
          },
        });
        signal.addEventListener('abort', () => hung?.error(new DOMException('x', 'AbortError')));
        return Promise.resolve(new Response(stream));
      },
      resume: () => Promise.resolve(body([done(2)])),
    });
    const running = h.f.run();
    for (let i = 0; i < 20 && h.f.turnId === undefined; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    h.f.wake();
    expect(await running).toBe('done');
    expect(h.sleeps).toEqual([]);
    expect(h.resumes).toEqual([['T', 1]]);
  });

  it('detaching stops following without an error', async () => {
    const h = harness({
      open: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
        ),
    });
    const running = h.f.run();
    h.detach.abort();
    expect(await running).toBe('detached');
  });
});
