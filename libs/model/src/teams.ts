/**
 * Team abbreviation normalisation.
 *
 * Yahoo and the NHL API disagree on exactly four clubs: Yahoo writes `LA`, `NJ`, `SJ`
 * and `TB` where the NHL API writes `LAK`, `NJD`, `SJS` and `TBL`. Verified by diffing
 * both 32-team sets on 2026-09-24 — those four are the only differences.
 *
 * This matters more than it looks. Team agreement is what breaks same-name ties and what
 * rejects a bad fuzzy match in the player join (§10.5), so an unnormalised `TB` would
 * silently refuse every Tampa Bay match and leave those players unmapped — a quiet
 * degradation rather than an error.
 */
const CANONICAL: Readonly<Record<string, string>> = {
  LA: 'LAK',
  NJ: 'NJD',
  SJ: 'SJS',
  TB: 'TBL',
  // Historical and alternate spellings seen in older season data.
  ARI: 'UTA',
  PHX: 'UTA',
  ATL: 'WPG',
  MON: 'MTL',
  WAS: 'WSH',
  TBY: 'TBL',
  CLS: 'CBJ',
};

/** Canonical (NHL-style) abbreviation. Unknown values pass through upper-cased. */
export function normalizeTeam(abbr: string | undefined | null): string {
  if (!abbr) return 'UNK';
  const up = abbr.trim().toUpperCase();
  if (up === '') return 'UNK';
  return CANONICAL[up] ?? up;
}

/** Whether two abbreviations refer to the same club, tolerating either spelling. */
export function sameTeam(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (na === 'UNK' || nb === 'UNK') return false;
  return na === nb;
}
