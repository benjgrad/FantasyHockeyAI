import { useQuery } from '@tanstack/react-query';
import { leagueApi } from './api';

/**
 * The rest of the season (D-025): every team's typical week on the rest-of-season lens, played against
 * every other. Expected categories won a week, P(win a week) against the average opponent, and
 * our chance against each team. Every number from the server.
 */
export function SeasonForecast() {
  const q = useQuery({
    queryKey: ['league-forecast'],
    queryFn: leagueApi.forecast,
    staleTime: 60_000,
  });
  const d = q.data;
  if (q.isPending) return <div className="card h-40 animate-pulse" aria-label="Loading forecast" />;
  if (d === undefined) return null;
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  return (
    <section className="card p-0">
      <div className="border-b border-line px-3 py-2">
        <div className="tag">Rest of season forecast</div>
        <div className="text-2xs text-mut">
          Typical week on the {d.lens.split(' (')[0]}; every team against every other.
        </div>
      </div>
      <table className="w-full text-sm tabular-nums">
        <thead className="text-xs text-mut">
          <tr>
            <th className="px-3 py-1.5 text-left font-normal">Team</th>
            <th className="px-3 py-1.5 text-right font-normal">Cats won / wk</th>
            <th className="px-3 py-1.5 text-right font-normal">Wins a week</th>
            <th className="px-3 py-1.5 text-right font-normal">We beat them</th>
          </tr>
        </thead>
        <tbody>
          {d.teams.map((t) => (
            <tr
              key={t.teamKey}
              className={`border-t border-line ${t.us ? 'bg-acc/10 font-semibold' : ''}`}
            >
              <td className="px-3 py-1.5">{t.us ? `${t.name} (us)` : t.name}</td>
              <td className="px-3 py-1.5 text-right">
                {t.expectedCatsWon.toFixed(1)}
                <span className="text-mut"> / {d.categories}</span>
              </td>
              <td className="px-3 py-1.5 text-right">{pct(t.pWinWeek)}</td>
              <td
                className={`px-3 py-1.5 text-right ${t.vsUs === null ? 'text-mut' : t.vsUs >= 0.5 ? 'text-good' : 'text-bad'}`}
              >
                {t.vsUs === null ? '—' : pct(t.vsUs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
