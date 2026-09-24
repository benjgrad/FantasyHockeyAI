import type { Valuation } from '@fha/core';

const SKATER_SLOTS = ['C', 'LW', 'RW', 'D'] as const;

/**
 * The §12.2 step 8 sanity report.
 *
 * It cannot tell us whether the model is *right*, only whether it is internally
 * coherent and whether the shape of the board is plausible. A systematic skew --
 * every defenceman 30 places too high, say -- is a bug, not an insight.
 */
export function sanityReport(
  valuations: readonly Valuation[],
  replacement: Record<string, number>,
  topN = 40,
): string[] {
  const lines: string[] = [];
  const byPos = (p: string): Valuation[] =>
    valuations.filter((v) => v.position === p).sort((a, b) => b.value - a.value);

  lines.push('value distribution by position (all players, sorted by raw value):');
  for (const p of [...SKATER_SLOTS, 'G']) {
    const l = byPos(p);
    const at = (i: number): string => {
      const v = l[i];
      return v ? v.value.toFixed(2).padStart(7) : '    n/a';
    };
    lines.push(
      `  ${p.padEnd(3)} n=${String(l.length).padStart(4)}  best ${at(0)}  #12 ${at(11)}` +
        `  #24 ${at(23)}  #48 ${at(47)}  #72 ${at(71)}`,
    );
  }

  lines.push('', 'replacement level by slot (lower means scarcer):');
  for (const [s, v] of Object.entries(replacement).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${s.padEnd(5)} ${v.toFixed(3)}`);
  }

  const top = valuations.slice(0, topN);
  const counts = new Map<string, number>();
  for (const v of top) counts.set(v.position, (counts.get(v.position) ?? 0) + 1);
  lines.push('', `position mix of the top ${topN} by VORP:`);
  for (const p of [...SKATER_SLOTS, 'G']) {
    const n = counts.get(p) ?? 0;
    lines.push(`  ${p.padEnd(3)} ${String(n).padStart(3)}  ${'#'.repeat(n)}`);
  }

  const flagged = top.filter((v) => v.lowConfidence);
  lines.push(
    '',
    `low-confidence players inside the top ${topN}: ${flagged.length}` +
      (flagged.length > 0 ? ` (${flagged.map((f) => f.name).join(', ')})` : ''),
  );
  lines.push('  these are projected from thin data; weigh them by judgement, not by rank.');
  return lines;
}

/** Spearman rank correlation between two paired rank vectors. */
export function spearman(ourRanks: readonly number[], theirRanks: readonly number[]): number {
  const n = ourRanks.length;
  if (n < 2) return 0;
  const d2 = ourRanks.reduce((acc, r, i) => {
    const t = theirRanks[i] ?? 0;
    return acc + (r - t) ** 2;
  }, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export interface MarketComparison {
  lines: string[];
  spearman: number;
  /** Mean signed rank difference by position. Negative means we rank them higher. */
  biasByPosition: Record<string, number>;
}

/**
 * Compare our board against a public consensus board (§12.2 step 8).
 *
 * The number that matters is not any individual disagreement -- disagreement is the
 * point of having our own model -- but *systematic* skew. If every defenceman sits 30
 * places above consensus, that is a bug in the valuation, not an edge.
 */
export function compareToMarket(
  valuations: readonly {
    name: string;
    position: string;
    marketRank?: number;
    lowConfidence: boolean;
  }[],
  topN = 100,
): MarketComparison {
  const ourRankById = new Map<string, number>();
  valuations.forEach((v, i) => ourRankById.set(v.name, i + 1));

  const paired = valuations
    .map((v, i) => ({ v, ourRank: i + 1 }))
    .filter(
      (x): x is { v: (typeof valuations)[number] & { marketRank: number }; ourRank: number } =>
        x.v.marketRank !== undefined,
    );

  const lines: string[] = [];
  if (paired.length < 2) {
    return {
      lines: ['no market data joined; cannot cross-check the ranking'],
      spearman: 0,
      biasByPosition: {},
    };
  }

  // Re-rank both sides over the joined subset so the comparison is apples to apples.
  const ourOrder = [...paired].sort((a, b) => a.ourRank - b.ourRank);
  const theirOrder = [...paired].sort((a, b) => a.v.marketRank - b.v.marketRank);
  const ourIdx = new Map(ourOrder.map((x, i) => [x.v.name, i + 1]));
  const theirIdx = new Map(theirOrder.map((x, i) => [x.v.name, i + 1]));

  const ours: number[] = [];
  const theirs: number[] = [];
  for (const x of paired) {
    ours.push(ourIdx.get(x.v.name) ?? 0);
    theirs.push(theirIdx.get(x.v.name) ?? 0);
  }
  const rho = spearman(ours, theirs);

  const diffs = new Map<string, number[]>();
  for (const x of paired) {
    const o = ourIdx.get(x.v.name) ?? 0;
    const t = theirIdx.get(x.v.name) ?? 0;
    diffs.set(x.v.position, [...(diffs.get(x.v.position) ?? []), o - t]);
  }
  const biasByPosition: Record<string, number> = {};
  for (const [pos, ds] of diffs) {
    biasByPosition[pos] = ds.reduce((a, b) => a + b, 0) / ds.length;
  }

  lines.push(
    `joined ${paired.length} players to the consensus board`,
    `Spearman rank correlation: ${rho.toFixed(3)}  ` +
      (rho >= 0.6
        ? '(healthy: we agree on shape, disagree on detail)'
        : '(LOW: investigate before trusting the board)'),
    '',
    'mean rank difference by position (negative = we rank them higher than consensus):',
  );
  for (const [pos, bias] of Object.entries(biasByPosition).sort((a, b) => a[1] - b[1])) {
    const flag = Math.abs(bias) > 25 ? '   << systematic skew, suspect a bug' : '';
    lines.push(`  ${pos.padEnd(3)} ${bias >= 0 ? '+' : ''}${bias.toFixed(1).padStart(6)}${flag}`);
  }

  const big = ourOrder
    .slice(0, topN)
    .map((x) => ({
      name: x.v.name,
      position: x.v.position,
      ours: ourIdx.get(x.v.name) ?? 0,
      theirs: theirIdx.get(x.v.name) ?? 0,
      low: x.v.lowConfidence,
    }))
    .filter((x) => Math.abs(x.ours - x.theirs) > 40)
    .sort((a, b) => a.ours - a.theirs - (b.ours - b.theirs));

  lines.push('', `disagreements over 40 places inside our top ${topN}: ${big.length}`);
  for (const b of big.slice(0, 25)) {
    const dir = b.ours < b.theirs ? 'we like' : 'we fade';
    lines.push(
      `  ${dir}  ${b.name.padEnd(24)} ${b.position.padEnd(3)} ours ${String(b.ours).padStart(3)}` +
        ` vs consensus ${String(b.theirs).padStart(3)}${b.low ? '  *thin data' : ''}`,
    );
  }
  return { lines, spearman: rho, biasByPosition };
}
