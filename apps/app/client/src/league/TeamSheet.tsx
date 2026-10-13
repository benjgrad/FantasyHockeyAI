import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ErrorNote } from '../components/ErrorNote';
import { Sheet } from '../components/Sheet';
import { PlayerLink } from '../players/PlayerLink';
import { usePlayerSheet } from '../players/sheet';
import { groupOf, type Group } from '../team/roster';
import { leagueApi, type LeagueCompareT, type TeamRowT, type TeamSheetT } from './api';
import { fmtWeekly, ordinal, rankColor } from './helpers';
import { useTeamSheet } from './teamSheet';

/**
 * The team sheet, mounted once for the whole app: a fantasy team's category ranks, this week's
 * score and its roster, opened over the page by `?team=`. A player tapped in the roster opens
 * his own sheet on top; closing that one comes back here.
 */
export function TeamSheetHost() {
  const { key, close } = useTeamSheet();
  const player = usePlayerSheet();
  if (key === null) return null;
  return (
    <Sheet label="Team" onClose={close} escape={player.key === null}>
      <TeamBody teamKey={key} />
    </Sheet>
  );
}

const GROUPS: readonly { group: Group; label: string }[] = [
  { group: 'active', label: 'Starting' },
  { group: 'bench', label: 'Bench' },
  { group: 'ir', label: 'IR' },
];

function TeamBody({ teamKey }: { teamKey: string }) {
  const team = useQuery({
    queryKey: ['team-sheet', teamKey],
    queryFn: () => leagueApi.team(teamKey),
    staleTime: 60_000,
  });
  // Shared with the League page, so its cache serves both.
  const compare = useQuery({
    queryKey: ['league-compare'],
    queryFn: leagueApi.compare,
    staleTime: 60_000,
  });
  if (team.error) return <ErrorNote error={team.error} />;
  if (!team.data) return <p className="text-mut">Loading…</p>;
  const t = team.data;
  const row = compare.data?.teams.find((r) => r.teamKey === teamKey);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="display text-2xl leading-tight">{t.name}</h2>
        <div className="text-xs text-mut">
          {[t.isUs ? 'Your team' : null, t.manager].filter(Boolean).join(' · ')}
        </div>
      </div>
      {compare.data && row ? (
        <Stats data={compare.data} row={row} />
      ) : compare.error ? null : (
        <p className="text-xs text-mut">Loading category ranks…</p>
      )}
      <Roster t={t} />
      <Link
        to={t.isUs ? '/team' : `/league/${encodeURIComponent(t.teamKey)}`}
        className="btn btn-sm self-start"
      >
        {t.isUs ? 'Open My team' : 'Head to head and trade ideas →'}
      </Link>
    </div>
  );
}

function Stats({ data, row }: { data: LeagueCompareT; row: TeamRowT }) {
  const n = data.categories.length;
  return (
    <section className="flex flex-col gap-2">
      <div className="text-sm text-soft">
        {row.live
          ? `This week: leading ${row.live.leading}–${row.live.trailing}${row.live.opponent ? ` vs ${row.live.opponent}` : ''}. `
          : ''}
        {row.vsUs
          ? `Against us they expect to win ${row.vsUs.theirExpectedWon.toFixed(1)} of ${n} categories in a typical week.`
          : ''}
      </div>
      <div className="tag">Season rank · per week</div>
      <div className="grid grid-cols-4 gap-1 text-xs tabular-nums sm:grid-cols-5">
        {row.categories.map((c) => (
          <div
            key={c.cat}
            className="rounded px-1.5 py-1 text-ink"
            style={{ backgroundColor: rankColor(c.rank, data.of) }}
            title={`${ordinal(c.rank)} of ${data.of} in ${c.cat}, ${fmtWeekly(c.cat, c.weekly)} a week`}
          >
            <div className="flex justify-between gap-1">
              <span className="font-medium">{c.cat}</span>
              <span>{ordinal(c.rank)}</span>
            </div>
            <div className="text-2xs opacity-80">{fmtWeekly(c.cat, c.weekly)}/wk</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Roster({ t }: { t: TeamSheetT }) {
  return (
    <section className="flex flex-col gap-2">
      {GROUPS.map(({ group, label }) => {
        const rows = t.roster.filter((r) => groupOf(r.slot) === group);
        if (rows.length === 0) return null;
        return (
          <div key={group}>
            <div className="tag mb-1">{label}</div>
            <ul className="flex flex-col divide-y divide-line text-sm">
              {rows.map((r) => (
                <li key={r.playerKey} className="flex items-baseline gap-2 py-1">
                  <span className="w-9 shrink-0 text-2xs text-mut">{r.slot}</span>
                  <PlayerLink playerKey={r.playerKey} className="min-w-0 truncate">
                    {r.name}
                  </PlayerLink>
                  {r.status ? <span className="text-2xs text-bad">{r.status}</span> : null}
                  <span className="ml-auto shrink-0 text-2xs text-mut">
                    {r.nhlTeam} · {r.eligible.filter((e) => !/^(BN|IR|Util)/.test(e)).join('/')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
