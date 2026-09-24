import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Projection, Valuation } from '@fha/core';
import {
  nhlPositionOf,
  eligibleSlots,
  pickNumbersFor,
  projectAll,
  scoreBoard,
  startingGoalieSlotCount,
  startingSkaterSlotCount,
  unfilledStartingSlots,
} from '@fha/model';
import { lowerIsBetter } from '@fha/model';
import { readSeason, recentSeasons } from '@fha/nhl';
import { buildRanking } from '../../gm/src/commands/rank.js';
import { loadLeague } from '../../gm/src/config.js';
import { readDraft, readPlayerMap } from '../../gm/src/commands/yahooFiles.js';

const STATE_PATH = 'data/draft-state.json';

export interface PlayerCard {
  nhlId: number;
  name: string;
  position: string;
  team: string;
  vorp: number;
  score: number;
  fit: number;
  urgency: number;
  need: number;
  gp: number;
  adp?: number;
  marketRank?: number;
  lowConfidence: boolean;
  /** Every scored category, best first, as a z-score against the draftable pool. */
  cats: { cat: string; z: number }[];
  /** Projected season totals for the scored categories — the actual numbers, not z-scores. */
  stats: { cat: string; total: number }[];
  /** Plain-language justifications, generated from the numbers. */
  reasons: string[];
}

export interface DraftView {
  now: string;
  draftStatus: string;
  onClock?: { pick: number; teamId: string; secs: number; isOurs: boolean };
  ourSeat?: number;
  ourPicks: number[];
  nextOurPick?: number;
  picksMade: number;
  totalPicks: number;
  recommendation?: PlayerCard;
  alternates: PlayerCard[];
  roster: { name: string; position: string; team: string; vorp: number }[];
  openSlots: string[];
  categoryStrength: { cat: string; z: number }[];
  recentPicks: { pick: number; name: string; position: string; mine: boolean }[];
  /** Categories where a lower number is better, so the UI colours a delta correctly. */
  lowerIsBetter: string[];
  pendingOverride?: { nhlId: number; name: string };
  warnings: string[];
}

/**
 * Cache the expensive half of the view.
 *
 * Projections and valuations depend only on the cached NHL seasons, the Yahoo pool, the player
 * map and the league config — never on who has already been drafted. The page polls every few
 * seconds and the push watcher polls again, so recomputing about a second of maths twice per
 * three seconds would burn a core for nothing. Keyed on input mtimes, so a pre-flight rebuild is
 * picked up immediately with no cache busting to remember.
 */
const CACHE_INPUTS = [
  'data/yahoo/pool.json',
  'data/yahoo/player-map.json',
  'config/league.yaml',
  'config/draft-overrides.yaml',
  'data/nhl/20252026.json',
];
let cache:
  | { key: string; ranking: ReturnType<typeof buildRanking>; totals: Map<number, Projection> }
  | undefined;

function cacheKey(): string {
  return CACHE_INPUTS.map((f) => {
    try {
      return `${f}:${statSync(f).mtimeMs}`;
    } catch {
      return `${f}:absent`;
    }
  }).join('|');
}

