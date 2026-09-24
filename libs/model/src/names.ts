/**
 * Player name matching (§10.5). Used to resolve a name typed during the draft to a
 * player in the pool.
 *
 * The rule that matters: an ambiguous or weak match is **not** resolved to the closest
 * candidate. Silently taking the nearest name is how a draft bot drafts the wrong
 * player and logs it as a success (P3).
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

/** NFKD, strip diacritics and punctuation, lowercase, drop generational suffixes. */
export function normalizeName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base
    .split(' ')
    .filter((part) => !SUFFIXES.has(part))
    .join(' ');
}

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const t = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

/** Jaro-Winkler, which rewards a shared prefix. §10.5 uses a 0.93 threshold. */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  if (j === 0) return 0;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

export const MATCH_THRESHOLD = 0.93;

export interface Candidate {
  nhlId: number;
  name: string;
  position: string;
  team: string;
}

export type MatchResult =
  | { kind: 'exact'; candidate: Candidate }
  | { kind: 'fuzzy'; candidate: Candidate; score: number }
  | { kind: 'ambiguous'; candidates: Candidate[] }
  | { kind: 'none'; best: { candidate: Candidate; score: number }[] };

/**
 * Resolve a typed name against the pool.
 *
 * Exact normalized matches win outright. Otherwise a single candidate at or above the
 * threshold is a fuzzy match; several are **ambiguous and left unresolved** for a human
 * to disambiguate. A query may be a full name, a surname, or a surname plus team.
 */
export function matchPlayer(query: string, pool: readonly Candidate[]): MatchResult {
  const q = normalizeName(query);
  if (q.length === 0) return { kind: 'none', best: [] };

  const exact = pool.filter((p) => normalizeName(p.name) === q);
  if (exact.length === 1 && exact[0]) return { kind: 'exact', candidate: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };

  // A bare surname is a common way to type a pick; treat it as its own exact class.
  const surname = pool.filter((p) => {
    const parts = normalizeName(p.name).split(' ');
    return parts.length > 1 && parts.slice(1).join(' ') === q;
  });
  if (surname.length === 1 && surname[0]) return { kind: 'exact', candidate: surname[0] };
  if (surname.length > 1) return { kind: 'ambiguous', candidates: surname };

  const scored = pool
    .map((candidate) => ({ candidate, score: jaroWinkler(q, normalizeName(candidate.name)) }))
    .sort((a, b) => b.score - a.score);

  const over = scored.filter((s) => s.score >= MATCH_THRESHOLD);
  if (over.length === 1 && over[0]) {
    return { kind: 'fuzzy', candidate: over[0].candidate, score: over[0].score };
  }
  if (over.length > 1) return { kind: 'ambiguous', candidates: over.map((o) => o.candidate) };
  return { kind: 'none', best: scored.slice(0, 5) };
}

export type DraftResolution =
  /** Exactly one live player matched. `note` explains any disambiguation that happened. */
  | { kind: 'ok'; candidate: Candidate; note?: string }
  /** The name matched, but he is off the board already. */
  | { kind: 'alreadyDrafted'; candidate: Candidate }
  /** Several live players matched; a human must choose. */
  | { kind: 'ambiguous'; candidates: Candidate[]; drafted: Candidate[] }
  | { kind: 'none'; best: { candidate: Candidate; score: number }[] };

/**
 * Resolve a name typed during a draft against the full pool, knowing who is gone.
 *
 * Matching deliberately runs over every player rather than only the available ones: a
 * name belonging to someone already drafted must report *that*, not degrade into a
 * confusing "no match" with unrelated suggestions.
 *
 * When a name is ambiguous but only one candidate is still available, it resolves to him
 * and says so. Silence there would let "Makar" quietly draft the wrong Makar once Cale
 * is gone.
 */
export function resolveDraftName(
  query: string,
  pool: readonly Candidate[],
  taken: ReadonlySet<number>,
): DraftResolution {
  const res = matchPlayer(query, pool);

  switch (res.kind) {
    case 'exact':
      return taken.has(res.candidate.nhlId)
        ? { kind: 'alreadyDrafted', candidate: res.candidate }
        : { kind: 'ok', candidate: res.candidate };

    case 'fuzzy':
      return taken.has(res.candidate.nhlId)
        ? { kind: 'alreadyDrafted', candidate: res.candidate }
        : {
            kind: 'ok',
            candidate: res.candidate,
            note: `fuzzy match on "${query}" (${res.score.toFixed(3)})`,
          };

    case 'ambiguous': {
      const live = res.candidates.filter((c) => !taken.has(c.nhlId));
      const drafted = res.candidates.filter((c) => taken.has(c.nhlId));
      if (live.length === 1 && live[0]) {
        return {
          kind: 'ok',
          candidate: live[0],
          note:
            `"${query}" also matched ${drafted.map((d) => d.name).join(', ')}, ` +
            `already drafted — resolved to the only one still available`,
        };
      }
      if (live.length === 0) {
        const first = res.candidates[0];
        return first ? { kind: 'alreadyDrafted', candidate: first } : { kind: 'none', best: [] };
      }
      return { kind: 'ambiguous', candidates: live, drafted };
    }

    case 'none':
      return { kind: 'none', best: res.best };
  }
}
