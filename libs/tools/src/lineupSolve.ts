import { solveLineup, type LineupPlayer, type LineupResult } from '@fha/model';
import { lineupEntries } from './derive.js';
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

export function solveOurLineup(
  view: LeagueView,
  date: string,
  now: string,
  overrides: readonly LineupOverride[] = [],
): SolveOutcome {
  const entries = lineupEntries(view, date, now);
  const byKey = new Map(entries.map((e) => [e.playerKey, e]));
  for (const o of overrides) {
    const e = byKey.get(o.playerKey);
    const name = view.player(o.playerKey)?.name ?? o.playerKey;
    if (e === undefined) {
      return {
        ok: false,
        error: `${name} (${o.playerKey}) is not on our roster, so he cannot be overridden. Call getRoster and use its playerKeys.`,
      };
    }
    if (e.locked) {
      return {
        ok: false,
        error: `${name}'s game on ${date} has started, so he is locked. Remove his override.`,
      };
    }
    if (!o.bench && !e.hasGame) {
      return {
        ok: false,
        error: `${name} has no game on ${date}, so he cannot be started. Remove his override.`,
      };
    }
    if (o.bench) e.hasGame = false;
    else e.status = undefined;
  }
  return { ok: true, entries, result: solveLineup({ slots: view.settings.rosterSlots, entries }) };
}
