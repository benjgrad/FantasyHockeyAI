import { weeklyAddCap, type Permissions } from '@fha/core';
import {
  clearsWhenHealthy,
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
  lensesFor,
  modelInputs,
  objectiveOf,
  openReserveSeats,
  pairWinDeltas,
  type LeagueView,
  type Objective,
} from '@fha/tools';

/**
 * The league view → the auto-grab opportunity inputs (D-016). One translation for the watcher's
 * "who is worth watching", the rules' pre-check and the evaluation itself, so they cannot
 * disagree about the numbers. The math lives in libs/model (`evaluateOpportunity`).
 */
export type GrabBase = Omit<OpportunityInput, 'candidate'>;

/** Injured free agents watched for their return, at most. */
export const WATCHED_INJURED = 25;

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
}

/**
 * Everything but the candidate: our roster, the week, the caps and the no-drop lists. `values`
 * is the view whose valuations are used: the lens Ben chose for auto-grab (D-026), by default the
 * one `lensesFor` picks; `view` stays the base for rosters, the gate and the week. On the
 * `winWeek` objective (D-034) the grab is judged on ΔP(win a typical week) on that lens.
 */
export function grabBase(
  view: LeagueView,
  store: Store,
  perms: Permissions,
  values: LeagueView = grabValues(view, store, perms),
  objective: Objective = objectiveOf(store),
): GrabBase {
  const m = modelInputs(values);
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
  const { end } = view.weekOf();
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
    ...(() => {
      const priority = view.waiverPriority();
      return priority === undefined
        ? {}
        : { waiverPriority: priority, numTeams: view.settings.numTeams };
    })(),
    ...(objective === 'winWeek'
      ? { winObjective: { delta: (pairs, opts) => pairWinDeltas(values, pairs, opts) } }
      : {}),
  };
}

const OBJECTIVES: readonly Objective[] = ['legacy', 'winWeek'];

/** The view auto-grab values players on: the lens chosen in permissions (D-026). */
export function grabValues(view: LeagueView, store: Store, perms: Permissions): LeagueView {
  return lensesFor(view, store, perms, 'autoGrab').active;
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

/**
 * Pre-check on the cached view: healthy, would he clear the bar? On either objective, so the
 * one in shadow still gets evaluated (and its disagreements recorded) before the switch.
 */
export function worthGrabbing(
  view: LeagueView,
  store: Store,
  perms: Permissions,
  playerKey: string,
): boolean {
  if (!perms.autoGrab.enabled || view.ownerOf(playerKey) === view.teamKey) return false;
  const values = grabValues(view, store, perms);
  const candidate = candidateFor(values, playerKey);
  if (candidate === undefined) return false;
  return OBJECTIVES.some((o) =>
    clearsWhenHealthy({ ...grabBase(view, store, perms, values, o), candidate }),
  );
}

/**
 * Injured free agents whose healthy value would clear the bar: the status watcher follows them,
 * so the moment one is back the rules can grab him. Best first, at most {@link WATCHED_INJURED}.
 */
export function injuredTargets(view: LeagueView, store: Store, perms: Permissions): string[] {
  if (!perms.autoGrab.enabled) return [];
  const values = grabValues(view, store, perms);
  // Ranked on the Adj. gain, kept if either objective would grab him healthy (see worthGrabbing).
  const [legacy, win] = OBJECTIVES.map((o) => grabBase(view, store, perms, values, o));
  return view.snap.players
    .filter((p) => view.isFreeAgent(p.playerKey) && isOut(p.status))
    .flatMap((p) => {
      const candidate = candidateFor(values, p.playerKey);
      if (candidate === undefined || legacy === undefined || win === undefined) return [];
      const a = { ...legacy, candidate };
      const keep = clearsWhenHealthy(a) || clearsWhenHealthy({ ...win, candidate });
      return keep ? [{ key: p.playerKey, gain: healthyGain(a) }] : [];
    })
    .sort((a, b) => b.gain - a.gain || a.key.localeCompare(b.key))
    .slice(0, WATCHED_INJURED)
    .map((x) => x.key);
}
