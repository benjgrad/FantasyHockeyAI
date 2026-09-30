import { describe, expect, it } from 'vitest';
import type { Plan, PlanPayload, Transaction } from '@fha/core';
import type { DecisionStatus } from '@fha/store';
import { confirmedInYahoo, type ConfirmSource } from './confirmDone.js';
import { actionsFor, confirmTextFor, needsBen, yahooUrlFor } from './decisionCard.js';

/** What each card offers (D-015), its Yahoo link and its confirm sentence: pure, no server. */
const plan = (payload: PlanPayload, over: Partial<Plan> = {}): Plan => ({
  planId: 'p-1',
  runId: 'r',
  agent: 'waivers',
  sourceTool: 'proposeAddDrop',
  createdAt: '2026-10-13T15:00:00Z',
  rationale: 'because',
  payload,
  ...over,
});
const TROCHECK = '477.p.5381';
const MARCHAND = '477.p.3737';
const US = '477.l.48535.t.6';
const THEM = '477.l.48535.t.2';
const addDrop = plan({ kind: 'addDrop', add: TROCHECK, drop: MARCHAND });
const lineup = plan({
  kind: 'lineup',
  date: '2026-10-14',
  moves: [{ playerKey: MARCHAND, slot: 'BN' }],
});
const NOW = new Date('2026-10-13T16:00:00Z');
const live = { live: true, now: NOW };
const acts = (p: Plan, status: DecisionStatus, execs: string[] = [], ctx = live) =>
  actionsFor({ plan: p, status }, execs as never, ctx);

describe('actionsFor', () => {
  it('a dry-run add/drop the app can make: Do it, Dismiss, Open in Yahoo', () => {
    expect(acts(addDrop, 'dry_run')).toEqual(['execute', 'dismiss', 'openInYahoo']);
    expect(acts(addDrop, 'pending')).toEqual(['execute', 'reject', 'openInYahoo']);
    expect(acts(addDrop, 'approved')).toEqual(['execute', 'openInYahoo']);
  });

  it('without a live Yahoo connection, or for a kind Yahoo writes are unobserved for: by hand', () => {
    const offline = { live: false, now: NOW };
    expect(acts(addDrop, 'dry_run', [], offline)).toEqual(['openInYahoo', 'done', 'dismiss']);
    expect(acts(lineup, 'dry_run')).toEqual(['openInYahoo', 'done', 'dismiss']);
    expect(acts(lineup, 'pending')).toEqual(['openInYahoo', 'done', 'reject']);
    const drop = plan({ kind: 'addDrop', drop: MARCHAND });
    expect(acts(drop, 'dry_run')).toEqual(['openInYahoo', 'done', 'dismiss']);
  });

  it('a plan handed to Ben can be confirmed or dropped; one sent can only be confirmed', () => {
    expect(acts(lineup, 'approved', ['needsHuman'])).toEqual(['openInYahoo', 'done', 'dismiss']);
    expect(acts(addDrop, 'approved', ['started'])).toEqual(['openInYahoo', 'done']);
    expect(acts(addDrop, 'unverified', ['submitted'])).toEqual(['openInYahoo', 'done']);
  });

  it('a settled plan offers nothing', () => {
    for (const s of [
      'executed',
      'rejected',
      'expired',
      'failed',
      'denied',
      'invalid',
      'proposed',
    ] as const) {
      expect(acts(addDrop, s)).toEqual([]);
    }
    expect(acts(plan({ kind: 'draftPick', playerKey: TROCHECK }), 'dry_run')).toEqual([]);
  });

  it('a lapsed plan (past lineup date or deadline) can only be dropped', () => {
    const old = plan({ kind: 'lineup', date: '2026-10-12', moves: [] });
    expect(acts(old, 'dry_run')).toEqual(['dismiss']);
    expect(acts(old, 'pending')).toEqual(['reject']);
    const due = plan({ kind: 'addDrop', add: TROCHECK }, { deadline: '2026-10-13T12:00:00Z' });
    expect(acts(due, 'dry_run')).toEqual(['dismiss']);
  });

  it('needsBen: something to do, confirm or answer', () => {
    expect(needsBen(['execute', 'dismiss'])).toBe(true);
    expect(needsBen(['openInYahoo', 'done'])).toBe(true);
    expect(needsBen(['dismiss'])).toBe(false);
    expect(needsBen([])).toBe(false);
  });
});

describe('yahooUrlFor: trades', () => {
  it('opens the propose-trade page prefilled with the partner and both sides', () => {
    const trade = {
      planId: 'p',
      runId: 'r',
      agent: 'trades' as const,
      sourceTool: 'proposeTrade',
      createdAt: '2026-09-30T12:00:00Z',
      rationale: 'x',
      payload: {
        kind: 'tradePropose' as const,
        partnerTeamKey: '477.l.48535.t.2',
        give: ['477.p.6395'],
        get: ['477.p.6877', '477.p.5981'],
        expectedGain: 0.5,
      },
    };
    expect(yahooUrlFor(trade, { leagueKey: '477.l.48535', teamKey: '477.l.48535.t.6' })).toBe(
      'https://hockey.fantasysports.yahoo.com/hockey/48535/6/proposetrade?stage=1&mid2=2&tpids2[]=6877&tpids2[]=5981&tpids[]=6395',
    );
  });
});

