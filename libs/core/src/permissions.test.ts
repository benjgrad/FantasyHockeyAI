import { describe, expect, it } from 'vitest';
import { Permissions } from './permissions.js';

describe('Permissions.autoGrab (D-016)', () => {
  it('a stored document from before auto-grab parses, with the defaults', () => {
    const old = { dryRun: true, paused: false, plans: { addDrop: { mode: 'allow', limits: {} } } };
    expect(Permissions.parse(old).autoGrab).toEqual({
      enabled: true,
      minGain: 1.5,
      ignoreDryRun: false,
    });
  });

  it('fills a partial section and keeps maxPerWeek', () => {
    const p = Permissions.parse({ autoGrab: { minGain: 2, maxPerWeek: 1 } });
    expect(p.autoGrab).toEqual({ enabled: true, minGain: 2, ignoreDryRun: false, maxPerWeek: 1 });
  });

  it('is strict: unknown keys, a negative bar or a fractional cap are refused', () => {
    expect(Permissions.safeParse({ autoGrab: { typo: true } }).success).toBe(false);
    expect(Permissions.safeParse({ autoGrab: { minGain: -1 } }).success).toBe(false);
    expect(Permissions.safeParse({ autoGrab: { maxPerWeek: 1.5 } }).success).toBe(false);
  });
});
