import type { DecisionActionResult, DecisionCard } from '@fha/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import { ErrorNote } from './ErrorNote';
import { LinkedSummary } from '../players/LinkedSummary';
import {
  autoApproveLine,
  changesRoster,
  confirmLines,
  needsYou,
  resultView,
  type Tone,
} from './decisionActions';

const STATUS_STYLE: Record<string, string> = {
  pending: 'text-warn',
  approved: 'text-good',
  executed: 'text-good',
  rejected: 'text-mut',
  expired: 'text-mut',
  failed: 'text-bad',
  denied: 'text-bad',
  invalid: 'text-bad',
  proposed: 'text-acc',
  unverified: 'text-warn',
  dry_run: 'text-acc',
};

type Act = 'execute' | 'dismiss' | 'done' | 'approve' | 'reject';

/**
 * One plan waiting for (or past) Ben's decision, with what he can do about it (D-015): **Do it**
 * (a confirm step, then the move in Yahoo — even with dry run on), **Open in Yahoo**, **I did it**
 * (the server re-reads Yahoo before believing it) and **Dismiss** / **Reject**. The server
 * decides which apply (`card.actions`); results show in place. The same card renders in chat
 * and on the Decisions page. An ask with timeout (D-018) also shows a live countdown to the
 * moment it happens on its own, and its "Do it" reads "Do it now".
 */
