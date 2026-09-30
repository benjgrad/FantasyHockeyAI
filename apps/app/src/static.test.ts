import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheControl, serveStatic, staticHeaders } from './static.js';

/** The caching headers the PWA depends on (see static.ts and client/src/sw.ts). */
let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fha-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<title>FHA</title>');
  writeFileSync(join(dir, 'sw.js'), 'self.x=1');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"FantasyHockeyAI"}');
  writeFileSync(join(dir, 'icon-192.png'), 'png');
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  server = createServer((req, res) => serveStatic(res, dir, (req.url ?? '/').split('?')[0] ?? '/'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('static caching headers', () => {
  it('serves the worker uncached, as JavaScript, allowed to control the root', async () => {
    const res = await fetch(`${base}/sw.js`);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('service-worker-allowed')).toBe('/');
  });

  it('serves the manifest uncached with its own content type', async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    expect(res.headers.get('service-worker-allowed')).toBeNull();
  });

  it('serves index.html uncached, directly and as the SPA fallback', async () => {
    for (const path of ['/', '/index.html', '/decisions/plan-1']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
  });

  it('serves hashed assets immutable for a year, and icons for an hour', async () => {
    const asset = await fetch(`${base}/assets/index-abc.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const icon = await fetch(`${base}/icon-192.png`);
    expect(icon.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(icon.headers.get('content-type')).toBe('image/png');
  });

  it('is a pure function of the path', () => {
    expect(cacheControl('/sw.js')).toBe('no-cache');
    expect(staticHeaders('/sw.js', '.js')['service-worker-allowed']).toBe('/');
    expect(staticHeaders('/x.bin', '.bin')['content-type']).toBe('application/octet-stream');
  });
});
