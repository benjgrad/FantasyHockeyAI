import { describe, expect, it } from 'vitest';
import { Permissions, askTimeoutMinutes } from './permissions.js';

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

describe('Permissions.plans askTimeout (D-018)', () => {
  it('a stored plan entry from before D-018 parses unchanged (no timeoutMinutes added)', () => {
    const p = Permissions.parse({ plans: { addDrop: { mode: 'allow', limits: {} } } });
    expect(p.plans.addDrop).toEqual({ mode: 'allow', limits: {} });
    expect(askTimeoutMinutes(p.plans.addDrop)).toBe(30);
  });

  it('accepts askTimeout with minutes in 5–1440, and refuses anything else', () => {
    const p = Permissions.parse({ plans: { lineup: { mode: 'askTimeout', timeoutMinutes: 45 } } });
    expect(p.plans.lineup).toEqual({ mode: 'askTimeout', limits: {}, timeoutMinutes: 45 });
    expect(askTimeoutMinutes(p.plans.lineup)).toBe(45);
    for (const bad of [4, 1441, 10.5, -1]) {
      const r = Permissions.safeParse({
        plans: { lineup: { mode: 'askTimeout', timeoutMinutes: bad } },
      });
      expect(r.success).toBe(false);
    }
    expect(Permissions.safeParse({ plans: { lineup: { mode: 'later' } } }).success).toBe(false);
  });
});
