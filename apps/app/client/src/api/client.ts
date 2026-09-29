import { ApiError } from '@fha/api';
import type { z } from 'zod';

/**
 * The one way this client talks to the server. Every response is parsed with the contract's
 * zod schema, so a drift between server and client fails here, loudly, instead of rendering
 * `undefined`. Every failure leaves as a `RequestError` with a `code` callers branch on.
 */

/** Sent on every mutation: a header a cross-site form cannot set (see `@fha/auth` originOk). */
export const CSRF_HEADER = 'x-fha';

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }

  get signedOut(): boolean {
    return this.status === 401;
  }

  /** Yahoo needs (re)connecting in Settings before this can work. */
  get needsYahoo(): boolean {
    return isYahooCode(this.code);
  }
}

export function isYahooCode(code: string): boolean {
  return code === 'yahoo_not_connected' || code === 'yahoo_reconnect_required';
}

/** No Anthropic key on the server: the assistant cannot answer, but the rest of the app works. */
export function isMissingKeyCode(code: string): boolean {
  return /api[_-]?key|anthropic|llm_not_configured/i.test(code);
}

/** 502/503/504: a proxy answered, the app did not. */
const GATEWAY = new Set([502, 503, 504]);
export const OFFLINE_MESSAGE = 'Can’t reach the FantasyHockeyAI server.';

/** Maps a failed response to a RequestError. Pure, so the mapping is tested without a server. */
export function errorFromResponse(status: number, bodyText: string): RequestError {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = undefined;
  }
  const parsed = ApiError.safeParse(json);
  if (parsed.success) {
    return new RequestError(status, parsed.data.error.code, parsed.data.error.message);
  }
  if (GATEWAY.has(status)) return new RequestError(status, 'offline', OFFLINE_MESSAGE);
  if (status === 401) return new RequestError(status, 'signed_out', 'You are signed out.');
  return new RequestError(status, `http_${status}`, `The server answered ${status}.`);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export function headersFor(method: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  if (hasBody) headers['content-type'] = 'application/json';
  return headers;
}

/** Sends a request and returns the raw Response, mapping transport and HTTP failures. */
export async function send(
  fetchImpl: FetchLike,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  const hasBody = options.body !== undefined;
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method,
      headers: headersFor(method, hasBody),
      body: hasBody ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RequestError(0, 'offline', OFFLINE_MESSAGE);
  }
  if (!response.ok) throw errorFromResponse(response.status, await response.text());
  return response;
}

/** A request whose JSON response is parsed with `schema`. */
export async function requestJson<S extends z.ZodTypeAny>(
  fetchImpl: FetchLike,
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.infer<S>> {
  const response = await send(fetchImpl, path, options);
  const text = await response.text();
  let json: unknown;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    throw new RequestError(
      response.status,
      'bad_response',
      'The server sent something unreadable.',
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : '';
    throw new RequestError(
      response.status,
      'bad_response',
      `The server’s answer to ${path} didn’t match the contract. ${where}`.trim(),
    );
  }
  return parsed.data;
}

/** A readable one-liner for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof RequestError) {
    if (isMissingKeyCode(error.code)) return missingKeyMessage;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export const missingKeyMessage =
  'The assistant isn’t available: the server has no Anthropic API key configured. Team, Decisions and Settings still work.';
