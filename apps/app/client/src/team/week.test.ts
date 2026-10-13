import { describe, expect, it } from 'vitest';
import { fmtStat, shareOf } from './week';

describe('this week bars', () => {
  it('is the share we hold, flipped where lower is better', () => {
    expect(shareOf(3, 1, 'G')).toBe(0.75);
    expect(shareOf(2.0, 6.0, 'GAA')).toBe(0.75);
    expect(shareOf(0, 0, 'G')).toBe(0.5);
    expect(shareOf(null, 3, 'G')).toBe(0.5);
  });

  it('handles negative +/- by the gap', () => {
    expect(shareOf(-1, -8, '+/-')).toBeGreaterThan(0.5);
    expect(shareOf(-8, -1, '+/-')).toBeLessThan(0.5);
  });

  it('formats like Yahoo', () => {
    expect(fmtStat(0.8104, 'SV%')).toBe('.810');
    expect(fmtStat(5.1256, 'GAA')).toBe('5.13');
    expect(fmtStat(26, 'SOG')).toBe('26');
    expect(fmtStat(26.37, 'SOG')).toBe('26.4');
  });
});
