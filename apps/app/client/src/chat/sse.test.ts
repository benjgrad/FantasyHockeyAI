import type { ChatEvent } from '@fha/api';
import { describe, expect, it } from 'vitest';
import { SseParser, decodeChatEvent, readChatStream, resumeChat, startChat } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(
  chunks: string[],
): Promise<{ events: [ChatEvent, number | undefined][]; done: boolean }> {
  const events: [ChatEvent, number | undefined][] = [];
  const { done } = await readChatStream(streamOf(chunks), (e, seq) => events.push([e, seq]));
  return { events, done };
}

describe('SseParser', () => {
  it('yields one frame per blank-line-terminated block, across chunk boundaries', () => {
    const p = new SseParser();
    expect(p.push('id: 1\ndata: {"a"')).toEqual([]);
    expect(p.push(':1}\n\ndata: 2\n\n')).toEqual([
      { id: '1', data: '{"a":1}' },
      { id: undefined, data: '2' },
    ]);
  });

  it('ignores comments and unknown fields; the id belongs to its own frame only', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\n\nevent: msg\nid: 4\n\ndata:x\n\n')).toEqual([
      { id: undefined, data: 'x' },
    ]);
  });

  it('handles CRLF, including a CR split from its LF', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\n\r\ndata: b\r\n\r\n')).toEqual([
      { id: undefined, data: 'a' },
      { id: undefined, data: 'b' },
    ]);
  });

  it('flushes a final frame without its blank line', () => {
    const p = new SseParser();
    expect(p.push('id: 9\ndata: last')).toEqual([]);
    expect(p.flush()).toEqual([{ id: '9', data: 'last' }]);
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
  it("decodes a full reply with each event's seq", async () => {
    const { events, done } = await collect([
      'id: 1\ndata: {"type":"turn","turnId":"t1","conversationId":"c1"}\n\n',
      'id: 2\ndata: {"type":"text","delta":"Hel"}\n\nid: 3\ndata: {"type":"text","del',
      'ta":"lo"}\n\n',
      ': ping\n\nid: 4\ndata: {"type":"done","usage":{"costUsd":0.01}}\n\n',
    ]);
    expect(events.map(([e, seq]) => `${e.type}:${seq}`)).toEqual([
      'turn:1',
      'text:2',
      'text:3',
      'done:4',
    ]);
    expect(done).toBe(true);
  });

  it('reports a stream that ends without done (P6)', async () => {
    const { done } = await collect(['id: 1\ndata: {"type":"text","delta":"Hel"}\n\n']);
    expect(done).toBe(false);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"text","delta":"é"}\n\ndata: {"type":"done"}\n\n',
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

describe('startChat / resumeChat', () => {
  it('posts with the CSRF header', async () => {
    let init: RequestInit | undefined;
    await startChat({ conversationId: null, text: 'hi' }, undefined, async (_url, i) => {
      init = i;
      return new Response(streamOf(['data: {"type":"done"}\n\n']), { status: 200 });
    });
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['x-fha']).toBe('1');
  });

  it('throws the mapped error when the server refuses', async () => {
    const body = JSON.stringify({
      error: { code: 'yahoo_not_connected', message: 'Connect Yahoo' },
    });
    await expect(
      startChat(
        { conversationId: null, text: 'hi' },
        undefined,
        async () => new Response(body, { status: 409 }),
      ),
    ).rejects.toMatchObject({ code: 'yahoo_not_connected' });
  });

  it('resumes after a seq with a GET', async () => {
    let url = '';
    await resumeChat('t 1', 7, undefined, async (u) => {
      url = u;
      return new Response('', { status: 200 });
    });
    expect(url).toBe('/api/chat/turns/t%201/events?after=7');
  });
});
