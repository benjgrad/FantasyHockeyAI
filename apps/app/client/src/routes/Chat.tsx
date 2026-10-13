import { useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api/endpoints';
import { useConversationDrawer, useFollowBottom } from '../chat/chatNav';
import { ConversationList } from '../chat/ConversationList';
import { retryText, turnFromMessage, type Turn } from '../chat/thread';
import { TurnView } from '../chat/TurnView';
import { useChatTurns } from '../chat/useChatTurns';
import { rememberConversation } from '../chat/lastConversation';
import { ErrorNote } from '../components/ErrorNote';
import { ArrowDownIcon, MenuIcon, SendIcon, StopIcon } from '../components/icons';
import { chatPrefillFrom } from '../players/sheet';

const SUGGESTIONS = [
  'How’s my lineup today?',
  'Any injuries I need to handle?',
  'Who should I pick up?',
  'Evaluate a trade for ',
];

export function Chat() {
  const { conversationId = null } = useParams();
  const drawer = useConversationDrawer();
  const [text, setText] = useState('');
  // "Ask the GM about him" on a player sheet arrives here with the question in router state.
  const prefill = chatPrefillFrom(useLocation().state);
  useEffect(() => {
    if (prefill) setText(prefill);
  }, [prefill]);
  const {
    live,
    streaming,
    connection,
    sendError,
    createdHere,
    send: sendTurn,
    stop,
  } = useChatTurns(conversationId);
  // A new chat (`/`) doesn't overwrite it: "+ New chat" and then away should still return here.
  useEffect(() => {
    if (conversationId !== null) rememberConversation(conversationId);
  }, [conversationId]);
  const input = useRef<HTMLTextAreaElement>(null);
  // The field grows with what is typed, up to its max-height (then it scrolls), and shrinks
  // back after sending. Measured before paint so it never flickers.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    // border-box: add the borders scrollHeight leaves out, or a one-line field would scroll.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [text]);

  const history = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.conversation(conversationId ?? ''),
    enabled: conversationId !== null && conversationId !== createdHere,
    // Refetched whenever the chat is reopened: turns sent while it was open live only in the
    // component's state, and the server is the record. Not on window focus, which would
    // duplicate a turn still shown live.
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  const turns: Turn[] = [
    ...(conversationId !== createdHere ? (history.data?.messages.map(turnFromMessage) ?? []) : []),
    ...live,
  ];

  const follow = useFollowBottom([turns.length, live]);
  // Retry resends the question behind the latest reply as a new turn (the server keeps the
  // failed one as history); only once that reply has finished.
  const retry = streaming ? undefined : retryText(turns);

  const send = async (message: string) => {
    if (!message.trim() || streaming) return;
    setText('');
    follow.jump();
    // Refused because a reply is still running here: it is reattached; keep the text.
    if (!(await sendTurn(message))) setText(message);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };
  const suggest = (s: string) => {
    if (s.endsWith(' ')) {
      setText(s);
      input.current?.focus();
    } else void send(s);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-64 shrink-0 border-r border-line md:block">
        <ConversationList onPick={() => undefined} />
      </aside>
      {drawer.isOpen ? (
        <div className="fixed inset-0 z-30 md:hidden" onClick={drawer.close} {...drawer.swipe}>
          <div className="absolute inset-0 bg-scrim" />
          <aside
            aria-label="Conversations"
            className="absolute inset-y-0 left-0 w-72 animate-drawer-in border-r border-line bg-bg pt-[env(safe-area-inset-top)]"
            onClick={(e) => e.stopPropagation()}
          >
            <ConversationList onPick={() => undefined} replace />
          </aside>
        </div>
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-line px-1 md:hidden">
          <button className="icon-btn" onClick={drawer.open} aria-label="Conversations">
            <MenuIcon />
          </button>
          <span className="truncate text-sm text-mut">
            {history.data?.title ?? (conversationId ? '' : 'New chat')}
          </span>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={follow.scroller} onScroll={follow.onScroll} className="pane px-3 py-4">
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
              {history.error ? <ErrorNote error={history.error} /> : null}
              {history.isFetching && turns.length === 0 ? (
                <p className="text-mut">Loading…</p>
              ) : null}
              {history.data?.title === 'Background activity' ? (
                <p className="rounded-lg bg-well px-3 py-2 text-xs text-mut">
                  What the agents did without you: scheduled and triggered runs, and every
                  notification. Reply to ask about any of it.{' '}
                  <Link className="text-acc" to="/activity">
                    What they watch →
                  </Link>
                </p>
              ) : null}
              {turns.length === 0 && !history.isFetching ? <Empty onPick={suggest} /> : null}
              {turns.map((t, i) => (
                <TurnView
                  key={t.id}
                  turn={t}
                  {...(i === turns.length - 1 && retry !== undefined
                    ? { onRetry: () => void send(retry) }
                    : {})}
                />
              ))}
              {connection === 'reconnecting' ? (
                <p className="text-xs text-mut" role="status">
                  Reconnecting…
                </p>
              ) : null}
              {sendError ? <ErrorNote error={sendError} /> : null}
              <div ref={follow.bottom} />
            </div>
          </div>
          {follow.behind && turns.length > 0 ? (
            <button
              className="absolute bottom-3 left-1/2 inline-flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-4 text-sm font-semibold text-brand-ink shadow-lg active:scale-95"
              onClick={follow.jump}
            >
              <ArrowDownIcon />
              {streaming ? 'New reply' : 'Latest'}
            </button>
          ) : null}
        </div>

        <form onSubmit={onSubmit} className="border-t border-line p-2">
          {/* The send button sits inside the field, as in every messaging app: the field keeps
              the full width, and nothing beside it shifts when the keyboard opens. */}
          <div className="relative mx-auto max-w-2xl">
            <textarea
              ref={input}
              className="input block max-h-40 min-h-[44px] resize-none rounded-3xl py-2.5 pr-12 pl-4"
              rows={1}
              placeholder="Ask about your team…"
              aria-label="Message"
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {streaming ? (
              <button
                type="button"
                aria-label="Stop"
                title="Stop"
                className="absolute right-1.5 bottom-1.5 inline-flex size-8 items-center justify-center rounded-full border border-line bg-raised text-ink active:scale-95"
                onClick={stop}
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                title="Send"
                className="absolute right-1.5 bottom-1.5 inline-flex size-8 items-center justify-center rounded-full bg-brand text-on-brand transition-opacity active:scale-95 disabled:opacity-30"
                disabled={!text.trim()}
              >
                <SendIcon />
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

function Empty({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="py-8 text-center">
      <div className="text-lg font-semibold">What do you need for your team?</div>
      <p className="mt-1 text-sm text-mut">
        I can read your roster, the matchup and the waiver wire, and propose moves for your
        approval.
      </p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            className="card text-left text-sm hover:border-acc"
            onClick={() => onPick(s)}
          >
            {s.endsWith(' ') ? `${s}…` : s}
          </button>
        ))}
      </div>
    </div>
  );
}
