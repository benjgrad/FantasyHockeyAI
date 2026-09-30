import { describe, expect, it } from 'vitest';
import { strategyFor, underPath, type RequestLike } from './strategy';

const ORIGIN = 'https://hockey.example';
const get = (path: string, extra: Partial<RequestLike> = {}): RequestLike => ({
  method: 'GET',
  url: `${ORIGIN}${path}`,
  mode: 'cors',
  ...extra,
});
const decide = (req: RequestLike) => strategyFor(req, ORIGIN);

describe('strategyFor', () => {
  it('serves page loads network-first with the shell fallback', () => {
    expect(decide(get('/', { mode: 'navigate' }))).toBe('navigation');
    expect(decide(get('/decisions/abc', { mode: 'navigate' }))).toBe('navigation');
  });

  it('caches the read views, including query strings and sub-paths', () => {
    for (const path of [
      '/api/me',
      '/api/team',
      '/api/decisions?status=pending',
      '/api/decisions/plan-1',
      '/api/conversations',
      '/api/conversations/c1',
      '/api/players/8478402',
      '/api/players/search?q=mc',
      '/api/compare?ids=1,2',
    ]) {
      expect(decide(get(path)), path).toBe('api');
    }
  });

  it('never caches auth, chat, push, settings, or unlisted API routes', () => {
    for (const path of [
      '/auth/login',
      '/auth/callback?code=x',
      '/api/chat',
      '/api/chat/turns/t1/stream',
      '/api/push/vapid',
      '/api/settings/permissions',
      '/api/settings/yahoo',
      '/api/notifications',
      '/api/teams',
      '/api/team/refresh',
    ]) {
      expect(decide(get(path)), path).toBe('network');
    }
  });

  it('never intercepts an auth navigation (the sign-in redirect must reach the server)', () => {
    expect(decide(get('/auth/login', { mode: 'navigate' }))).toBe('network');
  });

  it('never caches a write, whatever the path', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'post']) {
      expect(decide(get('/api/decisions/p1/approve', { method }))).toBe('network');
      expect(decide(get('/api/team', { method }))).toBe('network');
    }
  });

  it('never answers an event stream from a cache', () => {
    expect(decide(get('/api/conversations/c1', { accept: 'text/event-stream' }))).toBe('network');
  });

  it('leaves other origins and the worker script alone', () => {
    expect(decide({ ...get('/'), url: 'https://cdn.example/x.js' })).toBe('network');
    expect(decide(get('/sw.js'))).toBe('network');
    expect(decide({ ...get('/'), url: 'not a url' })).toBe('network');
  });

  it('serves hashed assets and public files cache-first', () => {
    expect(decide(get('/assets/index-abc.js'))).toBe('static');
    expect(decide(get('/icon-192.png'))).toBe('static');
    expect(decide(get('/manifest.webmanifest'))).toBe('static');
  });
});

describe('underPath', () => {
  it('matches whole segments only', () => {
    expect(underPath('/api/team', '/api/team')).toBe(true);
    expect(underPath('/api/team/x', '/api/team')).toBe(true);
    expect(underPath('/api/teams', '/api/team')).toBe(false);
  });
});
