import type { DecisionCard } from '@fha/api';
import { describe, expect, it } from 'vitest';
import { changesRoster, confirmLines, needsYou, resultView } from './decisionActions';

const card = (over: Partial<DecisionCard> = {}): DecisionCard => ({
  planId: 'p1',
  kind: 'addDrop',
  status: 'dry_run',
  summary: 'add Vincent Trocheck, drop Brad Marchand',
  rationale: 'r',
  gateReasons: [],
  agent: 'waivers',
  createdAt: '2026-09-29T00:00:00Z',
  deadline: null,
  result: null,
  actions: ['execute', 'dismiss', 'openInYahoo'],
  yahooUrl: 'https://hockey.fantasysports.yahoo.com/hockey/48535/addplayer?apid=5381',
  confirmText: 'Add Vincent Trocheck and drop Brad Marchand in Yahoo?',
  ...over,
});

describe('decision card helpers', () => {
  it('needsYou: a proposal to do, a move to confirm, or an approval to answer', () => {
    expect(needsYou(card())).toBe(true);
    expect(needsYou(card({ actions: ['openInYahoo', 'done'] }))).toBe(true);
    expect(needsYou(card({ actions: ['reject'] }))).toBe(true);
    expect(needsYou(card({ actions: ['dismiss'] }))).toBe(false);
    expect(needsYou(card({ status: 'executed', actions: [] }))).toBe(false);
  });

  it('the confirm step uses the server sentence and says what dry run means', () => {
    expect(confirmLines(card(), false)).toEqual([
      'Add Vincent Trocheck and drop Brad Marchand in Yahoo?',
      'This makes the move in Yahoo now.',
    ]);
    expect(confirmLines(card(), true)).toEqual([
      'Add Vincent Trocheck and drop Brad Marchand in Yahoo?',
      'This makes the move in Yahoo now.',
      'Dry run is on; this approval applies to this move only.',
    ]);
    expect(confirmLines(card({ confirmText: null }), false)[0]).toBe(
      'add Vincent Trocheck, drop Brad Marchand?',
    );
  });

  it('results read as verified, unverified with the reason, or failed with Yahoo’s message', () => {
    expect(resultView({ outcome: 'executed', message: 'ok' })).toMatchObject({
      tone: 'good',
      title: 'Done ✓ verified in Yahoo',
    });
    expect(resultView({ outcome: 'unverified', message: 'timeout' })).toEqual({
      tone: 'warn',
      title: 'Sent, not yet verified',
      message: 'timeout',
    });
    expect(resultView({ outcome: 'failed', message: 'Yahoo: roster full' })).toMatchObject({
      tone: 'bad',
      message: 'Yahoo: roster full',
    });
    expect(resultView({ outcome: 'notConfirmed', message: 'm' }).title).toBe(
      "Yahoo doesn't show it yet",
    );
  });

  it('only a move that may have landed refreshes the team view', () => {
    expect(changesRoster({ outcome: 'executed' })).toBe(true);
    expect(changesRoster({ outcome: 'confirmed' })).toBe(true);
    expect(changesRoster({ outcome: 'unverified' })).toBe(true);
    expect(changesRoster({ outcome: 'denied' })).toBe(false);
    expect(changesRoster({ outcome: 'dismissed' })).toBe(false);
  });
});
