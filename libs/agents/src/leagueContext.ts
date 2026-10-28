import {
  TOOL_FOR_KIND,
  askTimeoutMinutes,
  glossaryText,
  type LeagueSettings,
  type Permissions,
} from '@fha/core';
import { asOfLine, waiverRulesText, type LeagueView } from '@fha/tools';

/**
 * The `{{leagueContext}}` block of every agent's system prompt (§7.4, §13): the league's rules
 * and Ben's standing permissions, as plain text.
 *
 * It sits in `system`, behind the cache breakpoint, so it holds only what is stable for a day:
 * settings, categories, slots, limits, today's date, the permission summary and the glossary
 * of what every number means, plus the snapshot's as-of line (it changes with each hourly pull,
 * which costs one cache write an hour; telling the model how old its data is is worth that). Rosters,
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
    // When the data is from, and a loud warning when the last Yahoo read failed (4b, P9).
    asOfLine(view),
    `Skater categories: ${skaters.map((c) => c.abbr).join(', ')}.`,
    `Goalie categories: ${goalies.map((c) => c.abbr).join(', ')}.`,
    ...(lowerBetter.length > 0 ? [`Lower is better: ${lowerBetter.join(', ')}.`] : []),
    `Roster slots: ${slots}.`,
    waiverRulesText(view, settings.usesFaab),
    ...rulesLine(view, today),
    limitsLine(permissions),
    permissionsLine(permissions, view),
    // The same definitions the app's explainers show Ben (D-026): quote numbers by these names.
    glossaryText(),
  ].join('\n');
}

/** The league's own rules from Yahoo's settings (D-029), with the days left where it matters. */
function rulesLine(view: LeagueView, today: string): string[] {
  const r = view.snap.rules;
  if (r === undefined) return [];
  const days = (d: string) =>
    Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  const week = view.weekOf(today);
  const parts = [
    `This fantasy week: ${week.start}..${week.end}`,
    ...(r.minGoalieGames === undefined
      ? []
      : [`goalie minimum ${r.minGoalieGames} games a week (below it GAA and SV% do not count)`]),
    ...(r.tradeEndDate === undefined
      ? []
      : [
          days(r.tradeEndDate) < 0
            ? `the trade deadline (${r.tradeEndDate}) has passed: no trades`
            : `trade deadline ${r.tradeEndDate} (${days(r.tradeEndDate)} days)`,
        ]),
    ...(r.playoffStartWeek === undefined ? [] : [`playoffs from week ${r.playoffStartWeek}`]),
    ...(r.waiverDays === undefined ? [] : [`dropped players sit on waivers ${r.waiverDays} days`]),
    ...(r.maxWeeklyAdds === undefined ? [] : [`Yahoo allows ${r.maxWeeklyAdds} adds a week`]),
  ];
  return [`League rules (Yahoo): ${parts.join('; ')}.`];
}

function limitsLine(p: Permissions): string {
  const parts = Object.entries(p.plans).map(([kind, rule]) => {
    const limits = Object.entries(rule.limits)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k} ${String(v)}`);
    // Ask with timeout (D-018): queued for Ben, done on its own if he does not reject in time.
    // A claim is never filed by us (U-22): its timeout only hands it to Ben.
    const claim = kind === 'waiverClaim';
    const mode =
      rule.mode === 'askTimeout'
        ? claim
          ? `ask (after ${askTimeoutMinutes(rule)} min unless Ben rejects, handed to Ben to file in Yahoo)`
          : `ask (done after ${askTimeoutMinutes(rule)} min unless Ben rejects)`
        : claim && rule.mode === 'allow'
          ? 'allow (handed to Ben to file in Yahoo)'
          : rule.mode;
    return `${kind} ${mode}${limits.length > 0 ? ` (${limits.join(', ')})` : ''}`;
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
