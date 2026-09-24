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
