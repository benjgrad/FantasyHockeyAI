import type { IncomingMessage, ServerResponse } from 'node:http';
import type { User } from '@fha/store';

/**
 * A router small enough to read in one sitting: method + path pattern (`:name` segments) →
 * handler. Routes marked `auth: 'user'` only run with a signed-in user whose session epoch is
 * current, and mutating ones only after the CSRF check (see `session.ts`).
 */
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export interface UserCtx extends RequestCtx {
  user: User;
}

export type Route =
  | { method: Method; path: string; auth: 'public'; handle: (c: RequestCtx) => Promise<void> }
  | { method: Method; path: string; auth: 'user'; handle: (c: UserCtx) => Promise<void> };

interface Compiled {
  route: Route;
  parts: string[];
}

export interface Match {
  route: Route;
  params: Record<string, string>;
}

export class Router {
  private readonly routes: Compiled[] = [];

  add(...routes: Route[]): this {
    for (const route of routes) this.routes.push({ route, parts: split(route.path) });
    return this;
  }

  /**
   * The route for a request. `methodMismatch` is true when the path exists under another
   * method, so the caller can answer 405 rather than fall through to the SPA.
   */
  match(method: string, path: string): { hit?: Match; methodMismatch: boolean } {
    const segs = split(path);
    let methodMismatch = false;
    for (const c of this.routes) {
      const params = matchParts(c.parts, segs);
      if (params === undefined) continue;
      if (c.route.method === method) return { hit: { route: c.route, params }, methodMismatch };
      methodMismatch = true;
    }
    return { methodMismatch };
  }
}

function split(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

function matchParts(pattern: string[], segs: string[]): Record<string, string> | undefined {
  if (pattern.length !== segs.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] ?? '';
    const s = segs[i] ?? '';
    if (p.startsWith(':')) {
      let value: string;
      try {
        value = decodeURIComponent(s);
      } catch {
        return undefined;
      }
      params[p.slice(1)] = value;
    } else if (p !== s) {
      return undefined;
    }
  }
  return params;
}
