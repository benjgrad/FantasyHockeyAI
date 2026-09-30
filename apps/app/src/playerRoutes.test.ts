import { afterEach, describe, expect, it } from 'vitest';
import {
  CategoryStrength,
  CompareResponse,
  DecisionPlayers,
  PlayerCard,
  PlayerList,
} from '@fha/api';
import type { Plan } from '@fha/core';
import { LeagueView, MOCK_SETTINGS } from '@fha/tools';
import { cardContext } from './players.js';
import { playerKeysIn, playersInPlan } from './playersInPlans.js';
import { listPlayers, normalizeName, parseListQuery } from './playersList.js';
import { FIXTURE, START, call, connected, startHarness, type Harness } from './testing.js';

const view = LeagueView.fromFile(FIXTURE, MOCK_SETTINGS);
const CATS = MOCK_SETTINGS.categories.map((c) => c.abbr);
const list = (qs: string) =>
  listPlayers(cardContext(view, START), parseListQuery(new URLSearchParams(qs), CATS));
const jarvisKey = view.snap.players.find((p) => p.name === 'Seth Jarvis')?.playerKey ?? '';

describe('free-agent browser', () => {
  it('defaults to free agents sorted by score (value + fit), unvalued last', () => {
    const res = list('');
    expect(res.status).toBe('FA');
    expect(res.sort).toBe('fit');
    expect(res.players.length).toBeLessThanOrEqual(50);
    expect(res.players.every((p) => p.owner.kind === 'freeAgent')).toBe(true);
    const scores = res.players.map((p) => p.score);
    const firstNull = scores.indexOf(null);
    const valued = (firstNull < 0 ? scores : scores.slice(0, firstNull)) as number[];
    expect(valued).toEqual([...valued].sort((a, b) => b - a));
    if (firstNull >= 0) expect(scores.slice(firstNull).every((s) => s === null)).toBe(true);
  });

  it('filters to our roster and by position', () => {
    const ours = list('status=ours&limit=200');
    expect(ours.total).toBe(view.roster().entries.length);
    expect(ours.players.every((p) => p.owner.kind === 'us')).toBe(true);
    const goalies = list('status=all&position=G&limit=200');
    expect(goalies.players.length).toBeGreaterThan(0);
    expect(goalies.players.every((p) => p.positionType === 'G')).toBe(true);
  });

  it('sorts by one category’s z and shows it among the key categories', () => {
    const res = list('status=all&sort=cat:HIT&limit=20');
    const z = res.players.map((p) => view.valuation(p.playerKey)?.z['HIT'] ?? -Infinity);
    expect(z).toEqual([...z].sort((a, b) => b - a));
    expect(res.players.every((p) => p.keyCats.some((k) => k.cat === 'HIT'))).toBe(true);
  });

  it('sorts by value net of injuries', () => {
    const res = list('status=all&sort=value&limit=30');
    const v = res.players.map((p) => p.adjustedVorp ?? -Infinity);
    expect(v).toEqual([...v].sort((a, b) => b - a));
  });

  it('searches names without case or accents', () => {
    expect(list('status=all&q=JARVIS').players.map((p) => p.playerKey)).toEqual([jarvisKey]);
    expect(normalizeName('Tim Stützle')).toBe('tim stutzle');
  });

  it('lists nobody on waivers, and says why', () => {
    const res = list('status=W');
    expect(res.players).toEqual([]);
    expect(res.notes[0]).toMatch(/Waiver status/);
  });

  it('refuses a bad status, sort or limit rather than defaulting', () => {
    expect(() => list('status=X')).toThrow(/status/);
    expect(() => list('sort=cat:BLK')).toThrow(/sort/);
    expect(() => list('sort=name')).toThrow(/sort/);
    expect(() => list('limit=0')).toThrow(/limit/);
    expect(() => list('limit=500')).toThrow(/limit/);
  });

  it('round-trips through the contract', () => {
    const res = list('status=all&limit=10');
    expect(PlayerList.parse(JSON.parse(JSON.stringify(res)))).toEqual(res);
  });
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('player routes over HTTP', () => {
  it('serves a card, 404s a key not in the league, and needs a session', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const res = await call(h, `/api/players/${encodeURIComponent(jarvisKey)}`, { cookie });
    expect(res.status).toBe(200);
    expect(PlayerCard.parse(await res.json()).name).toBe('Seth Jarvis');
    expect((await call(h, '/api/players/477.p.999999', { cookie })).status).toBe(404);
    expect((await call(h, `/api/players/${jarvisKey}`)).status).toBe(401);
  });

  it('compares, and names the unknown keys in a 400', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    const other = view.roster().entries[0]?.player.playerKey ?? '';
    const ok = await call(h, `/api/compare?keys=${jarvisKey},${other}`, { cookie });
    expect(CompareResponse.parse(await ok.json()).players).toHaveLength(2);
    const bad = await call(h, `/api/compare?keys=${jarvisKey},477.p.1,bogus`, { cookie });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { message: string } };
    expect(body.error.message).toContain('477.p.1, bogus');
  });

  it('lists players and serves category strength with the week’s weights', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    // The fake Yahoo serves no free-agent pool, so list the rostered players.
    const players = PlayerList.parse(
      await (await call(h, '/api/players?status=all&limit=5', { cookie })).json(),
    );
    expect(players.players).toHaveLength(5);
    expect((await call(h, '/api/players?sort=bogus', { cookie })).status).toBe(400);
    const s = CategoryStrength.parse(
      await (await call(h, '/api/team/categories', { cookie })).json(),
    );
    expect(s.categories).toHaveLength(13);
    expect(s.weekWeightsSource).toBe('suggested');
    h.store.strategy.set(s.week, { A: 1.5 }, 'test');
    const stored = CategoryStrength.parse(
      await (await call(h, '/api/team/categories', { cookie })).json(),
    );
    expect(stored).toMatchObject({ weekWeightsSource: 'stored', weekWeights: { A: 1.5 } });
  });
});

describe('players named in a decision', () => {
  const kuemper = view.snap.players.find((p) => p.name === 'Darcy Kuemper')?.playerKey ?? '';
  const addDrop = {
    planId: 'pp-1',
    runId: 'run-1',
    agent: 'waivers',
    sourceTool: 'proposeAddDrop',
    createdAt: '2026-09-29T16:30:00.000Z',
    rationale: 'test',
    payload: { kind: 'addDrop', add: kuemper, drop: jarvisKey },
  } as Plan;

  it('finds every playerKey in a plan and resolves only the known ones (P3)', () => {
    expect([...playerKeysIn({ a: ['477.p.1', { b: '477.p.2' }], c: 'x.p.3' })]).toEqual([
      '477.p.1',
      '477.p.2',
    ]);
    const refs = playersInPlan(view, {
      ...addDrop,
      payload: { ...addDrop.payload, x: '477.p.999999' },
    });
    expect(refs.map((r) => r.name)).toEqual(['Darcy Kuemper', 'Seth Jarvis']);
  });

  it('serves them for a stored decision and 404s an unknown one', async () => {
    h = await startHarness();
    const cookie = await connected(h);
    h.store.decisions.insert(addDrop, { status: 'pending' });
    const res = await call(h, '/api/decisions/pp-1/players', { cookie });
    // The fake Yahoo serves no free-agent pool, so Kuemper (a free agent) is unknown to this
    // league and is left out rather than named from the plan.
    expect(DecisionPlayers.parse(await res.json()).players.map((p) => p.playerKey)).toEqual([
      jarvisKey,
    ]);
    expect((await call(h, '/api/decisions/nope/players', { cookie })).status).toBe(404);
  });
});
