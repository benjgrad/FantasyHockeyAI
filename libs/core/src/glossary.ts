/**
 * What every number means, in one place (D-026). The app's explainers (hover, or tap on a phone)
 * and every agent's system context read this same text, so the page and the chat never describe
 * a stat two different ways. Add a stat here before showing it anywhere.
 */
export interface GlossaryEntry {
  /** Short label as it appears in tables and cards. */
  label: string;
  /** One line: what it is. */
  short: string;
  /** How it is computed and how to read it. */
  long: string;
}

const entries = {
  // ── the value family ──────────────────────────────────────────────────────────────────
  value: {
    label: 'Value',
    short: 'Season value: summed category z-scores, weighted by how the league counts them.',
    long: "Σ over scoring categories of the player's z-score against the pool of players a league like this one starts. Rate stats (SV%, GAA) are weighted by volume. Higher is better; it is not adjusted for injuries or position.",
  },
  vorp: {
    label: 'VORP (preseason)',
    short: 'Preseason value over the last starter at his position, from the draft-day projection.',
    long: 'Value minus the value of the last player a league this size starts at his scarcest eligible position, calibrated across positions against the market (D-010). Frozen at the preseason projection; the rest-of-season version is VOLS.',
  },
  rosValue: {
    label: 'ROS value',
    short:
      "Value on the rest-of-season projection: the preseason projection updated by this season's games.",
    long: "The same §12.2 value, computed on per-game rates that blend this season with the preseason projection as a Bayesian prior: rate = (this season's total + K × prior rate) / (games + K). K is 40 games for skaters; 20 starts for goalie wins and shutouts, 50 for SV% and GAA. At 0 games it equals the preseason value.",
  },
  vols: {
    label: 'VOLS',
    short:
      "Value over last starter: ROS value minus the league's replacement level at his position.",
    long: "The rest-of-season VORP. Moves when his own projection moves and when his position's replacement level moves. Best for comparing players league-wide, such as trade value.",
  },
  adjusted: {
    label: 'Adj.',
    short: 'VOLS with expected time out taken off, once.',
    long: "VOLS − (1 − share) × (max(VOLS, 0) + 1), where share is the part of the rest of the season he is expected to be available for (from his injury status and return date). A healthy player's Adj. equals his VOLS.",
  },
  vofa: {
    label: 'VOFA',
    short: 'Value over the best free agent at his position: is he worth a roster spot today?',
    long: 'His Adj. minus the Adj. of the best healthy free agent who shares his scarcest position. Positive: no free agent beats him. Negative: a better player is free right now. The free agent named is the bar. Changes daily as the free-agent pool changes.',
  },
  cwa: {
    label: 'CWA',
    short: 'Category wins added: how many more categories a week WE expect to win with him.',
    long: 'Δ expected categories won per week against the league field, between our roster with him and without him. For one of ours, the best free agent takes his place; for anyone else, our lowest-value player is released to make room. Only starters count, so a bench player is 0, and strength in a category we already win is worth little. This is "need", measured.',
  },
  weekCwa: {
    label: 'Week CWA',
    short: "Category wins added in THIS week's matchup (banked score included).",
    long: "Δ expected categories won this week against this week's opponent if a free agent joined us now, or if one of ours sat out the rest of the week. Uses the real schedule of games left. For streaming and this week's lineup.",
  },
  perGameValue: {
    label: 'Per game',
    short: 'Value per game played: what a start of his is worth tonight.',
    long: 'Value ÷ projected games. The daily lineup ranks starters by expected games today × this.',
  },
  fit: {
    label: 'Fit',
    short: 'How well his categories match what our roster needs.',
    long: 'Adj. value plus a bonus for categories where our roster is weak. CWA measures the same thing directly against the league; Fit is the quicker roster-only version.',
  },
  z: {
    label: 'z',
    short: 'Standard deviations above the average rostered player in one category.',
    long: '0 is the average player a league like this starts; +1 is one standard deviation better. For GAA, higher z means a lower (better) GAA.',
  },
  lens: {
    label: 'Lens',
    short: 'Which projection a number was computed on: preseason or rest-of-season.',
    long: "Preseason: three past seasons, fixed at the draft. Rest-of-season: the preseason projection updated by this season's games (see ROS value). Every number says its lens; neither overwrites the other.",
  },
  lowConfidence: {
    label: 'Low confidence',
    short: 'Too few games this season for the update to mean much yet.',
    long: 'Fewer than 10 games for a skater or 5 starts for a goalie this season: the rest-of-season number is still mostly the preseason projection.',
  },
  luck: {
    label: 'Luck',
    short: 'Is a hot or cold run riding on shooting % (skaters) or save % (goalies)?',
    long: 'Shooting % over his last 20 games (goalies: SV% over the last 10 starts) against his own earlier rate, as a binomial z-score. "Lucky" (z ≥ 1.5): scoring above what his shots usually produce, which tends not to last. "Unlucky": the reverse. "Too small a sample": not enough shots to tell.',
  },
  trend: {
    label: 'Trend',
    short: 'Last 10 games against the 82 before, judged against what chance alone allows.',
    long: 'Per category, z = (recent rate − baseline rate) / its standard error. "Hot"/"cold" need |z| ≥ 1.5 and at least 5 recent games; "too rare to tell" means the baseline expects under 2 events in the window (e.g. shorthanded points).',
  },
  delta7d: {
    label: 'Δ7d',
    short: 'Change in VOLS over the last 7 days.',
    long: "Today's VOLS minus the stored value from a week ago (or the preseason value before a week of history exists).",
  },
  pWin: {
    label: 'P(win)',
    short: 'Chance of winning a category (or the week).',
    long: 'From the projected totals and their variance (§12.6). For the week: the categories won follow a Poisson-binomial distribution; winning more than half wins, exactly half counts as a half.',
  },
  expectedWon: {
    label: 'Exp. cats won',
    short: 'Expected number of categories won: the sum of the per-category P(win).',
    long: 'Σ P(win) over the scoring categories. A trade or add is scored by how much it moves this per week.',
  },
  availability: {
    label: 'Availability',
    short: 'Share of the rest of the season he is expected to play.',
    long: 'From his Yahoo status, injury note and return date; assumed absence lengths are used when no date is known.',
  },
  complementarity: {
    label: 'Complementarity',
    short: 'How well two rosters fit a trade: they have what we lack, and we have what they lack.',
    long: 'Σ over categories of our need × their surplus plus their need × our surplus, on league-standardised strength.',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof entries;
export const GLOSSARY: Readonly<Record<GlossaryKey, GlossaryEntry>> = entries;

/** Yahoo scoring categories, by abbreviation. */
export const CATEGORY_GLOSSARY: Readonly<Record<string, string>> = {
  G: 'Goals',
  A: 'Assists',
  P: 'Points (goals + assists)',
  '+/-': 'Plus/minus: even-strength and shorthanded goals for minus against while on the ice',
  PIM: 'Penalty minutes',
  PPP: 'Power-play points',
  SHP: 'Shorthanded points',
  GWG: 'Game-winning goals',
  SOG: 'Shots on goal',
  HIT: 'Hits',
  BLK: 'Blocked shots',
  FW: 'Faceoffs won',
  W: 'Goalie wins',
  GAA: 'Goals-against average (per 60 minutes; lower is better)',
  'SV%': 'Save percentage',
  SHO: 'Shutouts',
  GS: 'Games started',
};

/** The glossary as plain text for an agent's system context. */
export function glossaryText(): string {
  const stats = Object.values(GLOSSARY).map((e) => `- ${e.label}: ${e.short} ${e.long}`);
  const cats = Object.entries(CATEGORY_GLOSSARY).map(([k, v]) => `${k} = ${v}`);
  return [
    'What each number means (the app shows Ben the same definitions):',
    ...stats,
    `Categories: ${cats.join('; ')}.`,
  ].join('\n');
}
