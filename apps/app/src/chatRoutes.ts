import { ChatRequest, type ChatEvent } from '@fha/api';
import { runAssistantTurn, storedError, storedText, type AssistantDeps } from '@fha/agents';
import { cardFor, type CardContext } from './decisionCard.js';
import { HttpError, readJson, sendJson } from './http.js';
import type { Route } from './router.js';
import { cardContext, type Services } from './services.js';
import { assistantDeps, llmFor } from './chatRuntime.js';
import { lastSeenSeq, streamTurn } from './chatStream.js';
import { recordSummary, turnSummary, type TurnRun } from './chatTurns.js';

/**
 * Chat with the assistant. `POST /api/chat` starts a durable turn (see `chatTurns.ts`) and
 * streams its events as SSE; a client that lost the stream resumes from its last seq with
 * `GET /api/chat/turns/:turnId/events`. Anything that fails before the turn starts (signed out,
 * Yahoo not connected, no model configured, a turn already running) is an ordinary JSON error.
 *
 * The turn is not tied to the request: a disconnect detaches the stream, and only
 * `POST /api/chat/turns/:turnId/cancel` (or shutdown) aborts the model. Plans already filed stay
 * filed (P7).
 */
export const HEARTBEAT_MS = 15_000;
const TITLE_CHARS = 60;

/** The assistant's events as contract ChatEvents: a filed plan becomes its decision card. */
function assistantRun(
  s: Services,
  deps: AssistantDeps,
  cards: CardContext,
  turn: { conversationId: string; text: string },
): TurnRun {
  return async (emit: (e: ChatEvent) => void, signal) => {
    const r = await runAssistantTurn(deps, {
      ...turn,
      signal,
      emit: (e) => {
        if (e.type === 'plan') {
          const card = cardFor(s.store, e.planId, cards);
          if (card !== undefined) emit({ type: 'decision', card });
        } else if (e.type === 'done') {
          emit({ type: 'done', usage: { costUsd: e.costUsd } });
        } else {
          emit(e);
        }
      },
    });
    return r.status;
  };
}

function turnRoutes(s: Services, heartbeatMs: number): Route[] {
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
        // From here to `start` is synchronous, so two sends cannot both pass this check.
        const busy = existing === undefined ? undefined : s.chatTurns.runningIn(existing.id);
        if (busy !== undefined) {
          sendJson(res, 409, {
            error: {
              code: 'turn_in_progress',
              message: 'A reply is still being written in this chat.',
              turnId: busy.id,
            },
          });
          return;
        }
        const conversation =
          existing ?? s.store.conversations.create(user.id, body.text.slice(0, TITLE_CHARS));
        const deps = assistantDeps(s, user.id, league, llmFor(s.store, s.createMessage));
        const cards = {
          ...cardContext(s, user.id),
          name: (k: string) => league.view.player(k)?.name ?? k,
        };
        const turn = s.chatTurns.start({
          userId: user.id,
          conversationId: conversation.id,
          run: assistantRun(s, deps, cards, { conversationId: conversation.id, text: body.text }),
        });
        streamTurn(s.chatTurns, turn, 0, res, heartbeatMs);
      },
    },
    {
      method: 'GET',
      path: '/api/chat/turns',
      auth: 'user',
      handle: ({ res, url, user }) => {
        const status = url.searchParams.get('status') ?? 'running';
        if (status !== 'running' && status !== 'all') {
          throw new HttpError(400, 'invalid_request', 'status must be running or all');
        }
        sendJson(res, 200, { turns: s.chatTurns.list(user.id, status).map(turnSummary) });
        return Promise.resolve();
      },
    },
    {
      method: 'GET',
      path: '/api/chat/turns/:turnId/events',
      auth: 'user',
      handle: ({ req, res, url, params, user }) => {
        const id = params['turnId'] ?? '';
        const turn = s.chatTurns.get(id, user.id);
        if (turn === undefined) {
          if (s.store.chatTurns.get(id, user.id) !== undefined) {
            throw new HttpError(
              410,
              'turn_gone',
              'That reply has finished; reload the conversation to see it.',
            );
          }
          throw new HttpError(404, 'not_found', 'No such turn.');
        }
        streamTurn(s.chatTurns, turn, lastSeenSeq(req, url), res, heartbeatMs);
        return Promise.resolve();
      },
    },
    {
      method: 'POST',
      path: '/api/chat/turns/:turnId/cancel',
      auth: 'user',
      handle: ({ res, params, user }) => {
        const id = params['turnId'] ?? '';
        const turn = s.chatTurns.cancel(id, user.id);
        if (turn !== undefined) {
          sendJson(res, 200, turnSummary(turn));
          return Promise.resolve();
        }
        const rec = s.store.chatTurns.get(id, user.id);
        if (rec === undefined) throw new HttpError(404, 'not_found', 'No such turn.');
        sendJson(res, 200, recordSummary(rec));
        return Promise.resolve();
      },
    },
  ];
}

function conversationRoutes(s: Services): Route[] {
  return [
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
        const cards = cardContext(s, user.id);
        const messages = s.store.conversations.messages(c.id).flatMap((m) => {
          if (m.role !== 'user' && m.role !== 'assistant') return [];
          const error = storedError(m);
          return [
            {
              id: m.id,
              role: m.role,
              text: storedText(m),
              decisions: m.planIds.flatMap((id) => cardFor(s.store, id, cards) ?? []),
              ...(error === undefined ? {} : { error }),
              createdAt: m.createdAt,
            },
          ];
        });
        sendJson(res, 200, { id: c.id, title: c.title ?? 'New chat', messages });
        return Promise.resolve();
      },
    },
  ];
}

export function chatRoutes(s: Services, heartbeatMs = HEARTBEAT_MS): Route[] {
  return [...turnRoutes(s, heartbeatMs), ...conversationRoutes(s)];
}
