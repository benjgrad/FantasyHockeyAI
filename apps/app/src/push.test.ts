import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { inQuietHours, noticeFromPipeline } from './push.js';
import { call, signIn, startHarness, type Harness } from './testing.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const SUB = { endpoint: 'https://push.example/one', keys: { p256dh: 'p', auth: 'a' } };

async function subscribed(): Promise<{ h: Harness; cookie: string; userId: string }> {
  h = await startHarness();
  const { cookie } = await signIn(h);
  if (cookie === undefined) throw new Error('no cookie');
  await call(h, '/api/push/subscribe', { cookie, body: SUB });
  return { h, cookie, userId: h.store.users.bySub('ben-sub')?.id ?? '' };
}

describe('push routes', () => {
  it('serves the VAPID key, subscribes, tests and unsubscribes', async () => {
    const { h, cookie, userId } = await subscribed();
    expect(await (await call(h, '/api/push/vapid', { cookie })).json()).toEqual({
      publicKey: 'BPUB',
    });
    expect(h.store.pushSubscriptions.forUser(userId)).toHaveLength(1);
    expect(await (await call(h, '/api/push/test', { cookie, body: {} })).json()).toEqual({
      sent: 1,
    });
    await call(h, '/api/push/unsubscribe', { cookie, body: { endpoint: SUB.endpoint } });
    expect(h.store.pushSubscriptions.forUser(userId)).toHaveLength(0);
  });

  it('refuses a non-https endpoint, and push is 503 without VAPID keys', async () => {
    h = await startHarness({ vapid: false });
    const { cookie } = await signIn(h);
    const bad = await call(h, '/api/push/subscribe', {
      cookie,
      body: { ...SUB, endpoint: 'http://push.example/x' },
    });
    expect(bad.status).toBe(400);
    expect((await call(h, '/api/push/vapid', { cookie })).status).toBe(503);
  });
});

describe('notify', () => {
  it('records the notification and pushes it with its deep link', async () => {
    const { h, cookie, userId } = await subscribed();
    const r = await h.app.services.push.notify(userId, {
      kind: 'approval',
      title: 'Approval needed',
      url: '/decisions/p1',
      planId: 'p1',
    });
    expect(r.sent).toBe(1);
    expect(JSON.parse(h.pushes[0]?.payload ?? '{}')).toMatchObject({
      kind: 'approval',
      url: '/decisions/p1',
      planId: 'p1',
    });
    const list = (await (await call(h, '/api/notifications', { cookie })).json()) as {
      notifications: { title: string }[];
    };
    expect(list.notifications.map((n) => n.title)).toEqual(['Approval needed']);
  });

  it('respects a kind switched off and quiet hours, but still records', async () => {
    const { h, cookie, userId } = await subscribed();
    // 16:30Z is 12:30 in Toronto.
    await call(h, '/api/settings/notifications', {
      method: 'PUT',
      cookie,
      body: {
        kinds: { digest: false },
        quietHours: { start: '12:00', end: '13:00', tz: 'America/Toronto' },
      },
    });
    expect(await h.app.services.push.notify(userId, { kind: 'digest', title: 'd' })).toMatchObject({
      sent: 0,
      suppressed: 'kind_off',
    });
    expect(
      await h.app.services.push.notify(userId, { kind: 'approval', title: 'a' }),
    ).toMatchObject({ sent: 0, suppressed: 'quiet_hours' });
    expect(h.pushes).toHaveLength(0);
    expect(h.store.notifications.unread(userId, 10)).toHaveLength(2);
  });

  it('prunes a subscription the push service says is gone (410), keeps it on other errors', async () => {
    const { h, userId } = await subscribed();
    h.pushFailure.statusCode = 500;
    await h.app.services.push.notify(userId, { kind: 'approval', title: 'a' });
    expect(h.store.pushSubscriptions.forUser(userId)).toHaveLength(1);
    h.pushFailure.statusCode = 410;
    await h.app.services.push.notify(userId, { kind: 'approval', title: 'a' });
    expect(h.store.pushSubscriptions.forUser(userId)).toHaveLength(0);
  });
});

describe('quiet hours and pipeline notices', () => {
  const at = (iso: string) => new Date(iso);
  const q = (start: string, end: string) => ({
    kinds: {},
    quietHours: { start, end, tz: 'America/Toronto' },
  });

  it('handles windows that wrap midnight', () => {
    // 03:00Z = 23:00 Toronto (EDT).
    expect(inQuietHours(q('22:00', '07:00'), at('2026-09-30T03:00:00Z'))).toBe(true);
    expect(inQuietHours(q('22:00', '07:00'), at('2026-09-30T16:00:00Z'))).toBe(false);
    expect(inQuietHours(q('09:00', '17:00'), at('2026-09-30T16:00:00Z'))).toBe(true);
    expect(inQuietHours({ kinds: {} }, at('2026-09-30T03:00:00Z'))).toBe(false);
  });

  it('maps the pipeline’s notices: approvals deep-link, refusals are not pushed', () => {
    expect(noticeFromPipeline('Approval needed (p-1): set lineup\nWhy: x')).toEqual({
      kind: 'approval',
      title: 'Approval needed',
      body: 'set lineup',
      url: '/decisions/p-1',
      planId: 'p-1',
    });
    expect(
      noticeFromPipeline('ACTION NEEDED (p-2): add X. Then run: fha confirm p-2'),
    ).toMatchObject({ kind: 'executed', planId: 'p-2' });
    expect(noticeFromPipeline('Refused add X: locked')).toBeUndefined();
    expect(noticeFromPipeline('UNVERIFIED: add X — timeout')).toMatchObject({ kind: 'failed' });
  });
});

describe('config', () => {
  const env = {
    FHA_PUBLIC_URL: 'https://hockey.example.com/',
    FHA_SECRET_KEY: 'k'.repeat(48),
    FHA_ALLOWED_SUBS: 'a, b',
    FHA_VAPID_FILE: '/nonexistent/web-push.json',
  };

  it('applies defaults and trims', () => {
    const c = loadConfig(env, '/repo');
    expect(c.publicUrl).toBe('https://hockey.example.com');
    expect(c.oidcIssuer).toBe('https://os.gradyserver.com');
    expect([...c.allowedSubs]).toEqual(['a', 'b']);
    expect(c.port).toBe(8720);
    expect(c.dbPath).toBe('/repo/data/fha.sqlite');
    expect(c.anthropicApiKey).toBeUndefined();
    expect(c.vapid).toBeUndefined();
  });

  it('fails fast, naming the variable', () => {
    expect(() => loadConfig({ ...env, FHA_PUBLIC_URL: undefined })).toThrow(/FHA_PUBLIC_URL/);
    expect(() => loadConfig({ ...env, FHA_SECRET_KEY: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, FHA_ALLOWED_SUBS: ' , ' })).toThrow(/FHA_ALLOWED_SUBS/);
    expect(() => loadConfig({ ...env, FHA_VAPID_PUBLIC_KEY: 'x' })).toThrow(/VAPID/);
  });
});