function rankingAndTotals(): {
  ranking: ReturnType<typeof buildRanking>;
  totals: Map<number, Projection>;
} {
  const key = cacheKey();
  if (cache?.key === key) return { ranking: cache.ranking, totals: cache.totals };
  const { settings } = loadLeague();
  const ranking = buildRanking();
  const projections = projectAll({
    seasons: recentSeasons(2025, 3)
      .map((id) => readSeason('data', id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined),
    skaterPoolSize: settings.numTeams * startingSkaterSlotCount(settings.rosterSlots),
    goaliePoolSize: settings.numTeams * startingGoalieSlotCount(settings.rosterSlots),
  });
  const totals = new Map(projections.map((p) => [p.nhlId, p]));
  cache = { key, ranking, totals };
  return { ranking, totals };
}

function readState():
  { numTeams: number; slot: number; rounds: number; picks: unknown[] } | undefined {
  if (!existsSync(STATE_PATH)) return undefined;
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as {
    numTeams: number;
    slot: number;
    rounds: number;
    picks: unknown[];
  };
}

/**
 * Turn the scoring terms into sentences.
 *
 * The numbers are the truth, but nobody reads a board on a phone during a draft and works
 * out why `fit +2.4` matters. Each sentence is derived from a term that actually moved the
 * score, so the explanation cannot drift from the decision.
 */
function explain(
  v: Valuation,
  s: { need: number; fit: number; urgency: number; nextBest: number },
  openSlots: readonly string[],
  nextPick: number | undefined,
  cats: readonly string[],
): string[] {
  const out: string[] = [];
  const fills = openSlots.includes(v.vorpPosition);
  if (fills) out.push(`Fills an open ${v.vorpPosition} slot.`);
  else if (s.need < 1)
    out.push(`${v.vorpPosition} is already covered — counted at ${s.need.toFixed(2)}x.`);

  if (s.urgency > 0) out.push(`Urgent: starting slots are running out of picks to fill them.`);
  else if (s.urgency < 0) out.push(`Held back: cannot fill a slot we still need.`);

  if (Math.abs(s.fit) >= 0.5) {
    const strong = cats
      .map((c) => ({ c, z: v.z[c] ?? 0 }))
      .sort((a, b) => b.z - a.z)
      .slice(0, 2)
      .map((x) => x.c)
      .join(' and ');
    out.push(
      s.fit > 0
        ? `Helps where we are behind (${strong}): fit ${s.fit >= 0 ? '+' : ''}${s.fit.toFixed(2)}.`
        : `Piles into categories we already lead: fit ${s.fit.toFixed(2)}.`,
    );
  }

  if (nextPick !== undefined) {
    const gap = v.vorp - s.nextBest;
    if (gap > 1.5)
      out.push(
        `Unlikely to last to pick ${nextPick} — ${gap.toFixed(1)} better than what should survive.`,
      );
    else if (gap < 0.3) out.push(`Comparable value should still be there at pick ${nextPick}.`);
  }

  if (v.lowConfidence) out.push(`Thin data: projection is unreliable, judge this one yourself.`);
  if (v.adp !== undefined && v.marketRank !== undefined) {
    const ourRank = v.marketRank;
    if (v.adp - ourRank > 25)
      out.push(`Market takes him around ${v.adp.toFixed(0)}; we rate him higher.`);
  }
  return out;
}

export function buildView(): DraftView {
  const warnings: string[] = [];
  const { settings, teamKey } = loadLeague();
  const { ranking: r, totals } = rankingAndTotals();
  const state = readState();
  const yd = readDraft();
  const map = readPlayerMap();
  const keyByNhlId = new Map<number, string>();
  if (map) for (const [k, id] of map) keyByNhlId.set(id, k);

  const cats = settings.categories.filter((c) => !c.isDisplayOnly).map((c) => c.abbr);
  if (!state) warnings.push('No draft state yet — run "fha draft init".');
  if (!yd) warnings.push('No draft data from Yahoo yet.');
  if (!map) warnings.push('No player map — the board is not restricted to Yahoo’s pool.');

  const numTeams = state?.numTeams ?? settings.numTeams;
  const rounds = state?.rounds ?? 17;
  const slot = state?.slot ?? 1;
  const takenIds = new Set<number>();
  const mineIds = new Set<number>();
  const recentPicks: DraftView['recentPicks'] = [];

  for (const p of (yd?.picks ?? []).slice().sort((a, b) => a.pick - b.pick)) {
    const nhlId = p.playerKey ? map?.get(p.playerKey) : undefined;
    if (nhlId !== undefined) {
      takenIds.add(nhlId);
      if (teamKey && p.teamKey === teamKey) mineIds.add(nhlId);
    }
    const v = nhlId !== undefined ? r.valuations.find((x) => x.nhlId === nhlId) : undefined;
    recentPicks.push({
      pick: p.pick,
      name: v?.name ?? p.playerKey ?? 'unknown',
      position: v?.position ?? '?',
      mine: Boolean(teamKey && p.teamKey === teamKey),
    });
  }

  const available = r.valuations.filter((v) => !takenIds.has(v.nhlId));
  const myRoster = r.valuations.filter((v) => mineIds.has(v.nhlId));
  const ourPicks = pickNumbersFor(slot, numTeams, rounds);
  const onClockPick = yd?.onClock?.pick ?? (yd?.picks?.length ?? 0) + 1;
  const nextOurPick = ourPicks.find((p) => p > onClockPick);
  const openSlots = unfilledStartingSlots(myRoster, settings);

  const board = scoreBoard({
    available,
    myRoster,
    settings,
    categories: cats,
    picksRemaining: ourPicks.filter((p) => p >= onClockPick).length,
    ...(nextOurPick === undefined ? {} : { nextPick: nextOurPick }),
  });

  const card = (s: (typeof board)[number]): PlayerCard => {
    const v = s.valuation;
    const zs = cats
      .map((c) => ({ cat: c, z: Number((v.z[c] ?? 0).toFixed(2)) }))
      .sort((a, b) => b.z - a.z);
    const proj = totals.get(v.nhlId);
    // Rate categories are already rates; counting categories are season totals.
    const stats = cats.map((c) => ({
      cat: c,
      total: Number((proj?.totals[c] ?? 0).toFixed(c === 'SV%' ? 3 : c === 'GAA' ? 2 : 0)),
    }));
    return {
      nhlId: v.nhlId,
      name: v.name,
      position: v.position,
      team: v.team,
      vorp: Number(v.vorp.toFixed(2)),
      score: Number(s.score.toFixed(2)),
      fit: Number(s.fit.toFixed(2)),
      urgency: Number(s.urgency.toFixed(2)),
      need: Number(s.need.toFixed(2)),
      gp: Math.round(v.gp),
      ...(v.adp === undefined ? {} : { adp: v.adp }),
      ...(v.marketRank === undefined ? {} : { marketRank: v.marketRank }),
      lowConfidence: v.lowConfidence,
      cats: zs,
      stats,
      reasons: explain(v, s, openSlots, nextOurPick, cats),
    };
  };

  const strength = cats
    .map((c) => ({ cat: c, z: Number(myRoster.reduce((a, p) => a + (p.z[c] ?? 0), 0).toFixed(2)) }))
    .sort((a, b) => a.z - b.z);

  const preferPath = 'data/draft-prefer.json';
  const pending = existsSync(preferPath)
    ? (JSON.parse(readFileSync(preferPath, 'utf-8')) as { nhlId: number; name: string })
    : undefined;

  const isOurs = Boolean(
    yd?.onClock && teamKey && `${settings.leagueKey}.t.${yd.onClock.teamId}` === teamKey,
  );

  return {
    now: new Date().toISOString(),
    draftStatus: yd?.draftStatus ?? 'unknown',
    ...(yd?.onClock ? { onClock: { ...yd.onClock, isOurs } } : {}),
    ourSeat: slot,
    ourPicks,
    ...(nextOurPick === undefined ? {} : { nextOurPick }),
    picksMade: yd?.picks?.length ?? 0,
    totalPicks: numTeams * rounds,
    ...(board[0] ? { recommendation: card(board[0]) } : {}),
    alternates: board.slice(1, 9).map(card),
    roster: myRoster
      .slice()
      .sort((a, b) => b.vorp - a.vorp)
      .map((v) => ({
        name: v.name,
        position: v.position,
        team: v.team,
        vorp: Number(v.vorp.toFixed(2)),
      })),
    openSlots,
    categoryStrength: strength,
    recentPicks: recentPicks.slice(-12).reverse(),
    lowerIsBetter: cats.filter((c) => lowerIsBetter(c)),
    ...(pending ? { pendingOverride: pending } : {}),
    warnings,
  };
}

export function eligibleFor(
  v: Valuation,
  settings: ReturnType<typeof loadLeague>['settings'],
): string[] {
  return eligibleSlots(nhlPositionOf(v.position), settings.rosterSlots, v.eligible ?? []);
}
