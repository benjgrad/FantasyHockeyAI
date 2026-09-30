import { ChatEvent } from '@fha/api';
import { send, type FetchLike } from '../api/client';

/**
 * Reading a chat turn's `text/event-stream`. EventSource cannot POST, so this reads the
 * response body with fetch + ReadableStream and parses the SSE framing itself.
 *
 * The contract sends one frame per event: `id: <seq>` then one JSON ChatEvent on a `data:`
 * line, ended by a blank line. `:` comments (keep-alives) and other fields are ignored.
 */

export interface SseFrame {
  /** The frame's `id:` (a turn's seq), when it had one. */
  id: string | undefined;
  data: string;
}

/** Incremental SSE parser: feed it chunks as they arrive, get complete frames out. */
export class SseParser {
  private buffer = '';
  private id: string | undefined;
  private data: string[] = [];

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const out: SseFrame[] = [];
    let newline = this.buffer.search(/\r\n|\r|\n/);
    while (newline !== -1) {
      const width = this.buffer.startsWith('\r\n', newline) ? 2 : 1;
      // A lone `\r` at the very end may be the first half of `\r\n`: wait for the next chunk.
      if (this.buffer[newline] === '\r' && width === 1 && newline === this.buffer.length - 1) {
        break;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + width);
      const frame = this.line(line);
      if (frame !== undefined) out.push(frame);
      newline = this.buffer.search(/\r\n|\r|\n/);
    }
    return out;
  }

  /** The stream ended: a last frame without its blank line still counts. */
  flush(): SseFrame[] {
    const rest = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    const out: SseFrame[] = [];
    if (rest !== '') {
      const frame = this.line(rest);
      if (frame !== undefined) out.push(frame);
    }
    const last = this.line('');
    if (last !== undefined) out.push(last);
    return out;
  }

  private line(line: string): SseFrame | undefined {
    if (line === '') {
      if (this.data.length === 0) {
        this.id = undefined;
        return undefined;
      }
      const frame = { id: this.id, data: this.data.join('\n') };
      this.id = undefined;
      this.data = [];
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    return undefined;
  }
}

/** A data payload as a ChatEvent; anything unreadable becomes an `error` event, never a throw. */
export function decodeChatEvent(data: string): ChatEvent {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { type: 'error', code: 'bad_event', message: 'The server sent an unreadable event.' };
  }
  const parsed = ChatEvent.safeParse(json);
  if (parsed.success) return parsed.data;
  return {
    type: 'error',
    code: 'bad_event',
    message: 'The server sent an event this app does not understand.',
  };
}

/** Shown when the stream is lost for good; the turn itself may still be running on the server. */
export const CUT_OFF: ChatEvent = {
  type: 'error',
  code: 'stream_ended',
  message:
    'Lost the connection before the reply finished. It keeps going on the server — reopen this chat to see it.',
};

function seqOf(id: string | undefined): number | undefined {
  if (id === undefined) return undefined;
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Decodes a byte stream into ChatEvents with their seq. Resolves `{ done }`: whether `done`
 * arrived. A stream that stops without it is not an answer (P6); the caller decides whether to
 * reconnect or report it.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent, seq: number | undefined) => void,
): Promise<{ done: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let done = false;
  const emit = (frames: SseFrame[]): void => {
    for (const f of frames) {
      const event = decodeChatEvent(f.data);
      if (event.type === 'done') done = true;
      onEvent(event, seqOf(f.id));
    }
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    emit(parser.push(decoder.decode(chunk.value, { stream: true })));
  }
  emit(parser.push(decoder.decode()));
  emit(parser.flush());
  return { done };
}

const browserFetch: FetchLike = (input, init) => fetch(input, init);

/** `POST /api/chat`: starts a turn. Throws a RequestError when the server refuses. */
export function startChat(
  request: { conversationId: string | null; text: string },
  signal?: AbortSignal,
  fetchImpl: FetchLike = browserFetch,
): Promise<Response> {
  return send(fetchImpl, '/api/chat', { method: 'POST', body: request, signal });
}

/** `GET /api/chat/turns/:turnId/events?after=`: the turn's events after `after`, then live ones. */
export function resumeChat(
  turnId: string,
  after: number,
  signal?: AbortSignal,
  fetchImpl: FetchLike = browserFetch,
): Promise<Response> {
  const path = `/api/chat/turns/${encodeURIComponent(turnId)}/events?after=${after}`;
  return send(fetchImpl, path, { signal });
}
