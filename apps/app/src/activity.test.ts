import { describe, expect, it } from 'vitest';
import { replayHistory, storedSource } from '@fha/agents';
import { openStore } from '@fha/store';
import {
  ACTIVITY_TITLE,
  activityConversationId,
  existingActivityConversation,
  recordNotice,
  recordReply,
  recordTrigger,
  triggerText,
} from './activity.js';

describe('Background activity chat (D-027)', () => {
  it('records triggers, replies and notices in one conversation per user', () => {
    const store = openStore(':memory:');
    const ben = store.users.upsertBySub('ben').id;
    expect(existingActivityConversation(store, ben)).toBeUndefined();
    recordTrigger(store, ben, triggerText('lineup', 'lineup@2026-10-03#am'));
    recordReply(store, ben, {
      text: 'No change needed.',
      tools: [{ name: 'getRoster', ok: true, detail: 'Our roster on 2026-10-03:' }],
    });
    recordNotice(store, ben, { kind: 'injury', title: 'Hellebuyck can go to IR', body: 'IR-NR' });
    const id = activityConversationId(store, ben);
    expect(store.conversations.get(id, ben)?.title).toBe(ACTIVITY_TITLE);
    const ms = store.conversations.messages(id);
    expect(ms.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(ms.every((m) => storedSource(m) === 'background')).toBe(true);
    expect(JSON.stringify(ms[0]?.content)).toContain('Scheduled: the morning lineup run');
    expect(JSON.stringify(ms[2]?.content)).toContain(
      'Notified you: **Hellebuyck can go to IR** — IR-NR',
    );
    // Replayed to the model, a trigger is never mistaken for something Ben said.
    expect(replayHistory(ms)[0]?.content).toMatch(/^\[Background event, not a message from Ben\]/);
  });

  it('a rule reason reads as what happened and which agent ran', () => {
    expect(triggerText('lineup', 'Connor Hellebuyck now IR-eligible')).toBe(
      '📣 Connor Hellebuyck now IR-eligible → lineup agent',
    );
  });
});
