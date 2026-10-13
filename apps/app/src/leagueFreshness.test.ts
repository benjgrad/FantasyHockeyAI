import { afterEach, describe, expect, it } from 'vitest';
import { LeagueStatus, PlayerList, TeamView } from '@fha/api';
import { MAX_AGE_MS } from './league.js';
import { call, connected, startHarness, type Harness } from './testing.js';

/**
 * Pages never wait on a Yahoo rebuild they can avoid: a stale snapshot is served at once and
 * rebuilt in the background, and `/api/league/status` says how fresh it is.
 */
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Holds every Yahoo read until `release()`, as a slow Yahoo would. */
function slowYahoo(harness: Harness) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const base = harness.yahoo.reader;
  harness.yahoo.reader = (c, l, t) => {
    const r = base(c, l, t);
    const held = Object.fromEntries(
      Object.entries(r).map(([k, fn]) => [
        k,
        async (...args: unknown[]) => {
          await gate;
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    );
    return held as unknown as typeof r;
  };
  return { release: () => release() };
}

const status = async (cookie: string) =>
  LeagueStatus.parse(await (await call(h as Harness, '/api/league/status', { cookie })).json());

describe('league freshness', () => {
  it('serves a stale snapshot at once, refreshes in the background, then reports it fresh', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const first = TeamView.parse(await (await call(h, '/api/team', { cookie })).json());
    expect(await status(cookie)).toMatchObject({ refreshing: false, stale: false });

    h.clock.now = new Date(h.clock.now.getTime() + MAX_AGE_MS + 60_000);
    const yahoo = slowYahoo(h);
    // Yahoo is holding every read, yet the pages answer with the snapshot they have.
    const team = TeamView.parse(await (await call(h, '/api/team', { cookie })).json());
    expect(team.asOf).toBe(first.asOf);
    expect((await call(h, '/api/players?status=FA&sort=fit', { cookie })).status).toBe(200);
    PlayerList.parse(await (await call(h, '/api/players?status=ours&sort=fit', { cookie })).json());
    const during = await status(cookie);
    expect(during).toMatchObject({ refreshing: true, stale: true });

    yahoo.release();
    await h.app.services.league.get(h.store.yahooConnections.list()[0]?.userId ?? '');
    const after = await status(cookie);
    expect(after).toMatchObject({ refreshing: false, stale: false });
    expect(after.asOf).not.toBe(during.asOf);
  });

  it('after a write, serves nothing from the pre-write snapshot as fresh, memory or disk', async () => {
    // 2026-10-05: two add/drops were made with "Do it"; for up to 15 minutes the strength panel
    // and league ranks kept the dropped players, because invalidate() cleared only the memory
    // copy and the next read reloaded the pre-write snapshot from disk as fresh.
    h = await startHarness();
    const cookie = await connected(h);
    const userId = h.store.yahooConnections.list()[0]?.userId ?? '';
    const league = h.app.services.league;
    const first = TeamView.parse(await (await call(h, '/api/team', { cookie })).json());
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);

    league.invalidate(userId);
    const yahoo = slowYahoo(h);
    expect(league.status(userId)).toMatchObject({ stale: true });
    // The status poll itself starts the rebuild; pages keep the old data meanwhile.
    expect(await status(cookie)).toMatchObject({ stale: true, refreshing: true });
    const during = TeamView.parse(await (await call(h, '/api/team', { cookie })).json());
    expect(during.asOf).toBe(first.asOf);

    yahoo.release();
    await league.get(userId);
    const after = await status(cookie);
    expect(after).toMatchObject({ stale: false, refreshing: false });
    expect(after.asOf).not.toBe(first.asOf);
  });

  it('stays stale when the change lands while a rebuild is already reading Yahoo', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const userId = h.store.yahooConnections.list()[0]?.userId ?? '';
    const league = h.app.services.league;
    await call(h, '/api/team', { cookie });
    const yahoo = slowYahoo(h);
    const inFlight = league.get(userId, { refresh: true });
    league.invalidate(userId); // the write happens mid-read: that rebuild may predate it
    yahoo.release();
    await inFlight;
    expect(league.status(userId).stale).toBe(true);
    await league.get(userId);
    expect(league.status(userId).stale).toBe(false);
  });
});
