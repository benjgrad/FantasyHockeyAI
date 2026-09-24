/** Population mean. Throws on an empty sample rather than returning 0 (P5). */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('mean of an empty sample');
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Population standard deviation. Returns 0 for a constant sample; callers must
 * treat a zero sigma as "this category cannot discriminate" and score it 0,
 * never divide by it.
 */
export function stdev(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('stdev of an empty sample');
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

/** z-score that degrades to 0 rather than NaN/Infinity when the sample is constant. */
export function zScore(x: number, mu: number, sigma: number): number {
  if (sigma === 0 || !Number.isFinite(sigma)) return 0;
  return (x - mu) / sigma;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf approximation). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdfAbs = 1 - (Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)) * poly;
  return x >= 0 ? cdfAbs : 1 - cdfAbs;
}
