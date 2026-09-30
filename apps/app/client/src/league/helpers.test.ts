import { describe, expect, it } from 'vitest';
import {
  RANK_COLORS,
  fmtWeekly,
  pairBars,
  proposeText,
  rankBucket,
  rankColor,
  sortRows,
} from './helpers';

describe('rank colour scale', () => {
  it('maps rank 1 to the strong pole, the last rank to the weak pole, the middle to neutral', () => {
    expect(rankBucket(1, 8)).toBe(0);
    expect(rankBucket(8, 8)).toBe(RANK_COLORS.length - 1);
    expect(rankBucket(4, 7)).toBe(3);
    expect(rankColor(1, 8)).toBe(RANK_COLORS[0]);
  });

  it('is monotone in rank and survives a one-team league', () => {
    const buckets = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => rankBucket(r, 8));
    expect(buckets).toEqual([...buckets].sort((a, b) => a - b));
    expect(rankBucket(1, 1)).toBe(3);
    expect(rankBucket(99, 8)).toBe(RANK_COLORS.length - 1);
  });
});

describe('sortRows', () => {
  const row = (name: string, isUs: boolean, rank: number, theirs: number | null) => ({
    name,
    isUs,
    categories: [{ cat: 'G', rank }],
    vsUs: theirs === null ? null : { theirExpectedWon: theirs },
  });
  const rows = [row('B', false, 3, 6), row('Us', true, 5, null), row('C', false, 1, 7.2)];

  it('pins our row first whatever the sort', () => {
    for (const key of [
      { kind: 'league' } as const,
      { kind: 'cat', cat: 'G' } as const,
      { kind: 'vsUs' } as const,
    ]) {
      expect(sortRows(rows, key)[0]?.name).toBe('Us');
    }
  });

  it('sorts a category strongest first and the totals toughest first', () => {
    expect(sortRows(rows, { kind: 'cat', cat: 'G' }).map((r) => r.name)).toEqual(['Us', 'C', 'B']);
    expect(sortRows(rows, { kind: 'vsUs' }).map((r) => r.name)).toEqual(['Us', 'C', 'B']);
    expect(sortRows(rows, { kind: 'league' }).map((r) => r.name)).toEqual(['Us', 'B', 'C']);
  });
});

describe('formatting', () => {
  it('writes weekly numbers the way hockey does', () => {
    expect(fmtWeekly('SV%', 0.9087)).toBe('.909');
    expect(fmtWeekly('GAA', 2.549)).toBe('2.55');
    expect(fmtWeekly('SHP', 0.608)).toBe('0.6');
  });

  it('scales a pair of bars to the larger one', () => {
    expect(pairBars(10, 5)).toEqual({ ours: 100, theirs: 50 });
    expect(pairBars(0, 0)).toEqual({ ours: 0, theirs: 0 });
  });

  it('prefills the trade ask with names and keys', () => {
    const text = proposeText({
      partnerName: 'DraftAndRun',
      give: [{ name: 'A', playerKey: '1.p.1' }],
      get: [{ name: 'B', playerKey: '1.p.2' }],
    });
    expect(text).toBe(
      'Evaluate and propose this trade with DraftAndRun: we give A (1.p.1), we get B (1.p.2).',
    );
  });
});

describe('offline caching', () => {
  it('serves the League views from the last good copy when offline', async () => {
    const { strategyFor } = await import('../pwa/strategy');
    const req = (path: string) => ({ method: 'GET', url: `https://x.test${path}`, mode: 'cors' });
    expect(strategyFor(req('/api/league/compare'), 'https://x.test')).toBe('api');
    expect(strategyFor(req('/api/league/compare/477.l.1.t.2'), 'https://x.test')).toBe('api');
  });
});
