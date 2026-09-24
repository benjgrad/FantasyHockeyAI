import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';

describe('runs', () => {
  it('starts and finishes a run once', () => {
    const { store, clock } = memStore();
    const id = store.runs.start('waivers');
    expect(store.runs.get(id)).toEqual({
      runId: id,
      job: 'waivers',
      startedAt: '2026-10-06T12:00:00.000Z',
      status: 'running',
    });
    clock.advance(60_000);
    expect(store.runs.finish(id, 'success', '2 plans')).toBe(true);
    expect(store.runs.finish(id, 'failed')).toBe(false);
    expect(store.runs.get(id)).toMatchObject({
      status: 'success',
      summary: '2 plans',
      endedAt: '2026-10-06T12:01:00.000Z',
    });
    expect(store.runs.get('ghost')).toBeUndefined();
  });
});

describe('snapshots', () => {
  it('returns the newest snapshot for a reason', () => {
    const { store } = memStore();
    store.snapshots.save('465.l.1.t.3', '2026-10-06', { entries: [1] }, 'plan-1');
    const id = store.snapshots.save('465.l.1.t.3', '2026-10-06', { entries: [2] }, 'plan-1');
    store.snapshots.save('465.l.1.t.3', '2026-10-06', { entries: [3] }, 'plan-2');
    expect(store.snapshots.latest('plan-1')).toMatchObject({
      id,
      teamKey: '465.l.1.t.3',
      roster: { entries: [2] },
    });
    expect(store.snapshots.latest('none')).toBeUndefined();
  });
});

describe('questions', () => {
  it('asks, lists unanswered oldest first, and takes the first answer only', () => {
    const { store, clock } = memStore();
    const a = store.questions.ask('run-1', 'waivers', 'Drop Kane?', ['yes', 'no']);
    clock.advance(1000);
    const b = store.questions.ask('run-1', 'lineup', 'Start the backup?');
    expect(store.questions.unanswered().map((q) => q.id)).toEqual([a, b]);
    expect(store.questions.get(b)?.options).toEqual([]);

    expect(store.questions.answer(a, 'no')).toBe(true);
    expect(store.questions.answer(a, 'yes')).toBe(false);
    expect(store.questions.get(a)).toMatchObject({ answer: 'no', options: ['yes', 'no'] });
    expect(store.questions.unanswered().map((q) => q.id)).toEqual([b]);
    expect(store.questions.answer('ghost', 'x')).toBe(false);
  });
});

describe('strategy', () => {
  it('sets, replaces and reads weekly weights', () => {
    const { store } = memStore();
    store.strategy.set(3, { G: 1.2, PIM: 0.5 }, 'chase goals');
    store.strategy.set(3, { G: 1.5 }, 'really chase goals');
    expect(store.strategy.get(3)).toMatchObject({
      weights: { G: 1.5 },
      rationale: 'really chase goals',
    });
    expect(store.strategy.get(4)).toBeUndefined();
  });

  it('rejects non-finite weights', () => {
    const { store } = memStore();
    expect(() => store.strategy.set(1, { G: Number.NaN }, 'x')).toThrow();
  });
});

describe('kv', () => {
  it('sets, overwrites and deletes', () => {
    const { store } = memStore();
    expect(store.kv.get('paused')).toBeUndefined();
    store.kv.set('paused', 'true');
    store.kv.set('paused', 'false');
    expect(store.kv.get('paused')).toBe('false');
    expect(store.kv.delete('paused')).toBe(true);
    expect(store.kv.delete('paused')).toBe(false);
  });
});
