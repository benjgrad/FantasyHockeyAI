import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ErrorNote } from '../components/ErrorNote';
import { playersApi, type CompareT, type PlayerCardT } from './api';
import { AddPlayer } from './AddPlayer';
import { PlayerLink } from './PlayerLink';
import {
  TONE_CLASS,
  deltaTone,
  fmtCat,
  fmtDelta,
  parseKeys,
  signed,
  termTone,
  toggleKey,
} from './helpers';

/**
 * Side-by-side players, each column diffed against the base (the first), like the draft board's
 * alternatives table. Category deltas are coloured by whether they help us, so a lower GAA is
 * green; a skater against a goalie shows his own numbers, never a difference.
 */
export function Compare() {
  const [params, setParams] = useSearchParams();
  const keys = parseKeys(params.get('keys'));
  const setKeys = (next: string[]) => setParams(next.length ? { keys: next.join(',') } : {});
  const res = useQuery({
    queryKey: ['compare', keys],
    queryFn: () => playersApi.compare(keys),
    enabled: keys.length >= 2,
  });
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      <h1 className="text-lg font-semibold">Compare</h1>
      <AddPlayer
        disabled={keys.length >= 4}
        exclude={keys}
        onPick={(k) => setKeys(toggleKey(keys, k))}
        placeholder={keys.length >= 4 ? 'Four players at most' : 'Add a player…'}
      />
      {keys.length < 2 ? (
        <p className="text-sm text-mut">Pick at least two players to compare.</p>
      ) : null}
      {res.error ? <ErrorNote error={res.error} /> : null}
      {res.data ? (
        <CompareTable data={res.data} onRemove={(k) => setKeys(toggleKey(keys, k))} />
      ) : null}
    </div>
  );
}

function CompareTable({ data, onRemove }: { data: CompareT; onRemove: (k: string) => void }) {
  const base = data.players.find((p) => p.playerKey === data.base);
  if (!base) return null;
  const others = data.players.filter((p) => p.playerKey !== data.base);
  const delta = (k: string) => data.deltas.find((d) => d.playerKey === k);
  return (
    <section className="card overflow-x-auto p-0">
      <table className="w-full min-w-[480px] text-sm tabular-nums">
        <thead>
          <tr className="text-left align-bottom">
            <th className="px-2 py-2 font-normal text-mut">vs {base.name.split(' ').pop()}</th>
            {data.players.map((p) => (
              <th key={p.playerKey} className="px-2 py-2 text-right font-medium">
                <PlayerLink playerKey={p.playerKey}>{p.name}</PlayerLink>
                <div className="text-[11px] font-normal text-mut">
                  {p.positions.join('/')} · {p.owner.name} ·{' '}
                  {p.availability.source === 'healthy' ? 'healthy' : p.availability.status}
                </div>
                <button
                  className="text-[11px] text-mut hover:text-bad"
                  onClick={() => onRemove(p.playerKey)}
                >
                  remove
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <TermRows base={base} others={others} delta={delta} />
          {base.categories.map((c) => (
            <tr key={c.cat} className="border-t border-line">
              <td className="px-2 py-1 text-mut">
                {c.cat}
                {c.lowerIsBetter ? <span title="lower is better"> ↓</span> : null}
                {base.fit.targets.includes(c.cat) ? (
                  <span className="text-acc" title="one of our targets">
                    {' '}
                    ●
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-1 text-right">{fmtCat(c.cat, c.total)}</td>
              {others.map((p) => (
                <CatCell key={p.playerKey} p={p} cat={c.cat} d={delta(p.playerKey)} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {others.some((p) => p.positionType !== base.positionType) ? (
        <p className="px-2 py-2 text-xs text-mut">
          Skaters and goalies score different categories: their columns show their own numbers, not
          a difference.
        </p>
      ) : null}
    </section>
  );
}

type Delta = CompareT['deltas'][number] | undefined;

function CatCell({ p, cat, d }: { p: PlayerCardT; cat: string; d: Delta }) {
  const own = p.categories.find((c) => c.cat === cat);
  const row = d?.byCat.find((x) => x.cat === cat);
  if (!d?.comparable || !row) {
    return <td className="px-2 py-1 text-right text-mut">{own ? fmtCat(cat, own.total) : '—'}</td>;
  }
  return (
    <td className="px-2 py-1 text-right">
      {fmtCat(cat, own?.total ?? null)}{' '}
      <span className={TONE_CLASS[deltaTone(row.delta, row.better)]}>
        {fmtDelta(cat, row.delta)}
      </span>
    </td>
  );
}

const TERMS = [
  { k: 'vorp', label: 'VORP', get: (p: PlayerCardT) => p.value?.vorp ?? null, dp: 2 },
  {
    k: 'adjustedVorp',
    label: 'after injury',
    get: (p: PlayerCardT) => p.value?.adjustedVorp ?? null,
    dp: 2,
  },
  { k: 'fit', label: 'fit', get: (p: PlayerCardT) => p.fit.fit, dp: 2 },
  { k: 'score', label: 'score', get: (p: PlayerCardT) => p.fit.score, dp: 2 },
  {
    k: 'perGameValue',
    label: 'per game',
    get: (p: PlayerCardT) => p.value?.perGameValue ?? null,
    dp: 3,
  },
  { k: 'gp', label: 'proj GP', get: (p: PlayerCardT) => p.value?.gp ?? null, dp: 0 },
] as const;

function TermRows({
  base,
  others,
  delta,
}: {
  base: PlayerCardT;
  others: PlayerCardT[];
  delta: (k: string) => Delta;
}) {
  return (
    <>
      {TERMS.map((t) => (
        <tr key={t.k} className="border-t border-line bg-well/40">
          <td className="px-2 py-1 text-mut">{t.label}</td>
          <td className="px-2 py-1 text-right">{t.get(base)?.toFixed(t.dp) ?? '—'}</td>
          {others.map((p) => {
            const d = delta(p.playerKey)?.terms?.[t.k] ?? null;
            return (
              <td key={p.playerKey} className="px-2 py-1 text-right">
                {t.get(p)?.toFixed(t.dp) ?? '—'}{' '}
                {d !== null ? (
                  <span className={TONE_CLASS[termTone(d)]}>{signed(d, t.dp)}</span>
                ) : null}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
