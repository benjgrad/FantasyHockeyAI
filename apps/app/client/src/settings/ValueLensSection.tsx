import type { Permissions, ValueLens } from '@fha/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';
import { StatTip } from '../components/StatTip';
import { Toggle } from '../components/Toggle';

type Edit = (fn: (draft: Permissions) => void) => void;
type Decision = keyof Permissions['valueLens'];

const DECISIONS: { k: Decision; title: string; body: string }[] = [
  {
    k: 'lineup',
    title: 'Daily lineup',
    body: 'Who starts: expected games today × per-game value.',
  },
  {
    k: 'autoGrab',
    title: 'Auto-grab',
    body: 'Whether an upgrade is worth an add, and whom to drop.',
  },
  { k: 'protected', title: 'Protected players', body: 'Which of ours are the top N by VORP.' },
  { k: 'trades', title: 'Trade search', body: 'Which swaps the trade agent is shown.' },
];

/**
 * Shadow, then switch (D-026): each automated decision values players on the preseason
 * projection or on the rest-of-season one, and always runs the other in shadow. The list below
 * is where they disagreed, so the switch is made on evidence.
 */
export function ValueLensSection({ draft, edit }: { draft: Permissions; edit: Edit }) {
  const report = useQuery({ queryKey: ['shadow'], queryFn: () => api.shadow(14) });
  const set = (k: Decision, lens: ValueLens) => edit((d) => void (d.valueLens[k] = lens));
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="font-semibold">
          <StatTip k="lens">Value lens per decision</StatTip>
        </div>
        <div className="text-xs text-mut">
          On: use the rest-of-season numbers (updated by this season&rsquo;s games). Off: the
          preseason projection. The other lens always runs in shadow, and disagreements are listed
          below.
        </div>
      </div>
      {DECISIONS.map((d) => (
        <div key={d.k} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{d.title}</div>
            <div className="text-xs text-mut">
              {d.body} Now: {draft.valueLens[d.k] === 'preseason' ? 'preseason' : 'rest of season'}.
            </div>
          </div>
          <Toggle
            label={`${d.title}: rest-of-season values`}
            on={draft.valueLens[d.k] === 'rest-of-season'}
            onChange={(on) => set(d.k, on ? 'rest-of-season' : 'preseason')}
          />
        </div>
      ))}
      <div>
        <div className="tag mb-1">Disagreements, last 14 days</div>
        {report.error ? <ErrorNote error={report.error} /> : null}
        {report.data && report.data.rows.length === 0 ? (
          <p className="text-xs text-mut">None yet: both lenses made the same calls.</p>
        ) : null}
        <ul className="flex flex-col gap-1.5 text-xs">
          {report.data?.rows.slice(0, 30).map((r, i) => (
            <li key={`${r.date}-${r.decision}-${i}`} className="rounded-lg bg-well px-2 py-1.5">
              <span className="text-mut">
                {r.date} · {r.decision}
              </span>{' '}
              {r.summary}
              {r.outcome ? <div className="mt-0.5 text-mut">That day: {r.outcome}</div> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
