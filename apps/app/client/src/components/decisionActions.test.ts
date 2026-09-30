import type { DecisionCard } from '@fha/api';
import { describe, expect, it } from 'vitest';
import {
  autoApproveLine,
  changesRoster,
  confirmLines,
  needsYou,
  resultView,
  timeLeft,
} from './decisionActions';

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
  autoApproveAt: null,
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

describe('ask with timeout countdown (D-018)', () => {
  const at = '2026-10-13T14:45:00.000Z';
  const clock = (d: Date) => d.toISOString().slice(11, 16);
  const timed = card({ status: 'pending', autoApproveAt: at, actions: ['execute', 'reject'] });
  const now = (iso: string) => new Date(iso);

  it('counts down to the time, in words', () => {
    expect(autoApproveLine(timed, now('2026-10-13T14:33:00Z'), false, clock)).toEqual({
      text: 'Happens at 14:45 unless you reject · in 12 min',
      due: false,
    });
    expect(timeLeft(30_000)).toBe('in under a minute');
    expect(timeLeft(65 * 60_000)).toBe('in 1 h 5 min');
    expect(timeLeft(120 * 60_000)).toBe('in 2 h');
  });

  it('past the time: happening now, or with dry run on, waiting for Ben', () => {
    expect(autoApproveLine(timed, now('2026-10-13T14:46:00Z'), false, clock)?.text).toBe(
      'Due at 14:45: happening now unless you reject',
    );
    expect(autoApproveLine(timed, now('2026-10-13T14:46:00Z'), true, clock)?.text).toBe(
      'Was due at 14:45; dry run is on, so it waits for you',
    );
    expect(autoApproveLine(timed, now('2026-10-13T14:00:00Z'), true, clock)?.text).toMatch(
      /dry run is on: it will wait for you instead/,
    );
  });

  it('no timer, or no longer pending: nothing to show', () => {
    expect(autoApproveLine(card(), now(at), false, clock)).toBeNull();
    expect(autoApproveLine({ ...timed, status: 'executed' }, now(at), false, clock)).toBeNull();
  });
});
