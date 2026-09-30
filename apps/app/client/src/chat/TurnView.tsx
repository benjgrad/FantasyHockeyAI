import { useState } from 'react';
import { isMissingKeyCode, isYahooCode, missingKeyMessage } from '../api/client';
import { DecisionCardView } from '../components/DecisionCardView';
import { YahooNeeded } from '../components/ErrorNote';
import { Markdown } from '../markdown/Markdown';
import type { Part, Turn } from './thread';

export function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    const text = turn.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-acc/20 px-3 py-2 whitespace-pre-wrap">
          {text}
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
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-mut border-t-transparent" />
    ) : part.status === 'ok' ? (
      <span className="text-good">✓</span>
    ) : (
      <span className="text-bad">✗</span>
    );
  return (
    <div>
      <button
        className="pill cursor-pointer text-mut hover:text-ink"
        onClick={() => setOpen((o) => !o)}
        disabled={!part.detail}
        aria-expanded={open}
      >
        {icon}
        <span className="font-mono">{part.name}</span>
      </button>
      {open && part.detail ? (
        <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-well p-2 text-xs whitespace-pre-wrap text-soft">
          {part.detail}
        </pre>
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
