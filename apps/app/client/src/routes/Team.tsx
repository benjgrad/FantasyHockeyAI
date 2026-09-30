import type { TeamView } from '@fha/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';
import { formatWhen } from '../components/DecisionCardView';
import { TeamSwitch } from '../league/TeamSwitch';
import { PlayerLink } from '../players/PlayerLink';
import { StrengthCard } from '../players/StrengthCard';
import { availabilityTone, groupRoster, type Group, type RosterRowT } from '../team/roster';

const GROUP_TITLE: Record<Group, string> = {
  active: 'Active',
  bench: 'Bench',
  ir: 'Injured reserve',
};
const TONE: Record<'good' | 'warn' | 'bad', string> = {
  good: 'border-good/50 text-good',
  warn: 'border-warn/60 text-warn',
  bad: 'border-bad/60 text-bad',
};

export function Team() {
  const queryClient = useQueryClient();
  const team = useQuery({ queryKey: ['team'], queryFn: api.team });
  const refresh = useMutation({
    mutationFn: api.refreshTeam,
    onSuccess: (view) => queryClient.setQueryData(['team'], view),
  });

  const view = team.data;
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      <TeamSwitch />
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{view?.teamName ?? 'Team'}</h1>
          {view ? (
            <div className="text-xs text-mut">
              Week {view.week}
              {view.opponent ? ` · vs ${view.opponent}` : ''} · as of {formatWhen(view.asOf)}
              {view.source === 'mock' ? ' · sample data' : ''}
            </div>
          ) : null}
        </div>
        <button className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh from Yahoo'}
        </button>
      </div>
      {team.error ? <ErrorNote error={team.error} /> : null}
      {refresh.error ? <ErrorNote error={refresh.error} /> : null}
      {team.isPending ? <p className="text-mut">Loading…</p> : null}
      {view ? <TeamBody view={view} /> : null}
    </div>
  );
}

function TeamBody({ view }: { view: TeamView }) {
  const groups = groupRoster(view.roster);
  return (
    <>
      {view.health.length > 0 ? (
        <div className="card border-warn/50">
          <div className="tag mb-1">Roster health</div>
          <ul className="list-disc pl-5 text-sm text-soft">
            {view.health.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {(['active', 'bench', 'ir'] as const).map((g) =>
        groups[g].length > 0 ? (
          <section key={g} className="card p-0">
            <div className="tag border-b border-line px-3 py-2">
              {GROUP_TITLE[g]} · {groups[g].length}
            </div>
            {groups[g].map((row) => (
              <PlayerRow key={row.playerKey} row={row} />
            ))}
          </section>
        ) : null,
      )}
      {view.categories.length > 0 ? <Categories view={view} /> : null}
      <StrengthCard />
    </>
  );
}

function PlayerRow({ row }: { row: RosterRowT }) {
  const a = row.availability;
  return (
    <div className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
      <span className="w-10 shrink-0 text-center font-mono text-xs text-mut">{row.slot}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <PlayerLink playerKey={row.playerKey} className="truncate font-medium">
            {row.name}
          </PlayerLink>
          <span
            className={`pill ${TONE[availabilityTone(a.playProb)]}`}
            title={a.note ?? undefined}
          >
            {a.label}
          </span>
        </div>
        <div className="text-xs text-mut">
          {row.nhlTeam} · {row.positions}
          {row.gameToday ? ` · today ${row.gameToday}` : ' · no game today'}
          {a.note ? ` · ${a.note}` : ''}
        </div>
      </div>
      <div className="text-right text-xs tabular-nums">
        <div>
          <b className="text-acc">{row.gamesThisWeek}</b> <span className="text-mut">GP wk</span>
        </div>
        {row.value !== null ? <div className="text-mut">val {row.value.toFixed(1)}</div> : null}
      </div>
    </div>
  );
}

function Categories({ view }: { view: TeamView }) {
  return (
    <section className="card overflow-x-auto p-0">
      <div className="tag border-b border-line px-3 py-2">
        Categories{view.opponent ? ` vs ${view.opponent}` : ''}
      </div>
      <table className="w-full text-sm tabular-nums">
        <thead className="text-xs text-mut">
          <tr>
            <th className="px-3 py-1.5 text-left font-normal">Cat</th>
            <th className="px-3 py-1.5 text-right font-normal">Us</th>
            <th className="px-3 py-1.5 text-right font-normal">Them</th>
            <th className="px-3 py-1.5 text-right font-normal">Win %</th>
          </tr>
        </thead>
        <tbody>
          {view.categories.map((c) => (
            <tr key={c.cat} className="border-t border-line">
              <td className="px-3 py-1.5">{c.cat}</td>
              <td className="px-3 py-1.5 text-right">{fmt(c.us)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(c.them)}</td>
              <td className={`px-3 py-1.5 text-right ${winTone(c.winProb)}`}>
                {c.winProb === null ? '—' : `${Math.round(c.winProb * 100)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const fmt = (n: number | null): string =>
  n === null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2);

function winTone(p: number | null): string {
  if (p === null) return 'text-mut';
  if (p >= 0.6) return 'text-good';
  if (p <= 0.4) return 'text-bad';
  return 'text-warn';
}
