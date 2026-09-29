import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/endpoints';
import { DecisionCardView, isPending } from '../components/DecisionCardView';
import { ErrorNote } from '../components/ErrorNote';

/**
 * Pending first, then history. `/decisions/:planId` (what a push opens) highlights one; a
 * decision too old for the capped list is fetched by id and shown on top.
 */
export function Decisions() {
  const { planId } = useParams();
  const all = useQuery({ queryKey: ['decisions', 'all'], queryFn: () => api.decisions('all') });
  const decisions = all.data?.decisions ?? [];
  const pending = decisions.filter(isPending);
  const history = decisions.filter((d) => !isPending(d));
  const inList = planId ? decisions.some((d) => d.planId === planId) : true;
  const one = useQuery({
    queryKey: ['decision', planId],
    queryFn: () => api.decision(planId ?? ''),
    enabled: Boolean(planId) && all.isSuccess && !inList,
    retry: false,
  });

  useEffect(() => {
    if (!planId || !all.data) return;
    document.getElementById(`plan-${planId}`)?.scrollIntoView({ block: 'center' });
  }, [planId, all.data]);

  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      <h1 className="text-lg font-semibold">Decisions</h1>
      {all.error ? <ErrorNote error={all.error} /> : null}
      {all.isPending ? <p className="text-mut">Loading…</p> : null}
      {one.data ? <DecisionCardView card={one.data} highlight /> : null}
      {one.isError ? (
        <div className="card text-sm text-mut">
          That decision could not be found.{' '}
          <Link className="text-acc" to="/decisions">
            Show all
          </Link>
        </div>
      ) : null}
      {all.data ? (
        <>
          <div className="tag">Waiting for you · {pending.length}</div>
          {pending.length === 0 ? (
            <p className="text-sm text-mut">Nothing needs your approval.</p>
          ) : null}
          {pending.map((d) => (
            <DecisionCardView key={d.planId} card={d} highlight={d.planId === planId} />
          ))}
          <div className="tag mt-3">History</div>
          {history.length === 0 ? <p className="text-sm text-mut">No decisions yet.</p> : null}
          {history.map((d) => (
            <DecisionCardView key={d.planId} card={d} highlight={d.planId === planId} />
          ))}
        </>
      ) : null}
    </div>
  );
}
