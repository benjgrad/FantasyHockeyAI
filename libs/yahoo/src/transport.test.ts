import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { YahooAuthError, YahooHttpError, YahooThrottledError } from './errors.js';
import { redactPersonal, recordingTransport } from './redact.js';
import {
  cookieHeaderFor,
  describeSession,
  loadSessionFile,
  SessionMissingError,
  sessionFromCredentials,
  type StoredSession,
} from './session.js';
import { CookieTransport, FixtureTransport, interpret } from './transport.js';

describe('interpret', () => {
  it('should turn 401/403 into a reconnect error the UI can key on', () => {
    expect(() => interpret(401, false, '', '/x')).toThrow(YahooAuthError);
    try {
      interpret(403, false, '', '/x');
    } catch (e) {
      expect((e as YahooAuthError).code).toBe('yahoo_reconnect_required');
    }
  });

  it('should treat an HTML login page served with 200 as signed out', () => {
    expect(() => interpret(200, true, '<html>sign in</html>', '/x')).toThrow(YahooAuthError);
  });

  it('should name throttling and other HTTP failures', () => {
    expect(() => interpret(999, false, '', '/x')).toThrow(YahooThrottledError);
    expect(() => interpret(400, false, 'bad', '/x')).toThrow(YahooHttpError);
  });

  it('should parse a JSON body', () => {
    expect(interpret(200, true, '{"a":1}', '/x')).toEqual({ a: 1 });
  });
});

describe('CookieTransport', () => {
  it('should space requests by the minimum interval even when fired in parallel', async () => {
    const times: number[] = [];
    const fetchImpl = vi.fn(() => {
      times.push(Date.now());
      return Promise.resolve(new Response('{}'));
    });
    const t = new CookieTransport({
      session: sessionFromCredentials({ T: 'a', Y: 'b' }),
      fetchImpl,
      minIntervalMs: 40,
    });
    await Promise.all([t.get('/a'), t.get('/b'), t.get('/c')]);
    expect(times).toHaveLength(3);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(35);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(35);
  });

  it('should keep serving after a failed request', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('{"ok":1}'));
    const t = new CookieTransport({
      session: sessionFromCredentials({ T: 'a', Y: 'b' }),
      fetchImpl,
      minIntervalMs: 0,
    });
    await expect(t.get('/a')).rejects.toThrow(YahooHttpError);
    expect(await t.get('/b')).toEqual({ ok: 1 });
  });
});

describe('session', () => {
  const s: StoredSession = {
    savedAt: '2026-09-29T00:00:00Z',
    cookies: [
      {
        name: 'T',
        value: 'secret-t',
        domain: '.yahoo.com',
        path: '/',
        expires: 2e9,
        httpOnly: true,
        secure: true,
      },
      {
        name: 'Z',
        value: 'other',
        domain: '.example.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
      },
      {
        name: 'OLD',
        value: 'x',
        domain: '.yahoo.com',
        path: '/',
        expires: 10,
        httpOnly: false,
        secure: false,
      },
    ],
  };

  it('should send only live cookies for the request domain', () => {
    expect(cookieHeaderFor(s, 'https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/x')).toBe(
      'T=secret-t',
    );
  });

  it('should describe a session without any cookie value', () => {
    const d = JSON.stringify(describeSession(s));
    expect(d).not.toContain('secret-t');
    expect(d).toContain('"T"');
  });

  it('should load a session file and name a missing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fha-yahoo-'));
    writeFileSync(join(dir, 's.json'), JSON.stringify(s));
    expect((await loadSessionFile(join(dir, 's.json'))).cookies).toHaveLength(3);
    await expect(loadSessionFile(join(dir, 'none.json'))).rejects.toThrow(SessionMissingError);
  });
});

describe('redactPersonal', () => {
  it('should redact manager identity and chat ids but keep league data', () => {
    const body = {
      team: {
        name: "Ben's Team",
        managers: [
          {
            manager: {
              nickname: 'Ben',
              email: 'b@x.y',
              guid: 'G',
              image_url: 'u',
              felo_score: '1',
            },
          },
        ],
      },
      sendbird_channel_url: 'abc',
    };
    expect(redactPersonal(body)).toEqual({
      team: {
        name: "Ben's Team",
        managers: [{ manager: { nickname: 'REDACTED', email: 'REDACTED', guid: 'REDACTED' } }],
      },
      sendbird_channel_url: 'REDACTED',
    });
  });

  it('should record redacted bodies while returning the original to the caller', async () => {
    const sink = vi.fn();
    const t = recordingTransport(new FixtureTransport({ '/p': { email: 'e' } }), sink);
    expect(await t.get('/p')).toEqual({ email: 'e' });
    expect(sink).toHaveBeenCalledWith('/p', { email: 'REDACTED' });
  });
});

describe('CookieTransport cookie rotation (D-033)', () => {
  it('keeps cookies Yahoo sets, sends them next, and reports the whole jar', async () => {
    const cookies: string[] = [];
    let first = true;
    const fetchImpl = ((_url: string, init: RequestInit) => {
      cookies.push((init.headers as Record<string, string>).cookie);
      const h = new Headers({ 'content-type': 'application/json' });
      if (first) h.append('set-cookie', 'A3=a3; Domain=.yahoo.com; Max-Age=100');
      first = false;
      return Promise.resolve(new Response('{"fantasy_content":{}}', { status: 200, headers: h }));
    }) as typeof fetch;
    const original = sessionFromCredentials({ T: 'a', Y: 'b' });
    const seen: { names: string[]; jar: string[] }[] = [];
    const t = new CookieTransport({
      session: original,
      fetchImpl,
      minIntervalMs: 0,
      onCookies: (names, s) => seen.push({ names, jar: s.cookies.map((c) => c.name) }),
    });
    await t.get('/a');
    await t.get('/b');
    expect(cookies).toEqual(['T=a; Y=b', 'T=a; Y=b; A3=a3']);
    expect(seen).toEqual([{ names: ['A3'], jar: ['T', 'Y', 'A3'] }]);
    expect(original.cookies.map((c) => c.name)).toEqual(['T', 'Y']);
  });
});
