import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

/**
 * The built client (apps/app/client/dist), with a single-page-app fallback: any GET that is not
 * a file serves index.html, so a deep link such as /decisions/<planId> from a push notification
 * opens the app at that route.
 *
 * Path traversal is refused by resolving inside the root and checking the result stays there.
 * `/sw.js` is never cached: a stale service worker would pin every user to an old client.
 * Hashed assets under /assets/ are immutable and cached for a year.
 */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function cacheControl(path: string): string {
  if (path === '/sw.js' || path.endsWith('.html') || path.endsWith('.webmanifest')) {
    return 'no-cache';
  }
  return path.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600';
}

/** The file under `root` a URL path names, or undefined when it escapes the root or is absent. */
export function resolveStatic(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const base = resolve(root);
  const file = resolve(base, `.${decoded}`);
  if (file !== base && !file.startsWith(base + sep)) return undefined;
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  return file;
}

export function serveStatic(res: ServerResponse, root: string, urlPath: string): void {
  const file = resolveStatic(root, urlPath === '/' ? '/index.html' : urlPath);
  // A missing asset is a real 404; only route-like paths (no extension) fall back to the SPA.
  const spa =
    file === undefined && extname(urlPath) === '' ? resolveStatic(root, '/index.html') : undefined;
  const target = file ?? spa;
  if (target === undefined) {
    const missing = !existsSync(resolve(root, 'index.html'));
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(missing ? 'client not built: run the client build (apps/app/client)' : 'not found');
    return;
  }
  const shownPath = target === file ? urlPath : '/index.html';
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': cacheControl(shownPath),
  });
  res.end(readFileSync(target));
}
