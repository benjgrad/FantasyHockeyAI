import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';
import type { UsageEvent } from './usage.js';

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  runId: 'run-1',
  requestId: 'req-1',
  agent: 'waivers',
  model: 'claude-opus-4-7',
  iteration: 0,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 500,
  toolNames: ['getRoster'],
  durationMs: 1200,
  stopReason: 'tool_use',
  costUsd: 0.01,
  ...over,
});

describe('usage', () => {
  it('records events and totals them since an instant', () => {
    const { store, clock } = memStore();
    expect(store.usage.record(event({ at: '2026-10-05T12:00:00Z' }))).toBe(true);
    expect(store.usage.record(event())).toBe(true);
    clock.advance(1000);
    expect(store.usage.record(event({ inputTokens: 50, outputTokens: 5, costUsd: 0.5 }))).toBe(
      true,
    );

    const t = store.usage.totals('2026-10-06T08:00:00-04:00');
    expect(t.inputTokens).toBe(1050);
    expect(t.outputTokens).toBe(205);
    expect(t.costUsd).toBeCloseTo(0.51);
  });

  it('totals are zero with no rows', () => {
    const { store } = memStore();
    expect(store.usage.totals('2026-01-01T00:00:00Z')).toEqual({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('record never throws: a closed database returns false', () => {
    const { store } = memStore();
    store.close();
    expect(store.usage.record(event())).toBe(false);
  });

  it('record never throws: closing after the statement was prepared returns false', () => {
    const { store } = memStore();
    expect(store.usage.record(event())).toBe(true);
    store.close();
    expect(store.usage.record(event())).toBe(false);
  });

  it('record never throws: a malformed event returns false', () => {
    const { store } = memStore();
    expect(store.usage.record(event({ at: 'not a date' }))).toBe(false);
    expect(store.usage.record({ model: 'm' } as UsageEvent)).toBe(false);
    expect(store.usage.record(null as unknown as UsageEvent)).toBe(false);
  });
});
