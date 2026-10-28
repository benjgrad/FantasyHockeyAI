import { useQuery } from '@tanstack/react-query';
import { api, type StrategyViewT } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';

/**
 * The season strategy (D-034): the plan every agent run and chat starts from, as last recorded
 * (by the Monday strategy job, or by chat when Ben agrees a change), beside code's audit of
 * where each category stands now. Earlier versions fold away below.
 */
type Version = StrategyViewT['versions'][number];
type Stance = NonNullable<StrategyViewT['audit']>['categories'][number]['stance'];

const STANCE_TONE: Record<Stance, string> = {
  contested: 'border-warn/60 text-warn',
  saturated: 'border-acc/70 text-acc',
  lost: 'border-bad/60 text-bad',
};

export function StrategyCard() {
  const q = useQuery({ queryKey: ['strategy'], queryFn: api.strategy, staleTime: 60_000 });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return null;
  const { versions, audit, objective } = q.data;
  const [current, ...older] = versions;
  return (
    <section className="card p-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
        <span className="tag">Season strategy{current ? ` · v${current.id}` : ''}</span>
        <span className="text-2xs text-mut">
          {objective === 'winWeek'
            ? 'moves ranked by P(win a week)'
            : 'moves ranked the old way (new measure in shadow)'}
        </span>
      </div>
      {current ? (
        <Plan v={current} />
      ) : (
        <p className="px-3 py-2 text-sm text-mut">
          No strategy recorded yet. The Monday strategy job writes one, or ask chat to.
        </p>
      )}
      {audit ? <Audit audit={audit} /> : null}
      {older.length > 0 ? (
        <details className="border-t border-line px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Earlier versions <span className="text-mut">· {older.length}</span>
          </summary>
          <ul className="mt-1 flex flex-col gap-2">
            {older.map((v) => (
              <li key={v.id} className="text-xs text-soft">
                <b>v{v.id}</b> {v.createdAt.slice(0, 10)} · {v.author} · {v.stance}; targets{' '}
                {list(v.targets)}; surplus {list(v.surplus)}
                {v.changes.length > 0 ? (
                  <span className="text-mut"> · changed: {v.changes.join('; ')}</span>
                ) : null}
                <div className="text-mut">{v.rationale}</div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Plan({ v }: { v: Version }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        <span className="pill border-acc/70 font-semibold text-acc">{v.stance}</span>
        <Pills label="buy" cats={v.targets} tone="border-good/50 text-good" />
        <Pills label="trade from" cats={v.surplus} tone="border-acc/70 text-acc" />
        <Pills label="punt" cats={v.punts} tone="border-bad/60 text-bad" />
      </div>
      {v.principles.length > 0 ? (
        <ul className="list-disc pl-5 text-soft">
          {v.principles.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-soft">{v.rationale}</p>
      <div className="text-2xs text-mut">
        {v.createdAt.slice(0, 10)} · by {v.author}
        {v.reviewBy ? ` · review by ${v.reviewBy}` : ''}
        {v.changes.length > 0 ? ` · changed: ${v.changes.join('; ')}` : ''}
      </div>
    </div>
  );
}

function Pills({ label, cats, tone }: { label: string; cats: string[]; tone: string }) {
  if (cats.length === 0) return null;
  return (
    <>
      <span className="ml-1 text-xs text-mut">{label}:</span>
      {cats.map((c) => (
        <span key={c} className={`pill ${tone}`}>
          {c}
        </span>
      ))}
    </>
  );
}

function Audit({ audit }: { audit: NonNullable<StrategyViewT['audit']> }) {
  const byWeight = [...audit.categories].sort((a, b) => b.weight - a.weight);
  return (
    <div className="border-t border-line px-3 py-2">
      <div className="mb-1 text-xs text-mut">
        Code’s audit now: win a typical week{' '}
        <b className="text-ink">{Math.round(audit.pWinWeek * 100)}%</b> (
        {audit.expectedCats.toFixed(1)} categories). Most valuable to add first:
      </div>
      <div className="flex flex-wrap gap-1">
        {byWeight.map((c) => (
          <span
            key={c.cat}
            className={`pill tabular-nums ${STANCE_TONE[c.stance]}`}
            title={`${c.stance}: we win ${c.cat} ${Math.round(c.pField * 100)}% of weeks; weight ${c.weight.toFixed(2)}`}
          >
            {c.cat} ×{c.weight.toFixed(1)}
          </span>
        ))}
      </div>
      <div className="mt-1 text-2xs text-mut">
        ×weight = what one more starter’s worth does for the week (1 = average).{' '}
        <span className="text-warn">contested</span> · <span className="text-acc">saturated</span> ·{' '}
        <span className="text-bad">lost</span>
      </div>
    </div>
  );
}

const list = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(', '));
