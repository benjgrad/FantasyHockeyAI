import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WriteOutcomeUnknownError, YahooAuthError, YahooFormError } from '../errors.js';
import { interpretTradeSend, parseTradeReview, reviewRequestBody, sendBody } from './trade.js';
import { YahooWebWriter } from './writer.js';

const CRUMB = 'crumb/SECRET.x';
const T = 'T-cookie-SECRET';
const Y = 'Y-cookie-SECRET';
const IDS = { leagueId: '48535', teamId: '6' };
const REVIEW = readFileSync(
  new URL('../../fixtures/web/proposetrade-review.html', import.meta.url),
  'utf8',
).replace('CRUMB_REDACTED', CRUMB);
const SENT = JSON.parse(
  readFileSync(new URL('../../fixtures/web/proposetrade-sent.json', import.meta.url), 'utf8'),
) as { status: number; location: string };
const URL_ = 'https://hockey.fantasysports.yahoo.com/hockey/48535/6/proposetrade';

/** Ben's trade (HAR, 2026-10-01): Sergachev + Marchand to team 2 for Bouchard. */
const TRADE = { partnerId: '2', give: ['7117', '4351'], get: ['7908'] };
const REQUEST = {
  partnerTeamKey: '477.l.48535.t.2',
  give: ['477.p.7117', '477.p.4351'],
  get: ['477.p.7908'],
  note: 'Two bodies for one',
};

/** The bodies Ben's browser sent, crumb aside. */
const OBSERVED_REVIEW =
  'stage=3&mid2=2&trid=&onote=&note=&tpids2%5B%5D=7908&tpids%5B%5D=7117&tpids%5B%5D=4351&evaluate=&jsubmit=continue';
const OBSERVED_SEND = `stage=5&mid2=2&trid=&onote=&crumb=${encodeURIComponent(CRUMB)}&tpids2%5B%5D=7908&tpids%5B%5D=7117&tpids%5B%5D=4351&note=&evaluate=&jsubmit=send+trade+proposal`;

describe('trade parsers', () => {
  it('reproduce the observed review request and send', () => {
    expect(reviewRequestBody(TRADE)).toBe(OBSERVED_REVIEW);
    expect(sendBody(parseTradeReview(REVIEW, IDS), '')).toBe(OBSERVED_SEND);
  });

  it('refuse a page without the review form, or one for another team', () => {
    expect(() => parseTradeReview('<html></html>', IDS)).toThrow(YahooFormError);
    expect(() => parseTradeReview(REVIEW, { leagueId: '48535', teamId: '7' })).toThrow(/refusing/);
    expect(() => parseTradeReview(REVIEW.replace(CRUMB, ''), IDS)).toThrow(/crumb/);
  });

  it('read the observed 302 to our team page as sent; anything else is left to verify', () => {
    expect(interpretTradeSend(SENT.status, SENT.location, IDS)).toEqual({
      status: 'submitted',
      detail: 'Yahoo sent the trade proposal.',
    });
    expect(interpretTradeSend(200, null, IDS).detail).toMatch(/unknown outcome/);
    expect(interpretTradeSend(302, 'https://login.yahoo.com/x', IDS).status).toBe('failed');
  });
});

interface Call {
  url: string;
  init: RequestInit;
}

/** POSTs land in `calls`; the team-page GET that warms the cookies lands in `gets`. */
function fakeYahoo(
  over: {
    review?: () => Response;
    send?: () => Response | Promise<Response>;
    team?: () => Response;
  } = {},
) {
  const calls: Call[] = [];
  const gets: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    if (init.method === 'GET') {
      gets.push({ url, init });
      return Promise.resolve(over.team?.() ?? new Response('<html>team</html>', { status: 200 }));
    }
    calls.push({ url, init });
    const stage = new URLSearchParams(String(init.body)).get('stage');
    if (stage === '3')
      return Promise.resolve(over.review?.() ?? new Response(REVIEW, { status: 200 }));
    return Promise.resolve(
      over.send?.() ??
        new Response(null, { status: SENT.status, headers: { location: SENT.location } }),
    );
  }) as typeof fetch;
  return { calls, gets, fetchImpl };
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

