/**
 * Numeric-cell detection for Markdown tables: stat lines (`12`, `-3`, `+1.5`, `.915`, `45%`,
 * `2,310`, `1-2-0`, `—`) right-align so their digits line up.
 */
const NUMBER = /^[+\-−]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;
const RECORD = /^\d+(-\d+){1,2}$/;
const BLANK = /^[—–\-]?$/;

export function isNumericText(raw: string): boolean {
  const text = raw.trim();
  if (text === '' || !/\d/.test(text)) return false;
  return NUMBER.test(text) || RECORD.test(text);
}

/**
 * Which columns are numeric: every non-blank body cell is a number (dashes count as blank), and
 * at least one is.
 */
export function numericColumns(rows: readonly (readonly string[])[]): boolean[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const out: boolean[] = [];
  for (let c = 0; c < width; c += 1) {
    const cells = rows.map((r) => (r[c] ?? '').trim()).filter((t) => !BLANK.test(t));
    out.push(cells.length > 0 && cells.every(isNumericText));
  }
  return out;
}
