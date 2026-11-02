import type { PolicySource } from '@fha/api';

/**
 * How a category's role in the season strategy looks everywhere (D-041): the Team page's plan,
 * the strength panel and the player card show buy / trade from / punt the same way.
 */
export const ROLE_TONE = {
  target: 'border-good/50 text-good',
  surplus: 'border-acc/70 text-acc',
  punt: 'border-bad/60 text-bad',
} as const;

/** The same roles as a text colour, for a category label; neutral is plain. */
export const ROLE_TEXT = {
  target: 'text-good',
  surplus: 'text-acc',
  punt: 'text-bad',
  neutral: '',
} as const;

export function RolePills({
  label,
  cats,
  tone,
  hits = [],
}: {
  label: string;
  cats: readonly string[];
  tone: string;
  /** Categories to tick (a player's target hits). */
  hits?: readonly string[];
}) {
  if (cats.length === 0) return null;
  return (
    <>
      <span className="ml-1 text-xs text-mut">{label}:</span>
      {cats.map((c) => (
        <span key={c} className={`pill ${tone}`}>
          {c}
          {hits.includes(c) ? ' ✓' : ''}
        </span>
      ))}
    </>
  );
}

/** "strategy v3" (with "review overdue" when past its review date), or "code's audit". */
export function PolicySourceTag({ source, today }: { source: PolicySource; today?: string }) {
  if (source.kind === 'audit') {
    return (
      <span className="text-2xs text-mut" title="No season strategy recorded: code's own targets">
        · code’s audit
      </span>
    );
  }
  const day = today ?? new Date().toISOString().slice(0, 10);
  const overdue = source.reviewBy !== null && source.reviewBy < day;
  return (
    <span
      className="text-2xs text-mut"
      title={`Season strategy v${source.id} by ${source.author}, ${source.createdAt.slice(0, 10)}`}
    >
      · strategy v{source.id}
      {overdue ? <span className="text-warn"> · review overdue</span> : null}
    </span>
  );
}
