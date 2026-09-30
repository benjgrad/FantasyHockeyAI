import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const [show, setShow] = useState<'rank' | 'weekly'>('rank');
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
        <span className="tag">Category ranks · 1 = strongest</span>
        <div className="flex gap-1 text-xs">
          {(['rank', 'weekly'] as const).map((m) => (
            <button
              key={m}
              className={`rounded px-2 py-0.5 ${show === m ? 'bg-raised text-ink' : 'text-mut'}`}
              onClick={() => setShow(m)}
            >
              {m === 'rank' ? 'Rank' : 'Per week'}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-0.5 text-xs tabular-nums">
          <thead>
            <tr className="text-[10px] text-mut uppercase">
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
              <SortHeader
                label="vs us"
                active={sort.kind === 'vsUs'}
                onClick={() => sortBy({ kind: 'vsUs' })}
                title="Categories this team expects to win against us in a typical week"
              />
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
                <td className="px-2 text-right">
                  {t.vsUs ? t.vsUs.theirExpectedWon.toFixed(1) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-2 text-[11px] text-mut">
        Blue = strong, red = weak. “vs us” = categories they expect to win against us in a typical{' '}
        {data.typicalWeekGames}-game week (of {data.categories.length}). Tap a team for the head to
        head.
      </p>
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

function Cell(p: {
  team: TeamRowT;
  cat: string;
  of: number;
  show: 'rank' | 'weekly';
  picked: boolean;
  onPick: () => void;
}) {
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
            <span className="block text-[10px]">{fmtWeekly(p.cat, c.weekly)}</span>
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
