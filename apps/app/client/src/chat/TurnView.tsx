import { useState } from 'react';
import { isMissingKeyCode, isYahooCode, missingKeyMessage } from '../api/client';
import { DecisionCardView } from '../components/DecisionCardView';
import { YahooNeeded } from '../components/ErrorNote';
import { Markdown } from '../markdown/Markdown';
import { LinkedText } from '../mentions/Mention';
import { RetryIcon } from '../components/icons';
import { turnFailed, type Part, type Turn } from './thread';
import { inputPreview, toolLabel } from './toolLabels';

/** `onRetry`: given only to the latest finished reply; resends the question behind it. */
export function TurnView({ turn, onRetry }: { turn: Turn; onRetry?: () => void }) {
  if (turn.role === 'user' && turn.background !== undefined) {
    // A trigger the daemon recorded (a schedule slot, a Yahoo change): not something Ben said.
    const text = turn.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
    return (
      <div className="flex items-center gap-2 text-xs text-mut">
        <span className="h-px flex-1 bg-line" />
        <span className="max-w-[85%] text-center">
          {text}
          {turn.background.at ? <span className="ml-1">· {timeOf(turn.background.at)}</span> : null}
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }
  if (turn.role === 'user') {
    const text = turn.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-acc/20 px-3 py-2 whitespace-pre-wrap">
          <LinkedText text={text} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex max-w-full flex-col gap-2">
      {turn.parts.map((part, i) => (
        <PartView key={i} part={part} streaming={turn.pending && i === turn.parts.length - 1} />
      ))}
      {turn.pending ? <Typing /> : null}
      {onRetry ? <RetryButton failed={turnFailed(turn)} onRetry={onRetry} /> : null}
    </div>
  );
}

/** Ask the same question again: prominent after a failure, quiet otherwise. */
function RetryButton({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onRetry}
        className={
          failed
            ? 'btn btn-sm inline-flex items-center gap-1.5'
            : 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-mut hover:text-ink'
        }
      >
        <RetryIcon />
        {failed ? 'Try again' : 'Retry'}
      </button>
    </div>
  );
}

/** `streaming`: the text part still receiving deltas (the last part of a pending turn). */
function PartView({ part, streaming }: { part: Part; streaming: boolean }) {
  switch (part.kind) {
    case 'text':
      return <Markdown text={part.text} streaming={streaming} />;
    case 'tool':
      return <ToolChip part={part} />;
    case 'decision':
      return <DecisionCardView card={part.card} compact />;
    case 'error':
      if (isYahooCode(part.code)) return <YahooNeeded code={part.code} />;
      return (
        <div
          role="alert"
          className="rounded-lg border border-bad/50 bg-bad/10 px-3 py-2 text-sm text-soft"
        >
          {isMissingKeyCode(part.code) ? missingKeyMessage : part.message}
        </div>
      );
  }
}

function ToolChip({ part }: { part: Extract<Part, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const icon =
    part.status === 'running' ? (
      <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-mut border-t-transparent" />
    ) : part.status === 'ok' ? (
      <span className="text-good">✓</span>
    ) : (
      <span className="text-bad">✗</span>
    );
  const preview = inputPreview(part.input);
  const hasMore = part.detail !== undefined || part.input !== undefined;
  return (
    <div className="max-w-full">
      <button
        className="pill max-w-full cursor-pointer text-left text-soft hover:text-ink"
        onClick={() => setOpen((o) => !o)}
        disabled={!hasMore}
        aria-expanded={open}
      >
        {icon}
        <span className="font-medium">{toolLabel(part.name)}</span>
        {preview ? <span className="truncate text-mut">· {preview}</span> : null}
        {hasMore ? <span className="text-mut">{open ? '▴' : '▾'}</span> : null}
      </button>
      {open ? (
        <div className="mt-1 space-y-2 rounded-lg bg-well p-2 text-xs text-soft">
          <div className="font-mono text-mut">{part.name}</div>
          {part.input ? (
            <section>
              <div className="tag mb-0.5">Asked</div>
              <pre className="whitespace-pre-wrap">{part.input}</pre>
            </section>
          ) : null}
          {part.detail ? (
            <section>
              <div className="tag mb-0.5">{part.status === 'error' ? 'Error' : 'Result'}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap">{part.detail}</pre>
            </section>
          ) : part.status === 'running' ? (
            <div className="text-mut">Running…</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Typing() {
  return (
    <div className="flex gap-1 py-1" aria-label="Thinking">
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-mut"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </div>
  );
}

/** "Fri 10:00 AM" in the browser's zone. */
function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
