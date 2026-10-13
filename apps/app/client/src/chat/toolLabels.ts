/**
 * What each tool does, in Ben's words, for the chips under a chat reply. The raw name stays
 * visible in the expanded view; an unknown tool falls back to its name.
 */
const LABELS: Readonly<Record<string, string>> = {
  getRoster: 'Read your roster',
  getRosterHealth: 'Checked roster health',
  getLineupSuggestion: 'Ran the lineup solver',
  getTeamRoster: "Read a team's roster",
  getPlayers: 'Looked up players',
  searchPlayers: 'Searched players',
  getSchedule: 'Read the schedule',
  getGoalieStarts: 'Checked goalie starts',
  getNews: 'Read player news',
  getMatchup: 'Read the matchup',
  getLeagueComparison: 'Compared the league',
  getLeagueContext: 'Read league settings',
  getLeagueEvents: 'Read league activity',
  getDecisions: 'Checked open decisions',
  getPendingTrades: 'Read pending trades',
  findTradeTargets: 'Searched for trades',
  evaluateTrade: 'Scored a trade',
  proposeLineup: 'Proposed a lineup',
  proposeAddDrop: 'Proposed an add/drop',
  proposeWaiverClaim: 'Proposed a waiver claim',
  proposeTrade: 'Proposed a trade',
  proposeTradeResponse: 'Answered a trade offer',
  setCategoryWeights: 'Set category weights',
  runSpecialist: 'Asked a specialist',
  abstain: 'Decided to do nothing',
  askBen: 'Asked you a question',
};

export function toolLabel(name: string): string {
  return LABELS[name] ?? name;
}

/** One line for the collapsed chip: the arguments, joined. */
export function inputPreview(input: string | undefined, max = 60): string | undefined {
  const line = input
    ?.split('\n')
    .map((l) => l.replace(/^[^:]+:\s*/, ''))
    .join(' · ')
    .trim();
  if (line === undefined || line === '') return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
