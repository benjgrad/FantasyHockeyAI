import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WriteOutcomeUnknownError, YahooAuthError, YahooFormError } from '../errors.js';
import { YahooWebWriter } from './writer.js';

const CRUMB = 'crumb/SECRET.x';
const T = 'T-cookie-SECRET';
const Y = 'Y-cookie-SECRET';
const PAGE = readFileSync(
  new URL('../../fixtures/web/editroster-form.html', import.meta.url),
  'utf8',
).replace('CRUMB_REDACTED', CRUMB);
const RESULT = JSON.parse(
  readFileSync(new URL('../../fixtures/web/editroster-result.json', import.meta.url), 'utf8'),
) as { status: number; contentType: string; body: unknown };

const PAGE_URL = 'https://hockey.fantasysports.yahoo.com/hockey/48535/6?date=2026-10-01';
const SAVE_URL = 'https://hockey.fantasysports.yahoo.com/hockey/48535/6/editroster';

interface Call {
  url: string;
  init: RequestInit;
}

/** A scripted Yahoo: GET → the recorded team page, POST → the recorded JSON answer. */
function fakeYahoo(over: { get?: () => Response; post?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (init.method === 'POST') {
      return Promise.resolve(
        over.post?.() ??
          new Response(JSON.stringify(RESULT.body), {
            status: RESULT.status,
            headers: { 'content-type': RESULT.contentType },
          }),
      );
    }
    return Promise.resolve(over.get?.() ?? new Response(PAGE, { status: 200 }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function writer(fetchImpl: typeof fetch, logs: string[] = []) {
  return new YahooWebWriter({
    credentials: { T, Y },
    leagueKey: '477.l.48535',
    teamKey: '477.l.48535.t.6',
    fetchImpl,
    minIntervalMs: 0,
    log: (l) => logs.push(l),
  });
}

const SWAP = {
  date: '2026-10-01',
  moves: [
    { playerKey: '477.p.5336', slot: 'G' },
    { playerKey: '477.p.9118', slot: 'BN' },
  ],
};
const fields = (body: unknown) => Object.fromEntries(new URLSearchParams(String(body)));

describe('YahooWebWriter.setLineup', () => {
  it("should GET that date's team page, then POST Yahoo's form with only our moves changed", async () => {
    const y = fakeYahoo();
    const logs: string[] = [];
    const res = await writer(y.fetchImpl, logs).setLineup(SWAP);

    expect(res).toEqual({ status: 'submitted', detail: 'Yahoo saved the lineup.' });
    const [get, post] = y.calls;
    expect(y.calls).toHaveLength(2);
    expect(get?.url).toBe(PAGE_URL);
    expect(get?.init.method).toBe('GET');
    expect(post?.url).toBe(SAVE_URL);
    expect(post?.init.method).toBe('POST');
    expect(post?.init.redirect).toBe('manual');
    const body = fields(post?.init.body);
    expect(body).toMatchObject({ '5336': 'G', '9118': 'BN', '5699': 'G', '7163': 'IR' });
    expect(body).toMatchObject({ date: '2026-10-01', crumb: CRUMB, jsubmit: 'Save Changes' });
    expect(Object.keys(body)).toHaveLength(24);
    expect(post?.init.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      origin: 'https://hockey.fantasysports.yahoo.com',
      referer: PAGE_URL,
      cookie: `T=${T}; Y=${Y}`,
    });
    const logged = logs.join('\n');
    for (const secret of [CRUMB, T, Y]) expect(logged).not.toContain(secret);
  });

  it('should refuse, sending nothing, when Yahoo serves another date', async () => {
    const y = fakeYahoo();
    await expect(writer(y.fetchImpl).setLineup({ ...SWAP, date: '2026-10-02' })).rejects.toThrow(
      YahooFormError,
    );
    expect(y.calls.map((c) => c.init.method)).toEqual(['GET']);
  });

  it('should fail without POSTing for a locked or foreign player, or a slot not offered', async () => {
    const y = fakeYahoo();
    const w = writer(y.fetchImpl);
    const locked = await w.setLineup({
      date: '2026-10-01',
      moves: [{ playerKey: '477.p.1234', slot: 'C' }],
    });
    expect(locked).toEqual({
      status: 'failed',
      detail:
        'Not sent to Yahoo: player 1234 is not editable on that date (locked, or not on our roster).',
    });
    const slot = await w.setLineup({
      date: '2026-10-01',
      moves: [{ playerKey: '477.p.5336', slot: 'C' }],
    });
    expect(slot.status).toBe('failed');
    expect(y.calls.every((c) => c.init.method === 'GET')).toBe(true);
  });

  it('should report Yahoo errors in the answer as failed', async () => {
    const y = fakeYahoo({
      post: () =>
        new Response(JSON.stringify({ errors: ['Too many players at G'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(await writer(y.fetchImpl).setLineup(SWAP)).toEqual({
      status: 'failed',
      detail: 'Yahoo refused the lineup: Too many players at G',
    });
  });

  it('should ask for a reconnect when the team page redirects to sign-in', async () => {
    const y = fakeYahoo({
      get: () =>
        new Response(null, { status: 302, headers: { location: 'https://login.yahoo.com/' } }),
    });
    await expect(writer(y.fetchImpl).setLineup(SWAP)).rejects.toThrow(YahooAuthError);
    expect(y.calls).toHaveLength(1);
  });

  it('should report a POST that dies midway as an unknown outcome, never retrying', async () => {
    const y = fakeYahoo({ post: () => Promise.reject(new TypeError('socket hang up')) });
    await expect(writer(y.fetchImpl).setLineup(SWAP)).rejects.toThrow(WriteOutcomeUnknownError);
    expect(y.calls.filter((c) => c.init.method === 'POST')).toHaveLength(1);
  });

  it('should refuse a bad date or a key from another game before any request', async () => {
    const y = fakeYahoo();
    await expect(writer(y.fetchImpl).setLineup({ ...SWAP, date: 'today' })).rejects.toThrow();
    await expect(
      writer(y.fetchImpl).setLineup({
        date: '2026-10-01',
        moves: [{ playerKey: '465.p.5336', slot: 'G' }],
      }),
    ).rejects.toThrow(/not in game 477/);
    expect(y.calls).toHaveLength(0);
  });
});
