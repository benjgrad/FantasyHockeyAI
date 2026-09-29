import { describe, expect, it } from 'vitest';
import { memStore } from '../test-helpers.js';

function twoUsers() {
  const { store, clock } = memStore();
  const ben = store.users.upsertBySub('sub-ben');
  const eve = store.users.upsertBySub('sub-eve');
  return { store, clock, ben, eve };
}

describe('conversations', () => {
  it('never returns, lists or renames another user’s conversation', () => {
    const { store, ben, eve } = twoUsers();
    const c = store.conversations.create(ben.id, 'Waivers');
    expect(store.conversations.get(c.id, ben.id)).toEqual(c);
    expect(store.conversations.get(c.id, eve.id)).toBeUndefined();
    expect(store.conversations.get('ghost', ben.id)).toBeUndefined();
    expect(store.conversations.list(eve.id, 10)).toEqual([]);
    expect(store.conversations.rename(c.id, eve.id, 'mine now')).toBe(false);
    expect(store.conversations.rename(c.id, ben.id, 'Waiver wire')).toBe(true);
    expect(store.conversations.get(c.id, ben.id)?.title).toBe('Waiver wire');
  });

  it('lists most recently active first, bumped by a new message', () => {
    const { store, clock, ben } = twoUsers();
    const a = store.conversations.create(ben.id);
    clock.advance(1000);
    const b = store.conversations.create(ben.id);
    expect(store.conversations.list(ben.id, 10).map((c) => c.id)).toEqual([b.id, a.id]);
    clock.advance(1000);
    store.conversations.append(a.id, 'user', 'hi');
    expect(store.conversations.list(ben.id, 10).map((c) => c.id)).toEqual([a.id, b.id]);
    expect(store.conversations.list(ben.id, 1).map((c) => c.id)).toEqual([a.id]);
    expect(store.conversations.get(a.id, ben.id)?.updatedAt).toBe('2026-10-06T12:00:02.000Z');
  });

  it('appends messages with content and plan ids, and reads the latest N oldest first', () => {
    const { store, ben } = twoUsers();
    const c = store.conversations.create(ben.id);
    store.conversations.append(c.id, 'user', 'drop Kane?');
    const blocks = [{ type: 'text', text: 'Proposed.' }];
    const id = store.conversations.append(c.id, 'assistant', blocks, ['plan-1', 'plan-2']);
    store.conversations.append(c.id, 'user', 'why?');

    const all = store.conversations.messages(c.id);
    expect(all.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(all[1]).toEqual({
      id,
      conversationId: c.id,
      role: 'assistant',
      content: blocks,
      planIds: ['plan-1', 'plan-2'],
      createdAt: '2026-10-06T12:00:00.000Z',
    });
    expect(all[0]?.planIds).toEqual([]);
    expect(store.conversations.messages(c.id, 2).map((m) => m.content)).toEqual([blocks, 'why?']);
    expect(store.conversations.messages('ghost')).toEqual([]);
  });

  it('refuses a message for a conversation that does not exist', () => {
    const { store } = twoUsers();
    expect(() => store.conversations.append('ghost', 'user', 'x')).toThrow(/FOREIGN KEY/);
  });
});
