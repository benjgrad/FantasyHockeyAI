import type { ServerResponse } from 'node:http';
import { ChatRequest } from '@fha/api';
import { runAssistantTurn, storedText, type AssistantEvent } from '@fha/agents';
import { cardFor } from './decisions.js';
import { HttpError, readJson, sendJson } from './http.js';
import type { Route } from './router.js';
import { namesFor, type Services } from './services.js';
import { assistantDeps, llmFor } from './chatRuntime.js';

/**
 * Chat with the assistant: `POST /api/chat` streams `ChatEvent`s as server-sent events, one JSON
 * object per `data:` line. Anything that fails before the stream starts (signed out, Yahoo not
 * connected, no model configured) is an ordinary JSON error, so the client can show it.
 *
 * A comment line every 15 s keeps proxies from closing a quiet stream while a specialist runs.
 * When the browser goes away the model call is aborted through its AbortSignal; plans already
 * filed stay filed (P7).
 */
export const HEARTBEAT_MS = 15_000;
const TITLE_CHARS = 60;

type ChatEventOut =
  | { type: 'conversation'; conversationId: string }
  | Exclude<AssistantEvent, { type: 'plan' } | { type: 'done' }>
  | { type: 'decision'; card: NonNullable<ReturnType<typeof cardFor>> }
  | { type: 'done'; usage: { costUsd: number } };

function startStream(res: ServerResponse): (e: ChatEventOut) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx: do not buffer this response.
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  return (e) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
}

export function chatRoutes(s: Services, heartbeatMs = HEARTBEAT_MS): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/chat',
      auth: 'user',
      handle: async ({ req, res, user }) => {
        const body = await readJson(req, ChatRequest);
        if (s.createMessage === undefined) {
          throw new HttpError(
            503,
            'llm_not_configured',
            'Chat is off: ANTHROPIC_API_KEY is not set on the server.',
          );
        }
        // Ownership: another user's conversation id is indistinguishable from an unknown one.
        const existing =
          body.conversationId === null
            ? undefined
            : s.store.conversations.get(body.conversationId, user.id);
        if (body.conversationId !== null && existing === undefined) {
          throw new HttpError(404, 'not_found', 'No such conversation.');
        }
        const league = await s.league.get(user.id);
        const conversation =
          existing ?? s.store.conversations.create(user.id, body.text.slice(0, TITLE_CHARS));
        const deps = assistantDeps(s, user.id, league, llmFor(s.store, s.createMessage));

        const send = startStream(res);
        const abort = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) abort.abort(new Error('client disconnected'));
        });
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': ping\n\n');
        }, heartbeatMs);
        const names = (k: string) => league.view.player(k)?.name ?? k;
        send({ type: 'conversation', conversationId: conversation.id });
        try {
          await runAssistantTurn(deps, {
            conversationId: conversation.id,
            text: body.text,
            signal: abort.signal,
            emit: (e) => {
              if (e.type === 'plan') {
                const card = cardFor(s.store, e.planId, names);
                if (card !== undefined) send({ type: 'decision', card });
              } else if (e.type === 'done') {
                send({ type: 'done', usage: { costUsd: e.costUsd } });
              } else {
                send(e);
              }
            },
          });
        } finally {
          clearInterval(heartbeat);
          res.end();
        }
      },
    },
    {
      method: 'GET',
      path: '/api/conversations',
      auth: 'user',
      handle: ({ res, user }) => {
        const conversations = s.store.conversations.list(user.id, 50).map((c) => ({
          id: c.id,
          title: c.title ?? 'New chat',
          updatedAt: c.updatedAt,
        }));
        sendJson(res, 200, { conversations });
        return Promise.resolve();
      },
    },
    {
      method: 'GET',
      path: '/api/conversations/:id',
      auth: 'user',
      handle: ({ res, params, user }) => {
        const c = s.store.conversations.get(params['id'] ?? '', user.id);
        if (c === undefined) throw new HttpError(404, 'not_found', 'No such conversation.');
        const names = namesFor(s, user.id);
        const messages = s.store.conversations.messages(c.id).flatMap((m) =>
          m.role === 'user' || m.role === 'assistant'
            ? [
                {
                  id: m.id,
                  role: m.role,
                  text: storedText(m),
                  decisions: m.planIds.flatMap((id) => cardFor(s.store, id, names) ?? []),
                  createdAt: m.createdAt,
                },
              ]
            : [],
        );
        sendJson(res, 200, { id: c.id, title: c.title ?? 'New chat', messages });
        return Promise.resolve();
      },
    },
  ];
}
