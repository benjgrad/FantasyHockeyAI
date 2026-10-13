import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';

describe('proposal attempts (migration 005)', () => {
  it('records refused proposals and counts them per agent', () => {
    const { store } = memStore();
    const base = { runId: 'r1', kind: 'lineup', errors: ['too many at C'] };
    expect(store.attempts.record({ ...base, agent: 'lineup', attempt: 1, terminal: false })).toBe(
      true,
    );
    store.attempts.record({ ...base, agent: 'lineup', attempt: 2, terminal: true });
    store.attempts.record({ ...base, agent: 'gm', attempt: 1, terminal: false });
    expect(store.attempts.byAgent('2000-01-01T00:00:00Z')).toEqual([
      { agent: 'lineup', attempts: 2, terminal: 1 },
      { agent: 'gm', attempts: 1, terminal: 0 },
    ]);
  });

  it('usage per agent and model', () => {
    const { store } = memStore();
    const call = { model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 10, costUsd: 0.01 };
    store.usage.record({ ...call, agent: 'lineup', runId: 'a' });
    store.usage.record({ ...call, agent: 'lineup', runId: 'a' });
    store.usage.record({ ...call, agent: 'lineup', runId: 'b' });
    expect(store.usage.byAgent('2000-01-01T00:00:00Z')).toEqual([
      {
        agent: 'lineup',
        model: 'claude-sonnet-5-5',
        runs: 2,
        calls: 3,
        costUsd: 0.03,
        outputTokens: 30,
      },
    ]);
  });
});
