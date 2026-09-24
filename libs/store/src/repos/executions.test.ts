import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';

describe('executions', () => {
  it('the first begin claims the key; a repeat while running is in_progress', () => {
    const { store } = memStore();
    expect(store.executions.begin('plan-1:0', 'plan-1')).toBe('started');
    expect(store.executions.begin('plan-1:0', 'plan-1')).toBe('in_progress');
    expect(store.executions.get('plan-1:0')).toMatchObject({ status: 'started', planId: 'plan-1' });
  });

  it('a finished-done key is already_done, so executing twice gives one write', () => {
    const { store, clock } = memStore();
    let writes = 0;
    const run = () => {
      if (store.executions.begin('p:0', 'p') !== 'started') return;
      writes += 1;
      store.executions.finish('p:0', 'done', { ok: true });
    };
    run();
    clock.advance(1000);
    run();
    expect(writes).toBe(1);
    expect(store.executions.begin('p:0', 'p')).toBe('already_done');
    expect(store.executions.get('p:0')).toMatchObject({
      status: 'done',
      response: { ok: true },
      finishedAt: '2026-10-06T12:00:00.000Z',
    });
  });

  it('submitted and needsHuman are unresolved: in_progress, never a fresh start', () => {
    const { store } = memStore();
    store.executions.begin('a:0', 'a');
    store.executions.finish('a:0', 'submitted');
    store.executions.begin('b:0', 'b');
    store.executions.finish('b:0', 'needsHuman');
    expect(store.executions.begin('a:0', 'a')).toBe('in_progress');
    expect(store.executions.begin('b:0', 'b')).toBe('in_progress');
  });

  it('a clean failure is reported as failed', () => {
    const { store } = memStore();
    store.executions.begin('a:0', 'a');
    store.executions.finish('a:0', 'failed', 'HTTP 400');
    expect(store.executions.begin('a:0', 'a')).toBe('failed');
    expect(store.executions.get('a:0')?.response).toBe('HTTP 400');
  });

  it('finish on an unknown key reports false', () => {
    const { store } = memStore();
    expect(store.executions.finish('ghost:0', 'done')).toBe(false);
  });

  it('lists a plan’s actions in key order', () => {
    const { store } = memStore();
    store.executions.begin('p:1', 'p');
    store.executions.begin('p:0', 'p');
    store.executions.begin('q:0', 'q');
    expect(store.executions.forPlan('p').map((e) => e.idempotencyKey)).toEqual(['p:0', 'p:1']);
  });
});
