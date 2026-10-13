/**
 * Pure helpers for the League view: the heatmap's colour scale, sorting, and formatting.
 * Kept out of the components so each rule is a unit test.
 */

/**
 * A single diverging scale, strong (blue) through a neutral to weak (orange): blue and orange
 * stay apart under the common colour-vision deficiencies, the poles also differ in depth, and
 * every cell prints its rank, so colour is never the only cue. The steps are theme tokens
 * (`--color-heat-1…7` in styles.css), so the scale follows light and dark, and the app's ink
 * is checked for contrast on every step (src/theme/tokens.test.ts). Index 0 is rank 1.
 */
export const RANK_COLORS = [1, 2, 3, 4, 5, 6, 7].map((n) => `var(--color-heat-${n})`);

/** Which colour step a rank falls in: rank 1 → 0, rank `of` → the last step. */
export function rankBucket(rank: number, of: number): number {
  const steps = RANK_COLORS.length - 1;
  if (of <= 1) return Math.floor(steps / 2);
  const t = Math.min(1, Math.max(0, (rank - 1) / (of - 1)));
  return Math.round(t * steps);
}

export function rankColor(rank: number, of: number): string {
  return RANK_COLORS[rankBucket(rank, of)] ?? 'var(--color-heat-4)';
}

/** How the heatmap is sorted: by a category's rank, by the totals column, or league order. */
export type SortKey = { kind: 'league' } | { kind: 'cat'; cat: string } | { kind: 'vsUs' };

export interface SortableRow {
  isUs: boolean;
  name: string;
  categories: readonly { cat: string; rank: number }[];
  vsUs: { theirExpectedWon: number } | null;
}

/**
 * Rows sorted by `key`, ours always pinned first. By category: strongest first (rank 1). By the
 * totals column: the toughest opponent first (most categories they expect to win against us).
 * Ties keep league order.
 */
export function sortRows<T extends SortableRow>(rows: readonly T[], key: SortKey): T[] {
  const us = rows.filter((r) => r.isUs);
  const rest = rows.filter((r) => !r.isUs);
  const rank = (r: T, cat: string) => r.categories.find((c) => c.cat === cat)?.rank ?? Infinity;
  const sorted =
    key.kind === 'cat'
      ? [...rest].sort((a, b) => rank(a, key.cat) - rank(b, key.cat))
      : key.kind === 'vsUs'
        ? [...rest].sort(
            (a, b) => (b.vsUs?.theirExpectedWon ?? 0) - (a.vsUs?.theirExpectedWon ?? 0),
          )
        : rest;
  return [...us, ...sorted];
}

/** A weekly projection: .912 for SV%, 2.54 for GAA, one decimal for counts (0.6 SHP). */
export function fmtWeekly(cat: string, n: number): string {
  if (cat === 'SV%') return n.toFixed(3).replace(/^(-?)0\./, '$1.');
  if (cat === 'GAA') return n.toFixed(2);
  return n.toFixed(1);
}

export const pct = (p: number): string => `${Math.round(p * 100)}%`;

/** Bar widths (0–100) for ours vs theirs in one category, on a shared scale. */
export function pairBars(ours: number, theirs: number): { ours: number; theirs: number } {
  const max = Math.max(Math.abs(ours), Math.abs(theirs));
  if (max === 0) return { ours: 0, theirs: 0 };
  return { ours: (Math.abs(ours) / max) * 100, theirs: (Math.abs(theirs) / max) * 100 };
}

/** The chat composer text for "Ask the GM to propose this". */
export function proposeText(idea: {
  partnerName: string;
  give: readonly { name: string; playerKey: string }[];
  get: readonly { name: string; playerKey: string }[];
}): string {
  const list = (xs: readonly { name: string; playerKey: string }[]) =>
    xs.map((x) => `${x.name} (${x.playerKey})`).join(' and ');
  return `Evaluate and propose this trade with ${idea.partnerName}: we give ${list(idea.give)}, we get ${list(idea.get)}.`;
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}
