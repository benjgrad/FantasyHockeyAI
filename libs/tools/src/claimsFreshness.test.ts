import { describe, expect, it } from 'vitest';
import type { LeagueSnapshot, Plan } from '@fha/core';
import type { ToolResult } from '@fha/llm';
import { asOfLine, staleWarning } from './freshness.js';
import { decisionsBlock } from './openDecisions.js';
import { proposeWaiverClaim } from './tools/proposeRoster.js';
import { getLeagueContext, searchPlayers } from './tools/league.js';
import { getRoster } from './tools/roster.js';
import { mockView, testRun } from './testing.js';

/**
 * Phase 5 and 6 of the 10-24 review: waiver priority, the claims already filed in Yahoo, the
 * as-of line on read tools, and a search that finds owned players.
 */
const MAKAR = '477.p.7519'; // on our roster in the mock league
const US = '477.l.48535.t.6';

function summary<T>(r: ToolResult<T>): string {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.summary ?? '';
}

/** A free agent on waivers, a drop of ours, and (optionally) our pending Yahoo claim on him. */
function withClaim(filed: boolean) {
  return (snap: LeagueSnapshot) => {
    const owned = new Set(Object.values(snap.rosters).flat().map((e) => e.playerKey));
    const fa = snap.players.find((p) => !owned.has(p.playerKey) && p.positionType === 'P');
    const drop = (snap.rosters[US] ?? []).find((e) => e.slot === 'BN')?.playerKey;
    if (fa === undefined || drop === undefined) throw new Error('fixture changed');
    Object.assign(fa, { name: 'Waiver Guy', onWaivers: true, waiverDate: '2026-10-15' });
    snap.teams = snap.teams.map((t, i) => ({ ...t, waiverPriority: i + 1 }));
    if (filed) {
      snap.transactions.push({
        transactionKey: `477.l.48535.w.c.6_${fa.playerKey}`,
        type: 'waiver',
        timestamp: '',
        teamKey: US,
        players: [
          { playerKey: fa.playerKey, toTeamKey: US },
          { playerKey: drop, fromTeamKey: US },
        ],
        status: 'pending',
      });
    }
    return { add: fa.playerKey, drop };
  };
}

function claimRun(filed: boolean) {
  let keys = { add: '', drop: '' };
  const make = withClaim(filed);
  const run = testRun({ agent: 'waivers', edit: (s) => (keys = make(s)) });
  return { ...run, ...keys };
}

describe('waiver priority (Phase 5)', () => {
  it('the view reads our place in the rolling order', () => {
    const view = mockView((s) => withClaim(false)(s));
    expect(view.waiverPriority()).toBe(6); // Our Team is sixth in the mock's team list
    expect(view.waiverPriority('477.l.48535.t.101')).toBe(1);
    expect(mockView().waiverPriority()).toBeUndefined();
  });

  it('getLeagueContext says where we stand in the order', async () => {
    const { ctx } = claimRun(false);
    const s = summary(await getLeagueContext.execute({}, ctx));
    expect(s).toContain('we are #6 of 8 in waiver priority');
  });
});

