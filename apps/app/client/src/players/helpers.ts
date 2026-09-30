/**
 * Pure display rules for player cards and comparisons, kept out of the components so they are
 * tested without a DOM. They reproduce the draft board's (apps/web/public/app.js).
 */

export interface CatLike {
  cat: string;
  z: number | null;
}

/**
 * Best `top` and worst `bottom` categories by z (the draft board's 4 + 2), never overlapping,
 * both in descending z so the very worst comes last. Unscored categories are skipped.
 */
export function topBottom<T extends CatLike>(
  cats: readonly T[],
  top = 4,
  bottom = 2,
): { best: T[]; worst: T[] } {
  const scored = cats.filter((c) => c.z !== null).sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  const best = scored.slice(0, top);
  const rest = scored.slice(best.length);
  return { best, worst: rest.slice(Math.max(0, rest.length - bottom)) };
}

export type Tone = 'up' | 'down' | 'flat';

/** Colour for a category delta: `better` already accounts for lower-is-better (GAA). */
export function deltaTone(delta: number | null, better: boolean): Tone {
  if (delta === null || Math.abs(delta) < 0.0005) return 'flat';
  return better ? 'up' : 'down';
}

/** Colour for a scoring-term delta (VORP, fit…): higher is always better there. */
export function termTone(delta: number | null): Tone {
  if (delta === null || Math.abs(delta) < 0.005) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

export const TONE_CLASS: Record<Tone, string> = {
  up: 'text-good',
  down: 'text-bad',
  flat: 'text-mut',
};

/** A category value the way hockey writes it: .912 for SV%, 2.54 for GAA, counts whole. */
export function fmtCat(cat: string, n: number | null): string {
  if (n === null) return '—';
  if (cat === 'SV%') return n.toFixed(3).replace(/^(-?)0\./, '$1.');
  if (cat === 'GAA') return n.toFixed(2);
  return Math.round(n).toString();
}

/** A signed delta: "+12", "−0.18". */
export function fmtDelta(cat: string, d: number | null): string {
  if (d === null) return '—';
  const body = fmtCat(cat, Math.abs(d));
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${body}`;
}

export function signed(n: number | null, dp = 2): string {
  if (n === null) return '—';
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}`;
}

/** z −3..+3 as a bar width in percent, and its colour: a weakness reads as a weakness. */
export function zBar(z: number | null): { pct: number; tone: Tone } {
  const v = z ?? 0;
  const pct = Math.max(0, Math.min(100, ((v + 3) / 6) * 100));
  return { pct, tone: v >= 0.5 ? 'up' : v <= -0.5 ? 'down' : 'flat' };
}

export const MAX_COMPARE = 4;

/** Keys from `?keys=a,b`, de-duplicated, at most four. */
export function parseKeys(raw: string | null): string[] {
  const keys = (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
  return [...new Set(keys)].slice(0, MAX_COMPARE);
}

export function compareHref(keys: readonly string[]): string {
  return `/compare?keys=${keys.map(encodeURIComponent).join(',')}`;
}

/** Add a key to a comparison (at most four), or remove it. */
export function toggleKey(keys: readonly string[], key: string): string[] {
  if (keys.includes(key)) return keys.filter((k) => k !== key);
  return keys.length >= MAX_COMPARE ? [...keys] : [...keys, key];
}

/** The chat composer text for "Ask the GM about him". */
export function askText(p: {
  name: string;
  nhlTeam: string;
  positions: readonly string[];
}): string {
  return `What do you think of ${p.name} (${p.nhlTeam}, ${p.positions.join('/')}) for us right now?`;
}

/** Strength bar: summed z scaled to ±8 (a full roster's range), centred at 50%. */
export function strengthBar(z: number): { left: number; width: number } {
  const clamped = Math.max(-8, Math.min(8, z));
  const w = (Math.abs(clamped) / 8) * 50;
  return clamped >= 0 ? { left: 50, width: w } : { left: 50 - w, width: w };
}

export type Segment = { text: string } | { text: string; playerKey: string };

/**
 * Split text into plain runs and player-name runs, for linking the names a decision's summary
 * mentions. Longest names first, so "Sebastian Aho" is not split by a shorter match.
 */
export function linkify(
  text: string,
  players: readonly { playerKey: string; name: string }[],
): Segment[] {
  const byName = [...players]
    .filter((p) => p.name !== '')
    .sort((a, b) => b.name.length - a.name.length);
  const out: Segment[] = [];
  let rest = text;
  while (rest !== '') {
    let hit: { at: number; p: { playerKey: string; name: string } } | undefined;
    for (const p of byName) {
      const at = rest.indexOf(p.name);
      if (at >= 0 && (hit === undefined || at < hit.at)) hit = { at, p };
    }
    if (hit === undefined) {
      out.push({ text: rest });
      break;
    }
    if (hit.at > 0) out.push({ text: rest.slice(0, hit.at) });
    out.push({ text: hit.p.name, playerKey: hit.p.playerKey });
    rest = rest.slice(hit.at + hit.p.name.length);
  }
  return out;
}
