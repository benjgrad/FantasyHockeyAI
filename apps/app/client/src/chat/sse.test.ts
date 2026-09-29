import type { ChatEvent } from '@fha/api';
import { describe, expect, it } from 'vitest';
import { CUT_OFF, SseParser, decodeChatEvent, readChatStream, streamChat } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await readChatStream(streamOf(chunks), (e) => events.push(e));
  return events;
}

describe('SseParser', () => {
  it('yields one payload per data line, across chunk boundaries', () => {
    const p = new SseParser();
    expect(p.push('data: {"a"')).toEqual([]);
    expect(p.push(':1}\n\ndata: 2\n')).toEqual(['{"a":1}', '2']);
  });

  it('ignores comments, event and id fields, and blank lines', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\nevent: msg\nid: 4\n\ndata:x\n\n')).toEqual(['x']);
  });

  it('handles CRLF, including a CR split from its LF', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\ndata: b\r\n')).toEqual(['a', 'b']);
  });

  it('flushes a final line without a newline', () => {
    const p = new SseParser();
    expect(p.push('data: last')).toEqual([]);
    expect(p.flush()).toEqual(['last']);
  });
});

describe('decodeChatEvent', () => {
  it('parses a valid event', () => {
    expect(decodeChatEvent('{"type":"text","delta":"hi"}')).toEqual({ type: 'text', delta: 'hi' });
  });

  it('turns junk and unknown shapes into an error event rather than throwing', () => {
    expect(decodeChatEvent('{nope').type).toBe('error');
    expect(decodeChatEvent('{"type":"mystery"}')).toMatchObject({
      type: 'error',
      code: 'bad_event',
    });
  });
});

describe('readChatStream', () => {
  it('decodes a full reply', async () => {
    const events = await collect([
      'data: {"type":"conversation","conversationId":"c1"}\n\n',
      'data: {"type":"text","delta":"Hel"}\n\ndata: {"type":"text","del',
      'ta":"lo"}\n\n',
      'data: {"type":"done","usage":{"costUsd":0.01}}\n\n',
    ]);
    expect(events.map((e) => e.type)).toEqual(['conversation', 'text', 'text', 'done']);
  });

  it('reports truncation when the stream ends without done', async () => {
    const events = await collect(['data: {"type":"text","delta":"Hel"}\n\n']);
    expect(events.at(-1)).toEqual(CUT_OFF);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"text","delta":"é"}\n\ndata: {"type":"done"}\n',
    );
    const cut = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const events: ChatEvent[] = [];
    await readChatStream(stream, (e) => events.push(e));
    expect(events[0]).toEqual({ type: 'text', delta: 'é' });
  });
});

describe('streamChat', () => {
  it('posts with the CSRF header and streams the events', async () => {
    let init: RequestInit | undefined;
    const events: ChatEvent[] = [];
    await streamChat(
      { conversationId: null, text: 'hi' },
      (e) => events.push(e),
      undefined,
      async (_url, i) => {
        init = i;
        return new Response(streamOf(['data: {"type":"done"}\n\n']), { status: 200 });
      },
    );
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['x-fha']).toBe('1');
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('throws the mapped error when the server refuses', async () => {
    const body = JSON.stringify({
      error: { code: 'yahoo_not_connected', message: 'Connect Yahoo' },
    });
    await expect(
      streamChat(
        { conversationId: null, text: 'hi' },
        () => undefined,
        undefined,
        async () => new Response(body, { status: 409 }),
      ),
    ).rejects.toMatchObject({ code: 'yahoo_not_connected' });
  });
});
