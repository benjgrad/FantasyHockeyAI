import { describe, expect, it } from 'vitest';
import { absorbSetCookies, parseSetCookie } from './cookieJar.js';
import { cookieHeaderFor, sessionFromCredentials } from './session.js';

const NOW = 1_791_000_000;
const PAGE = 'https://hockey.fantasysports.yahoo.com/hockey/48535/6';

describe('parseSetCookie', () => {
  it('should read domain, path, flags and prefer Max-Age over Expires', () => {
    const c = parseSetCookie(
      'A1=v=1&x; Expires=Sun, 10 Oct 2027 02:32:36 GMT; Max-Age=31557600; Domain=.yahoo.com; Path=/; SameSite=Lax; Secure; HttpOnly',
      'hockey.fantasysports.yahoo.com',
      NOW,
    );
    expect(c).toEqual({
      name: 'A1',
      value: 'v=1&x',
      domain: '.yahoo.com',
      path: '/',
      expires: NOW + 31_557_600,
      httpOnly: true,
      secure: true,
    });
  });

  it('should scope a cookie without Domain to the answering host, as a session cookie', () => {
    const c = parseSetCookie('A1S=abc', 'login.yahoo.com', NOW);
    expect(c?.domain).toBe('login.yahoo.com');
    expect(c?.expires).toBe(-1);
  });

  it('should refuse a header with no name', () => {
    expect(parseSetCookie('=x; Path=/', 'yahoo.com', NOW)).toBeUndefined();
  });
});

describe('absorbSetCookies', () => {
  it('should add new cookies and send them on the next request', () => {
    const s = sessionFromCredentials({ T: 't', Y: 'y' });
    const names = absorbSetCookies(
      s,
      ['A1=a1; Domain=.yahoo.com; Max-Age=100', 'SPT=spt; domain=fantasysports.yahoo.com'],
      PAGE,
      NOW,
    );
    expect(names).toEqual(['A1', 'SPT']);
    expect(cookieHeaderFor(s, PAGE, NOW)).toBe('T=t; Y=y; A1=a1; SPT=spt');
  });

  it('should replace a cookie of the same name and domain, and delete on Max-Age=0', () => {
    const s = sessionFromCredentials({ T: 'old', Y: 'y' });
    absorbSetCookies(s, ['T=new; Domain=yahoo.com'], PAGE, NOW);
    expect(cookieHeaderFor(s, PAGE, NOW)).toBe('Y=y; T=new');
    absorbSetCookies(s, ['Y=; Domain=.yahoo.com; Max-Age=0'], PAGE, NOW);
    expect(cookieHeaderFor(s, PAGE, NOW)).toBe('T=new');
  });
});
