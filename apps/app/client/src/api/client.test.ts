import { DecisionCard } from '@fha/api';
import { describe, expect, it } from 'vitest';
import {
  CSRF_HEADER,
  RequestError,
  describeError,
  errorFromResponse,
  headersFor,
  isMissingKeyCode,
  requestJson,
  send,
  type FetchLike,
} from './client';

const card = {
  planId: 'p1',
  kind: 'addDrop',
  status: 'pending',
  summary: 'Add A, drop B',
  rationale: 'because',
  gateReasons: ['kind addDrop is ask'],
  agent: 'waivers',
  createdAt: '2026-09-29T12:00:00Z',
  deadline: null,
  result: null,
};

function respond(status: number, body: string): FetchLike {
  return async () => new Response(body, { status });
}

describe('errorFromResponse', () => {
  it('maps the contract error envelope to code and message', () => {
    const err = errorFromResponse(
      409,
      JSON.stringify({ error: { code: 'yahoo_not_connected', message: 'Connect Yahoo' } }),
    );
    expect(err).toBeInstanceOf(RequestError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('yahoo_not_connected');
    expect(err.message).toBe('Connect Yahoo');
    expect(err.needsYahoo).toBe(true);
  });

  it('treats 401 as signed out even without an envelope', () => {
    const err = errorFromResponse(401, '');
    expect(err.code).toBe('signed_out');
    expect(err.signedOut).toBe(true);
  });

  it('maps a proxy gateway error to offline', () => {
    expect(errorFromResponse(502, '<html>Bad gateway</html>').code).toBe('offline');
    expect(errorFromResponse(504, '').code).toBe('offline');
  });

  it('falls back to http_<status> for an unknown body', () => {
    const err = errorFromResponse(500, 'oops');
    expect(err.code).toBe('http_500');
    expect(err.needsYahoo).toBe(false);
  });
});

describe('headersFor', () => {
  it('sends x-fha on every mutation and never on a GET', () => {
    expect(headersFor('GET', false)[CSRF_HEADER]).toBeUndefined();
    for (const m of ['POST', 'PUT', 'DELETE']) expect(headersFor(m, false)[CSRF_HEADER]).toBe('1');
    expect(headersFor('POST', true)['content-type']).toBe('application/json');
  });
});

describe('requestJson', () => {
  it('parses a valid response with the contract schema', async () => {
    const out = await requestJson(respond(200, JSON.stringify(card)), '/x', DecisionCard);
    expect(out.planId).toBe('p1');
  });

  it('rejects a response that does not match the contract', async () => {
    const bad = { ...card, gateReasons: 'nope' };
    await expect(
      requestJson(respond(200, JSON.stringify(bad)), '/x', DecisionCard),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('rejects unreadable JSON', async () => {
    await expect(requestJson(respond(200, '{'), '/x', DecisionCard)).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('throws the mapped ApiError on a 4xx', async () => {
    const body = JSON.stringify({ error: { code: 'signed_out', message: 'Sign in' } });
    await expect(requestJson(respond(401, body), '/api/me', DecisionCard)).rejects.toMatchObject({
      status: 401,
      code: 'signed_out',
    });
  });

  it('maps a transport failure to offline', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(send(down, '/api/me')).rejects.toMatchObject({ status: 0, code: 'offline' });
  });

  it('sends the body as JSON with the CSRF header', async () => {
    let seen: RequestInit | undefined;
    const spy: FetchLike = async (_input, init) => {
      seen = init;
      return new Response('{}', { status: 200 });
    };
    await send(spy, '/api/x', { method: 'PUT', body: { a: 1 } });
    expect(seen?.body).toBe('{"a":1}');
    expect((seen?.headers as Record<string, string>)[CSRF_HEADER]).toBe('1');
    expect(seen?.credentials).toBe('same-origin');
  });
});

describe('describeError', () => {
  it('turns a missing API key code into a readable message', () => {
    expect(isMissingKeyCode('anthropic_api_key_missing')).toBe(true);
    expect(describeError(new RequestError(503, 'no_api_key', 'x'))).toMatch(/Anthropic API key/);
  });

  it('passes through other messages', () => {
    expect(describeError(new RequestError(400, 'bad', 'Bad input'))).toBe('Bad input');
    expect(describeError('?')).toBe('Something went wrong.');
  });
});
