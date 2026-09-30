import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';

function setup() {
  const { store, clock } = memStore();
  const ben = store.users.upsertBySub('sub-ben');
  const eve = store.users.upsertBySub('sub-eve');
  const conv = store.conversations.create(ben.id, 'x');
  return { store, clock, ben, eve, conv };
}

describe('chatTurns', () => {
  it('starts running, finishes once, and is only visible to its owner', () => {
    const { store, ben, eve, conv } = setup();
    store.chatTurns.start({ id: 't1', userId: ben.id, conversationId: conv.id });
    expect(store.chatTurns.get('t1', ben.id)).toMatchObject({ status: 'running', lastSeq: 0 });
    expect(store.chatTurns.get('t1', eve.id)).toBeUndefined();
    expect(store.chatTurns.finish('t1', 'done', 7)).toBe(true);
    expect(store.chatTurns.finish('t1', 'failed', 9, 'late')).toBe(false);
    expect(store.chatTurns.get('t1', ben.id)).toMatchObject({ status: 'done', lastSeq: 7 });
  });

  it('interruptRunning marks every running turn failed and returns them', () => {
    const { store, ben, conv } = setup();
    store.chatTurns.start({ id: 'a', userId: ben.id, conversationId: conv.id });
    store.chatTurns.start({ id: 'b', userId: ben.id, conversationId: conv.id });
    store.chatTurns.finish('b', 'done', 3);
    const cut = store.chatTurns.interruptRunning('interrupted');
    expect(cut.map((t) => t.id)).toEqual(['a']);
    expect(store.chatTurns.get('a', ben.id)).toMatchObject({
      status: 'failed',
      errorCode: 'interrupted',
    });
    expect(store.chatTurns.interruptRunning('interrupted')).toEqual([]);
  });

  it('prune deletes only finished turns older than the cutoff', () => {
    const { store, clock, ben, conv } = setup();
    store.chatTurns.start({ id: 'old', userId: ben.id, conversationId: conv.id });
    store.chatTurns.finish('old', 'done', 1);
    store.chatTurns.start({ id: 'live', userId: ben.id, conversationId: conv.id });
    clock.advance(10_000);
    expect(store.chatTurns.prune(clock.now())).toBe(1);
    expect(store.chatTurns.get('old', ben.id)).toBeUndefined();
    expect(store.chatTurns.get('live', ben.id)).toBeDefined();
  });
});