describe('yahooUrlFor', () => {
  const links = { leagueKey: '477.l.48535', teamKey: US };
  it('an add opens the add-player page for that player', () => {
    expect(yahooUrlFor(addDrop, links)).toBe(
      'https://hockey.fantasysports.yahoo.com/hockey/48535/addplayer?apid=5381',
    );
    expect(yahooUrlFor(plan({ kind: 'waiverClaim', add: TROCHECK }), links)).toMatch(/apid=5381$/);
  });
  it('lineups open the team page, trades the prefilled propose-trade page; no connection, no link', () => {
    expect(yahooUrlFor(lineup, links)).toBe(
      'https://hockey.fantasysports.yahoo.com/hockey/48535/6',
    );
    const trade = plan({
      kind: 'tradePropose',
      partnerTeamKey: THEM,
      give: [MARCHAND],
      get: [TROCHECK],
      expectedGain: 1,
    });
    expect(yahooUrlFor(trade, links)).toMatch(
      /^https:\/\/hockey\.fantasysports\.yahoo\.com\/hockey\/48535\/6\/proposetrade\?stage=1&mid2=\d+&tpids2\[\]=\d+&tpids\[\]=\d+$/,
    );
    expect(yahooUrlFor(addDrop, { leagueKey: null, teamKey: null })).toBeNull();
  });
});

describe('confirmTextFor', () => {
  const names: Record<string, string> = {
    [TROCHECK]: 'Vincent Trocheck',
    [MARCHAND]: 'Brad Marchand',
  };
  const name = (k: string) => names[k] ?? k;
  it('says exactly what will happen, with names', () => {
    expect(confirmTextFor(addDrop, name)).toBe(
      'Add Vincent Trocheck and drop Brad Marchand in Yahoo?',
    );
    expect(confirmTextFor(plan({ kind: 'addDrop', add: TROCHECK }), name)).toBe(
      'Add Vincent Trocheck in Yahoo?',
    );
    expect(confirmTextFor(plan({ kind: 'addDrop', drop: MARCHAND }), name)).toBe(
      'Drop Brad Marchand in Yahoo?',
    );
    expect(confirmTextFor(plan({ kind: 'waiverClaim', add: TROCHECK, drop: MARCHAND }), name)).toBe(
      'Put in a waiver claim for Vincent Trocheck, dropping Brad Marchand, in Yahoo?',
    );
    expect(confirmTextFor(lineup, name)).toBe(
      'Set your 2026-10-14 lineup in Yahoo: Brad Marchand to BN?',
    );
    const trade = plan({
      kind: 'tradePropose',
      partnerTeamKey: THEM,
      give: [MARCHAND],
      get: [TROCHECK],
      expectedGain: 1,
    });
    expect(confirmTextFor(trade, name, () => 'The Rivals')).toBe(
      'Offer Brad Marchand to The Rivals for Vincent Trocheck in Yahoo?',
    );
  });
});

describe('confirmedInYahoo', () => {
  const src = (byDate: Record<string, Record<string, string>>, trades: Transaction[] = []) =>
    ({
      today: '2026-10-13',
      slotsOn: (d: string) => Promise.resolve(new Map(Object.entries(byDate[d] ?? {}))),
      pendingTrades: () => Promise.resolve(trades),
    }) satisfies ConfirmSource;

  it('an add/drop shows on today’s or tomorrow’s roster', async () => {
    expect(await confirmedInYahoo(addDrop, src({ '2026-10-13': { [TROCHECK]: 'BN' } }), US)).toBe(
      true,
    );
    expect(await confirmedInYahoo(addDrop, src({ '2026-10-14': { [TROCHECK]: 'C' } }), US)).toBe(
      true,
    );
    const still = src({ '2026-10-13': { [TROCHECK]: 'BN', [MARCHAND]: 'LW' } });
    expect(await confirmedInYahoo(addDrop, still, US)).toBe(false);
    expect(await confirmedInYahoo(addDrop, src({}), US)).toBe(false);
  });

  it('a lineup matches every move on its date', async () => {
    expect(await confirmedInYahoo(lineup, src({ '2026-10-14': { [MARCHAND]: 'BN' } }), US)).toBe(
      true,
    );
    expect(await confirmedInYahoo(lineup, src({ '2026-10-14': { [MARCHAND]: 'LW' } }), US)).toBe(
      false,
    );
  });

  it('a trade offer shows as our pending trade', async () => {
    const trade = plan({
      kind: 'tradePropose',
      partnerTeamKey: THEM,
      give: [MARCHAND],
      get: [TROCHECK],
      expectedGain: 1,
    });
    const offer: Transaction = {
      transactionKey: 't-1',
      type: 'pending_trade',
      timestamp: '1',
      teamKey: US,
      tradeeTeamKey: THEM,
      players: [
        { playerKey: MARCHAND, fromTeamKey: US, toTeamKey: THEM },
        { playerKey: TROCHECK, fromTeamKey: THEM, toTeamKey: US },
      ],
    };
    expect(await confirmedInYahoo(trade, src({}, [offer]), US)).toBe(true);
    expect(await confirmedInYahoo(trade, src({}), US)).toBe(false);
  });
});
