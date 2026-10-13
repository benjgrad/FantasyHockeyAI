import { useQuery } from '@tanstack/react-query';
import { StatTip } from '../components/StatTip';
import { Sparkline } from '../components/Sparkline';
import { playersApi, type PlayerFormT } from './api';

/**
 * The player card's form (D-025): trend chips (code-labelled, sample size already accounted
 * for), a rolling 10-game sparkline per category against his baseline, the rest-of-season projection
 * next to the preseason one, the next 7 and 14 days, and his recent game log. Every number is
 * computed by the server; this only draws.
 */
export function FormSection({ playerKey }: { playerKey: string }) {
  const q = useQuery({
    queryKey: ['player-form', playerKey],
    queryFn: () => playersApi.form(playerKey),
    staleTime: 60_000,
  });
  if (q.isPending)
    return <div className="h-24 animate-pulse rounded-lg bg-well" aria-label="Loading form" />;
  const f = q.data;
  if (f === undefined || f.kind === 'none') {
    return <p className="text-xs text-mut">No NHL game history linked to this player yet.</p>;
  }
  return (
    <section className="flex flex-col gap-2">
      <div className="tag">Form</div>
      <Chips f={f} />
      <Lines f={f} />
      {f.lens ? <Lens f={f} /> : null}
      <Forecasts f={f} />
      <GameLog f={f} />
    </section>
  );
}

const fmt = (n: number, cat: string) =>
  cat === 'SV%'
    ? n.toFixed(3).replace(/^0/, '')
    : cat === 'GAA' || cat === 'TOI'
      ? n.toFixed(2)
      : n.toFixed(2);

function Chips({ f }: { f: PlayerFormT }) {
  const flagged = f.trends.filter((t) => t.label === 'hot' || t.label === 'cold');
  if (flagged.length === 0) {
    return (
      <p className="text-xs text-soft">
        <StatTip k="trend">Last 10 games</StatTip>: nothing beyond normal variation.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-2xs text-mut">
        <StatTip k="trend" />
      </span>
      {flagged.map((t) => (
        <span
          key={t.cat}
          className={`pill ${t.label === 'hot' ? 'border-good/60 text-good' : 'border-bad/60 text-bad'}`}
          title={`Last ${t.nRecent} games ${fmt(t.recent, t.cat)} vs ${fmt(t.baseline, t.cat)} before (z ${t.z.toFixed(1)})`}
        >
          {t.label === 'hot' ? '▲' : '▼'} {t.cat} {fmt(t.recent, t.cat)} vs {fmt(t.baseline, t.cat)}
        </span>
      ))}
    </div>
  );
}

function Lines({ f }: { f: PlayerFormT }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-2">
      {f.series.map((s) => (
        <div key={s.cat} className="flex items-center justify-between gap-2 text-xs tabular-nums">
          <span className="w-9 font-semibold">{s.cat}</span>
          <Sparkline
            points={s.points}
            baseline={s.baseline}
            label={`${s.cat}: rolling 10-game average, latest ${fmt(s.points.at(-1) ?? 0, s.cat)}, baseline ${fmt(s.baseline, s.cat)}`}
          />
          <span className="w-11 text-right text-soft">
            {s.points.length > 0 ? fmt(s.points.at(-1) ?? 0, s.cat) : '—'}
          </span>
        </div>
      ))}
      <p className="col-span-2 text-2xs text-mut">
        Rolling 10-game average per game; dashed = his previous 82 games.
      </p>
    </div>
  );
}

function Lens({ f }: { f: PlayerFormT }) {
  const lens = f.lens;
  if (lens === null) return null;
  const cats = Object.keys(lens.inSeason);
  return (
    <details>
      <summary className="tag cursor-pointer">
        Projection per game: rest of season vs preseason
      </summary>
      <table className="mt-1 w-full text-xs tabular-nums">
        <thead className="text-mut">
          <tr>
            <th className="text-left font-normal" />
            {cats.map((c) => (
              <th key={c} className="text-right font-normal">
                <StatTip cat={c} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <StatTip k="rosValue">rest of season</StatTip>
            </td>
            {cats.map((c) => (
              <td key={c} className="text-right">
                {(lens.inSeason[c] ?? 0).toFixed(2)}
              </td>
            ))}
          </tr>
          <tr className="text-mut">
            <td>preseason</td>
            {cats.map((c) => (
              <td key={c} className="text-right">
                {(lens.preseason[c] ?? 0).toFixed(2)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className="mt-1 text-2xs text-mut">
        This season: {lens.gpCurrent} GP, weighted {(lens.weightCurrent * 100).toFixed(0)}% (full
        weight at 20 GP).
      </p>
    </details>
  );
}

function Forecasts({ f }: { f: PlayerFormT }) {
  if (f.forecast.length === 0) return null;
  const goalie = f.kind === 'goalie';
  const cats = goalie ? ['W'] : ['G', 'A', 'PPP', 'SOG', 'HIT'];
  return (
    <div className="rounded-lg bg-well p-2 text-xs">
      <div className="mb-1 text-mut">Expected over the next…</div>
      <table className="w-full tabular-nums">
        <tbody>
          {f.forecast.map((x) => (
            <tr key={x.days}>
              <td className="py-0.5">{x.days} days</td>
              <td className="py-0.5 text-mut">
                {x.expectedGames.toFixed(1)} of {x.scheduled} {goalie ? 'starts' : 'games'}
              </td>
              {cats.map((c) => (
                <td key={c} className="py-0.5 text-right">
                  {c} {(x.totals[c] ?? 0).toFixed(1)}
                </td>
              ))}
              {x.goalie ? (
                <td className="py-0.5 text-right">
                  SV% {fmt(x.goalie.svPct, 'SV%')} · GAA {x.goalie.gaa.toFixed(2)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GameLog({ f }: { f: PlayerFormT }) {
  if (f.games.length === 0) return null;
  const cols = Object.keys(f.games[0]?.line ?? {});
  return (
    <details>
      <summary className="tag cursor-pointer">Last {f.games.length} games</summary>
      <div className="scroll-x mt-1">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-mut">
            <tr>
              <th className="pr-2 text-left font-normal">Date</th>
              <th className="pr-2 text-left font-normal">Opp</th>
              {cols.map((c) => (
                <th key={c} className="px-1 text-right font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {f.games.map((g) => (
              <tr key={`${g.date}${g.opponent}`} className="border-t border-line">
                <td className="pr-2">{g.date.slice(5)}</td>
                <td className="pr-2">
                  {g.home ? 'vs' : '@'} {g.opponent}
                </td>
                {cols.map((c) => (
                  <td key={c} className="px-1 text-right">
                    {c === 'TOI' || c === 'MIN' ? (g.line[c] ?? 0).toFixed(1) : (g.line[c] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
