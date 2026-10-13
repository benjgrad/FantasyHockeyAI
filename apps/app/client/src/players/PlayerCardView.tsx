import { useNavigate } from 'react-router-dom';
import type { PlayerCardT } from './api';
import { FormSection } from './FormSection';
import { NowSection } from './NowSection';
import { StatTip } from '../components/StatTip';
import { AvailabilityBadge, CatTile, OwnerBadge, Stat } from './parts';
import { CHAT_PREFILL } from './sheet';
import { askText, compareHref, fmtCat, signed, topBottom } from './helpers';

/**
 * The draft board's player card for the season: who holds him and whether he plays, what he
 * is worth and how he fits our needs, his best four and worst two categories (all of them one
 * tap away), the news, and the reasons. Every number comes from the server.
 */
export function PlayerCardView({ card }: { card: PlayerCardT }) {
  const navigate = useNavigate();
  const { best, worst } = topBottom(card.categories);
  const targets = new Set(card.fit.targets);
  // Navigating away drops the sheet's `?player=`, so the sheet closes itself.
  const go = (to: string, state?: unknown) =>
    void navigate(to, state === undefined ? undefined : { state });
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="display text-3xl leading-none">{card.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-mut">
          <span>
            {card.positions.join('/')} · {card.nhlTeam}
          </span>
          <OwnerBadge owner={card.owner} />
          <AvailabilityBadge a={card.availability} />
          {card.lowConfidence ? (
            <span className="pill border-warn/60 text-warn">thin data</span>
          ) : null}
        </div>
        {card.availability.source !== 'healthy' ? (
          <div className="mt-1 text-xs text-soft">{card.availability.label}</div>
        ) : null}
      </div>
      {card.now ? <NowSection now={card.now} /> : null}
      <ValueRow card={card} />
      <FitLine card={card} />
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-3">
        {[...best, ...worst].map((c) => (
          <CatTile key={c.cat} c={c} target={targets.has(c.cat)} />
        ))}
      </div>
      <details>
        <summary className="tag cursor-pointer">
          All {card.categories.length} categories (rest of season)
        </summary>
        <table className="mt-1 w-full text-sm tabular-nums">
          <tbody>
            {card.categories.map((c) => (
              <tr key={c.cat} className="border-t border-line">
                <td className="py-1">
                  <StatTip cat={c.cat} />
                </td>
                <td className="py-1 text-right">{fmtCat(c.cat, c.total)}</td>
                <td className="py-1 text-right text-mut">
                  {c.perGame === null ? '—' : `${c.perGame}/g`}
                </td>
                <td className="py-1 text-right">{signed(c.z)}z</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <FormSection playerKey={card.playerKey} />
      {card.reasons.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-soft">
          {card.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {card.news.length > 0 ? (
        <div>
          <div className="tag mb-1">News</div>
          {card.news.map((n) => (
            <p key={n} className="mb-1 text-xs text-soft">
              {n}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button className="btn" onClick={() => go(compareHref([card.playerKey]))}>
          Compare with…
        </button>
        <button className="btn" onClick={() => go('/', { [CHAT_PREFILL]: askText(card) })}>
          Ask the GM about him
        </button>
      </div>
    </div>
  );
}

function ValueRow({ card }: { card: PlayerCardT }) {
  const v = card.value;
  return (
    <div className="grid grid-cols-4 gap-1.5 text-sm">
      <Stat label="VORP (pre)" value={v ? v.vorp.toFixed(2) : '—'} tip="vorp" />
      <Stat label="pre, after injury" value={v ? v.adjustedVorp.toFixed(2) : '—'} tip="adjusted" />
      <Stat
        label="proj GP"
        value={v ? v.gp.toFixed(0) : '—'}
        hint="Rest-of-season games, net of time out"
      />
      <Stat
        label="this week"
        value={`${card.schedule.gamesThisWeek} gm`}
        hint={card.schedule.gameToday ? `Today ${card.schedule.gameToday}` : 'No game today'}
      />
    </div>
  );
}

function FitLine({ card }: { card: PlayerCardT }) {
  const { fit, score, targets, targetHits } = card.fit;
  return (
    <div className="rounded-lg bg-well px-2 py-1.5 text-sm">
      <span className="text-mut">
        <StatTip k="fit">Fit to our needs</StatTip>{' '}
      </span>
      <b className={fit === null ? '' : fit >= 0 ? 'text-good' : 'text-bad'}>{signed(fit)}</b>
      {score !== null ? <span className="text-mut"> · score {score.toFixed(2)}</span> : null}
      {card.market.adp !== null ? (
        <span className="text-mut"> · ADP {card.market.adp.toFixed(0)}</span>
      ) : null}
      {card.market.percentOwned !== null ? (
        <span className="text-mut"> · {card.market.percentOwned}% owned</span>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
        <span className="text-mut">Our targets:</span>
        {targets.map((t) => (
          <span
            key={t}
            className={`pill ${targetHits.includes(t) ? 'border-good/60 text-good' : ''}`}
          >
            {t}
            {targetHits.includes(t) ? ' ✓' : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
