import type { StoredAssistantMessage, StoredUserMessage, ToolNote } from '@fha/agents';
import type { Store } from '@fha/store';
import type { Notice } from './push.js';

/**
 * The Background activity conversation (D-027): what the agents did while Ben was not chatting,
 * in the chat he already reads. Each trigger (a schedule slot, a Yahoo change, an auto-grab
 * check) is a `background` marker; each agent run is an assistant reply with its tool notes and
 * decision cards; each notification sent is a note. Ben can reply in it to ask why.
 *
 * Best effort (P9): recording never breaks a job or a notification.
 */
export const ACTIVITY_TITLE = 'Background activity';
const key = (userId: string) => `activity.conversation:${userId}`;

/** The user's activity conversation, created on first use. */
export function activityConversationId(store: Store, userId: string): string {
  const known = store.kv.get(key(userId));
  if (known !== undefined && store.conversations.get(known, userId) !== undefined) return known;
  const c = store.conversations.create(userId, ACTIVITY_TITLE);
  store.kv.set(key(userId), c.id);
  return c.id;
}

/** The user's activity conversation id, if it exists yet. */
export function existingActivityConversation(store: Store, userId: string): string | undefined {
  const known = store.kv.get(key(userId));
  return known !== undefined && store.conversations.get(known, userId) !== undefined
    ? known
    : undefined;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // P9: the activity record is a view, never a reason for a job to fail.
  }
}

/** What started something: "⏰ 10:00 lineup", "📣 Hellebuyck NA → IR-NR". */
export function recordTrigger(store: Store, userId: string, text: string): void {
  safely(() => {
    const m: StoredUserMessage = { text, source: 'background' };
    store.conversations.append(activityConversationId(store, userId), 'user', m);
  });
}

/** An agent's (or a deterministic check's) answer, with its tool notes and plan cards. */
export function recordReply(
  store: Store,
  userId: string,
  r: {
    text: string;
    tools?: ToolNote[];
    planIds?: readonly string[];
    error?: { code: string; message: string };
  },
): void {
  safely(() => {
    const m: StoredAssistantMessage = {
      text: r.text,
      tools: r.tools ?? [],
      source: 'background',
      ...(r.error === undefined ? {} : { error: r.error }),
    };
    store.conversations.append(activityConversationId(store, userId), 'assistant', m, r.planIds);
  });
}

/** Every notification, recorded where Ben reads the rest. */
export function recordNotice(store: Store, userId: string, n: Notice): void {
  const body = n.body === undefined || n.body === '' ? '' : ` — ${n.body}`;
  recordReply(store, userId, { text: `🔔 Notified you: **${n.title}**${body}` });
}

/** How a daemon job's reason reads as a trigger. */
export function triggerText(job: string, why: string): string {
  const slot = /^(\w+)@(\d{4}-\d{2}-\d{2})#(\w+)$/.exec(why);
  if (slot !== null) {
    const when =
      { am: 'morning', pm: 'afternoon', pregame: 'pre-game', daily: 'daily', weekly: 'weekly' }[
        slot[3] ?? ''
      ] ?? slot[3];
    return `⏰ Scheduled: the ${when} ${job} run`;
  }
  return `📣 ${why} → ${job} agent`;
}
