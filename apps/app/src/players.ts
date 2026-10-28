import type { PlayerCard } from '@fha/api';
import type { Player } from '@fha/core';
import { GOALIE_RATE_CATEGORIES, lowerIsBetter, type Availability } from '@fha/model';
import {
  availabilityOf,
  categoriesFor,
  dayStatus,
  playerFit,
  weeksRemaining,
  SEASON_WEEKS,
  type LeagueView,
} from '@fha/tools';
import { newYorkDate } from './league.js';
import { reasonsFor } from './playersReasons.js';
import { valueNowView } from './playerValueNow.js';
import type { Store } from '@fha/store';
import {
  categoryStrength,
  restOfSeasonGames,
  adjustedVorpOf,
  type Strength,
} from './playersStrength.js';

/**
 * The player card: the draft board's card (apps/web `PlayerCard`) adapted to the season.
 *
 * Totals are **rest of season**: the snapshot's per-game projection times the games he is
 * expected to play from here, which is the season's remaining share of his projected games
 * less the games his injury is expected to cost. So an injured player's card shows what we
 * would actually get from him, not what a healthy season would give. Per-game numbers and
 * z-scores are the rest-of-season lens's (D-040), the same ones his fit is computed from, against
 * the rostered pool and oriented so higher is better in every category.
 */
export interface CardContext {
  view: LeagueView;
  strength: Strength;
  /** Today in New York: the day "game today" and "games this week" count from. */
  today: string;
  nowIso: string;
  gamesThisWeek: Map<string, number>;
  /** Game history and the stored value days; without it the card has no rest-of-season part. */
  store?: Store;
}

export function cardContext(view: LeagueView, now: Date, store?: Store): CardContext {
  const today = view.snap.date > newYorkDate(now) ? view.snap.date : newYorkDate(now);
  return {
    view,
    strength: categoryStrength(view, store),
    today,
    nowIso: now.toISOString(),
    gamesThisWeek: view.gamesBetween(today, view.weekOf().end),
    ...(store === undefined ? {} : { store }),
  };
}

export { categoriesFor };

const round = (n: number, dp = 2): number => Math.round(n * 10 ** dp) / 10 ** dp;
const dpFor = (cat: string): number => (cat === 'SV%' ? 3 : cat === 'GAA' ? 2 : 1);

/** Rest-of-season projected games: the season's remaining share, less expected time out. */
export function restOfSeasonGp(view: LeagueView, p: Player, a: Availability): number | null {
  const pr = view.projection(p.playerKey);
  if (pr === undefined) return null;
  const share = Math.min(1, pr.gp / 82);
  const left = pr.gp * (weeksRemaining(view.snap.week) / SEASON_WEEKS);
  return Math.max(0, left - Math.min(restOfSeasonGames(view), a.expectedGamesMissed) * share);
}

export function ownerOf(view: LeagueView, key: string): PlayerCard['owner'] {
  const teamKey = view.ownerOf(key);
  if (teamKey === undefined) {
    const p = view.player(key);
    return p?.onWaivers === true
      ? {
          kind: 'waivers',
          teamKey: null,
          name: `waivers${p.waiverDate === undefined ? '' : ` until ${p.waiverDate}`}`,
        }
      : { kind: 'freeAgent', teamKey: null, name: 'free agent' };
  }
  if (teamKey === view.teamKey) return { kind: 'us', teamKey, name: 'us' };
  const name = view.snap.teams.find((t) => t.teamKey === teamKey)?.name ?? teamKey;
  return { kind: 'team', teamKey, name };
}

function gameToday(c: CardContext, p: Player): string | null {
  const g = dayStatus(c.view, p, c.today, c.nowIso);
  if (g.opponent === undefined || g.startTimeUtc === undefined) return null;
  const time = new Date(g.startTimeUtc).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `vs ${g.opponent} ${time} ET${g.locked ? ' (locked)' : ''}`;
}

function categoriesOf(c: CardContext, p: Player, gp: number | null): PlayerCard['categories'] {
  const lens = c.strength.lens.view;
  const pr = lens.projection(p.playerKey);
  const v = lens.valuation(p.playerKey);
  return categoriesFor(c.view, p.positionType).map((cat) => {
    const perGame = pr?.perGame[cat];
    const rate = (GOALIE_RATE_CATEGORIES as readonly string[]).includes(cat);
    const total = perGame === undefined || gp === null ? null : rate ? perGame : perGame * gp;
    return {
      cat,
      total: total === null ? null : round(total, dpFor(cat)),
      perGame: perGame === undefined ? null : round(perGame, 3),
      z: v?.z[cat] === undefined ? null : round(v.z[cat]),
      lowerIsBetter: lowerIsBetter(cat),
    };
  });
}

/** His fit to our needs, from the same lens and weights as the category-strength panel. */
export function fitOf(c: CardContext, p: Player): PlayerCard['fit'] {
  const { weights, targets, lens } = c.strength;
  const f = playerFit(lens, weights, p);
  const targetHits = targets.filter((t) => (f.z[t] ?? 0) >= 0.5);
  return { fit: f.fit, score: f.score, weights, targets, targetHits, lens: f.lens };
}

function valueOf(c: CardContext, p: Player, gp: number | null): PlayerCard['value'] {
  const v = c.view.valuation(p.playerKey);
  if (v === undefined) return null;
  return {
    value: round(v.value),
    vorp: round(v.vorp),
    adjustedVorp: round(adjustedVorpOf(c.view, p) ?? v.vorp),
    perGameValue: round(v.perGameValue, 4),
    gp: round(gp ?? v.gp, 1),
  };
}

function availabilityPart(c: CardContext, p: Player, a: Availability): PlayerCard['availability'] {
  const note = (c.view.snap.news[p.playerKey] ?? []).find((l) => !l.startsWith('Status:'));
  return {
    label: a.label,
    status: p.status ?? null,
    playProb: a.playProb,
    source: a.source,
    expectedReturn: a.expectedReturn ?? null,
    expectedGamesMissed: round(a.expectedGamesMissed, 1),
    note: a.source === 'healthy' ? null : (note ?? null),
  };
}

/** The card for a player already resolved against the league index (P3). */
export function buildCard(c: CardContext, p: Player): PlayerCard {
  const a = availabilityOf(c.view, p);
  const gp = restOfSeasonGp(c.view, p, a);
  const card: Omit<PlayerCard, 'reasons'> = {
    playerKey: p.playerKey,
    name: p.name,
    nhlTeam: p.nhlTeam,
    positions: p.eligible.filter((e) => e !== 'Util'),
    positionType: p.positionType === 'G' ? 'G' : 'P',
    owner: ownerOf(c.view, p.playerKey),
    availability: availabilityPart(c, p, a),
    value: valueOf(c, p, gp),
    fit: fitOf(c, p),
    now: valueNowView(c.view, c.store, p.playerKey),
    market: { adp: p.adp ?? null, percentOwned: p.percentOwned ?? null },
    lowConfidence: c.view.valuation(p.playerKey)?.lowConfidence ?? true,
    categories: categoriesOf(c, p, gp),
    schedule: { gamesThisWeek: c.gamesThisWeek.get(p.nhlTeam) ?? 0, gameToday: gameToday(c, p) },
    news: c.view.snap.news[p.playerKey] ?? [],
  };
  return { ...card, reasons: reasonsFor(card, c) };
}
