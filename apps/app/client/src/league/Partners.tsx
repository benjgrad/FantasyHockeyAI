import { Link } from 'react-router-dom';
import type { LeagueCompareT } from './api';

/** Teams most complementary to us first: strong where we are weak, weak where we are strong. */
export function Partners({ data }: { data: LeagueCompareT }) {
  return (
    <section className="card p-0">
      <div className="tag border-b border-line px-3 py-2">Trade partners · best fit first</div>
      {data.partners.map((p) => (
        <Link
          key={p.teamKey}
          to={`/league/${encodeURIComponent(p.teamKey)}`}
          className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 hover:bg-raised"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{p.name}</div>
            <div className="text-xs text-mut">{p.reason}</div>
          </div>
          <span className="text-xs tabular-nums text-soft" title="Complementarity score">
            {p.complementarity.toFixed(1)}
          </span>
        </Link>
      ))}
    </section>
  );
}
