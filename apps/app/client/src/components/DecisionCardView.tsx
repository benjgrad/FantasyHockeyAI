import type { DecisionCard } from '@fha/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import { ErrorNote } from './ErrorNote';

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
};

export function isPending(card: DecisionCard): boolean {
  return card.status === 'pending';
}

/**
 * One plan waiting for (or past) Ben's decision. Approve / Reject call the decisions API and
 * update the card in place; "Why?" shows the agent's rationale and the gate's reasons.
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
  const [card, setCard] = useState(initial);
  const [why, setWhy] = useState(highlight);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => setCard(initial), [initial]);

  const decide = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      action === 'approve'
        ? api.approve(card.planId)
        : api.reject(card.planId, reason.trim() || undefined),
    onSuccess: (next) => {
      setCard(next);
      setRejecting(false);
      void queryClient.invalidateQueries({ queryKey: ['decisions'] });
    },
  });

  const pending = isPending(card);
  return (
    <div
      id={`plan-${card.planId}`}
      className={`card ${pending ? 'border-warn/60' : ''} ${highlight ? 'ring-2 ring-acc' : ''}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="tag">
          {card.kind} · {card.agent}
        </span>
        <span
          className={`text-xs font-semibold uppercase ${STATUS_STYLE[card.status] ?? 'text-mut'}`}
        >
          {card.status}
        </span>
      </div>
      <div className="mt-1 font-medium">{card.summary}</div>
      {card.deadline && pending ? (
        <div className="mt-0.5 text-xs text-mut">Decide by {formatWhen(card.deadline)}</div>
      ) : null}
      {card.result ? <div className="mt-1 text-sm text-soft">{card.result}</div> : null}

      {why ? (
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
      ) : null}

      {rejecting ? (
        <input
          className="input mt-2"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      ) : null}
      {decide.error ? (
        <div className="mt-2">
          <ErrorNote error={decide.error} />
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {pending && !rejecting ? (
          <>
            <button
              className="btn btn-primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate('approve')}
            >
              {decide.isPending ? 'Working…' : 'Approve'}
            </button>
            <button className="btn" disabled={decide.isPending} onClick={() => setRejecting(true)}>
              Reject
            </button>
          </>
        ) : null}
        {pending && rejecting ? (
          <>
            <button
              className="btn btn-danger"
              disabled={decide.isPending}
              onClick={() => decide.mutate('reject')}
            >
              Confirm reject
            </button>
            <button className="btn" onClick={() => setRejecting(false)}>
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
