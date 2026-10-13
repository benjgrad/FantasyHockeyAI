import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorNote } from '../components/ErrorNote';
import { SkeletonRows } from '../components/Skeleton';
import { Freshness } from '../league/Freshness';
import { playersApi, type ListParams, type PlayerListT } from './api';
import { compareHref, signed, toggleKey } from './helpers';
import { usePlayerSheet } from './sheet';
import { usePane } from '../components/pane';
import { StatTip } from '../components/StatTip';

/**
 * The free-agent browser. Default sort is CWA, the categories a week a player adds for us on
 * the rest-of-season lens (D-026); fit (the preseason roster-only version), VOFA, VOLS and each
 * category are a tap away. Tick up to four players to compare.
 */
const STATUSES: { v: ListParams['status']; label: string }[] = [
  { v: 'FA', label: 'Free agents' },
  { v: 'ours', label: 'Ours' },
  { v: 'all', label: 'All' },
];
const POSITIONS = ['', 'C', 'LW', 'RW', 'D', 'G'];

export function Players() {
  const pane = usePane();
  const navigate = useNavigate();
  const { open } = usePlayerSheet();
  const [params, setParams] = useState<ListParams>({ status: 'FA', sort: 'cwa', limit: 50 });
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const effective = { ...params, q: q.trim() || undefined };
  const list = useQuery({
    queryKey: ['players', effective],
    queryFn: () => playersApi.list(effective),
    // A new filter keeps the current list on screen (dimmed) until its answer arrives.
    placeholderData: keepPreviousData,
  });
  // A search that found players outside the pool started a rebuild (D-032): poll its status, so
  // the list refetches the moment it lands and they appear.
  const queryClient = useQueryClient();
  const found = list.data?.found?.length ?? 0;
  useEffect(() => {
    if (found > 0) void queryClient.invalidateQueries({ queryKey: ['leagueStatus'] });
  }, [found, queryClient]);
  const strength = useQuery({
    queryKey: ['strength'],
    queryFn: playersApi.strength,
    staleTime: 60_000,
  });
  const cats = strength.data?.categories.map((c) => c.cat).sort() ?? [];
  const targets = strength.data?.targets ?? [];
  const set = (patch: Partial<ListParams>) => setParams((p) => ({ ...p, ...patch }));

  return (
    <div ref={pane} className="pane flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="display text-2xl leading-tight">Players</h1>
          <Freshness />
        </div>
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
            className={`btn btn-sm ${params.status === s.v ? 'border-acc text-acc' : ''}`}
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
          <option value="cwa">Sort: helps us (CWA)</option>
          <option value="vofa">Sort: over best free agent (VOFA)</option>
          <option value="ros">Sort: rest-of-season value (VOLS)</option>
          <option value="fit">Sort: fit to our needs (preseason)</option>
          <option value="value">Sort: preseason value</option>
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-mut">
        <span>Columns:</span>
        <StatTip k="cwa" />
        <StatTip k="vofa" />
        <StatTip k="delta7d" />
        <StatTip k="fit" />
        <StatTip k="trend">▲▼ form</StatTip>
        <StatTip k="luck" />
      </div>
      <input
        className="input"
        placeholder="Search by name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {list.error ? <ErrorNote error={list.error} /> : null}
      {list.data ? (
        <div
          className={list.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}
          aria-busy={list.isPlaceholderData}
        >
          <Rows
            data={list.data}
            picked={picked}
            targets={targets}
            onOpen={open}
            onPick={(k) => setPicked((p) => toggleKey(p, k))}
          />
        </div>
      ) : list.isPending ? (
        <SkeletonRows label="Loading players" />
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
      {data.players.length === 0 && (data.found?.length ?? 0) === 0 ? (
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
              {p.form?.hot.length ? (
                <span className="pill border-good/60 text-good" title="Hot over his last 10 games">
                  ▲ {p.form.hot.join('/')}
                </span>
              ) : null}
              {p.form?.cold.length ? (
                <span className="pill border-bad/60 text-bad" title="Cold over his last 10 games">
                  ▼ {p.form.cold.join('/')}
                </span>
              ) : null}
              {p.now?.luck === 'lucky' || p.now?.luck === 'unlucky' ? (
                <span
                  className={`pill ${p.now.luck === 'lucky' ? 'border-warn/60 text-warn' : 'border-acc/60 text-acc'}`}
                >
                  {p.now.luck}
                </span>
              ) : null}
              {p.availability.playProb < 1 ? (
                <span className="pill border-warn/60 text-warn">
                  {p.availability.label.split(',')[0]}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1 text-2xs">
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
          <NowColumn p={p} />
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

type Row = PlayerListT['players'][number];

/** The right-hand numbers: rest of season when available, else the preseason fit and value. */
function NowColumn({ p }: { p: Row }) {
  const now = p.now;
  const tone = (n: number | null | undefined) =>
    n === null || n === undefined ? '' : n > 0 ? 'text-good' : n < 0 ? 'text-bad' : '';
  if (now === null || now === undefined) {
    return (
      <div className="text-right text-xs tabular-nums">
        <div>
          fit <b className={tone(p.fit)}>{signed(p.fit)}</b>
        </div>
        <div className="text-mut">val {p.adjustedVorp?.toFixed(1) ?? '—'}</div>
        <div className="text-mut">{p.gamesThisWeek} gm wk</div>
      </div>
    );
  }
  const d = now.delta7d;
  return (
    <div className="text-right text-xs tabular-nums">
      <div>
        CWA <b className={tone(now.cwa)}>{now.cwa === null ? '—' : signed(now.cwa, 2)}</b>
      </div>
      <div className="text-mut">
        VOFA <span className={tone(now.vofa)}>{signed(now.vofa, 1)}</span>
        {d !== null && Math.abs(d) >= 0.05 ? (
          <span className={tone(d)} aria-label={`${signed(d)} in 7 days`}>
            {' '}
            {d > 0 ? '▲' : '▼'}
          </span>
        ) : null}
      </div>
      <div className="text-mut">
        {p.gamesThisWeek} gm wk{now.lowConfidence ? ' · thin' : ''}
      </div>
    </div>
  );
}
