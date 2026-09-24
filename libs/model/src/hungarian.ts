/**
 * Maximum-weight bipartite assignment (§12.3), via the Hungarian algorithm in its
 * O(n²·m) shortest-augmenting-path form. Every row is assigned to a distinct column,
 * so the matrix must have at least as many columns as rows.
 *
 * A weight of `-Infinity` marks a forbidden cell. It is handled as a true infinity
 * rather than a big-M penalty, so tiny tie-break weights keep their precision.
 */
export interface Assignment {
  /** `cols[i]` is the column assigned to row `i`. */
  cols: number[];
  total: number;
}

function get(a: ArrayLike<number>, i: number): number {
  return a[i] ?? Number.NaN;
}

function getRow(m: readonly (readonly number[])[], i: number): readonly number[] {
  return m[i] ?? [];
}

/**
 * Returns the assignment maximising the total weight, or `null` when every complete
 * assignment uses a forbidden cell (or there are more rows than columns).
 */
export function maxWeightAssignment(weights: readonly (readonly number[])[]): Assignment | null {
  const n = weights.length;
  if (n === 0) return { cols: [], total: 0 };
  const m = getRow(weights, 0).length;
  if (n > m || weights.some((r) => r.length !== m)) return null;

  const cost = (i: number, j: number): number => -get(getRow(weights, i - 1), j - 1);
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1); // p[j]: the row matched to column j (1-based, 0 = none)
  const way = new Int32Array(m + 1);

  for (let i = 1; i <= n; i++) {
    if (!augment(i, m, cost, u, v, p, way)) return null;
  }

  const cols = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    const row = get(p, j);
    if (row > 0) cols[row - 1] = j - 1;
  }
  const total = cols.reduce((s, j, i) => s + get(getRow(weights, i), j), 0);
  return { cols, total };
}

/** Adds row `i` to the matching along a shortest augmenting path. False if none exists. */
function augment(
  i: number,
  m: number,
  cost: (i: number, j: number) => number,
  u: Float64Array,
  v: Float64Array,
  p: Int32Array,
  way: Int32Array,
): boolean {
  p[0] = i;
  let j0 = 0;
  const minv = new Float64Array(m + 1).fill(Number.POSITIVE_INFINITY);
  const used = new Uint8Array(m + 1);
  do {
    used[j0] = 1;
    const i0 = get(p, j0);
    let delta = Number.POSITIVE_INFINITY;
    let j1 = -1;
    for (let j = 1; j <= m; j++) {
      if (get(used, j)) continue;
      const cur = cost(i0, j) - get(u, i0) - get(v, j);
      if (cur < get(minv, j)) {
        minv[j] = cur;
        way[j] = j0;
      }
      if (get(minv, j) < delta) {
        delta = get(minv, j);
        j1 = j;
      }
    }
    if (j1 < 0 || !Number.isFinite(delta)) return false;
    for (let j = 0; j <= m; j++) {
      if (get(used, j)) {
        const row = get(p, j);
        u[row] = get(u, row) + delta;
        v[j] = get(v, j) - delta;
      } else {
        minv[j] = get(minv, j) - delta;
      }
    }
    j0 = j1;
  } while (get(p, j0) !== 0);

  do {
    const j1 = get(way, j0);
    p[j0] = get(p, j1);
    j0 = j1;
  } while (j0 !== 0);
  return true;
}
