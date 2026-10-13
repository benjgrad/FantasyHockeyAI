/**
 * The Team page's "This week" bars: how much of a category we hold, as a share from 0 (all
 * theirs) to 1 (all ours). Pure, so the drawing logic is tested without a DOM.
 */
const LOWER_IS_BETTER = new Set(['GAA']);

export function shareOf(
  us: number | null | undefined,
  them: number | null | undefined,
  cat: string,
): number {
  if (us === null || us === undefined || them === null || them === undefined) return 0.5;
  const [a, b] = LOWER_IS_BETTER.has(cat) ? [them, us] : [us, them];
  if (a < 0 || b < 0) {
    // +/- can be negative: compare the gap against the larger magnitude.
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return clamp(0.5 + (a - b) / (4 * scale));
  }
  return a + b === 0 ? 0.5 : clamp(a / (a + b));
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));

/** Scores as Yahoo shows them: counts whole, SV% to three places, GAA to two. */
export function fmtStat(n: number | null | undefined, cat: string): string {
  if (n === null || n === undefined) return '—';
  if (cat === 'SV%') return n.toFixed(3).replace(/^0/, '');
  if (cat === 'GAA') return n.toFixed(2);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
