import { describe, expect, it } from 'vitest';
import type { Plan, PlanPayload, Roster } from '@fha/core';
import { NotObservedError, WriteOutcomeUnknownError, YahooAuthError } from '../errors.js';
import { YahooWebAdapter, type AddDropWriter } from './adapter.js';
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
  writer: AddDropWriter,
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
    },
    teamKey: US,
    describe: (p) => `plan ${p.payload.kind}`,
    notify: (t) => notes.push(t),
    today: () => '2026-09-29',
    onAuthExpired: () => expired.n++,
  });
}

const never: AddDropWriter = {
  addDrop: () => Promise.reject(new Error('must not be called')),
};

describe('YahooWebAdapter.execute', () => {
  it.each<PlanPayload>([
    { kind: 'lineup', date: '2026-09-29', moves: [{ playerKey: '477.p.1', slot: 'C' }] },
    { kind: 'waiverClaim', add: '477.p.1' },
    {
      kind: 'tradePropose',
      partnerTeamKey: '477.l.48535.t.2',
      give: ['477.p.1'],
      get: ['477.p.2'],
      expectedGain: 1,
    },
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
    const writer: AddDropWriter = {
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
    const throwing = (e: Error): AddDropWriter => ({ addDrop: () => Promise.reject(e) });
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
