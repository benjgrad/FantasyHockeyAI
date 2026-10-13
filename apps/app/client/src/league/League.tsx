import { useQuery } from '@tanstack/react-query';
import { formatWhen } from '../components/DecisionCardView';
import { ErrorNote } from '../components/ErrorNote';
import { leagueApi } from './api';
import { Heatmap } from './Heatmap';
import { Partners } from './Partners';
import { ProfileCard } from './ProfileCard';
import { SeasonForecast } from './SeasonForecast';
import { TeamSwitch } from './TeamSwitch';
import { usePane } from '../components/pane';

/** Team → League: how every team stacks up, our profile, and who to trade with. */
export function League() {
  const pane = usePane();
  const q = useQuery({
    queryKey: ['league-compare'],
    queryFn: leagueApi.compare,
    staleTime: 60_000,
  });
  const data = q.data;
  return (
    <div ref={pane} className="pane flex flex-col gap-3 p-3">
      <TeamSwitch />
      <div>
        <h1 className="display text-2xl leading-tight">League</h1>
        {data ? (
          <div className="text-xs text-mut">
            Week {data.week} · {data.of} teams · as of {formatWhen(data.asOf)}
          </div>
        ) : null}
      </div>
      {q.error ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? (
        <p className="text-mut">Comparing the league… (the first look searches trades)</p>
      ) : null}
      {data ? (
        <>
          <Heatmap data={data} />
          <SeasonForecast />
          <ProfileCard data={data} />
          <Partners data={data} />
          <ul className="list-disc pl-5 text-2xs text-mut">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
