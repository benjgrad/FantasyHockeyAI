import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '@fha/auth';
import { cookieHeaderFor, sessionFromCredentials } from '@fha/yahoo';
import { GOOD_COOKIE, SECRET, call, signIn, startHarness, type Harness } from './testing.js';
import { openCredentials, pastedSession, persistRotated, sealCredentials } from './yahoo.js';

const URL_ = 'https://hockey.fantasysports.yahoo.com/hockey/1/2';

describe('the stored cookie jar (D-033)', () => {
  it('round-trips a jar and still opens a connection stored as T and Y', () => {
    const s = pastedSession('tt', 'yy', { A3: 'a3', A1S: 'a1s', T: 'ignored', empty: '' });
    const back = openCredentials(SECRET, sealCredentials(SECRET, s));
    expect(back?.cookies.map((c) => c.name)).toEqual(['T', 'Y', 'A3', 'A1S']);
    expect(cookieHeaderFor(back ?? s, URL_)).toBe('T=tt; Y=yy; A3=a3; A1S=a1s');
    const legacy = encrypt(SECRET, JSON.stringify({ T: 'old-t', Y: 'old-y' }));
    expect(cookieHeaderFor(openCredentials(SECRET, legacy) ?? s, URL_)).toBe('T=old-t; Y=old-y');
    expect(openCredentials('x'.repeat(48), legacy)).toBeUndefined();
  });
});

describe('persistRotated', () => {
  let h: Harness;
  let userId = '';
  beforeEach(async () => {
    h = await startHarness();
    await signIn(h);
    userId = h.store.users.bySub('ben-sub')?.id ?? '';
    h.store.yahooConnections.saveCredentials(
      userId,
      sealCredentials(SECRET, pastedSession('t', 'y', { A1: 'a1' })),
    );
  });
  afterEach(async () => {
    await h.close();
  });

  it('applies only the changed cookies onto the jar stored now, so rotations do not collide', () => {
    const deps = { store: h.store, secretKey: SECRET, log: (l: string) => h.logs.push(l) };
    // Reader A started from the original jar and Yahoo rotated A1; reader B rotated SPT.
    const a = pastedSession('t', 'y', { A1: 'a1-new' });
    const b = pastedSession('t', 'y', { A1: 'a1', SPT: 'spt' });
    persistRotated(deps, userId, ['A1'], a);
    persistRotated(deps, userId, ['SPT'], b);
    const conn = h.store.yahooConnections.get(userId);
    const jar = openCredentials(SECRET, conn?.cookiesEnc ?? '');
    expect(cookieHeaderFor(jar ?? sessionFromCredentials({ T: '', Y: '' }), URL_)).toBe(
      'T=t; Y=y; A1=a1-new; SPT=spt',
    );
    // A cookie Yahoo deleted (absent from the session) is dropped.
    persistRotated(deps, userId, ['SPT'], pastedSession('t', 'y'));
    const after = openCredentials(SECRET, h.store.yahooConnections.get(userId)?.cookiesEnc ?? '');
    expect(after?.cookies.map((c) => c.name)).toEqual(['T', 'Y', 'A1']);
    expect(h.logs.join('\n')).not.toContain('a1-new');
  });
});

describe('Connect with the whole paste', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('stores every cookie, logs only names, and refuses a malformed cookie name', async () => {
    const { cookie } = await signIn(h);
    const ok = await call(h, '/api/settings/yahoo', {
      cookie,
      body: { T: GOOD_COOKIE, Y: 'good-cookie-value-Y', cookies: { A3: 'a3-SECRET-v' } },
    });
    expect(ok.status).toBe(200);
    const userId = h.store.users.bySub('ben-sub')?.id ?? '';
    const jar = openCredentials(SECRET, h.store.yahooConnections.get(userId)?.cookiesEnc ?? '');
    expect(jar?.cookies.map((c) => c.name)).toEqual(['T', 'Y', 'A3']);
    expect(h.logs.some((l) => l.includes('cookies A3, T, Y'))).toBe(true);
    expect(h.logs.join('\n')).not.toContain('a3-SECRET-v');
    const bad = await call(h, '/api/settings/yahoo', {
      cookie,
      body: { T: GOOD_COOKIE, Y: 'good-cookie-value-Y', cookies: { 'A3; x': 'v' } },
    });
    expect(bad.status).toBe(400);
  });
});
