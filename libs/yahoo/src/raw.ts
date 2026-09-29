import { YahooShapeError } from './errors.js';

/**
 * Small, total accessors over untyped `json_f` bodies.
 *
 * Yahoo's JSON is loosely typed (numbers arrive as strings, absent fields as null), so every
 * read goes through one of these rather than a cast. A missing optional field yields
 * `undefined`; a missing structural field throws `YahooShapeError` with the path, so a Yahoo
 * format change fails loudly instead of producing an empty league (P5).
 */
export type Raw = Record<string, unknown>;

export function isRaw(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function obj(v: unknown, where: string): Raw {
  if (!isRaw(v)) throw new YahooShapeError(`expected an object at ${where}`);
  return v;
}

export function optObj(v: unknown): Raw | undefined {
  return isRaw(v) ? v : undefined;
}

export function str(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

export function reqStr(v: unknown, where: string): string {
  const s = str(v);
  if (s === undefined) throw new YahooShapeError(`expected a string at ${where}`);
  return s;
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Yahoo flags arrive as 1, "1", true or null. */
export function flag(v: unknown): boolean {
  return v === 1 || v === '1' || v === true;
}

/** `json_f` collections are arrays of single-key wrappers: `[{player:{...}}, ...]`. */
export function unwrap(list: unknown, key: string): Raw[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (isRaw(x) ? x[key] : undefined)).filter(isRaw);
}

/** A collection of single-key scalar wrappers: `[{position:"C"}, {position:"Util"}]`. */
export function unwrapScalars(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (isRaw(x) ? str(x[key]) : undefined)).filter((x) => x !== undefined);
}

/** The `fantasy_content` envelope every v2 response has. */
export function content(body: unknown): Raw {
  return obj(obj(body, 'response').fantasy_content, 'fantasy_content');
}

/** Unix seconds (string or number) → ISO instant. */
export function isoFromUnix(v: unknown): string | undefined {
  const n = num(v);
  return n === undefined ? undefined : new Date(n * 1000).toISOString();
}
