import type { ChatEvent, DecisionCard } from '@fha/api';

/**
 * What the thread renders, built from ChatEvents by a pure reducer so the streaming logic is
 * tested without a DOM.
 */
export type Part =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      name: string;
      status: 'running' | 'ok' | 'error';
      /** The result (or error). */
      detail?: string;
      /** What the model asked for, as `key: value` lines. */
      input?: string;
    }
  | { kind: 'decision'; card: DecisionCard }
  | { kind: 'error'; code: string; message: string };

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  parts: Part[];
  /** An assistant turn still streaming. */
  pending: boolean;
  /** Written by the daemon into the Background activity chat (D-027), with when. */
  background?: { at: string };
}

export function userTurn(id: string, text: string): Turn {
  return { id, role: 'user', parts: [{ kind: 'text', text }], pending: false };
}

export function assistantTurn(id: string): Turn {
  return { id, role: 'assistant', parts: [], pending: true };
}

/** Applies one event to the streaming assistant turn. `turn` is the caller's concern. */
export function applyEvent(turn: Turn, event: ChatEvent): Turn {
  switch (event.type) {
    case 'turn':
      return turn;
    case 'text':
      return { ...turn, parts: appendText(turn.parts, event.delta) };
    case 'tool':
      return { ...turn, parts: applyTool(turn.parts, event) };
    case 'decision':
      return { ...turn, parts: upsertDecision(turn.parts, event.card) };
    case 'error':
      return {
        ...turn,
        pending: false,
        parts: [
          ...settleTools(turn.parts),
          { kind: 'error', code: event.code, message: event.message },
        ],
      };
    case 'done':
      return { ...turn, pending: false, parts: settleTools(turn.parts) };
  }
}

function appendText(parts: Part[], delta: string): Part[] {
  const last = parts[parts.length - 1];
  if (last?.kind === 'text')
    return [...parts.slice(0, -1), { kind: 'text', text: last.text + delta }];
  return [...parts, { kind: 'text', text: delta }];
}

function applyTool(parts: Part[], event: Extract<ChatEvent, { type: 'tool' }>): Part[] {
  const detail = event.detail === undefined ? {} : { detail: event.detail };
  if (event.status === 'start') {
    const input = event.input === undefined ? {} : { input: event.input };
    return [...parts, { kind: 'tool', name: event.name, status: 'running', ...detail, ...input }];
  }
  const status = event.status;
  // The most recent running call of this tool is the one that finished.
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part?.kind === 'tool' && part.name === event.name && part.status === 'running') {
      const next = [...parts];
      next[i] = { ...part, status, ...detail };
      return next;
    }
  }
  return [...parts, { kind: 'tool', name: event.name, status, ...detail }];
}

function upsertDecision(parts: Part[], card: DecisionCard): Part[] {
  const at = parts.findIndex((p) => p.kind === 'decision' && p.card.planId === card.planId);
  if (at === -1) return [...parts, { kind: 'decision', card }];
  const next = [...parts];
  next[at] = { kind: 'decision', card };
  return next;
}

/** A tool still spinning when the turn ends never reported back: show it as failed. */
function settleTools(parts: Part[]): Part[] {
  return parts.map((p) =>
    p.kind === 'tool' && p.status === 'running' ? { ...p, status: 'error' } : p,
  );
}

/**
 * A stored message as a turn: its tool calls (shortened), text, decisions and why it failed.
 */
export function turnFromMessage(message: {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  decisions: DecisionCard[];
  error?: { code: string; message: string } | undefined;
  tools?: { name: string; ok: boolean; detail?: string; input?: string }[] | undefined;
  source?: 'background' | undefined;
  createdAt?: string;
}): Turn {
  const parts: Part[] = [];
  // The tools ran before the answer was written, so their chips come first.
  for (const t of message.tools ?? []) {
    parts.push({
      kind: 'tool',
      name: t.name,
      status: t.ok ? 'ok' : 'error',
      ...(t.detail === undefined ? {} : { detail: t.detail }),
      ...(t.input === undefined ? {} : { input: t.input }),
    });
  }
  if (message.text) parts.push({ kind: 'text', text: message.text });
  for (const card of message.decisions) parts.push({ kind: 'decision', card });
  if (message.error) parts.push({ kind: 'error', ...message.error });
  const turn: Turn = { id: `m${message.id}`, role: message.role, parts, pending: false };
  return message.source === 'background'
    ? { ...turn, background: { at: message.createdAt ?? '' } }
    : turn;
}

/**
 * What "Retry" resends: the question behind the latest reply, once that reply has finished.
 * Undefined while a reply is streaming, or when the thread does not end with a reply.
 */
export function retryText(turns: readonly Turn[]): string | undefined {
  const last = turns[turns.length - 1];
  // A background reply answered a trigger, not a question: nothing to resend.
  if (last?.role !== 'assistant' || last.pending || last.background !== undefined) return undefined;
  for (let i = turns.length - 2; i >= 0; i -= 1) {
    const t = turns[i];
    if (t?.role === 'user') {
      const text = t.parts
        .map((p) => (p.kind === 'text' ? p.text : ''))
        .join('')
        .trim();
      return text === '' ? undefined : text;
    }
  }
  return undefined;
}

/** True when the turn ended in an error (shown as a red note). */
export function turnFailed(turn: Turn): boolean {
  return turn.parts.some((p) => p.kind === 'error');
}
