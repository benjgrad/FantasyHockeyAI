import type { Valuation } from '@fha/core';

const POSITIONS = ['C', 'LW', 'RW', 'D', 'G'] as const;

/** Median of a numeric sample; 0 for an empty one. */
function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Break a sorted list into tiers at genuine cliffs.
 *
 * Tiers matter more than ranks at a draft: the question is never "is he 14th or 17th" but
 * "is there a real drop after him".
 *
 * The comparison has to be **local**. Value gaps between elite players are far larger than
 * gaps in the middle of a board, so any global threshold — a multiple of the overall median,
 * or the nth largest gap — puts every boundary at the top and yields a run of
 * single-player tiers followed by one enormous one. Comparing each gap to the typical gap
 * among its neighbours adapts to that shrinking scale, and a perfectly even board correctly
 * produces no tiers at all.
 */
export function tier(
  sorted: readonly Valuation[],
  opts: { ratio?: number; window?: number; maxTierSize?: number } = {},
): Valuation[][] {
  const ratio = opts.ratio ?? 2.0;
  const window = opts.window ?? 7;
  const maxTierSize = opts.maxTierSize ?? 14;
  if (sorted.length === 0) return [];

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(Math.max(0, (sorted[i - 1]?.vorp ?? 0) - (sorted[i]?.vorp ?? 0)));
  }

  const isBoundary = (i: number): boolean => {
    const gap = gaps[i] ?? 0;
    if (gap <= 0) return false;
    const lo = Math.max(0, i - window);
    const hi = Math.min(gaps.length, i + window + 1);
    const local = median(gaps.slice(lo, hi).filter((g) => g > 0));
    if (local <= 0) return false;
    return gap >= ratio * local;
  };

  const tiers: Valuation[][] = [];
  let current: Valuation[] = [];
  sorted.forEach((v, i) => {
    // A tier longer than maxTierSize stops being a useful grouping, so split it.
    if (i > 0 && current.length > 0 && (isBoundary(i - 1) || current.length >= maxTierSize)) {
      tiers.push(current);
      current = [];
    }
    current.push(v);
  });
  if (current.length > 0) tiers.push(current);
  return tiers;
}

function row(v: Valuation, rank: number): string {
  const adp = v.adp === undefined ? '    ' : v.adp.toFixed(0).padStart(4);
  const mkt = v.marketRank === undefined ? '   ' : String(v.marketRank).padStart(3);
  const flag = v.lowConfidence ? ' *' : '  ';
  return (
    `${String(rank).padStart(3)} ${v.name.slice(0, 22).padEnd(22)} ${v.team.padEnd(4)}` +
    ` ${v.vorp.toFixed(1).padStart(5)} ${adp} ${mkt}${flag}`
  );
}

const HEADER = '  # player                 tm    VORP  adp mkt';

/**
 * A printable cheat sheet: overall board, tiers by position, and the places where our
 * valuation disagrees most with the market.
 *
 * The disagreement section is the useful part on the night. A player we rate far above
 * the room should still be there later than his value implies, so he can wait; a player
 * we rate far below is someone to let others reach for.
 */
export function buildSheet(
  valuations: readonly Valuation[],
  leagueName: string,
  opts: { overall?: number; perPosition?: number; disagreement?: number } = {},
): string {
  const overall = opts.overall ?? 100;
  const perPosition = opts.perPosition ?? 30;
  const disagreement = opts.disagreement ?? 25;
  const out: string[] = [];

  out.push(`${leagueName} — draft cheat sheet`);
  out.push(`generated ${new Date().toISOString()}`);
  out.push('');
  out.push("VORP = value over replacement in this league's categories.  adp = market average");
  out.push('draft position.  mkt = market consensus rank.  * = thin data, use judgement.');
  out.push('');
  out.push('='.repeat(64));
  out.push(`OVERALL TOP ${overall}`);
  out.push('='.repeat(64));
  const top = valuations.slice(0, overall);
  const tiers = tier(top);
  let rank = 1;
  tiers.forEach((t, i) => {
    out.push('');
    out.push(`-- tier ${i + 1} --`);
    out.push(HEADER);
    for (const v of t) out.push(row(v, rank++));
  });

  for (const pos of POSITIONS) {
    const list = valuations.filter((v) => v.position === pos).slice(0, perPosition);
    if (list.length === 0) continue;
    out.push('');
    out.push('='.repeat(64));
    out.push(`${pos} — top ${list.length}`);
    out.push('='.repeat(64));
    let r = 1;
    tier(list).forEach((t, i) => {
      out.push('');
      out.push(`-- ${pos} tier ${i + 1} --`);
      out.push(HEADER);
      for (const v of t) out.push(row(v, r++));
    });
  }

  const paired = valuations
    .map((v, i) => ({ v, ours: i + 1 }))
    .filter((x) => x.v.marketRank !== undefined)
    .map((x) => ({ ...x, diff: x.ours - (x.v.marketRank ?? 0) }));

  const weLike = paired
    .filter((x) => x.diff < -disagreement && x.ours <= 150)
    .sort((a, b) => a.diff - b.diff);
  const weFade = paired
    .filter((x) => x.diff > disagreement && (x.v.marketRank ?? 999) <= 120)
    .sort((a, b) => b.diff - a.diff);

  out.push('');
  out.push('='.repeat(64));
  out.push('WHERE WE DISAGREE WITH THE MARKET');
  out.push('='.repeat(64));
  out.push('');
  out.push('We rate these ABOVE the room — they should last longer than their value says:');
  for (const x of weLike.slice(0, 25)) {
    out.push(
      `  ${x.v.name.slice(0, 22).padEnd(22)} ${x.v.position.padEnd(3)} ${x.v.team.padEnd(4)}` +
        ` ours ${String(x.ours).padStart(3)}  market ${String(x.v.marketRank).padStart(3)}${x.v.lowConfidence ? '  *' : ''}`,
    );
  }
  out.push('');
  out.push('We rate these BELOW the room — let someone else reach:');
  for (const x of weFade.slice(0, 25)) {
    out.push(
      `  ${x.v.name.slice(0, 22).padEnd(22)} ${x.v.position.padEnd(3)} ${x.v.team.padEnd(4)}` +
        ` ours ${String(x.ours).padStart(3)}  market ${String(x.v.marketRank).padStart(3)}`,
    );
  }

  const thin = valuations.slice(0, overall).filter((v) => v.lowConfidence);
  out.push('');
  out.push('='.repeat(64));
  out.push('THIN DATA — ranked from little evidence, judge these yourself');
  out.push('='.repeat(64));
  for (const v of thin) {
    out.push(
      `  ${v.name.slice(0, 22).padEnd(22)} ${v.position.padEnd(3)} ${v.team.padEnd(4)} vorp ${v.vorp.toFixed(1)}`,
    );
  }
  out.push('');
  return out.join('\n');
}
