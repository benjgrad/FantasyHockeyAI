import { useQuery } from '@tanstack/react-query';
import { formatWhen } from '../components/DecisionCardView';
import { ErrorNote } from '../components/ErrorNote';
import { leagueApi } from './api';
import { Heatmap } from './Heatmap';
import { Partners } from './Partners';
import { ProfileCard } from './ProfileCard';
import { TeamSwitch } from './TeamSwitch';

/** Team → League: how every team stacks up, our profile, and who to trade with. */
export function League() {
  const q = useQuery({
    queryKey: ['league-compare'],
    queryFn: leagueApi.compare,
    staleTime: 60_000,
  });
  const data = q.data;
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      <TeamSwitch />
      <div>
        <h1 className="text-lg font-semibold">League</h1>
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
          <ProfileCard data={data} />
          <Partners data={data} />
          <ul className="list-disc pl-5 text-[11px] text-mut">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
