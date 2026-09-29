import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';

/**
 * JSON over `node:http`, with the few rules every route shares: a body size limit, security
 * headers on every response, and errors in the contract's `{ error: { code, message } }` shape.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** A failure with an HTTP status and a stable code the client keys on. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Sent on everything. The CSP allows only this origin: the client is bundled, and the chat
 * stream and API are same-origin.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function applySecurityHeaders(res: ServerResponse, secure: boolean): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (secure) res.setHeader('strict-transport-security', 'max-age=31536000');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

/** The raw body, refused past {@link MAX_BODY_BYTES}. Never logged: it may hold Yahoo cookies. */
export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared > limit) throw new HttpError(413, 'body_too_large', `body over ${limit} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new HttpError(413, 'body_too_large', `body over ${limit} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse and validate a JSON body against a contract schema; a bad one is a 400, not a 500. */
export async function readJson<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const raw = await readBody(req);
  let json: unknown;
  try {
    json = raw === '' ? {} : JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'bad_json', 'the request body is not JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Paths and messages only: zod messages never echo the offending value.
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ');
    throw new HttpError(400, 'invalid_request', detail);
  }
  return parsed.data;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
