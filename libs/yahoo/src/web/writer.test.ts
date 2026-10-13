import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NotObservedError,
  WriteOutcomeUnknownError,
  YahooAuthError,
  YahooFormError,
} from '../errors.js';
import { idsFor, interpretPost, playerIdFor, YahooWebWriter } from './writer.js';

const CRUMB = 'crumb-SECRET-a1b2';
const T = 'T-cookie-SECRET';
const Y = 'Y-cookie-SECRET';
const FORM_HTML = readFileSync(
  new URL('../../fixtures/web/addplayer-form.html', import.meta.url),
  'utf8',
).replace('CRUMB_REDACTED', CRUMB);
const RESULT = JSON.parse(
  readFileSync(new URL('../../fixtures/web/addplayer-result.json', import.meta.url), 'utf8'),
) as { status: number; location: string };

interface Call {
  url: string;
  init: RequestInit;
}

/** A scripted Yahoo: GET → the recorded form, POST → the recorded 302, unless overridden. */
function fakeYahoo(over: { get?: () => Response; post?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (init.method === 'POST') {
      return Promise.resolve(
        over.post?.() ??
          new Response(null, { status: RESULT.status, headers: { location: RESULT.location } }),
      );
    }
    return Promise.resolve(over.get?.() ?? new Response(FORM_HTML, { status: 200 }));
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

const headers = (c: Call | undefined) => (c?.init.headers ?? {}) as Record<string, string>;

describe('YahooWebWriter.addDrop', () => {
  it('should GET the form then POST exactly the observed body and headers', async () => {
    const y = fakeYahoo();
    const logs: string[] = [];
    const res = await writer(y.fetchImpl, logs).addDrop({ addPlayerKey: '477.p.5336' });

    expect(res).toEqual({ status: 'submitted', detail: 'Yahoo: added Darcy Kuemper' });
    expect(y.calls).toHaveLength(2);
    const [get, post] = y.calls;
    const formUrl = 'https://hockey.fantasysports.yahoo.com/hockey/48535/addplayer?apid=5336';
    expect(get?.url).toBe(formUrl);
    expect(get?.init.method).toBe('GET');
    expect(get?.init.redirect).toBe('manual');
    expect(post?.url).toBe('https://hockey.fantasysports.yahoo.com/hockey/48535/6/addplayer');
    expect(post?.init.method).toBe('POST');
    expect(post?.init.redirect).toBe('manual');
    expect(post?.init.body).toBe(`stage=3&crumb=${CRUMB}&stat1=P&stat2=P&apid=5336`);
    expect(headers(post)).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://hockey.fantasysports.yahoo.com',
      referer: formUrl,
      cookie: `T=${T}; Y=${Y}`,
    });
    expect(headers(post)['user-agent']).toMatch(/Chrome\//);
    expect(post?.init.signal).toBeInstanceOf(AbortSignal);

    const logged = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [CRUMB, T, Y]) expect(logged).not.toContain(secret);
  });

  it('should add dpid to the body when dropping a droppable player', async () => {
    const y = fakeYahoo();
    await writer(y.fetchImpl).addDrop({ addPlayerKey: '477.p.5336', dropPlayerKey: '477.p.7163' });
    expect(y.calls[1]?.init.body).toBe(
      `stage=3&crumb=${CRUMB}&stat1=P&stat2=P&apid=5336&dpid=7163`,
    );
  });

  it('should fail without POSTing when Yahoo does not offer the drop', async () => {
    const y = fakeYahoo();
    const res = await writer(y.fetchImpl).addDrop({
      addPlayerKey: '477.p.5336',
      dropPlayerKey: '477.p.3988',
    });
    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/Yahoo does not allow dropping 477\.p\.3988/);
    expect(y.calls.map((c) => c.init.method)).toEqual(['GET']);
  });

  it('should refuse a pure drop as unobserved, sending nothing', async () => {
    const y = fakeYahoo();
    await expect(writer(y.fetchImpl).addDrop({ dropPlayerKey: '477.p.7163' })).rejects.toThrow(
      NotObservedError,
    );
    expect(y.calls).toHaveLength(0);
  });

  it('should ask for a reconnect when the form redirects to sign-in', async () => {
    const y = fakeYahoo({
      get: () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://login.yahoo.com/?done=https%3A%2F%2Fhockey' },
        }),
    });
    const err = await writer(y.fetchImpl)
      .addDrop({ addPlayerKey: '477.p.5336' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YahooAuthError);
    expect((err as YahooAuthError).code).toBe('yahoo_reconnect_required');
    expect(y.calls).toHaveLength(1);
  });

  it('should keep the cookies a silent sign-in sets and ask for the form once more (U-30)', async () => {
    let gets = 0;
    const logs: string[] = [];
    const y = fakeYahoo({
      get: () => {
        gets += 1;
        if (gets > 1) return new Response(FORM_HTML, { status: 200 });
        const h = new Headers({
          location: 'https://login.yahoo.com/config/login?noPrompt=1&.done=https%3A%2F%2Fhockey',
        });
        h.append('set-cookie', 'A1=a1-SECRET; Domain=.yahoo.com; Max-Age=31557600; Secure');
        h.append('set-cookie', 'A3=a3-SECRET; Domain=.yahoo.com; Max-Age=31557600; Secure');
        return new Response(null, { status: 302, headers: h });
      },
    });
    const res = await writer(y.fetchImpl, logs).addDrop({ addPlayerKey: '477.p.5336' });
    expect(res.status).toBe('submitted');
    expect(y.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'POST']);
    expect(headers(y.calls[1]).cookie).toBe(`T=${T}; Y=${Y}; A1=a1-SECRET; A3=a3-SECRET`);
    expect(headers(y.calls[2]).cookie).toBe(`T=${T}; Y=${Y}; A1=a1-SECRET; A3=a3-SECRET`);
    expect(logs.join('\n')).not.toContain('SECRET');
  });

  it('should report rotated cookies and check the site read only (D-033)', async () => {
    const rotated: string[][] = [];
    const y = fakeYahoo({
      get: () => {
        const h = new Headers();
        h.append('set-cookie', 'SPT=spt-SECRET; domain=fantasysports.yahoo.com; Max-Age=100');
        return new Response('<html>team</html>', { status: 200, headers: h });
      },
    });
    const w = new YahooWebWriter({
      credentials: { T, Y },
      leagueKey: '477.l.48535',
      teamKey: '477.l.48535.t.6',
      fetchImpl: y.fetchImpl,
      minIntervalMs: 0,
      onCookies: (names) => rotated.push(names),
    });
    await w.checkSite();
    expect(y.calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', 'https://hockey.fantasysports.yahoo.com/hockey/48535/6'],
    ]);
    expect(rotated).toEqual([['SPT']]);
  });

  it('should report a dead site from the keepalive', async () => {
    const y = fakeYahoo({
      get: () =>
        new Response(null, { status: 302, headers: { location: 'https://login.yahoo.com/' } }),
    });
    await expect(writer(y.fetchImpl).checkSite()).rejects.toThrow(YahooAuthError);
  });

  it('should ask only once more, then report a dead session without POSTing', async () => {
    const y = fakeYahoo({
      get: () => {
        const h = new Headers({ location: 'https://login.yahoo.com/config/login?noPrompt=1' });
        h.append('set-cookie', 'A1S=x; Domain=.yahoo.com');
        return new Response(null, { status: 302, headers: h });
      },
    });
    const err = await writer(y.fetchImpl)
      .addDrop({ addPlayerKey: '477.p.5336' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YahooAuthError);
    expect(y.calls.map((c) => c.init.method)).toEqual(['GET', 'GET']);
  });

  it('should refuse a form for a different player than asked', async () => {
    const y = fakeYahoo();
    await expect(writer(y.fetchImpl).addDrop({ addPlayerKey: '477.p.1' })).rejects.toThrow(
      YahooFormError,
    );
    expect(y.calls).toHaveLength(1);
  });

  it('should refuse a player key from another game before any request', async () => {
    const y = fakeYahoo();
    await expect(writer(y.fetchImpl).addDrop({ addPlayerKey: '465.p.5336' })).rejects.toThrow(
      /not in game 477/,
    );
    expect(y.calls).toHaveLength(0);
  });

  it('should report a POST that dies midway as an unknown outcome, never retrying', async () => {
    const y = fakeYahoo({ post: () => Promise.reject(new TypeError('socket hang up')) });
    await expect(writer(y.fetchImpl).addDrop({ addPlayerKey: '477.p.5336' })).rejects.toThrow(
      WriteOutcomeUnknownError,
    );
    expect(y.calls.filter((c) => c.init.method === 'POST')).toHaveLength(1);
  });

  it('should stop before sending when the caller aborts', async () => {
    const y = fakeYahoo();
    const ac = new AbortController();
    ac.abort();
    await expect(
      writer(y.fetchImpl).addDrop({ addPlayerKey: '477.p.5336' }, ac.signal),
    ).rejects.toThrow();
    expect(y.calls).toHaveLength(0);
  });

  it('should space requests by the minimum interval', async () => {
    const y = fakeYahoo();
    const waits: number[] = [];
    let clock = 1000;
    const w = new YahooWebWriter({
      credentials: { T, Y },
      leagueKey: '477.l.48535',
      teamKey: '477.l.48535.t.6',
      fetchImpl: y.fetchImpl,
      minIntervalMs: 2000,
      now: () => clock,
      sleep: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    await w.addDrop({ addPlayerKey: '477.p.5336' });
    expect(waits).toEqual([2000]);
  });
});

describe('interpretPost', () => {
  it('should treat a Yahoo refusal as failed and an unreadable answer as submitted', () => {
    const no = `/hockey/48535/6?_global_alerts=${encodeURIComponent('S=|[{"errno":7,"status":1,"params":["weekly add limit reached"]}]')}`;
    expect(interpretPost(302, no)).toEqual({
      status: 'failed',
      detail: 'Yahoo refused (errno 7): weekly add limit reached',
    });
    expect(interpretPost(200, null).status).toBe('submitted');
    expect(interpretPost(302, 'https://login.yahoo.com/').status).toBe('failed');
  });
});

describe('ids', () => {
  it('should derive numeric ids and refuse a team from another league', () => {
    expect(idsFor('477.l.48535', '477.l.48535.t.6')).toEqual({
      gameKey: '477',
      leagueId: '48535',
      teamId: '6',
    });
    expect(() => idsFor('477.l.48535', '477.l.1.t.6')).toThrow(/not in league/);
    expect(playerIdFor('477.p.5336', '477')).toBe('5336');
  });
});