describe('S5: a claim filed in Yahoo', () => {
  it('getLeagueContext and getRoster report the claim as filed in Yahoo', async () => {
    const { ctx } = claimRun(true);
    const league = summary(await getLeagueContext.execute({}, ctx));
    expect(league).toMatch(/filed in Yahoo/);
    expect(league).toMatch(/claim Waiver Guy, dropping .+ \(he clears waivers 2026-10-15\)/);
    const roster = summary(await getRoster.execute({}, ctx));
    expect(roster).toMatch(/claim Waiver Guy.*filed in Yahoo/);
  });

  it('an open claim plan reads as filed, not as waiting on Ben, and names it', async () => {
    const { ctx, store, add, drop } = claimRun(true);
    const plan: Plan = {
      planId: 'fa28c1bf-0000-4000-8000-000000000000',
      runId: 'run-x',
      agent: 'waivers',
      sourceTool: 'proposeWaiverClaim',
      createdAt: ctx.now,
      rationale: 'test',
      payload: { kind: 'waiverClaim', add, drop },
    };
    store.decisions.insert(plan, { status: 'approved', gate: 'allow' });
    const block = decisionsBlock(ctx.view, store, ctx.now);
    expect(block).toContain('fa28c1bf');
    expect(block).toMatch(/filed in Yahoo as "claim Waiver Guy/);
    expect(block).not.toMatch(/handed to Ben|waiting for Ben/);
    const league = summary(await getLeagueContext.execute({}, ctx));
    expect(league).toContain('fulfils plan fa28c1bf');
  });

  it('a second claim on the same player is refused, and nothing is recorded', async () => {
    const { ctx, store, add, drop } = claimRun(true);
    const r = await proposeWaiverClaim.execute({ add, drop, reason: 'again' }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/already filed in Yahoo/);
    expect(!r.ok && r.retryable).toBe(false);
    expect(store.decisions.listByStatus('dry_run', 'approved', 'pending')).toHaveLength(0);
  });

  it('without a filed claim the same proposal goes through', async () => {
    const { ctx, add, drop } = claimRun(false);
    const r = await proposeWaiverClaim.execute({ add, drop, reason: 'first' }, ctx);
    expect(r.ok).toBe(true);
  });
});

describe('claim wording (U-22)', () => {
  it('a claim result says Ben files it in Yahoo and it processes when he clears', async () => {
    const { ctx, add, drop } = claimRun(false);
    const s = summary(await proposeWaiverClaim.execute({ add, drop, reason: 'first' }, ctx));
    expect(s).toMatch(/Ben files it in Yahoo/);
    expect(s).toMatch(/processes when he clears waivers/);
    expect(s).not.toMatch(/goes through after/);
  });
});

describe('as-of line (4b)', () => {
  it('read tools say when Yahoo was read and how far the stats go', async () => {
    const { ctx } = testRun();
    ctx.view.freshness = { builtAt: '2026-10-24T15:44:15.000Z', statsThrough: '2026-10-23' };
    const line = 'As of Oct 24, 11:44 AM ET (Yahoo read); NHL stats through 2026-10-23.';
    expect(asOfLine(ctx.view)).toBe(line);
    expect(summary(await getRoster.execute({}, ctx))).toContain(line);
    expect(summary(await searchPlayers.execute({ sort: [{ by: 'value', order: 'desc' }], status: 'FA' }, ctx))).toContain(line);
    expect(summary(await getLeagueContext.execute({}, ctx))).toContain(line);
  });

  it('a stale view carries the warning everywhere', async () => {
    const { ctx } = testRun();
    ctx.view.freshness = {
      builtAt: '2026-10-24T10:00:00.000Z',
      stale: { failedAt: '2026-10-24T15:00:00.000Z', reason: 'yahoo_unavailable' },
    };
    expect(staleWarning(ctx.view)).toMatch(/^STALE: the last Yahoo read failed at Oct 24, 11:00 AM ET/);
    expect(summary(await getRoster.execute({}, ctx))).toContain('STALE');
    expect(summary(await getLeagueContext.execute({}, ctx))).toContain('STALE');
  });
});

describe('S4: searchPlayers finds owned players (Phase 6)', () => {
  it('status A finds a rostered player by name and labels him ours', async () => {
    const { ctx } = testRun();
    const r = await searchPlayers.execute({ sort: [{ by: 'value', order: 'desc' }], status: 'A', query: 'makar' }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.players.map((p) => p.playerKey)).toEqual([MAKAR]);
    expect(r.data.players[0]?.owner).toBe('us');
    expect(r.summary).toMatch(/Cale Makar.*\| us \|/);
    expect(r.summary).toMatch(/owned players too/);
  });

  it('a free-agent search that misses an owned player says who owns him', async () => {
    const { ctx } = testRun();
    const s = summary(await searchPlayers.execute({ sort: [{ by: 'value', order: 'desc' }], status: 'FA', query: 'makar' }, ctx));
    expect(s).toMatch(/no players match/);
    expect(s).toMatch(/Cale Makar \(us\)/);
    expect(s).toMatch(/status A/);
  });

  it('a name outside the pool falls back to the live Yahoo search', async () => {
    const { ctx } = testRun();
    const asked: string[] = [];
    ctx.searchYahoo = (name) => {
      asked.push(name);
      return Promise.resolve({
        found: [{ playerKey: '477.p.99999', name: 'Deep Sleeper', nhlTeam: 'SEA' }],
        notes: [],
      });
    };
    const s = summary(await searchPlayers.execute({ sort: [{ by: 'value', order: 'desc' }], status: 'A', query: 'Deep Sleeper' }, ctx));
    expect(asked).toEqual(['Deep Sleeper']);
    expect(s).toMatch(/Found on Yahoo.*Deep Sleeper \(SEA\)/);
    expect(s).not.toContain('477.p.99999'); // not usable until the rebuild indexes him (P3)
  });

  it('degrades to a note when the live search is unavailable or fails (P9)', async () => {
    const { ctx } = testRun();
    const none = summary(await searchPlayers.execute({ sort: [{ by: 'value', order: 'desc' }], status: 'A', query: 'Deep Sleeper' }, ctx));
    expect(none).toMatch(/not in the snapshot's player pool/i);
    ctx.searchYahoo = () => Promise.reject(new Error('down'));
    const failed = summary(await searchPlayers.execute({ sort: [{ by: 'value', order: 'desc' }], status: 'A', query: 'Deep Sleeper' }, ctx));
    expect(failed).toMatch(/Yahoo could not be searched/);
  });
});
