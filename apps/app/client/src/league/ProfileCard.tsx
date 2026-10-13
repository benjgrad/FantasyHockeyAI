import type { LeagueCompareT } from './api';
import { fmtWeekly, ordinal } from './helpers';

/** Our strengths and weaknesses, and the cheapest way to fix each weakness (FA vs trade). */
export function ProfileCard({ data }: { data: LeagueCompareT }) {
  const { strengths, weaknesses, weaknessesRelative } = data.profile;
  return (
    <section className="card flex flex-col gap-2">
      <div className="tag">Our profile</div>
      <div className="text-sm">
        <span className="text-mut">Strong: </span>
        {strengths.length === 0
          ? 'nothing in the top two'
          : strengths.map((c) => `${c.cat} (${ordinal(c.rank)})`).join(', ')}
      </div>
      <div className="text-sm">
        <span className="text-mut">
          {weaknessesRelative ? 'Weakest (none bottom two): ' : 'Weak: '}
        </span>
        {weaknesses.length === 0
          ? '—'
          : weaknesses.map((c) => `${c.cat} (${ordinal(c.rank)})`).join(', ')}
      </div>
      {weaknesses.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {weaknesses.map((w) => (
            <li key={w.cat} className="rounded-lg bg-well px-2 py-1.5 text-sm">
              <div className="flex items-center gap-2">
                <b>{w.cat}</b>
                <span className="text-xs text-mut">
                  {ordinal(w.rank)} · {fmtWeekly(w.cat, w.weekly)}/wk
                </span>
                {w.fix ? (
                  <span className="pill ml-auto border-acc/70 text-acc">
                    {w.fix.route === 'FA'
                      ? 'free agent'
                      : w.fix.route === 'trade'
                        ? 'trade'
                        : 'no fix'}
                  </span>
                ) : null}
              </div>
              {w.fix ? <p className="text-xs text-soft">{w.fix.how}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-2xs text-mut">
        Cheapest fix compares the best free agent’s gain in the category (for our weakest player of
        that type) with the best 1-for-1 trade idea’s, in the same z units.
      </p>
    </section>
  );
}
