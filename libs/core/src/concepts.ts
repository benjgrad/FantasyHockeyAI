/**
 * Hockey and head-to-head concepts every agent and the chat reason with (D-041).
 *
 * Ben's chats kept raising ideas the agents never brought up themselves: games played, the
 * bench seat a third goalie costs, ice time before points, whether a partner would take a
 * trade. This is the shared primer, in every agent's league context beside the glossary. It
 * names ideas and the tools that measure them; it never carries a number, so P1 holds.
 *
 * It sits behind the system prompt's cache breakpoint, so it must stay static: no dates, nothing
 * per run. Keep it short; `concepts.test.ts` caps it.
 */
const CONCEPTS: readonly string[] = [
  'Games volume: a week is won on what our started players produce, so games played is a lever of its own. ' +
    "It is each player's NHL schedule times the daily seats we can fill: light nights leave seats empty, heavy nights (often Tue/Thu/Sat) leave players on the bench. " +
    'Every goalie beyond the two we start holds a bench spot a skater could use to fill an empty seat, and players eligible at two positions (C/LW, LW/RW) fill more seats. ' +
    'getSchedule and getForecast give games and expected totals; compare ours with the opponent before calling a week close.',
  'Head-to-head categories: a saturated category buys nothing more, a lost one is expensive to chase, and the contested ones decide weeks. ' +
    "Judge a player by what he adds where we are contested (his per-category CWA), not by a total. A stream is judged on this week's games; a lasting upgrade on the rest of the season.",
  'Leading indicators: ice time, power-play unit and linemates move before points do, so a drop in minutes or a lost PP1 role is news even while he still scores. ' +
    'A hot run carried by shooting or save percentage tends to fade; one game, even a hat trick, is noise. getPlayerForm shows ice time, PP points, trends and the luck flags.',
  'Goalies: a start share or timeshare decides how many games he gives us; a weak starter costs GAA and SV% as well as W; the weekly goalie minimum decides whether GAA and SV% count at all.',
  'Trades: a trade happens only if the other manager gains on his own needs, so check what his roster lacks (getTeamRoster, getLeagueComparison) before offering. ' +
    'Stars rarely move for two lesser players, a hot player costs more than his projection, and an injured player is a weak sweetener. Prefer giving from our surplus categories.',
  "Lineup timing: Yahoo's daily lineups lock each player at his own game's start. Whether a seat can be reused after its player's game ends is unverified [U]: say so rather than promise it.",
  'General hockey knowledge (coaches, real trades, team context) may inform your reasoning when the tools are silent. Say it is general knowledge that may be out of date, and never use it as a number.',
];

/** The primer as a block for the league context. */
export function conceptsText(): string {
  return ['Hockey concepts to reason with:', ...CONCEPTS.map((c) => `- ${c}`)].join('\n');
}
