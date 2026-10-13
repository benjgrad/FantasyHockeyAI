import type { Player } from '@fha/core';
import {
  availabilityAdjustedVorp,
  categoryWinsAdded,
  goalieLuck,
  skaterLuck,
  weeklyCategoryPlan,
  type LuckFlag,
  type WeekSide,
} from '@fha/model';
import type { Store } from '@fha/store';
import { scoringCategories } from './derive.js';
import { playerSeasonShare } from './leagueCompare.js';
import {
  SEASON_WEEKS,
  liveSides,
  modelInputs,
  opponentFor,
  remainingWeekLine,
  remainingWeekLineFor,
  seasonHorizonGames,
  weeksRemaining,
} from './modelInputs.js';
import { ROS_LENS, rosLensView } from './valuationLens.js';
import type { LeagueView } from './view.js';

/**
 * The mid-season value family (D-026): one labelled number per question, all computed in code.
 *
 * | measure  | question                                   |
 * |----------|--------------------------------------------|
 * | value    | how good is he from here (rest-of-season §12.2 value)   |
 * | vols     | how does he compare league-wide (value over the last starter at his position) |
 * | adjusted | `vols` with expected time out taken off, once |
 * | vofa     | is he worth a roster spot today (over the best free agent at his position) |
 * | cwa      | what does he do for *our* team (Δ expected categories won a week) |
 * | weekCwa  | what does he do for *this* matchup (the rest of this week) |
 * | luck     | is a hot or cold run finishing / save-percentage luck |
 */

export interface PlayerRef {
  playerKey: string;
  name: string;
}

export interface PlayerValueNow {
  playerKey: string;
  value: number;
  vols: number;
  perGameValue: number;
  adjusted: number;
  vofa: number;
  /** The position his free-agent bar was taken at, and the free agent who sets it. */
  vofaPosition: string | undefined;
  vofaAgainst: PlayerRef | undefined;
  cwa: number | undefined;
  cwaByCategory: Record<string, number>;
  /** Who would leave to make room (or come in, for one of ours). */
  cwaSwap: PlayerRef | undefined;
  weekCwa: number | undefined;
  gpCurrent: number;
  weightCurrent: number;
  lowConfidence: boolean;
  luck: LuckFlag | undefined;
  preseason: { value: number; vorp: number; adjusted: number };
}

export interface ValueNow {
  lens: string;
  asOf: string;
  players: ReadonlyMap<string, PlayerValueNow>;
  /** The best healthy free agent per position, by availability-adjusted VOLS. */
  bestFreeAgent: Record<string, PlayerRef & { adjusted: number }>;
}

/** Positions a free-agent bar is kept for. */
export const VOFA_POSITIONS = ['C', 'LW', 'RW', 'D', 'G'] as const;
/** A free agent counts toward a bar only if expected to play this share of what is left. */
const HEALTHY_SHARE = 0.9;

const cache = new WeakMap<LeagueView, WeakMap<Store, ValueNow>>();

export function valueNow(view: LeagueView, store: Store): ValueNow {
  let byStore = cache.get(view);
  if (byStore === undefined) {
    byStore = new WeakMap();
    cache.set(view, byStore);
  }
  const hit = byStore.get(store);
  if (hit !== undefined) return hit;
  const built = build(view, store);
  byStore.set(store, built);
  return built;
}

const ref = (p: Player): PlayerRef => ({ playerKey: p.playerKey, name: p.name });

function positionsOf(p: Player): string[] {
  return VOFA_POSITIONS.filter((x) => p.eligible.includes(x) || (x === 'G' && p.positionType === 'G'));
}

function build(view: LeagueView, store: Store): ValueNow {
  const { view: lens, players: meta, histories } = rosLensView(view, store);
  const adjusted = new Map<string, number>();
  for (const p of view.snap.players) {
    const v = lens.valuation(p.playerKey);
    if (v !== undefined) adjusted.set(p.playerKey, availabilityAdjustedVorp(v.vorp, playerSeasonShare(view, p)));
  }
  const best = bestFreeAgents(view, adjusted);
  const cwa = categoryWins(lens);
  const week = weekWins(lens);
  const out = new Map<string, PlayerValueNow>();
  for (const p of view.snap.players) {
    const v = lens.valuation(p.playerKey);
    const pre = view.valuation(p.playerKey);
    const adj = adjusted.get(p.playerKey);
    if (v === undefined || pre === undefined || adj === undefined) continue;
    // The scarcest of his positions: the one whose best free agent is weakest (as VORP does).
    const bars = positionsOf(p).flatMap((pos) => {
      const b = best[pos];
      return b === undefined ? [] : [{ pos, b }];
    });
    const bar = bars.reduce<(typeof bars)[number] | undefined>((a, x) => (a === undefined || x.b.adjusted < a.b.adjusted ? x : a), undefined);
    const c = cwa.get(p.playerKey);
    const m = meta.get(p.playerKey);
    const h = histories.get(p.playerKey);
    out.set(p.playerKey, {
      playerKey: p.playerKey,
      value: v.value,
      vols: v.vorp,
      perGameValue: v.perGameValue,
      adjusted: adj,
      vofa: bar === undefined ? adj : adj - bar.b.adjusted,
      vofaPosition: bar?.pos,
      vofaAgainst: bar === undefined ? undefined : { playerKey: bar.b.playerKey, name: bar.b.name },
      cwa: c?.cwa,
      cwaByCategory: c?.byCategory ?? {},
      cwaSwap: c?.swap,
      weekCwa: week.get(p.playerKey),
      gpCurrent: m?.gpCurrent ?? 0,
      weightCurrent: m?.weightCurrent ?? 0,
      lowConfidence: m?.lowConfidence ?? true,
      luck: h === undefined || h.games.length === 0 ? undefined : h.kind === 'skater' ? skaterLuck(h.games) : goalieLuck(h.games),
      preseason: {
        value: pre.value,
        vorp: pre.vorp,
        adjusted: availabilityAdjustedVorp(pre.vorp, playerSeasonShare(view, p)),
      },
    });
  }
  return { lens: ROS_LENS, asOf: view.snap.date, players: out, bestFreeAgent: best };
}

