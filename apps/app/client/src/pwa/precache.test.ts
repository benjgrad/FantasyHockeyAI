import { describe, expect, it } from 'vitest';
import { SHELL_URL, fnv1a64, precacheManifest } from './precache';

const input = {
  emitted: ['index.html', 'assets/index-abc.js', 'assets/index-def.css', 'assets/x.js.map'],
  publicFiles: ['icon-192.png', 'manifest.webmanifest', 'sw.js'],
  fingerprint: ['<html>v1</html>'],
};

describe('precacheManifest', () => {
  it('lists every emitted and public file as an absolute URL, plus the shell', () => {
    const { urls } = precacheManifest(input);
    expect(urls).toEqual([
      '/assets/index-abc.js',
      '/assets/index-def.css',
      '/icon-192.png',
      '/index.html',
      '/manifest.webmanifest',
    ]);
    expect(urls).toContain(SHELL_URL);
  });

  it('never precaches the worker itself or source maps', () => {
    const { urls } = precacheManifest(input);
    expect(urls.some((u) => u.endsWith('sw.js') || u.endsWith('.map'))).toBe(false);
  });

  it('adds the shell even when index.html was not emitted, without duplicating it', () => {
    const { urls } = precacheManifest({ ...input, emitted: ['assets/a.js'] });
    expect(urls.filter((u) => u === SHELL_URL)).toHaveLength(1);
  });

  it('versions deterministically, and changes with any file or fingerprint change', () => {
    const v1 = precacheManifest(input).version;
    expect(precacheManifest(input).version).toBe(v1);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    const renamed = precacheManifest({ ...input, emitted: ['index.html', 'assets/index-zzz.js'] });
    expect(renamed.version).not.toBe(v1);
    const htmlChanged = precacheManifest({ ...input, fingerprint: ['<html>v2</html>'] });
    expect(htmlChanged.version).not.toBe(v1);
  });

  it('is order-independent for the file lists', () => {
    const reversed = { ...input, emitted: [...input.emitted].reverse() };
    expect(precacheManifest(reversed)).toEqual(precacheManifest(input));
  });
});

describe('fnv1a64', () => {
  it('separates near-identical inputs', () => {
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
    expect(fnv1a64('')).toHaveLength(16);
  });
});
