import { describe, expect, it } from 'vitest';
import type { Plan, PlanPayload, Roster, Transaction } from '@fha/core';
import { NotObservedError, WriteOutcomeUnknownError, YahooAuthError } from '../errors.js';
import { YahooWebAdapter, type YahooWriter } from './adapter.js';
import type { AddDropRequest } from './writer.js';

const US = '477.l.48535.t.6';
const plan = (payload: PlanPayload): Plan => ({
  planId: 'plan-1',
  runId: 'run-1',
  agent: 'waivers',
  sourceTool: 'proposeAddDrop',
  createdAt: '2026-09-29T15:00:00Z',
  rationale: 'because',
  payload,
});

function roster(date: string, keys: string[]): Roster {
  return {
    teamKey: US,
    date,
    entries: keys.map((k) => ({
      slot: 'BN',
      player: { playerKey: k, name: k, nhlTeam: 'EDM', eligible: ['C'], positionType: 'P' },
    })),
  };
}

function adapter(
  writer: YahooWriter,
  rosters: Record<string, string[]> = {},
  notes: string[] = [],
  expired: { n: number } = { n: 0 },
) {
  return new YahooWebAdapter({
    writer,
    reader: {
      roster: (_t, date) => {
        const keys = rosters[date];
        return keys === undefined
          ? Promise.reject(new Error('read failed'))
          : Promise.resolve(roster(date, keys));
      },
      transactions: () => Promise.resolve([]),
    },
    teamKey: US,
    describe: (p) => `plan ${p.payload.kind}`,
    notify: (t) => notes.push(t),
    today: () => '2026-09-29',
    onAuthExpired: () => expired.n++,
  });
}

const never: YahooWriter = {
  addDrop: () => Promise.reject(new Error('must not be called')),
  setLineup: () => Promise.reject(new Error('must not be called')),
  proposeTrade: () => Promise.reject(new Error('must not be called')),
};

describe('YahooWebAdapter.execute', () => {
  it.each<PlanPayload>([
    { kind: 'waiverClaim', add: '477.p.1' },
    { kind: 'tradeRespond', transactionKey: 'tx', action: 'accept', give: [], get: [] },
  ])('should hand $kind to Ben because it is unobserved', async (payload) => {
    const notes: string[] = [];
    const res = await adapter(never, {}, notes).execute(plan(payload));
    expect(res.status).toBe('needsHuman');
    expect(res.detail).toMatch(/^ACTION NEEDED \(plan-1\): do this in Yahoo: plan /);
    expect(res.detail).toMatch(/U-12/);
    expect(notes).toEqual([res.detail]);
  });

  it('should pass an add/drop to the writer and report submitted, never done', async () => {
    const seen: AddDropRequest[] = [];
    const writer: YahooWriter = {
      ...never,
      addDrop: (r) => {
        seen.push(r);
        return Promise.resolve({ status: 'submitted', detail: 'Yahoo: added X' });
      },
    };
    const res = await adapter(writer).execute(
      plan({ kind: 'addDrop', add: '477.p.5336', drop: '477.p.7163' }),
    );
    expect(seen).toEqual([{ addPlayerKey: '477.p.5336', dropPlayerKey: '477.p.7163' }]);
    expect(res).toEqual({ status: 'submitted', detail: 'Yahoo: added X' });
  });

  it('should map writer errors: unobserved → by hand, unknown → submitted, auth → failed', async () => {
    const throwing = (e: Error): YahooWriter => ({ ...never, addDrop: () => Promise.reject(e) });
    const drop = plan({ kind: 'addDrop', drop: '477.p.7163' });
    const expired = { n: 0 };
    expect((await adapter(throwing(new NotObservedError('x'))).execute(drop)).status).toBe(
      'needsHuman',
    );
    expect((await adapter(throwing(new WriteOutcomeUnknownError('x'))).execute(drop)).status).toBe(
      'submitted',
    );
    const auth = await adapter(throwing(new YahooAuthError('dead')), {}, [], expired).execute(drop);
    expect(auth.status).toBe('failed');
    expect(expired.n).toBe(1);
    expect((await adapter(throwing(new TypeError('offline'))).execute(drop)).status).toBe('failed');
  });
});

