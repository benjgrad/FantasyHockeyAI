import type { GlossaryKey } from '@fha/core';
import { Sparkline } from '../components/Sparkline';
import { StatTip } from '../components/StatTip';
import type { PlayerCardT } from './api';
import { signed } from './helpers';
import { PlayerLink } from './PlayerLink';

type Now = NonNullable<PlayerCardT['now']>;

/**
 * The rest-of-season value family (D-026): what he is worth from here, over the best free agent,
 * and to our team. Every label opens its glossary explainer (hover, or tap on a phone).
 */
export function NowSection({ now }: { now: Now }) {
  const cats = Object.entries(now.cwaByCategory)
    .filter(([, x]) => Math.abs(x) >= 0.01)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4);
  return (
    <section className="rounded-lg border border-line px-2 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="tag">
          <StatTip k="lens">Now · rest of season</StatTip>
        </span>
        <span className="text-mut">
          {now.gpCurrent} {now.gpCurrent === 1 ? 'game' : 'games'} this season ·{' '}
          {Math.round(now.weightCurrent * 100)}% weight
        </span>
        {now.lowConfidence ? (
          <span className="pill border-warn/60 text-warn">
            <StatTip k="lowConfidence">low confidence</StatTip>
          </span>
        ) : null}
        <LuckChip luck={now.luck} />
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-sm sm:grid-cols-4">
        <Cell k="vols" value={now.vols.toFixed(2)} />
        <Cell k="vofa" value={signed(now.vofa)} tone={now.vofa} />
        <Cell
          k="dWin"
          value={now.dWin == null ? '—' : signed(now.dWin * 100, 1)}
          tone={now.dWin ?? null}
        />
        <Cell k="cwa" value={now.cwa === null ? '—' : signed(now.cwa, 3)} tone={now.cwa} />
        <Cell
          k="weekCwa"
          value={now.weekCwa === null ? '—' : signed(now.weekCwa, 3)}
          tone={now.weekCwa}
        />
      </div>
      <div className="mt-1.5 text-xs text-soft">
        {now.vofaAgainst !== null ? (
          <div>
            <StatTip k="vofa" /> bar:{' '}
            <PlayerLink playerKey={now.vofaAgainst.playerKey}>{now.vofaAgainst.name}</PlayerLink>,
            the best free agent at {now.vofaPosition}.
          </div>
        ) : null}
        {cats.length > 0 ? (
          <div>
            <StatTip k="cwa" /> by category:{' '}
            {cats.map(([c, x], i) => (
              <span key={c}>
                {i > 0 ? ', ' : ''}
                <StatTip cat={c} /> {signed(x)}
              </span>
            ))}
            {now.cwaSwap !== null ? (
              <span className="text-mut"> · measured with {now.cwaSwap.name} as the swap</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <Trend now={now} />
    </section>
  );
}

function Cell({ k, value, tone }: { k: GlossaryKey; value: string; tone?: number | null }) {
  const cls =
    tone === undefined || tone === null ? '' : tone > 0 ? 'text-good' : tone < 0 ? 'text-bad' : '';
  return (
    <div className="rounded-lg bg-well px-2 py-1">
      <div className="text-2xs text-mut">
        <StatTip k={k} />
      </div>
      <div className={`font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function LuckChip({ luck }: { luck: Now['luck'] }) {
  if (luck === null || luck.label === 'normal' || luck.label === 'too small a sample') return null;
  const tone = luck.label === 'lucky' ? 'border-warn/60 text-warn' : 'border-acc/60 text-acc';
  return (
    <span className={`pill ${tone}`}>
      <StatTip k="luck">
        {luck.label} · {luck.stat} {(luck.recent * 100).toFixed(1)}% vs{' '}
        {(luck.baseline * 100).toFixed(1)}%
      </StatTip>
    </span>
  );
}

function Trend({ now }: { now: Now }) {
  const t = now.trend;
  if (t === null) return null;
  const base = t.series[0]?.vols ?? now.vols;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-mut">
      <span className="text-acc">
        <Sparkline
          points={t.series.map((x) => x.vols)}
          baseline={base}
          label={`VOLS by day, from ${base.toFixed(2)} to ${now.vols.toFixed(2)}`}
        />
      </span>
      <span>
        <StatTip k="vols" /> {signed(t.sincePreseason)} since preseason
      </span>
      {t.since7d !== null ? (
        <span>
          · <StatTip k="delta7d">{signed(t.since7d)} in 7 days</StatTip>
        </span>
      ) : null}
      {t.sinceYesterday !== null ? <span>· {signed(t.sinceYesterday)} since yesterday</span> : null}
    </div>
  );
}
