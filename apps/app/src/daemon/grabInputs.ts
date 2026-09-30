import { weeklyAddCap, type Permissions } from '@fha/core';
import {
  healthyGain,
  isOut,
  type OpportunityCandidate,
  type OpportunityInput,
  type OpportunityPlayer,
} from '@fha/model';
import type { Store } from '@fha/store';
import {
  addsUsedThisWeek,
  gateStateFor,
  modelInputs,
  weekBounds,
  type LeagueView,
} from '@fha/tools';

/**
 * The league view → the auto-grab opportunity inputs (D-016). One translation for the watcher's
 * "who is worth watching", the rules' pre-check and the evaluation itself, so they cannot
 * disagree about the numbers. The math lives in libs/model (`evaluateOpportunity`).
 */
export type GrabBase = Omit<OpportunityInput, 'candidate'>;

/** Injured free agents watched for their return, at most. */
export const WATCHED_INJURED = 25;

const RESERVE = ['IR', 'IR+', 'NA'];
const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
}

function openReserveSeats(view: LeagueView): string[] {
  const used = new Map<string, number>();
  for (const e of view.roster().entries) used.set(e.slot, (used.get(e.slot) ?? 0) + 1);
  return view.settings.rosterSlots
    .filter((s) => RESERVE.includes(s.position))
    .flatMap((s) =>
      Array.from({ length: Math.max(0, s.count - (used.get(s.position) ?? 0)) }, () => s.position),
    );
}

/** Everything but the candidate: our roster, the week, the caps and the no-drop lists. */
export function grabBase(view: LeagueView, store: Store, perms: Permissions): GrabBase {
  const m = modelInputs(view);
  const roster: OpportunityPlayer[] = [];
  let unvalued = 0;
  for (const { player, slot } of view.roster().entries) {
    const id = m.id(player.playerKey);
    const valuation = id === undefined ? undefined : m.valuationById(id);
    // A player we cannot value still takes a roster spot, but is never picked as the drop.
    if (valuation === undefined) {
      if (slot !== 'IR' && slot !== 'IR+') unvalued++;
      continue;
    }
    roster.push({ playerKey: player.playerKey, valuation, slot, status: player.status });
  }
  const { end } = weekBounds(view.snap.date);
  const weights = store.strategy.get(view.snap.week)?.weights;
  return {
    settings: view.settings,
    roster,
    unvaluedSpots: unvalued,
    availability: m.availability,
    gamesThisWeek: Object.fromEntries(view.gamesBetween(view.snap.date, end)),
    ...(weights === undefined ? {} : { weights }),
    daysRemaining: Math.min(7, Math.max(1, daysBetween(view.snap.date, end) + 1)),
    addsUsed: addsUsedThisWeek(view, store),
    addCap: weeklyAddCap(perms),
    minGain: perms.autoGrab.minGain,
    locked: perms.players.locked,
    protectedKeys: gateStateFor(view, store, perms).protectedKeys,
    ask: perms.players.ask,
    openReserveSlots: openReserveSeats(view),
  };
}

/** A player as an opportunity candidate, or undefined when the view cannot value him (P3). */
export function candidateFor(
  view: LeagueView,
  playerKey: string,
  ownership: Pick<OpportunityCandidate, 'ownership' | 'waiverDate'> = { ownership: 'freeAgent' },
): OpportunityCandidate | undefined {
  const m = modelInputs(view);
  const player = view.player(playerKey);
  const id = m.id(playerKey);
  const valuation = id === undefined ? undefined : m.valuationById(id);
  if (player === undefined || valuation === undefined) return undefined;
  return { playerKey, valuation, status: player.status, ...ownership };
}

/** Pre-check on the cached view: healthy, would he clear the bar? */
export function worthGrabbing(
  view: LeagueView,
  store: Store,
  perms: Permissions,
  playerKey: string,
): boolean {
  if (!perms.autoGrab.enabled || view.ownerOf(playerKey) === view.teamKey) return false;
  const candidate = candidateFor(view, playerKey);
  if (candidate === undefined) return false;
  return healthyGain({ ...grabBase(view, store, perms), candidate }) > perms.autoGrab.minGain;
}

/**
 * Injured free agents whose healthy value would clear the bar: the status watcher follows them,
 * so the moment one is back the rules can grab him. Best first, at most {@link WATCHED_INJURED}.
 */
export function injuredTargets(view: LeagueView, store: Store, perms: Permissions): string[] {
  if (!perms.autoGrab.enabled) return [];
  const base = grabBase(view, store, perms);
  return view.snap.players
    .filter((p) => view.isFreeAgent(p.playerKey) && isOut(p.status))
    .flatMap((p) => {
      const candidate = candidateFor(view, p.playerKey);
      if (candidate === undefined) return [];
      const gain = healthyGain({ ...base, candidate });
      return gain > perms.autoGrab.minGain ? [{ key: p.playerKey, gain }] : [];
    })
    .sort((a, b) => b.gain - a.gain || a.key.localeCompare(b.key))
    .slice(0, WATCHED_INJURED)
    .map((x) => x.key);
}
