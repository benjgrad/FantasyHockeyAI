import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ErrorNote } from '../components/ErrorNote';
import { compareHref } from '../players/helpers';
import { PlayerLink } from '../players/PlayerLink';
import { CHAT_PREFILL } from '../players/sheet';
import { leagueApi, type HeadToHeadT, type TradeIdeaT } from './api';
import { fmtWeekly, ordinal, pairBars, pct, proposeText } from './helpers';
import { TeamSwitch } from './TeamSwitch';

/**
 * `/league/:teamKey`: one team head to head with us over a typical week. Swing categories
 * (35–65%) are outlined; the ones we trail in are listed cheapest to flip first.
 */
export function TeamDetail() {
  const { teamKey = '' } = useParams();
  const q = useQuery({
    queryKey: ['league-h2h', teamKey],
    queryFn: () => leagueApi.headToHead(teamKey),
    staleTime: 60_000,
  });
  const h = q.data;
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      <TeamSwitch />
      <Link to="/league" className="text-xs text-mut hover:text-ink">
        ← League
      </Link>
      {q.error ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? <p className="text-mut">Comparing, and searching trades…</p> : null}
      {h ? <Body h={h} /> : null}
    </div>
  );
}

function Body({ h }: { h: HeadToHeadT }) {
  const n = h.categories.length;
  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">Us vs {h.them.name}</h1>
        <div className="text-sm text-soft">
          We expect to win <b>{h.expectedWon.typical.toFixed(1)}</b> of {n} categories in a typical
          week
          {h.expectedWon.thisWeek !== null
            ? `, ${h.expectedWon.thisWeek.toFixed(1)} over the rest of this week`
            : ''}
          .
        </div>
        {h.flipOrder.length > 0 ? (
          <div className="text-xs text-mut">Cheapest to flip: {h.flipOrder.join(', ')}</div>
        ) : null}
      </div>
      <section className="card p-0">
        <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-[11px] text-mut">
          <span className="tag">Per week</span>
          <span className="flex items-center gap-1">
            <i className="inline-block h-2 w-3 rounded-sm bg-acc" /> us
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block h-2 w-3 rounded-sm bg-mut" /> {h.them.name}
          </span>
          <span className="ml-auto">outlined = swing</span>
        </div>
        {h.categories.map((c) => (
          <CategoryRow key={c.cat} c={c} />
        ))}
      </section>
      <TradeIdeas h={h} />
      <ul className="list-disc pl-5 text-[11px] text-mut">
        {h.notes.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </>
  );
}

type Cat = HeadToHeadT['categories'][number];

function CategoryRow({ c }: { c: Cat }) {
  const bars = pairBars(c.ours, c.theirs);
  const tone = c.winProb >= 0.6 ? 'text-good' : c.winProb <= 0.4 ? 'text-bad' : 'text-warn';
  return (
    <details
      className={`border-b border-line px-3 py-2 last:border-b-0 ${c.swing ? 'outline outline-1 -outline-offset-1 outline-warn/60' : ''}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
        <span className="w-10 shrink-0 font-medium">
          {c.cat}
          {c.lowerIsBetter ? <span title="lower is better">↓</span> : null}
        </span>
        <div className="flex flex-1 flex-col gap-0.5">
          <Bar pct={bars.ours} cls="bg-acc" label={fmtWeekly(c.cat, c.ours)} />
          <Bar pct={bars.theirs} cls="bg-mut" label={fmtWeekly(c.cat, c.theirs)} />
        </div>
        <span className={`w-11 text-right text-xs tabular-nums ${tone}`}>{pct(c.winProb)}</span>
      </summary>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <Contributors title={`Ours · ${ordinal(c.ourRank)}`} players={c.ourTop} />
        <Contributors title={`Theirs · ${ordinal(c.theirRank)}`} players={c.theirTop} />
        <div className="col-span-2 text-mut">
          {c.swing ? 'Swing category. ' : ''}Gap {c.gapSd >= 0 ? '+' : ''}
          {c.gapSd.toFixed(2)} σ
          {c.thisWeekWinProb !== null ? ` · this week ${pct(c.thisWeekWinProb)}` : ''}
        </div>
      </div>
    </details>
  );
}

function Bar({ pct: w, cls, label }: { pct: number; cls: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-2 flex-1 rounded bg-well">
        <i className={`block h-2 rounded ${cls}`} style={{ width: `${w}%` }} />
      </div>
      <span className="w-11 text-right text-[11px] tabular-nums text-soft">{label}</span>
    </div>
  );
}

function Contributors({ title, players }: { title: string; players: Cat['ourTop'] }) {
  return (
    <div>
      <div className="tag mb-0.5">{title}</div>
      {players.map((p) => (
        <div key={p.playerKey} className="flex justify-between gap-1">
          <PlayerLink playerKey={p.playerKey} className="truncate">
            {p.name}
          </PlayerLink>
          <span className="tabular-nums text-mut">{p.z.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

function TradeIdeas({ h }: { h: HeadToHeadT }) {
  const navigate = useNavigate();
  return (
    <section className="card flex flex-col gap-2">
      <div className="tag">Trade ideas with {h.them.name}</div>
      {h.tradeIdeas.length === 0 ? (
        <p className="text-sm text-mut">No trade helps us without costing them.</p>
      ) : null}
      {h.tradeIdeas.map((t) => (
        <Idea
          key={[...t.give, ...t.get].map((p) => p.playerKey).join(',')}
          t={t}
          onCompare={() =>
            void navigate(compareHref([...t.give, ...t.get].map((p) => p.playerKey).slice(0, 4)))
          }
          onAsk={() => void navigate('/', { state: { [CHAT_PREFILL]: proposeText(t) } })}
        />
      ))}
    </section>
  );
}

function Idea({
  t,
  onCompare,
  onAsk,
}: {
  t: TradeIdeaT;
  onCompare: () => void;
  onAsk: () => void;
}) {
  const names = (xs: TradeIdeaT['give']) =>
    xs.map((p, i) => (
      <span key={p.playerKey}>
        {i > 0 ? ' + ' : ''}
        <PlayerLink playerKey={p.playerKey}>{p.name}</PlayerLink>
      </span>
    ));
  return (
    <div className="rounded-lg bg-well px-2 py-2 text-sm">
      <div>
        <span className="text-mut">Give </span>
        {names(t.give)}
        <span className="text-mut"> · get </span>
        {names(t.get)}
      </div>
      <div className="text-xs text-soft">
        Us <b className="text-good">+{t.ourGain.toFixed(2)}</b> · them {t.theirGain >= 0 ? '+' : ''}
        {t.theirGain.toFixed(2)} expected categories a week
      </div>
      {t.reasons.length > 0 ? <p className="mt-1 text-xs text-mut">{t.reasons[0]}</p> : null}
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button className="btn py-1 text-xs" onClick={onCompare}>
          Compare players
        </button>
        <button className="btn py-1 text-xs" onClick={onAsk}>
          Ask the GM to propose this
        </button>
      </div>
    </div>
  );
}
