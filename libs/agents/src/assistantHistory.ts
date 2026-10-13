import { z } from 'zod';
import type { BaseParams } from '@fha/llm';
import type { Message } from '@fha/store';

/**
 * How a chat is stored and replayed for the assistant (plan Phase 5).
 *
 * The `conversations` repo holds what the user said and what the assistant answered, plus a
 * compact record of the tools it called and the plans it made. It never holds raw tool payloads:
 * a roster table replayed from last week would be stale data presented as current, and it would
 * grow every request. The next turn re-reads anything it needs through the tools.
 */
/** `background`: a trigger or note the daemon wrote into the Background activity chat (D-027). */
export const MessageSource = z.literal('background');
export const StoredUserMessage = z.object({ text: z.string(), source: MessageSource.optional() });
export type StoredUserMessage = z.infer<typeof StoredUserMessage>;

export const ToolNote = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
  /** What the tool was asked, shortened. For the UI only; replay shows names. */
  input: z.string().optional(),
});
export type ToolNote = z.infer<typeof ToolNote>;

export const StoredAssistantMessage = z.object({
  text: z.string(),
  tools: z.array(ToolNote).default([]),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  source: MessageSource.optional(),
});
export type StoredAssistantMessage = z.infer<typeof StoredAssistantMessage>;

/** Messages replayed per turn; older ones drop off so a long chat stays inside the budget. */
export const HISTORY_LIMIT = 40;

/** The text a stored message renders as, for the UI and for replay. Unknown shapes are ''. */
export function storedText(m: Pick<Message, 'role' | 'content'>): string {
  const schema = m.role === 'assistant' ? StoredAssistantMessage : StoredUserMessage;
  const parsed = schema.safeParse(m.content);
  return parsed.success ? parsed.data.text : '';
}

/** `background` for a message the daemon wrote into the Background activity chat (D-027). */
export function storedSource(m: Pick<Message, 'role' | 'content'>): 'background' | undefined {
  const schema = m.role === 'assistant' ? StoredAssistantMessage : StoredUserMessage;
  const parsed = schema.safeParse(m.content);
  return parsed.success ? parsed.data.source : undefined;
}

/** The tools a stored assistant turn called, for the UI's chips. */
export function storedTools(m: Pick<Message, 'role' | 'content'>): ToolNote[] {
  if (m.role !== 'assistant') return [];
  const parsed = StoredAssistantMessage.safeParse(m.content);
  return parsed.success ? parsed.data.tools : [];
}

/** Why a stored assistant turn failed, for the UI; undefined for a finished reply. */
export function storedError(
  m: Pick<Message, 'role' | 'content'>,
): { code: string; message: string } | undefined {
  if (m.role !== 'assistant') return undefined;
  const parsed = StoredAssistantMessage.safeParse(m.content);
  return parsed.success ? parsed.data.error : undefined;
}

/** One assistant turn as the model will see it next time: its notes, then what it said. */
function replayAssistant(m: Message): string {
  const parsed = StoredAssistantMessage.safeParse(m.content);
  if (!parsed.success) return '';
  const { text, tools, error } = parsed.data;
  const notes: string[] = [];
  if (tools.length > 0) {
    notes.push(
      `Tools called: ${tools.map((t) => `${t.name} (${t.ok ? 'ok' : 'error'})`).join(', ')}.`,
    );
  }
  if (m.planIds.length > 0) notes.push(`Proposals made: ${m.planIds.join(', ')}.`);
  if (error !== undefined)
    notes.push(`This turn failed (${error.code}); the reply was not finished.`);
  const head = notes.length === 0 ? '' : `<turn_notes>${notes.join(' ')}</turn_notes>\n`;
  return `${head}${text}`.trim();
}

/**
 * Stored messages → the Anthropic `messages` array. The API needs a user message first and
 * strict alternation; a failed turn can leave two user messages in a row, so consecutive
 * same-role messages are merged and a leading assistant message is dropped.
 */
export function replayHistory(stored: readonly Message[]): BaseParams['messages'][number][] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of stored) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const raw = m.role === 'user' ? storedText(m) : replayAssistant(m);
    // A background trigger is not something Ben said: say so to the model.
    const text =
      m.role === 'user' && raw !== '' && storedSource(m) === 'background'
        ? `[Background event, not a message from Ben] ${raw}`
        : raw;
    if (text === '') continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === m.role) last.content = `${last.content}\n\n${text}`;
    else if (out.length > 0 || m.role === 'user') out.push({ role: m.role, content: text });
  }
  return out;
}

/**
 * Live context for this turn only, put ahead of Ben's newest message: what is already filed
 * (`<decisions>`). It changes every turn, so it rides on the new message rather than the
 * system prompt (which stays cacheable) and is never stored, so replays never show stale state.
 */
export function withTurnContext(
  messages: BaseParams['messages'][number][],
  context: string,
): BaseParams['messages'][number][] {
  const last = messages[messages.length - 1];
  if (
    context === '' ||
    last === undefined ||
    last.role !== 'user' ||
    typeof last.content !== 'string'
  ) {
    return messages;
  }
  return [...messages.slice(0, -1), { role: 'user', content: `${context}\n\n${last.content}` }];
}
