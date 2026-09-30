import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { api } from '../api/endpoints';
import { ConversationList } from '../chat/ConversationList';
import { turnFromMessage, type Turn } from '../chat/thread';
import { TurnView } from '../chat/TurnView';
import { useChatTurns } from '../chat/useChatTurns';
import { ErrorNote } from '../components/ErrorNote';
import { chatPrefillFrom } from '../players/sheet';

const SUGGESTIONS = [
  'How’s my lineup today?',
  'Any injuries I need to handle?',
  'Who should I pick up?',
  'Evaluate a trade for ',
];

export function Chat() {
  const { conversationId = null } = useParams();
  const [drawer, setDrawer] = useState(false);
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
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const history = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.conversation(conversationId ?? ''),
    enabled: conversationId !== null && conversationId !== createdHere,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const turns: Turn[] = [
    ...(conversationId !== createdHere ? (history.data?.messages.map(turnFromMessage) ?? []) : []),
    ...live,
  ];

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, live]);

  const send = async (message: string) => {
    if (!message.trim() || streaming) return;
    setText('');
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
      {drawer ? (
        <div className="fixed inset-0 z-30 md:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <aside
            className="absolute inset-y-0 left-0 w-72 border-r border-line bg-bg pt-[env(safe-area-inset-top)]"
            onClick={(e) => e.stopPropagation()}
          >
            <ConversationList onPick={() => setDrawer(false)} />
          </aside>
        </div>
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 md:hidden">
          <button
            className="btn px-2 py-1"
            onClick={() => setDrawer(true)}
            aria-label="Conversations"
          >
            ☰
          </button>
          <span className="truncate text-sm text-mut">
            {history.data?.title ?? (conversationId ? '' : 'New chat')}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {history.error ? <ErrorNote error={history.error} /> : null}
            {history.isFetching && turns.length === 0 ? <p className="text-mut">Loading…</p> : null}
            {turns.length === 0 && !history.isFetching ? <Empty onPick={suggest} /> : null}
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} />
            ))}
            {connection === 'reconnecting' ? (
              <p className="text-xs text-mut" role="status">
                Reconnecting…
              </p>
            ) : null}
            {sendError ? <ErrorNote error={sendError} /> : null}
            <div ref={bottom} />
          </div>
        </div>

        <form onSubmit={onSubmit} className="border-t border-line p-2">
          <div className="mx-auto flex max-w-2xl items-end gap-2">
            <textarea
              ref={input}
              className="input max-h-40 min-h-[44px] resize-none"
              rows={1}
              placeholder="Ask about your team…"
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {streaming ? (
              <button type="button" className="btn h-[44px]" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary h-[44px]" disabled={!text.trim()}>
                Send
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
