import type { TeamView } from '@fha/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';
import { SkeletonRows } from '../components/Skeleton';
import { Freshness, refreshLeagueQueries } from '../league/Freshness';
import { TeamSwitch } from '../league/TeamSwitch';
import { PlayerLink } from '../players/PlayerLink';
import { StrengthCard } from '../players/StrengthCard';
import { StatTip } from '../components/StatTip';
import { availabilityTone, groupRoster, type Group, type RosterRowT } from '../team/roster';
import { fmtStat, shareOf } from '../team/week';
import { usePane } from '../components/pane';

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
  const pane = usePane();
  const queryClient = useQueryClient();
  const team = useQuery({ queryKey: ['team'], queryFn: api.team });
  const refresh = useMutation({
    mutationFn: api.refreshTeam,
    onSuccess: (view) => {
      // Everything else built from the league (strength, ranks, players) is now stale too.
      refreshLeagueQueries(queryClient);
      queryClient.setQueryData(['team'], view);
    },
  });

  const view = team.data;
  return (
    <div ref={pane} className="pane flex flex-col gap-3 p-3">
      <TeamSwitch />
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="display text-2xl leading-tight">{view?.teamName ?? 'Team'}</h1>
          {view ? (
            <div className="text-xs text-mut">
              Week {view.week}
              {view.opponent ? ` · vs ${view.opponent}` : ''}
              {view.source === 'mock' ? ' · sample data' : ''}
            </div>
          ) : null}
          <Freshness />
        </div>
        <button className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh from Yahoo'}
        </button>
      </div>
      {team.error ? <ErrorNote error={team.error} /> : null}
      {refresh.error ? <ErrorNote error={refresh.error} /> : null}
      {team.isPending ? <SkeletonRows rows={8} label="Loading your team" /> : null}
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
            <div className="tag flex items-center justify-between border-b border-line px-3 py-2">
              <span>
                {GROUP_TITLE[g]} · {groups[g].length}
              </span>
              <span className="normal-case">
                <StatTip k="vofa" /> <StatTip k="delta7d">▲▼</StatTip>
              </span>
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
        {row.now ? (
          <div className="text-mut">
            VOFA{' '}
            <span className={row.now.vofa >= 0 ? 'text-good' : 'text-bad'}>
              {row.now.vofa >= 0 ? '+' : '−'}
              {Math.abs(row.now.vofa).toFixed(1)}
            </span>
            {row.now.delta7d !== null && Math.abs(row.now.delta7d) >= 0.05 ? (
              <span className={row.now.delta7d > 0 ? 'text-good' : 'text-bad'}>
                {' '}
                {row.now.delta7d > 0 ? '▲' : '▼'}
              </span>
            ) : null}
          </div>
        ) : row.value !== null ? (
          <div className="text-mut">val {row.value.toFixed(1)}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * This week's matchup, per category: the score so far (Yahoo's scoreboard) as a tug-of-war bar,
 * a tick where the projected final lands, and our chance to win it. Without a scoreboard
 * reading it shows the projection alone.
 */
function Categories({ view }: { view: TeamView }) {
  const live = view.liveAsOf !== null && view.liveAsOf !== undefined;
  return (
    <section className="card p-0">
      <div className="flex items-baseline justify-between gap-2 border-b border-line px-3 py-2">
        <div className="tag">This week{view.opponent ? ` vs ${view.opponent}` : ''}</div>
        <div className="text-2xs text-mut">
          {live ? `Live score · projected final ▏ · win %` : 'Projected (no live score yet)'}
        </div>
      </div>
      <ul>
        {view.categories.map((c) => {
          const now = live ? shareOf(c.usNow, c.themNow, c.cat) : shareOf(c.us, c.them, c.cat);
          const final = shareOf(c.us, c.them, c.cat);
          return (
            <li key={c.cat} className="border-t border-line px-3 py-2 first:border-t-0">
              <div className="flex items-center gap-2 text-sm tabular-nums">
                <span className="w-10 shrink-0 font-semibold">{c.cat}</span>
                <span className="w-24 shrink-0 text-right">
                  {live ? (
                    <>
                      <b className={now > 0.5 ? 'text-good' : now < 0.5 ? 'text-ink' : ''}>
                        {fmtStat(c.usNow, c.cat)}
                      </b>
                      <span className="text-mut"> – </span>
                      <b className={now < 0.5 ? 'text-bad' : 'text-ink'}>
                        {fmtStat(c.themNow, c.cat)}
                      </b>
                    </>
                  ) : (
                    <span className="text-soft">
                      {fmtStat(c.us, c.cat)} – {fmtStat(c.them, c.cat)}
                    </span>
                  )}
                </span>
                <div
                  className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-well"
                  role="img"
                  aria-label={`${c.cat}: we hold ${Math.round(now * 100)}% now, ${Math.round(final * 100)}% projected at the end of the week`}
                >
                  <div
                    className="absolute inset-y-0 left-0 bg-acc/70"
                    style={{ width: `${now * 100}%` }}
                  />
                  {live ? (
                    <div
                      className="absolute inset-y-0 w-0.5 bg-ink"
                      style={{ left: `calc(${final * 100}% - 1px)` }}
                    />
                  ) : null}
                  <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
                </div>
                <span className={`w-12 shrink-0 text-right ${winTone(c.winProb)}`}>
                  {c.winProb === null ? '—' : `${Math.round(c.winProb * 100)}%`}
                </span>
              </div>
              {live ? (
                <div className="mt-0.5 pl-12 text-2xs text-mut tabular-nums">
                  final ≈ {fmtStat(c.us, c.cat)} – {fmtStat(c.them, c.cat)}
                  {c.decided ? (
                    <span
                      className={`ml-1.5 pill py-0 ${(c.winProb ?? 0) > 0.5 ? 'text-good' : 'text-bad'}`}
                    >
                      decided
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function winTone(p: number | null): string {
  if (p === null) return 'text-mut';
  if (p >= 0.6) return 'text-good';
  if (p <= 0.4) return 'text-bad';
  return 'text-warn';
}
