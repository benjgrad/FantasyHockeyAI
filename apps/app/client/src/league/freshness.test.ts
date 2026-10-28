import { describe, expect, it } from 'vitest';
import { freshnessText, isFailed, justRefreshed, statusPollMs } from './freshness';

const NOW = new Date('2026-10-01T18:30:00Z');
const s = (asOf: string | null, refreshing: boolean) => ({
  asOf,
  refreshing,
  stale: false,
  failedAt: null,
  failure: null,
  statsThrough: null,
});

describe('freshness', () => {
  it('says how old the data is, and when fresher data is coming', () => {
    expect(freshnessText(s('2026-10-01T18:13:00Z', false), NOW)).toBe('Updated 17 min ago');
    expect(freshnessText(s('2026-10-01T18:13:00Z', true), NOW)).toBe(
      'Updated 17 min ago · refreshing from Yahoo…',
    );
    expect(freshnessText(s(null, true), NOW)).toMatch(/first load takes about 20 seconds/);
  });

  it('adds the stats date, and says when the last Yahoo read failed (4b)', () => {
    const base = s('2026-10-01T18:13:00Z', false);
    expect(freshnessText({ ...base, statsThrough: '2026-09-30' }, NOW)).toBe(
      'Updated 17 min ago · stats through Sep 30',
    );
    const failed = { ...base, failedAt: '2026-10-01T18:25:00Z', failure: 'yahoo_unavailable' };
    expect(freshnessText(failed, NOW)).toBe(
      'Updated 17 min ago · Yahoo could not be read 5 min ago, so this may be out of date',
    );
    expect(isFailed(failed)).toBe(true);
    expect(isFailed(base)).toBe(false);
    const expired = { ...failed, failure: 'yahoo_reconnect_required' };
    expect(freshnessText(expired, NOW)).toMatch(/Yahoo session expired: reconnect in Settings/);
  });

  it('polls fast only while refreshing', () => {
    expect(statusPollMs(s(null, true))).toBe(2_000);
    expect(statusPollMs(s('x', false))).toBe(60_000);
    expect(statusPollMs(undefined)).toBe(60_000);
  });

  it('notices a finished rebuild or a new snapshot', () => {
    expect(justRefreshed(s('a', true), s('b', false))).toBe(true);
    expect(justRefreshed(s('a', false), s('b', false))).toBe(true);
    expect(justRefreshed(s('a', false), s('a', false))).toBe(false);
    expect(justRefreshed(undefined, s('a', false))).toBe(false);
  });
});