describe('YahooWebAdapter lineups', () => {
  const lineup = plan({
    kind: 'lineup',
    date: '2026-10-01',
    moves: [
      { playerKey: '477.p.5336', slot: 'G' },
      { playerKey: '477.p.9118', slot: 'BN' },
    ],
  });
  const slotted = (slots: Record<string, string>): Roster => ({
    teamKey: US,
    date: '2026-10-01',
    entries: Object.entries(slots).map(([k, slot]) => ({
      slot,
      player: { playerKey: k, name: k, nhlTeam: 'DAL', eligible: ['G'], positionType: 'G' },
    })),
  });
  const withRoster = (r: Roster | undefined, writer: YahooWriter = never) =>
    new YahooWebAdapter({
      writer,
      reader: {
        roster: () => (r === undefined ? Promise.reject(new Error('down')) : Promise.resolve(r)),
        transactions: () => Promise.resolve([]),
      },
      teamKey: US,
      describe: () => 'lineup',
    });

  it('should send the date and moves to the writer', async () => {
    const seen: unknown[] = [];
    const writer: YahooWriter = {
      ...never,
      setLineup: (r) => {
        seen.push(r);
        return Promise.resolve({ status: 'submitted', detail: 'Yahoo saved the lineup.' });
      },
    };
    const res = await withRoster(undefined, writer).execute(lineup);
    expect(res).toEqual({ status: 'submitted', detail: 'Yahoo saved the lineup.' });
    expect(seen).toEqual([
      { date: '2026-10-01', moves: lineup.payload.kind === 'lineup' ? lineup.payload.moves : [] },
    ]);
  });

  it('should hand a lineup to Ben when the writer refuses it as unobserved', async () => {
    const writer: YahooWriter = {
      ...never,
      setLineup: () => Promise.reject(new NotObservedError('x')),
    };
    expect((await withRoster(undefined, writer).execute(lineup)).status).toBe('needsHuman');
  });

  it('should verify only when every moved player sits in his slot that day', async () => {
    expect(
      await withRoster(slotted({ '477.p.5336': 'G', '477.p.9118': 'BN' })).verify(lineup),
    ).toBe(true);
    expect(
      await withRoster(slotted({ '477.p.5336': 'BN', '477.p.9118': 'G' })).verify(lineup),
    ).toBe(false);
    expect(await withRoster(slotted({ '477.p.5336': 'G' })).verify(lineup)).toBe(false);
    expect(await withRoster(undefined).verify(lineup)).toBe(false);
  });
});

describe('YahooWebAdapter.verify', () => {
  const swap = plan({ kind: 'addDrop', add: '477.p.5336', drop: '477.p.7163' });

  it('should confirm when the add is on the roster and the drop is gone', async () => {
    const a = adapter(never, { '2026-09-29': ['477.p.5336', '477.p.1'] });
    expect(await a.verify(swap)).toBe(true);
  });

  it("should accept tomorrow's roster when the move takes effect next day", async () => {
    const a = adapter(never, {
      '2026-09-29': ['477.p.7163'],
      '2026-09-30': ['477.p.5336'],
    });
    expect(await a.verify(swap)).toBe(true);
  });

  it('should not confirm when the roster is unchanged or cannot be read', async () => {
    expect(
      await adapter(never, { '2026-09-29': ['477.p.7163'], '2026-09-30': ['477.p.7163'] }).verify(
        swap,
      ),
    ).toBe(false);
    expect(await adapter(never, {}).verify(swap)).toBe(false);
    expect(
      await adapter(never, { '2026-09-29': ['477.p.5336'] }).verify(
        plan({ kind: 'waiverClaim', add: '477.p.5336' }),
      ),
    ).toBe(false);
  });
});

describe('YahooWebAdapter trade proposals (U-23)', () => {
  const THEM = '477.l.48535.t.2';
  const offer = plan({
    kind: 'tradePropose',
    partnerTeamKey: THEM,
    give: ['477.p.7117', '477.p.4351'],
    get: ['477.p.7908'],
    note: 'Two for one',
    expectedGain: 0.4,
  });
  const pending = (from: string, to: string, give: string[], get: string[]): Transaction => ({
    transactionKey: 'tx',
    type: 'pending_trade',
    timestamp: '2026-10-01T20:00:00Z',
    teamKey: from,
    tradeeTeamKey: to,
    players: [
      ...give.map((k) => ({ playerKey: k, fromTeamKey: from, toTeamKey: to })),
      ...get.map((k) => ({ playerKey: k, fromTeamKey: to, toTeamKey: from })),
    ],
  });
  const withTrades = (txs: Transaction[] | undefined, writer: YahooWriter = never) =>
    new YahooWebAdapter({
      writer,
      reader: {
        roster: () => Promise.reject(new Error('unused')),
        transactions: () =>
          txs === undefined ? Promise.reject(new Error('down')) : Promise.resolve(txs),
      },
      teamKey: US,
      describe: () => 'trade',
    });

  it('sends the partner, players and note to the writer', async () => {
    const seen: unknown[] = [];
    const writer: YahooWriter = {
      ...never,
      proposeTrade: (r) => {
        seen.push(r);
        return Promise.resolve({ status: 'submitted', detail: 'Yahoo sent the trade proposal.' });
      },
    };
    expect((await withTrades([], writer).execute(offer)).status).toBe('submitted');
    expect(seen).toEqual([
      {
        partnerTeamKey: THEM,
        give: ['477.p.7117', '477.p.4351'],
        get: ['477.p.7908'],
        note: 'Two for one',
      },
    ]);
  });

  it('verifies only when Yahoo lists our offer with exactly these players', async () => {
    const ok = pending(US, THEM, ['477.p.4351', '477.p.7117'], ['477.p.7908']);
    expect(await withTrades([ok]).verify(offer)).toBe(true);
    expect(
      await withTrades([pending(US, THEM, ['477.p.7117'], ['477.p.7908'])]).verify(offer),
    ).toBe(false);
    expect(
      await withTrades([pending(THEM, US, ['477.p.7908'], ['477.p.7117', '477.p.4351'])]).verify(
        offer,
      ),
    ).toBe(false);
    expect(await withTrades(undefined).verify(offer)).toBe(false);
  });
});