export function DecisionCardView({
  card: initial,
  highlight = false,
  compact = false,
}: {
  card: DecisionCard;
  highlight?: boolean;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 60_000 });
  const [card, setCard] = useState(initial);
  const [why, setWhy] = useState(highlight);
  const [mode, setMode] = useState<'idle' | 'confirming' | 'rejecting'>('idle');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<DecisionActionResult | null>(null);
  useEffect(() => setCard(initial), [initial]);

  const act = useMutation({
    mutationFn: async (a: Act): Promise<DecisionActionResult | DecisionCard> => {
      const note = reason.trim() || undefined;
      switch (a) {
        case 'execute':
          return api.execute(card.planId);
        case 'dismiss':
          return api.dismiss(card.planId, note);
        case 'done':
          return api.done(card.planId);
        case 'approve':
          return api.approve(card.planId);
        case 'reject':
          return api.reject(card.planId, note);
      }
    },
    onSuccess: (next) => {
      const r = 'outcome' in next ? next : null;
      setCard(r?.card ?? (next as DecisionCard));
      setResult(r);
      setMode('idle');
      void queryClient.invalidateQueries({ queryKey: ['decisions'] });
      if (r !== null && changesRoster(r))
        void queryClient.invalidateQueries({ queryKey: ['team'] });
    },
  });

  const open = needsYou(card);
  return (
    <div
      id={`plan-${card.planId}`}
      className={`card ${open ? 'border-warn/60' : ''} ${highlight ? 'ring-2 ring-acc' : ''}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="tag">
          {card.kind} · {card.agent}
        </span>
        <span
          className={`text-xs font-semibold uppercase ${STATUS_STYLE[card.status] ?? 'text-mut'}`}
        >
          {card.status === 'dry_run' ? 'proposed' : card.status}
        </span>
      </div>
      <div className="mt-1 font-medium">
        <LinkedSummary
          planId={card.planId}
          text={card.summary}
          load={open || highlight || compact || why}
        />
      </div>
      <AutoApproveCountdown card={card} dryRun={me.data?.dryRun ?? false} />
      {card.deadline && open ? (
        <div className="mt-0.5 text-xs text-mut">Decide by {formatWhen(card.deadline)}</div>
      ) : null}
      {card.result && result === null ? (
        <div className="mt-1 text-sm text-soft">{card.result}</div>
      ) : null}
      {result ? <ResultNote result={result} /> : null}
      {why ? <WhyPanel card={card} /> : null}

      {mode === 'confirming' ? (
        <ConfirmStep
          lines={confirmLines(card, me.data?.dryRun ?? false)}
          busy={act.isPending}
          onConfirm={() => act.mutate('execute')}
          onCancel={() => setMode('idle')}
        />
      ) : null}
      {mode === 'rejecting' ? (
        <input
          className="input mt-2"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      ) : null}
      {act.error ? (
        <div className="mt-2">
          <ErrorNote error={act.error} />
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {mode === 'idle' ? (
          <ActionButtons
            card={card}
            busy={act.isPending}
            onAct={(a) => act.mutate(a)}
            onConfirm={() => setMode('confirming')}
            onReject={() => setMode('rejecting')}
          />
        ) : null}
        {mode === 'rejecting' ? (
          <>
            <button
              className="btn btn-danger"
              disabled={act.isPending}
              onClick={() => act.mutate(card.actions.includes('reject') ? 'reject' : 'dismiss')}
            >
              {card.actions.includes('reject') ? 'Confirm reject' : 'Confirm dismiss'}
            </button>
            <button className="btn" onClick={() => setMode('idle')}>
              Cancel
            </button>
          </>
        ) : null}
        <button className="btn" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
          {why ? 'Hide why' : 'Why?'}
        </button>
        {compact ? (
          <Link
            className="ml-auto text-xs text-acc"
            to={`/decisions/${encodeURIComponent(card.planId)}`}
          >
            Open
          </Link>
        ) : (
          <span className="ml-auto text-xs text-mut">{formatWhen(card.createdAt)}</span>
        )}
      </div>
    </div>
  );
}

/** The buttons the server said this card offers, primary first. */
function ActionButtons({
  card,
  busy,
  onAct,
  onConfirm,
  onReject,
}: {
  card: DecisionCard;
  busy: boolean;
  onAct: (a: Act) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const has = (a: DecisionCard['actions'][number]) => card.actions.includes(a);
  return (
    <>
      {has('execute') ? (
        <button className="btn btn-primary" disabled={busy} onClick={onConfirm}>
          {card.autoApproveAt === null ? 'Do it' : 'Do it now'}
        </button>
      ) : null}
      {has('approve') ? (
        <button className="btn btn-primary" disabled={busy} onClick={() => onAct('approve')}>
          {busy ? 'Working…' : 'Approve'}
        </button>
      ) : null}
      {has('openInYahoo') && card.yahooUrl ? (
        <a className="btn" href={card.yahooUrl} target="_blank" rel="noopener noreferrer">
          Open in Yahoo ↗
        </a>
      ) : null}
      {has('done') ? (
        <button className="btn" disabled={busy} onClick={() => onAct('done')}>
          {busy ? 'Checking Yahoo…' : 'I did it'}
        </button>
      ) : null}
      {has('reject') || has('dismiss') ? (
        <button className="btn" disabled={busy} onClick={onReject}>
          {has('reject') ? 'Reject' : 'Dismiss'}
        </button>
      ) : null}
    </>
  );
}

/** "Happens at 10:45 unless you reject · in 12 min", re-rendered every 15 s (D-018). */
function AutoApproveCountdown({ card, dryRun }: { card: DecisionCard; dryRun: boolean }) {
  const [now, setNow] = useState(() => new Date());
  const timed = card.autoApproveAt !== null && card.status === 'pending';
  useEffect(() => {
    if (!timed) return undefined;
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, [timed]);
  const line = autoApproveLine(card, now, dryRun);
  if (line === null) return null;
  return (
    <div
      className={`mt-1 text-sm font-medium ${line.due ? 'text-warn' : 'text-acc'}`}
      role="timer"
      aria-live="off"
    >
      {line.text}
    </div>
  );
}

function ConfirmStep({
  lines,
  busy,
  onConfirm,
  onCancel,
}: {
  lines: string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [question, ...notes] = lines;
  return (
    <div className="mt-2 rounded-lg border border-acc/50 bg-well p-2 text-sm" role="alertdialog">
      <div className="font-medium">{question}</div>
      {notes.map((n) => (
        <div key={n} className="mt-0.5 text-soft">
          {n}
        </div>
      ))}
      <div className="mt-2 flex gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working in Yahoo…' : 'Yes, do it'}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const TONE: Record<Tone, string> = {
  good: 'border-good/60 text-good',
  warn: 'border-warn/60 text-warn',
  bad: 'border-bad/60 text-bad',
  mut: 'border-line text-mut',
};

function ResultNote({ result }: { result: DecisionActionResult }) {
  const v = resultView(result);
  return (
    <div className={`mt-2 rounded-lg border p-2 text-sm ${TONE[v.tone]}`} role="status">
      <div className="font-semibold">{v.title}</div>
      <div className="mt-0.5 text-soft">{v.message}</div>
    </div>
  );
}

function WhyPanel({ card }: { card: DecisionCard }) {
  return (
    <div className="mt-2 rounded-lg bg-well p-2 text-sm">
      <div className="text-soft whitespace-pre-wrap">{card.rationale}</div>
      {card.gateReasons.length > 0 ? (
        <>
          <div className="tag mt-2">Why it needs you</div>
          <ul className="mt-1 list-disc pl-5 text-soft">
            {card.gateReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
