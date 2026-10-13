import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatTip } from '../components/StatTip';
import type { LeagueCompareT, TeamRowT } from './api';
import { fmtWeekly, ordinal, rankColor, sortRows, type SortKey } from './helpers';

/**
 * Every team × every category, coloured by league rank (1 = strongest, blue; last = red).
 * Ours is pinned first and outlined. A column header sorts by that column; the team column is
 * sticky so the categories scroll horizontally under it on a phone. Each cell prints its rank
 * (or, switched, the typical-week projection); hover or tap shows both.
 */
export function Heatmap({ data }: { data: LeagueCompareT }) {
  const [sort, setSort] = useState<SortKey>({ kind: 'league' });
  const [show, setShow] = useState<Show>('rank');
  const hasLive = data.teams.some((t) => t.live);
  const modes: Show[] = hasLive ? ['rank', 'weekly', 'live'] : ['rank', 'weekly'];
  const live = show === 'live';
  const [picked, setPicked] = useState<string | null>(null);
  const navigate = useNavigate();
  const rows = sortRows(data.teams, sort);
  const skater = data.categories.filter((c) => c.group === 'skater');
  const goalie = data.categories.filter((c) => c.group === 'goalie');
  const cats = [...skater, ...goalie];
  const sortBy = (key: SortKey) => setSort((cur) => (same(cur, key) ? { kind: 'league' } : key));

  return (
    <section className="card p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="tag">
          {live ? 'This week so far · rank across the league' : 'Category ranks · 1 = strongest'}
        </span>
        <div className="flex gap-1 text-xs">
          {modes.map((m) => (
            <button
              key={m}
              className={`rounded px-2 py-0.5 ${show === m ? 'bg-raised text-ink' : 'text-mut'}`}
              onClick={() => setShow(m)}
            >
              {m === 'rank' ? 'Season rank' : m === 'weekly' ? 'Per week' : 'This week'}
            </button>
          ))}
        </div>
      </div>
      <div className="scroll-x">
        <table className="border-separate border-spacing-0.5 text-xs tabular-nums">
          <thead>
            <tr className="text-3xs text-mut uppercase">
              <th className="sticky left-0 z-10 bg-card" />
              <th colSpan={skater.length} className="font-normal">
                Skaters
              </th>
              <th colSpan={goalie.length} className="font-normal">
                Goalies
              </th>
              <th />
            </tr>
            <tr>
              <th className="sticky left-0 z-10 bg-card px-2 py-1 text-left font-normal text-mut">
                Team
              </th>
              {cats.map((c) => (
                <SortHeader
                  key={c.cat}
                  label={c.lowerIsBetter ? `${c.cat}↓` : c.cat}
                  active={sort.kind === 'cat' && sort.cat === c.cat}
                  onClick={() => sortBy({ kind: 'cat', cat: c.cat })}
                  title={
                    c.lowerIsBetter ? `${c.cat}: lower is better (already ranked that way)` : c.cat
                  }
                />
              ))}
              {live ? (
                <th
                  className="px-1 py-1 font-normal text-mut"
                  title="Categories leading–trailing their own opponent this week"
                >
                  vs opp
                </th>
              ) : (
                <SortHeader
                  label="vs us"
                  active={sort.kind === 'vsUs'}
                  onClick={() => sortBy({ kind: 'vsUs' })}
                  title="Categories this team expects to win against us in a typical week"
                />
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.teamKey}>
                <th
                  scope="row"
                  className={`sticky left-0 z-10 max-w-[8.5rem] truncate bg-card px-2 py-1 text-left font-medium ${
                    t.isUs ? 'text-acc' : ''
                  }`}
                >
                  {t.isUs ? (
                    <span title={t.name}>{t.name} (us)</span>
                  ) : (
                    <button
                      className="truncate text-left underline decoration-line decoration-dotted underline-offset-2 hover:text-acc"
                      title={`${t.name}: head to head`}
                      onClick={() => void navigate(`/league/${encodeURIComponent(t.teamKey)}`)}
                    >
                      {t.name}
                    </button>
                  )}
                </th>
                {cats.map((c) => (
                  <Cell
                    key={c.cat}
                    team={t}
                    cat={c.cat}
                    of={data.of}
                    show={show}
                    picked={picked === `${t.teamKey}|${c.cat}`}
                    onPick={() =>
                      setPicked((p) =>
                        p === `${t.teamKey}|${c.cat}` ? null : `${t.teamKey}|${c.cat}`,
                      )
                    }
                  />
                ))}
                <td className="px-2 text-right whitespace-nowrap">
                  {live
                    ? t.live
                      ? `${t.live.leading}–${t.live.trailing}`
                      : '—'
                    : t.vsUs
                      ? t.vsUs.theirExpectedWon.toFixed(1)
                      : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-2 text-2xs text-mut">
        {live
          ? "This week: each team's total so far from Yahoo's scoreboard, coloured by its rank across the league; “vs opp” = categories leading–trailing its own opponent. "
          : 'Season ranks use the rest-of-season projection (the preseason projection updated by this season’s games). '}
        Blue = strong, orange = weak. “vs us” = categories they expect to win against us in a
        typical {data.typicalWeekGames}-game week (of {data.categories.length}). Tap a team for the
        head to head.
      </p>
      <div className="flex flex-wrap gap-x-2 gap-y-1 px-3 pb-2 text-2xs text-mut">
        <StatTip k="lens" />
        <StatTip k="expectedWon" />
        {cats.map((c) => (
          <StatTip key={c.cat} cat={c.cat} />
        ))}
      </div>
    </section>
  );
}

function same(a: SortKey, b: SortKey): boolean {
  return a.kind === b.kind && (a.kind !== 'cat' || (b.kind === 'cat' && a.cat === b.cat));
}

function SortHeader(p: { label: string; active: boolean; onClick: () => void; title: string }) {
  return (
    <th className="px-0.5 py-1 font-normal">
      <button
        className={`min-w-9 rounded px-1 ${p.active ? 'bg-raised text-ink' : 'text-mut hover:text-ink'}`}
        title={p.title}
        aria-pressed={p.active}
        onClick={p.onClick}
      >
        {p.label}
      </button>
    </th>
  );
}

type Show = 'rank' | 'weekly' | 'live';

function Cell(p: {
  team: TeamRowT;
  cat: string;
  of: number;
  show: Show;
  picked: boolean;
  onPick: () => void;
}) {
  if (p.show === 'live') {
    const l = p.team.live?.cells.find((x) => x.cat === p.cat);
    if (!l) return <td className="text-center text-mut">—</td>;
    const detail = `${p.team.name}: ${fmtLive(p.cat, l.value)} ${p.cat} this week, ${ordinal(l.rank)} in the league`;
    return (
      <td className="p-0">
        <div
          className={`flex h-9 w-full min-w-9 items-center justify-center rounded px-1 text-ink ${p.team.isUs ? 'ring-1 ring-acc' : ''}`}
          style={{ backgroundColor: rankColor(l.rank, p.of) }}
          title={detail}
          aria-label={detail}
        >
          {fmtLive(p.cat, l.value)}
        </div>
      </td>
    );
  }
  const c = p.team.categories.find((x) => x.cat === p.cat);
  if (!c) return <td className="text-center text-mut">—</td>;
  const detail = `${p.team.name}: ${ordinal(c.rank)} in ${p.cat}, ${fmtWeekly(p.cat, c.weekly)} a week`;
  const both = p.picked;
  return (
    <td className="p-0">
      <button
        className={`h-9 w-full min-w-9 rounded px-1 text-center text-ink ${
          p.team.isUs ? 'ring-1 ring-acc' : ''
        }`}
        style={{ backgroundColor: rankColor(c.rank, p.of) }}
        title={detail}
        aria-label={detail}
        onClick={p.onPick}
      >
        {both ? (
          <span className="leading-tight">
            <b>{c.rank}</b>
            <span className="block text-3xs">{fmtWeekly(p.cat, c.weekly)}</span>
          </span>
        ) : p.show === 'rank' ? (
          c.rank
        ) : (
          fmtWeekly(p.cat, c.weekly)
        )}
      </button>
    </td>
  );
}

/** A live total as Yahoo shows it: whole counts, SV% to three places, GAA to two. */
function fmtLive(cat: string, n: number): string {
  if (cat === 'SV%') return n.toFixed(3).replace(/^0/, '');
  if (cat === 'GAA') return n.toFixed(2);
  return String(Math.round(n));
}
