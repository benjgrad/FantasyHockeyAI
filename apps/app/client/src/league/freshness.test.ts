import { describe, expect, it } from 'vitest';
import { freshnessText, justRefreshed, statusPollMs } from './freshness';

const NOW = new Date('2026-10-01T18:30:00Z');
const s = (asOf: string | null, refreshing: boolean) => ({ asOf, refreshing, stale: false });

describe('freshness', () => {
  it('says how old the data is, and when fresher data is coming', () => {
    expect(freshnessText(s('2026-10-01T18:13:00Z', false), NOW)).toBe('Updated 17 min ago');
    expect(freshnessText(s('2026-10-01T18:13:00Z', true), NOW)).toBe(
      'Updated 17 min ago · refreshing from Yahoo…',
    );
    expect(freshnessText(s(null, true), NOW)).toMatch(/first load takes about 20 seconds/);
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