describe('YahooWebWriter.proposeTrade', () => {
  it('asks for the review, then sends exactly that form with our note', async () => {
    const y = fakeYahoo();
    const logs: string[] = [];
    const res = await writer(y.fetchImpl, logs).proposeTrade(REQUEST);
    expect(res).toEqual({ status: 'submitted', detail: 'Yahoo sent the trade proposal.' });
    const [review, send] = y.calls;
    expect(y.calls).toHaveLength(2);
    expect(review?.url).toBe(URL_);
    expect(review?.init.body).toBe(OBSERVED_REVIEW);
    expect(send?.url).toBe(URL_);
    expect(send?.init.body).toBe(
      OBSERVED_SEND.replace(
        '&note=&',
        `&note=${encodeURIComponent(REQUEST.note).replace(/%20/g, '+')}&`,
      ),
    );
    expect(send?.init.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://hockey.fantasysports.yahoo.com',
      cookie: `T=${T}; Y=${Y}`,
    });
    const logged = logs.join('\n');
    for (const secret of [CRUMB, T, Y]) expect(logged).not.toContain(secret);
  });

  it('never sends when Yahoo’s review is not our trade', async () => {
    const y = fakeYahoo();
    const res = await writer(y.fetchImpl).proposeTrade({ ...REQUEST, get: ['477.p.1234'] });
    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/^Not sent to Yahoo/);
    expect(y.calls).toHaveLength(1);
  });

  it('a dead session at the review step sends nothing', async () => {
    const y = fakeYahoo({
      review: () =>
        new Response(null, { status: 302, headers: { location: 'https://login.yahoo.com/' } }),
    });
    await expect(writer(y.fetchImpl).proposeTrade(REQUEST)).rejects.toThrow(YahooAuthError);
    expect(y.calls).toHaveLength(1);
  });

  it('a send that dies midway is an unknown outcome, never retried', async () => {
    const y = fakeYahoo({ send: () => Promise.reject(new TypeError('socket hang up')) });
    await expect(writer(y.fetchImpl).proposeTrade(REQUEST)).rejects.toThrow(
      WriteOutcomeUnknownError,
    );
    expect(y.calls).toHaveLength(2);
  });

  it('refuses our own team or a team from another league before any request', async () => {
    const y = fakeYahoo();
    const w = writer(y.fetchImpl);
    await expect(
      w.proposeTrade({ ...REQUEST, partnerTeamKey: '477.l.48535.t.6' }),
    ).rejects.toThrow();
    await expect(w.proposeTrade({ ...REQUEST, partnerTeamKey: '477.l.1.t.2' })).rejects.toThrow();
    expect(y.calls).toHaveLength(0);
    expect(y.gets).toHaveLength(0);
  });

  it('loads our team page first and sends the review with the cookies Yahoo set (U-30)', async () => {
    let first = true;
    const y = fakeYahoo({
      team: () => {
        if (!first) return new Response('<html>team</html>', { status: 200 });
        first = false;
        const h = new Headers({ location: 'https://login.yahoo.com/config/login?noPrompt=1' });
        h.append('set-cookie', 'A1=a1-SECRET; Domain=.yahoo.com; Max-Age=100');
        return new Response(null, { status: 302, headers: h });
      },
    });
    const res = await writer(y.fetchImpl).proposeTrade(REQUEST);
    expect(res.status).toBe('submitted');
    expect(y.gets).toHaveLength(2);
    expect(y.gets[0]?.url).toBe('https://hockey.fantasysports.yahoo.com/hockey/48535/6');
    expect((y.calls[0]?.init.headers as Record<string, string>).cookie).toBe(
      `T=${T}; Y=${Y}; A1=a1-SECRET`,
    );
  });
});
