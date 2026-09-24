import { TOOL_FOR_KIND, type LeagueSettings, type Permissions } from '@fha/core';
import type { LeagueView } from '@fha/tools';

/**
 * The `{{leagueContext}}` block of every agent's system prompt (§7.4, §13): the league's rules
 * and Ben's standing permissions, as plain text.
 *
 * It sits in `system`, behind the cache breakpoint, so it holds only what is stable for a day:
 * settings, categories, slots, limits, today's date and the permission summary. Rosters,
 * candidates and Ben's note go in the user message. The permission line is informational — the
 * gate enforces it in code (P2) — but telling the model up front saves it proposing moves that
 * are certain to be refused.
 */
export function buildLeagueContext(
  settings: LeagueSettings,
  permissions: Permissions,
  view: LeagueView,
  today: string,
): string {
  const skaters = settings.categories.filter((c) => c.positionType === 'P' && !c.isDisplayOnly);
  const goalies = settings.categories.filter((c) => c.positionType === 'G' && !c.isDisplayOnly);
  const lowerBetter = settings.categories.filter((c) => !c.higherIsBetter).map((c) => c.abbr);
  const slots = settings.rosterSlots.map((s) => `${s.position}×${s.count}`).join(', ');
  return [
    `League: ${settings.name}, ${settings.numTeams} teams, ${settings.scoringType} scoring.`,
    `Today (America/New_York): ${today}. Week ${view.snap.week}.`,
    `Skater categories: ${skaters.map((c) => c.abbr).join(', ')}.`,
    `Goalie categories: ${goalies.map((c) => c.abbr).join(', ')}.`,
    ...(lowerBetter.length > 0 ? [`Lower is better: ${lowerBetter.join(', ')}.`] : []),
    `Roster slots: ${slots}.`,
    `Waivers: ${settings.usesFaab ? 'FAAB' : 'rolling priority, no FAAB'}.`,
    limitsLine(permissions),
    permissionsLine(permissions, view),
  ].join('\n');
}

function limitsLine(p: Permissions): string {
  const parts = Object.entries(p.plans).map(([kind, rule]) => {
    const limits = Object.entries(rule.limits)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k} ${String(v)}`);
    return `${kind} ${rule.mode}${limits.length > 0 ? ` (${limits.join(', ')})` : ''}`;
  });
  return `Plan kinds (any not listed is refused): ${parts.join('; ') || 'none'}.`;
}

/** One line on what Ben's permissions forbid, with players named rather than keyed. */
export function permissionsLine(p: Permissions, view: LeagueView): string {
  const name = (k: string) => `${view.player(k)?.name ?? 'unknown player'} (${k})`;
  const off = Object.values(TOOL_FOR_KIND).filter((t) => p.tools[t] === false);
  const parts = [
    p.dryRun ? 'DRY RUN: nothing executes on Yahoo' : 'live: allowed plans execute',
    ...(p.paused ? ['PAUSED: every write is refused'] : []),
    `locked (never dropped or traded): ${p.players.locked.map(name).join(', ') || 'none'}`,
    `ask first: ${p.players.ask.map(name).join(', ') || 'none'}`,
    `our top ${p.protected.topNByVorp} by VORP need approval to leave`,
    `tools switched off: ${off.join(', ') || 'none'}`,
  ];
  return `Permissions (enforced by code): ${parts.join('; ')}.`;
}

/** The calendar date in New York for an ISO instant; the league's day boundary (§14.2). */
export function nyDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}
