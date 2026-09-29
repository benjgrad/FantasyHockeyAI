import { ChatEvent } from '@fha/api';
import { send, type FetchLike } from '../api/client';

/**
 * Streaming `POST /api/chat`. EventSource cannot POST, so this reads the response body with
 * fetch + ReadableStream and parses the `text/event-stream` framing itself.
 *
 * The contract puts one JSON ChatEvent on each `data:` line, so every data line is decoded on
 * its own; `event:`/`id:`/`retry:` fields and `:` comments (keep-alives) are ignored.
 */

/** Incremental line splitter: feed it chunks as they arrive, get complete data payloads out. */
export class SseParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let newline = this.buffer.search(/\r\n|\r|\n/);
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith('\r\n', newline) ? 2 : 1;
      // A lone `\r` at the very end may be the first half of `\r\n`: wait for the next chunk.
      if (this.buffer[newline] === '\r' && width === 1 && newline === this.buffer.length - 1) {
        break;
      }
      this.buffer = this.buffer.slice(newline + width);
      const data = dataOf(line);
      if (data !== null) out.push(data);
      newline = this.buffer.search(/\r\n|\r|\n/);
    }
    return out;
  }

  /** The stream ended: a final line with no newline still counts. */
  flush(): string[] {
    const rest = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    const data = dataOf(rest);
    return data === null ? [] : [data];
  }
}

function dataOf(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const value = line.slice(5);
  return value.startsWith(' ') ? value.slice(1) : value;
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

export const CUT_OFF: ChatEvent = {
  type: 'error',
  code: 'stream_ended',
  message: 'The reply was cut off before it finished.',
};

/** Decodes a whole byte stream into ChatEvents. Ends with `CUT_OFF` if `done` never arrived. */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let finished = false;
  const emit = (payloads: string[]): void => {
    for (const data of payloads) {
      const event = decodeChatEvent(data);
      if (event.type === 'done') finished = true;
      onEvent(event);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    emit(parser.push(decoder.decode(value, { stream: true })));
  }
  emit(parser.push(decoder.decode()));
  emit(parser.flush());
  // A stream that stops without `done` is a truncation, not a short answer (P6).
  if (!finished) onEvent(CUT_OFF);
}

export async function streamChat(
  request: { conversationId: string | null; text: string },
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<void> {
  const response = await send(fetchImpl, '/api/chat', { method: 'POST', body: request, signal });
  if (!response.body) {
    onEvent(CUT_OFF);
    return;
  }
  await readChatStream(response.body, onEvent);
}
