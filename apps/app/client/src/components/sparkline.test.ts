import { describe, expect, it } from 'vitest';
import { sparkPath } from './sparkline';

describe('sparkPath', () => {
  it('scales into the box with the baseline inside the range', () => {
    const { line, base } = sparkPath([0, 1, 2], 1, 100, 20);
    expect(line).toBe('2.0,18.0 50.0,10.0 98.0,2.0');
    expect(base).toBe(10);
  });
  it('keeps a flat line in the box', () => {
    expect(sparkPath([1, 1], 1, 10, 10).line).toBe('2.0,8.0 8.0,8.0');
  });
});
