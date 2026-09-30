import type { ChatEvent } from '@fha/api';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RequestError, describeError } from '../api/client';
import { api } from '../api/endpoints';
import { TurnFollower, type Opener } from './follow';
import type { StreamState } from './resume';
import { CUT_OFF, resumeChat, startChat } from './sse';
import { applyEvent, assistantTurn, userTurn, type Turn } from './thread';

/**
 * The chat page's live turns. A turn runs on the server whatever this page does, so:
 * - leaving the chat only detaches (the reply is stored, and a push says so);
 * - a dropped stream reconnects from the last seq (see `follow.ts`), and coming back to the page
 *   or the network returning reconnects at once;
 * - opening a chat with a running turn reattaches to it;
 * - Stop cancels the turn on the server, not just this page's fetch.
 */
let turnSeq = 0;
const nextId = (): string => `t${(turnSeq += 1)}`;

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

export interface ChatTurns {
  live: Turn[];
  streaming: boolean;
  connection: StreamState;
  sendError: unknown;
  /** The conversation this page created by streaming: its history is already on screen. */
  createdHere: string | null;
  /** False when the message was not sent (a turn is already running here); keep the text. */
  send: (text: string) => Promise<boolean>;
  stop: () => void;
}

export function useChatTurns(conversationId: string | null): ChatTurns {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [live, setLive] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connection, setConnection] = useState<StreamState>('idle');
  const [sendError, setSendError] = useState<unknown>(null);
  const createdHere = useRef<string | null>(null);
  const follower = useRef<TurnFollower | null>(null);
  const detach = useRef<AbortController | null>(null);
  const stopped = useRef(false);

  const follow = useCallback(
    async (reply: string, open: Opener, turnId?: string): Promise<void> => {
      detach.current?.abort();
      const controller = new AbortController();
      detach.current = controller;
      stopped.current = false;
      const apply = (event: ChatEvent) =>
        setLive((l) => l.map((t) => (t.id === reply ? applyEvent(t, event) : t)));
      const f = new TurnFollower({
        open,
        resume: (id, after, signal) => resumeChat(id, after, signal),
        signal: controller.signal,
        ...(turnId === undefined ? {} : { turnId }),
        onState: setConnection,
        onEvent: (event) => {
          if (event.type !== 'turn') return apply(event);
          if (event.conversationId !== conversationId) {
            createdHere.current = event.conversationId;
            void navigate(`/c/${encodeURIComponent(event.conversationId)}`, { replace: true });
          }
        },
      });
      follower.current = f;
      setStreaming(true);
      try {
        const end = await f.run();
        if (end === 'lost') apply(CUT_OFF);
        if (end === 'detached' && stopped.current) {
          apply({ type: 'error', code: 'stopped', message: 'Stopped.' });
        }
        if (end === 'gone') {
          // Its events are gone; the stored conversation has the reply.
          createdHere.current = null;
          setLive([]);
          void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
        }
      } finally {
        if (follower.current === f) {
          follower.current = null;
          setStreaming(false);
          setConnection('idle');
        }
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        void queryClient.invalidateQueries({ queryKey: ['decisions'] });
      }
    },
    [conversationId, navigate, queryClient],
  );

  /** Reattach to this conversation's running turn, if it has one. */
  const reattach = useCallback(
    async (isCurrent: () => boolean = () => true): Promise<void> => {
      if (conversationId === null) return;
      const { turns } = await api.runningTurns();
      const running = turns.find((t) => t.conversationId === conversationId);
      if (running === undefined || !isCurrent()) return;
      const reply = nextId();
      setLive((l) => [...l, assistantTurn(reply)]);
      try {
        await follow(reply, (signal) => resumeChat(running.turnId, 0, signal), running.turnId);
      } catch (error) {
        setLive((l) =>
          l.map((t) =>
            t.id === reply
              ? applyEvent(t, { type: 'error', code: 'failed', message: describeError(error) })
              : t,
          ),
        );
      }
    },
    [conversationId, follow],
  );

  const send = useCallback(
    async (message: string): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed || streaming) return false;
      const mine = nextId();
      const reply = nextId();
      setLive((l) => [...l, userTurn(mine, trimmed), assistantTurn(reply)]);
      setSendError(null);
      try {
        await follow(reply, (signal) => startChat({ conversationId, text: trimmed }, signal));
        return true;
      } catch (error) {
        if (error instanceof RequestError && error.code === 'turn_in_progress') {
          setLive((l) => l.filter((t) => t.id !== mine && t.id !== reply));
          void reattach().catch(() => undefined);
          return false;
        }
        const event: ChatEvent = isAbort(error)
          ? { type: 'error', code: 'stopped', message: 'Stopped.' }
          : {
              type: 'error',
              code: error instanceof RequestError ? error.code : 'failed',
              message: describeError(error),
            };
        setLive((l) => l.map((t) => (t.id === reply ? applyEvent(t, event) : t)));
        if (!isAbort(error) && !(error instanceof RequestError)) setSendError(error);
        return true;
      }
    },
    [conversationId, follow, reattach, streaming],
  );

  const stop = useCallback(() => {
    stopped.current = true;
    const turnId = follower.current?.turnId;
    // Before the turn's id is known there is nothing to cancel on the server yet.
    if (turnId === undefined) {
      detach.current?.abort();
      return;
    }
    api.cancelTurn(turnId).catch(() => detach.current?.abort());
  }, []);

  // Switching conversation detaches from the previous one's turn (it keeps running) and
  // reattaches to the new one's, if any.
  useEffect(() => {
    if (conversationId !== null && conversationId === createdHere.current) return;
    createdHere.current = null;
    detach.current?.abort();
    setLive([]);
    setSendError(null);
    let current = true;
    void reattach(() => current).catch(() => undefined);
    return () => {
      current = false;
    };
    // Only on navigation: `reattach` changes with `conversationId` anyway.
  }, [conversationId]);

  // Back to the page, or back online: a sleeping phone may hold a dead socket.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === 'visible') follower.current?.wake();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      detach.current?.abort();
    };
  }, []);

  return {
    live,
    streaming,
    connection,
    sendError,
    createdHere: createdHere.current,
    send,
    stop,
  };
}
