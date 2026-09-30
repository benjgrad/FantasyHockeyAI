import { describe, expect, it } from 'vitest';
import { BACKOFF_MAX_MS, SeqTracker, backoffDelay, nextState, type StreamState } from './resume';

describe('SeqTracker', () => {
  it('accepts each seq once, dropping a replayed overlap', () => {
    const t = new SeqTracker();
    expect([1, 2, 3].map((s) => t.accept(s))).toEqual([true, true, true]);
    expect([2, 3, 4, 4, 5].map((s) => t.accept(s))).toEqual([false, false, true, false, true]);
    expect(t.last).toBe(5);
    expect(t.accept(undefined)).toBe(true);
  });
});

describe('backoffDelay', () => {
  it('doubles from 0.5 s and caps at 15 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay)).toEqual([
      500, 1000, 2000, 4000, 8000, 15000, 15000, 15000,
    ]);
    expect(backoffDelay(0)).toBe(500);
    expect(backoffDelay(1000)).toBe(BACKOFF_MAX_MS);
  });
});

describe('nextState', () => {
  const run = (inputs: Parameters<typeof nextState>[1][]): StreamState =>
    inputs.reduce(nextState, 'idle' as StreamState);

  it('streams, drops, reconnects and finishes', () => {
    expect(
      run([
        { type: 'open' },
        { type: 'event', done: false },
        { type: 'drop' },
        { type: 'open' },
        { type: 'event', done: true },
      ]),
    ).toBe('done');
  });

  it('gives up only while reconnecting', () => {
    expect(run([{ type: 'open' }, { type: 'giveUp' }])).toBe('streaming');
    expect(run([{ type: 'open' }, { type: 'drop' }, { type: 'giveUp' }])).toBe('lost');
  });

  it('terminal states absorb every input', () => {
    expect(run([{ type: 'open' }, { type: 'gone' }, { type: 'open' }])).toBe('gone');
    expect(run([{ type: 'detach' }, { type: 'event', done: true }])).toBe('detached');
    expect(run([{ type: 'open' }, { type: 'event', done: true }, { type: 'drop' }])).toBe('done');
  });
});
