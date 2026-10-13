/** Sparkline geometry: points scaled into the box (2px padding), with the baseline's y. Pure. */
export function sparkPath(
  points: readonly number[],
  baseline: number,
  width: number,
  height: number,
): { line: string; base: number } {
  const pad = 2;
  const lo = Math.min(baseline, ...points);
  const hi = Math.max(baseline, ...points);
  const span = hi - lo || 1;
  const y = (v: number) => pad + (height - 2 * pad) * (1 - (v - lo) / span);
  const x = (i: number) => pad + ((width - 2 * pad) * i) / Math.max(1, points.length - 1);
  return {
    line: points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    base: Number(y(baseline).toFixed(1)),
  };
}
