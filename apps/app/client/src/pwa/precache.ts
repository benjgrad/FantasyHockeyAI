/**
 * The precache manifest: which files the service worker stores at install, and the version
 * string that names this build's cache.
 *
 * Pure (no node:, no DOM) so vite.config.ts can call it at build time and the tests can call
 * it without a build. The result is injected into `dist/sw.js` as constants, so the worker
 * never needs a second request to learn what to cache — and because the list is part of the
 * worker's own bytes, every build that changes the app also changes `sw.js`, which is how the
 * browser notices an update at all.
 */

export interface PrecacheInput {
  /** Every file the main build emitted (Rollup's bundle keys), relative to the outDir. */
  readonly emitted: readonly string[];
  /** Files copied from public/ (names only), relative to the outDir. */
  readonly publicFiles: readonly string[];
  /**
   * Extra strings folded into the version: index.html's source and a digest of each public
   * file's bytes. Hashed asset names already carry their content; these files do not.
   */
  readonly fingerprint: readonly string[];
}

export interface PrecacheManifest {
  /** Short, stable for identical input, different for any change. Names the cache. */
  readonly version: string;
  /** Absolute URL paths to fetch at install. */
  readonly urls: readonly string[];
}

/** The URL the SPA shell is cached under; navigations fall back to it offline. */
export const SHELL_URL = '/index.html';

/** Never precached: the worker itself, source maps, and anything that is not served. */
function precacheable(name: string): boolean {
  return name !== 'sw.js' && !name.endsWith('.map') && !name.startsWith('.');
}

export function precacheManifest(input: PrecacheInput): PrecacheManifest {
  const files = [...input.emitted, ...input.publicFiles].filter(precacheable);
  const urls = Array.from(new Set([...files.map((name) => `/${name}`), SHELL_URL])).sort();
  const version = fnv1a64([...urls, ...input.fingerprint].join('\n'));
  return { version, urls };
}

/**
 * FNV-1a over UTF-16 code units, as two 32-bit lanes → 16 hex chars. Not cryptographic; it
 * only has to change when the build changes, and it keeps this module free of node:crypto.
 */
export function fnv1a64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (a & 0xff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
