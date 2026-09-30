import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorNote } from '../components/ErrorNote';
import { playersApi, type ListParams, type PlayerListT } from './api';
import { compareHref, signed, toggleKey } from './helpers';
import { usePlayerSheet } from './sheet';

/**
 * The free-agent browser. Default sort is fit to our needs (value steered to our weak
 * categories), with a one-tap sort by each target category; tick up to four players to compare.
 */
const STATUSES: { v: ListParams['status']; label: string }[] = [
  { v: 'FA', label: 'Free agents' },
  { v: 'ours', label: 'Ours' },
  { v: 'all', label: 'All' },
];
const POSITIONS = ['', 'C', 'LW', 'RW', 'D', 'G'];

export function Players() {
  const navigate = useNavigate();
  const { open } = usePlayerSheet();
  const [params, setParams] = useState<ListParams>({ status: 'FA', sort: 'fit', limit: 50 });
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const effective = { ...params, q: q.trim() || undefined };
  const list = useQuery({
    queryKey: ['players', effective],
    queryFn: () => playersApi.list(effective),
  });
  const strength = useQuery({
    queryKey: ['strength'],
    queryFn: playersApi.strength,
    staleTime: 60_000,
  });
  const cats = strength.data?.categories.map((c) => c.cat).sort() ?? [];
  const targets = strength.data?.targets ?? [];
  const set = (patch: Partial<ListParams>) => setParams((p) => ({ ...p, ...patch }));

  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Players</h1>
        <button
          className="btn"
          disabled={picked.length < 2}
          onClick={() => void navigate(compareHref(picked))}
        >
          Compare {picked.length > 0 ? `(${picked.length})` : ''}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s.v}
            className={`btn px-2.5 py-1 ${params.status === s.v ? 'border-acc text-acc' : ''}`}
            onClick={() => set({ status: s.v })}
          >
            {s.label}
          </button>
        ))}
        <select
          className="input w-auto py-1"
          value={params.position ?? ''}
          onChange={(e) => set({ position: e.target.value || undefined })}
        >
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p === '' ? 'Any position' : p}
            </option>
          ))}
        </select>
        <select
          className="input w-auto py-1"
          value={params.sort}
          onChange={(e) => set({ sort: e.target.value })}
        >
          <option value="fit">Sort: fit to our needs</option>
          <option value="value">Sort: value</option>
          {cats.map((c) => (
            <option key={c} value={`cat:${c}`}>
              Sort: {c}
              {targets.includes(c) ? ' (target)' : ''}
            </option>
          ))}
        </select>
      </div>
      {targets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-mut">Targeting:</span>
          {targets.map((t) => (
            <button
              key={t}
              className={`pill ${params.sort === `cat:${t}` ? 'border-acc text-acc' : ''}`}
              onClick={() => set({ sort: `cat:${t}` })}
            >
              {t}
            </button>
          ))}
        </div>
      ) : null}
      <input
        className="input"
        placeholder="Search by name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {list.error ? <ErrorNote error={list.error} /> : null}
      {list.data ? (
        <Rows
          data={list.data}
          picked={picked}
          targets={targets}
          onOpen={open}
          onPick={(k) => setPicked((p) => toggleKey(p, k))}
        />
      ) : list.isPending ? (
        <p className="text-mut">Loading…</p>
      ) : null}
    </div>
  );
}

function Rows({
  data,
  picked,
  targets,
  onOpen,
  onPick,
}: {
  data: PlayerListT;
  picked: string[];
  targets: string[];
  onOpen: (k: string) => void;
  onPick: (k: string) => void;
}) {
  return (
    <section className="card p-0">
      {data.notes.map((n) => (
        <p key={n} className="border-b border-line px-3 py-2 text-xs text-mut">
          {n}
        </p>
      ))}
      {data.players.length === 0 ? (
        <p className="px-3 py-2 text-sm text-mut">No players match.</p>
      ) : null}
      {data.players.map((p) => (
        <div
          key={p.playerKey}
          className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
        >
          <input
            type="checkbox"
            aria-label={`Compare ${p.name}`}
            checked={picked.includes(p.playerKey)}
            onChange={() => onPick(p.playerKey)}
          />
          <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(p.playerKey)}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-mut">
                {p.positions.join('/')} · {p.nhlTeam}
                {p.owner.kind === 'team' ? ` · ${p.owner.name}` : ''}
              </span>
              {p.availability.playProb < 1 ? (
                <span className="pill border-warn/60 text-warn">
                  {p.availability.label.split(',')[0]}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1 text-[11px]">
              {p.keyCats.map((k) => (
                <span
                  key={k.cat}
                  className={`pill ${targets.includes(k.cat) ? 'border-acc/70' : ''}`}
                >
                  {k.cat} {signed(k.z, 1)}
                </span>
              ))}
            </div>
          </button>
          <div className="text-right text-xs tabular-nums">
            <div>
              fit <b className={(p.fit ?? 0) >= 0 ? 'text-good' : 'text-bad'}>{signed(p.fit)}</b>
            </div>
            <div className="text-mut">val {p.adjustedVorp?.toFixed(1) ?? '—'}</div>
            <div className="text-mut">{p.gamesThisWeek} gm wk</div>
          </div>
        </div>
      ))}
      {data.total > data.players.length ? (
        <p className="px-3 py-2 text-xs text-mut">
          Showing {data.players.length} of {data.total}.
        </p>
      ) : null}
    </section>
  );
}
