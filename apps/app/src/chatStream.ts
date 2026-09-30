import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatTurns, LiveTurn } from './chatTurns.js';

/**
 * One HTTP observer of a chat turn, as server-sent events: `id: <seq>` then one JSON ChatEvent
 * on a `data:` line. A comment line every `heartbeatMs` keeps proxies from closing a quiet
 * stream while a specialist runs.
 *
 * The stream only *watches*: when the browser goes away the listener is detached and the turn
 * carries on (its reply is stored, and a push says so if nobody is watching at the end).
 */
export function streamTurn(
  turns: ChatTurns,
  turn: LiveTurn,
  after: number,
  res: ServerResponse,
  heartbeatMs: number,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx: do not buffer this response.
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, heartbeatMs);
  let detach: () => void = () => undefined;
  const stop = (): void => {
    clearInterval(heartbeat);
    detach();
  };
  res.on('close', stop);
  detach = turns.attach(turn, after, {
    event: ({ seq, event }) => {
      if (!res.writableEnded) res.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    end: () => {
      stop();
      if (!res.writableEnded) res.end();
    },
  });
}

/**
 * The seq a resuming client last saw: the `Last-Event-ID` header (what EventSource sends), else
 * `?after=`. Anything unreadable is 0, which replays the whole turn — safe, since the client
 * de-duplicates by seq.
 */
export function lastSeenSeq(req: IncomingMessage, url: URL): number {
  const header = req.headers['last-event-id'];
  const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('after') ?? '';
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
