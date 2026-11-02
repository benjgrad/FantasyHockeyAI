import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, startHarness, type Harness } from './testing.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe('/api/health (the deploy smoke test, D-042)', () => {
  it('answers without a session: ok and the running git sha, nothing else', async () => {
    const res = await call(h, '/api/health', { sameOrigin: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sha: 'test-sha' });
  });

  it('sets no cookie', async () => {
    const res = await call(h, '/api/health', { sameOrigin: false });
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