function bestFreeAgents(
  view: LeagueView,
  adjusted: ReadonlyMap<string, number>,
): Record<string, PlayerRef & { adjusted: number }> {
  const out: Record<string, PlayerRef & { adjusted: number }> = {};
  for (const p of view.snap.players) {
    if (!view.isFreeAgent(p.playerKey) || playerSeasonShare(view, p) < HEALTHY_SHARE) continue;
    const a = adjusted.get(p.playerKey);
    if (a === undefined) continue;
    for (const pos of positionsOf(p)) {
      const cur = out[pos];
      if (cur === undefined || a > cur.adjusted) out[pos] = { ...ref(p), adjusted: a };
    }
  }
  return out;
}

/** CWA for every valued player, on the lens, against the whole league field. */
function categoryWins(
  lens: LeagueView,
): Map<string, { cwa: number; byCategory: Record<string, number>; swap: PlayerRef | undefined }> {
  const m = modelInputs(lens);
  const out = new Map<string, { cwa: number; byCategory: Record<string, number>; swap: PlayerRef | undefined }>();
  const results = categoryWinsAdded(
    {
      settings: lens.settings,
      categories: scoringCategories(lens.settings),
      ourRoster: m.rosterIds(lens.teamKey),
      otherRosters: lens.otherTeams().map((t) => m.rosterIds(t.teamKey)),
      projections: m.projections,
      valuations: m.valuations,
      freeAgents: m.freeAgentIds(),
      weeksRemaining: weeksRemaining(lens.snap.week),
      projectionWeeks: SEASON_WEEKS,
      horizonGames: seasonHorizonGames(lens),
      availability: m.availability,
    },
    m.valuations.map((v) => v.nhlId),
  );
  for (const r of results) {
    const swapKey = r.swappedWith === undefined ? undefined : m.key(r.swappedWith);
    const swap = swapKey === undefined ? undefined : lens.player(swapKey);
    out.set(m.key(r.nhlId), {
      cwa: r.cwa,
      byCategory: r.byCategory,
      swap: swap === undefined ? undefined : ref(swap),
    });
  }
  return out;
}

/**
 * Week CWA: Δ expected categories won in this week's matchup (banked score included) if a free
 * agent joins us now, or if one of ours sits out the rest of the week. Free agents and ours only.
 */
function weekWins(lens: LeagueView): Map<string, number> {
  const out = new Map<string, number>();
  const opponent = opponentFor(lens, lens.snap.week);
  if (opponent === undefined) return out;
  const cats = scoringCategories(lens.settings);
  const from = lens.snap.date;
  const live = liveSides(lens, opponent.teamKey, cats);
  const after = live === undefined ? {} : { notStartedAfter: lens.snap.recordedAt };
  const them: WeekSide = { remaining: remainingWeekLine(lens, opponent.teamKey, from, after) };
  if (live !== undefined) them.actual = live.them;
  const ours = lens
    .roster()
    .entries.filter((e) => e.slot !== 'IR' && e.slot !== 'IR+')
    .map((e) => e.player.playerKey);
  const won = (keys: readonly string[]) => {
    const us: WeekSide = { remaining: remainingWeekLineFor(lens, keys, from, after) };
    if (live !== undefined) us.actual = live.us;
    return weeklyCategoryPlan(us, them, cats).expectedWon;
  };
  const base = won(ours);
  for (const key of ours) out.set(key, base - won(ours.filter((k) => k !== key)));
  for (const p of lens.snap.players) {
    if (lens.isFreeAgent(p.playerKey) && lens.valuation(p.playerKey) !== undefined) {
      out.set(p.playerKey, won([...ours, p.playerKey]) - base);
    }
  }
  return out;
}
