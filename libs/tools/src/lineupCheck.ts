import { auditLineup, type LineupAudit, type LineupInput, type LineupPlayer } from '@fha/model';
import type { Store } from '@fha/store';
import { nameKeys } from './derive.js';
import { goalieStartsFor } from './goalieStarts.js';
import { ourLineupEntries, type LineupOverride } from './lineupSolve.js';
import type { LeagueView } from './view.js';

/**
 * Deterministic lineup checks for our team (D-044): the inputs are sound, and the lineup starts
 * every player who plays. The lineup guard, plan validation and the tools all use these.
 */

/**
 * Problems that make any solve or audit of `date` unsafe (P5). A player who silently reads as
 * "no game" is the dangerous case: the solver then rationally benches him (the TB/TBL bug).
 */
export function lineupInputProblems(view: LeagueView, date: string): string[] {
  const day = view.snap.schedule.find((d) => d.date === date);
  if (day === undefined) {
    return [`The NHL schedule for ${date} is not loaded, so no one's games can be verified.`];
  }
  const teams = new Set(view.snap.schedule.flatMap((d) => d.games.flatMap((g) => [g.home, g.away])));
  return view
    .roster()
    .entries.filter(({ player }) => !teams.has(player.nhlTeam))
    .map(
      ({ player }) =>
        `${player.name}'s team ${player.nhlTeam || '(none)'} plays no game in the loaded schedule (${view.snap.schedule[0]?.date ?? '?'}..${view.snap.schedule.at(-1)?.date ?? '?'}): a team abbreviation mismatch would read as "no game" every day.`,
    );
}

/** Warnings worth logging that do not block: a player we cannot value starts last. */
export function lineupInputWarnings(view: LeagueView): string[] {
  return view
    .roster()
    .entries.filter(({ player }) => view.valuation(player.playerKey) === undefined)
    .map(({ player }) => `${player.name} has no valuation, so he ranks as 0.`);
}

export type LineupCheck =
  | { ok: false; problems: string[] }
  | {
      ok: true;
      input: LineupInput;
      entries: LineupPlayer[];
      audit: LineupAudit;
      warnings: string[];
    };

/**
 * Our lineup on `date` as the solver sees it (same goalie starts, same overrides), audited.
 * `assignments` audits a planned lineup instead of the current one.
 */
export function checkOurLineup(
  view: LeagueView,
  store: Store | undefined,
  userId: string | undefined,
  date: string,
  now: string,
  opts: {
    overrides?: readonly Pick<LineupOverride, 'playerKey' | 'bench'>[];
    assignments?: readonly { playerKey: string; slot: string }[];
  } = {},
): LineupCheck {
  const input = ourLineupInput(view, store, userId, date, now, opts.overrides);
  if (!input.ok) return input;
  return {
    ok: true,
    input: input.input,
    entries: input.input.entries as LineupPlayer[],
    audit: auditLineup(input.input, opts.assignments),
    warnings: lineupInputWarnings(view),
  };
}

/** The solver's input for our team on `date`, or the problems that make it unsafe. */
export function ourLineupInput(
  view: LeagueView,
  store: Store | undefined,
  userId: string | undefined,
  date: string,
  now: string,
  overrides: readonly Pick<LineupOverride, 'playerKey' | 'bench'>[] = [],
): { ok: true; input: LineupInput } | { ok: false; problems: string[] } {
  const problems = lineupInputProblems(view, date);
  if (problems.length > 0) return { ok: false, problems };
  const goalieStarts = goalieStartsFor(view, store, userId, date, now);
  const built = ourLineupEntries(view, date, now, overrides, goalieStarts);
  if (!built.ok) return { ok: false, problems: [built.error] };
  return { ok: true, input: { slots: view.settings.rosterSlots, entries: built.entries } };
}

/** The audit's findings of `severity`, with players named. */
export function findingTexts(
  view: LeagueView,
  audit: LineupAudit,
  severity: 'error' | 'warn' | 'info',
): string[] {
  return audit.findings.filter((f) => f.severity === severity).map((f) => nameKeys(view, f.text));
}
