import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE, connected, startHarness, type Harness } from '../testing.js';
import { executeJob } from './jobs.js';

/** D-035: the weekly re-seed keeps the valuation seed up with the league's player pool. */
let h: Harness;
let userId = '';

beforeEach(async () => {
  h = await startHarness();
  await connected(h);
  userId = h.store.yahooConnections.list()[0]?.userId ?? '';
});

afterEach(async () => {
  await h.close();
});

const run = () =>
  executeJob(
    { s: h.app.services, now: () => h.clock.now },
    userId,
    'reseed',
    new AbortController().signal,
  );

describe('the re-seed job', () => {
  it('does nothing while the seed is pinned', async () => {
    const r = await run();
    expect(r.status).toBe('noop');
    expect(r.summary).toContain('pinned');
  });

  it('writes a new seed next to the old one and records the run', async () => {
    const dir = h.app.services.config.snapshotDir;
    mkdirSync(dir, { recursive: true });
    copyFileSync(FIXTURE, join(dir, 'live-2026-09-01.json'));
    h.app.services.config.valuationSnapshot = undefined;
    const r = await run();
    expect(r.status, r.summary).toBe('success');
    const written = readdirSync(dir).filter(
      (f) => f.startsWith('live-') && f !== 'live-2026-09-01.json',
    );
    expect(written).toHaveLength(1);
    expect(existsSync(join(dir, written[0] ?? ''))).toBe(true);
    expect(h.store.runs.latestFinished('reseed')?.status).toBe('success');
  });
});
