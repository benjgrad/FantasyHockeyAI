import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The brand's guard rails (D-019): every colour in the app is a role token from styles.css,
 * and every role pairing the UI actually draws reads at WCAG AA in both themes.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');

type Pair = { light: string; dark: string };

/** `--color-x: light-dark(#light, #dark);` from the @theme block, by role. */
function tokens(): Map<string, Pair> {
  const out = new Map<string, Pair>();
  const re = /--color-([a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6,8}),\s*(#[0-9a-f]{6,8})\)/g;
  for (const m of css.matchAll(re)) out.set(m[1] ?? '', { light: m[2] ?? '', dark: m[3] ?? '' });
  return out;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Text role → the surfaces it is drawn on. Each pair must reach 4.5:1 (AA, body text). */
const TEXT_ON: Record<string, string[]> = {
  ink: ['bg', 'card', 'raised', 'well', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `heat-${n}`)],
  soft: ['bg', 'card', 'raised', 'well'],
  mut: ['bg', 'card', 'raised', 'well'],
  'brand-ink': ['bg', 'card', 'raised'],
  'on-brand': ['brand'],
  acc: ['bg', 'card'],
  good: ['bg', 'card'],
  warn: ['bg', 'card'],
  bad: ['bg', 'card'],
  bg: ['warn'], // the pending-count badge
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('brand tokens', () => {
  const t = tokens();

  it('defines every role the app draws with, in both themes', () => {
    const roles = new Set([...Object.keys(TEXT_ON), ...Object.values(TEXT_ON).flat()]);
    for (const role of roles) expect(t.has(role), `--color-${role}`).toBe(true);
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`reads at AA in the ${theme} theme`, () => {
      const failures: string[] = [];
      for (const [fg, surfaces] of Object.entries(TEXT_ON)) {
        for (const bg of surfaces) {
          const [a, b] = [t.get(fg)?.[theme], t.get(bg)?.[theme]];
          if (!a || !b) continue;
          const ratio = contrast(a, b);
          if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('keeps colour out of components: no hex, rgb() or raw Tailwind palette classes', () => {
    const allowed = new Set(['theme/theme.ts']); // the status-bar colours, mirrored from CSS
    const palette =
      /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|shadow|accent)-(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/;
    const literal = /#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(/;
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path))
      .filter((rel) => !allowed.has(rel))
      .flatMap((rel) =>
        readFileSync(join(SRC, rel), 'utf8')
          .split('\n')
          .map((line, i) => ({ rel, line, n: i + 1 }))
          .filter(({ line }) => palette.test(line) || literal.test(line))
          .map(({ rel: r, n, line }) => `${r}:${n} ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});
