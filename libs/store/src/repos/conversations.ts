import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseJson, parseLoose, type Clock, type Db } from '../db.js';

/**
 * Chat with the assistant agent (plan Phase 5): multi-turn conversations, one user each.
 *
 * Ownership is enforced at the conversation: `get`, `list` and `rename` take the user id and
 * never return another user's conversation. `append` and `messages` take only the conversation
 * id, so the web layer must `get(id, userId)` first — it already has to, to render the page.
 */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface Conversation {
  id: string;
  userId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  conversationId: string;
  role: MessageRole;
  /** Whatever the chat layer stored (text or Anthropic content blocks); its shape is the caller's. */
  content: unknown;
  /** Plans this message proposed, so the UI can render their decision cards. */
  planIds: string[];
  createdAt: string;
}

export interface ConversationsRepo {
  create(userId: string, title?: string): Conversation;
  /** The user's conversations, most recently active first. */
  list(userId: string, limit: number): Conversation[];
  /** Undefined when the id is unknown *or* belongs to someone else. */
  get(id: string, userId: string): Conversation | undefined;
  /** Adds a message and bumps the conversation's `updatedAt`. Returns the message id. */
  append(
    conversationId: string,
    role: MessageRole,
    content: unknown,
    planIds?: readonly string[],
  ): number;
  /** Oldest first; with `limit`, the latest `limit` messages (still oldest first). */
  messages(conversationId: string, limit?: number): Message[];
  /** Returns false when the conversation is unknown or not the user's. */
  rename(id: string, userId: string, title: string): boolean;
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  role: MessageRole;
  content_json: string;
  plan_ids: string | null;
  created_at: string;
}

const PlanIds = z.array(z.string());

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    userId: r.user_id,
    ...(r.title === null ? {} : { title: r.title }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: parseLoose(r.content_json),
    planIds:
      r.plan_ids === null ? [] : parseJson(PlanIds, r.plan_ids, `messages[${r.id}].plan_ids`),
    createdAt: r.created_at,
  };
}

export function conversationsRepo(db: Db, now: Clock): ConversationsRepo {
  const insert = db.prepare(
    `INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const select = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?');
  const list = db.prepare(
    'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?',
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (conversation_id, role, content_json, plan_ids, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const touch = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
  // Latest N by id, then re-sorted ascending; -1 is SQLite's "no limit".
  const messages = db.prepare(
    `SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?)
     ORDER BY id`,
  );
  const rename = db.prepare(
    'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  );

  const append = db.transaction(
    (id: string, role: MessageRole, content: unknown, planIds?: readonly string[]) => {
      const at = now().toISOString();
      const planJson =
        planIds === undefined || planIds.length === 0 ? null : JSON.stringify(planIds);
      const info = insertMessage.run(id, role, JSON.stringify(content), planJson, at);
      touch.run(at, id);
      return Number(info.lastInsertRowid);
    },
  );

  return {
    create(userId, title) {
      const at = now().toISOString();
      const id = randomUUID();
      insert.run(id, userId, title ?? null, at, at);
      return {
        id,
        userId,
        ...(title === undefined ? {} : { title }),
        createdAt: at,
        updatedAt: at,
      };
    },
    list: (userId, limit) => (list.all(userId, limit) as ConversationRow[]).map(toConversation),
    get(id, userId) {
      const r = select.get(id, userId) as ConversationRow | undefined;
      return r === undefined ? undefined : toConversation(r);
    },
    append: (id, role, content, planIds) => append(id, role, content, planIds),
    messages: (id, limit) => (messages.all(id, limit ?? -1) as MessageRow[]).map(toMessage),
    rename: (id, userId, title) => rename.run(title, now().toISOString(), id, userId).changes === 1,
  };
}
