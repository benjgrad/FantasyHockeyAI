import { solveLineup, type LineupPlayer, type LineupResult } from '@fha/model';
import { lineupEntries } from './derive.js';
import type { GoalieStartSignal } from './goalieStarts.js';
import type { LeagueView } from './view.js';

/**
 * The lineup solver (§12.3) applied to our roster, with the agent's overrides.
 *
 * An override is news the solver cannot know, expressed as a change to the solver's *inputs*,
 * never to its output, so the result is still a legal, optimal lineup:
 * - `bench: true`  — "he will not play" (late scratch): his P(plays) becomes 0;
 * - `bench: false` — "he will play despite his status" (cleared to return): status is ignored.
 */
export interface LineupOverride {
  playerKey: string;
  bench: boolean;
  reason: string;
}

export type SolveOutcome =
  | { ok: true; entries: LineupPlayer[]; result: LineupResult }
  | { ok: false; error: string };

export type EntriesOutcome = { ok: true; entries: LineupPlayer[] } | { ok: false; error: string };

/**
 * Our roster as the solver's input for `date`, with goalie starts and overrides applied. The one
 * builder the solver, plan validation and the lineup guard share (D-044), so they cannot
 * disagree about who plays.
 */
export function ourLineupEntries(
  view: LeagueView,
  date: string,
  now: string,
  overrides: readonly Pick<LineupOverride, 'playerKey' | 'bench'>[] = [],
  goalieStarts: readonly GoalieStartSignal[] = [],
): EntriesOutcome {
  const starts = new Map(goalieStarts.map((g) => [g.playerKey, g.pStart]));
  const entries = lineupEntries(view, date, now, (k) => starts.get(k));
  const error = applyOverrides(view, entries, date, overrides);
  return error === undefined ? { ok: true, entries } : { ok: false, error };
}

/** Apply overrides to the entries in place; the first problem, if any, as an instruction. */
export function applyOverrides(
  view: LeagueView,
  entries: LineupPlayer[],
  date: string,
  overrides: readonly Pick<LineupOverride, 'playerKey' | 'bench'>[],
): string | undefined {
  const byKey = new Map(entries.map((e) => [e.playerKey, e]));
  for (const o of overrides) {
    const e = byKey.get(o.playerKey);
    const name = view.player(o.playerKey)?.name ?? o.playerKey;
    if (e === undefined) {
      return `${name} (${o.playerKey}) is not on our roster, so he cannot be overridden. Call getRoster and use its playerKeys.`;
    }
    if (e.locked) return `${name}'s game on ${date} has started, so he is locked. Remove his override.`;
    if (!o.bench && !e.hasGame) {
      return `${name} has no game on ${date}, so he cannot be started. Remove his override.`;
    }
    if (o.bench) e.hasGame = false;
    else e.status = undefined;
  }
  return undefined;
}

export function solveOurLineup(
  view: LeagueView,
  date: string,
  now: string,
  overrides: readonly LineupOverride[] = [],
  opts: { goalieStarts?: readonly GoalieStartSignal[] } = {},
): SolveOutcome {
  const built = ourLineupEntries(view, date, now, overrides, opts.goalieStarts);
  if (!built.ok) return built;
  const { entries } = built;
  return { ok: true, entries, result: solveLineup({ slots: view.settings.rosterSlots, entries }) };
}
