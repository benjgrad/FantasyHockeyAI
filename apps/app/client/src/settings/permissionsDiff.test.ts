import { Permissions } from '@fha/core';
import { describe, expect, it } from 'vitest';
import {
  diffPermissions,
  modeOf,
  parseLimit,
  parseMinGain,
  parseTimeout,
  widensAutonomy,
} from './permissionsDiff';

const base = Permissions.parse({
  dryRun: true,
  paused: false,
  plans: {
    lineup: { mode: 'allow', limits: {} },
    addDrop: { mode: 'ask', limits: { maxPerWeek: 2 } },
    tradePropose: { mode: 'ask', limits: { minTradeGain: 5 } },
    waiverClaim: { mode: 'ask', limits: { maxFaabPerClaimPct: 0.2 } },
  },
  players: { locked: ['465.p.1'], ask: ['465.p.2'] },
  tools: { propose_trade: false },
  protected: { topNByVorp: 6 },
});

type Draft = ReturnType<typeof Permissions.parse>;
const edit = (fn: (p: Draft) => void): Draft => {
  const copy = structuredClone(base);
  fn(copy);
  return copy;
};

const only = (after: Draft) => {
  const changes = diffPermissions(base, after);
  expect(changes).toHaveLength(1);
  return changes[0]!;
};

describe('diffPermissions', () => {
  it('reports nothing for an unchanged document', () => {
    expect(diffPermissions(base, structuredClone(base))).toEqual([]);
  });

  it('dry run off widens; on narrows', () => {
    expect(only(edit((p) => (p.dryRun = false))).widens).toBe(true);
    const live = edit((p) => (p.dryRun = false));
    expect(diffPermissions(live, base)[0]!.widens).toBe(false);
  });

  it('un-pausing widens; pausing narrows', () => {
    expect(only(edit((p) => (p.paused = true))).widens).toBe(false);
    const paused = edit((p) => (p.paused = true));
    expect(diffPermissions(paused, base)[0]!.widens).toBe(true);
  });

  it('a mode moving toward allow widens, toward deny narrows', () => {
    expect(only(edit((p) => (p.plans.addDrop!.mode = 'allow'))).widens).toBe(true);
    expect(only(edit((p) => (p.plans.addDrop!.mode = 'deny'))).widens).toBe(false);
    expect(only(edit((p) => (p.plans.lineup!.mode = 'ask'))).widens).toBe(false);
  });

  it('treats a missing kind as deny, so adding it as ask widens', () => {
    expect(modeOf(base, 'draftPick')).toBe('deny');
    const c = only(edit((p) => (p.plans.draftPick = { mode: 'ask', limits: {} })));
    expect(c.path).toBe('plans.draftPick.mode');
    expect(c.widens).toBe(true);
  });

  it('raising or removing a cap widens; lowering or adding one narrows', () => {
    expect(only(edit((p) => (p.plans.addDrop!.limits.maxPerWeek = 3))).widens).toBe(true);
    expect(only(edit((p) => (p.plans.addDrop!.limits.maxPerWeek = 1))).widens).toBe(false);
    expect(only(edit((p) => delete p.plans.addDrop!.limits.maxPerWeek)).widens).toBe(true);
    expect(only(edit((p) => (p.plans.lineup!.limits.maxPerWeek = 7))).widens).toBe(false);
    expect(only(edit((p) => (p.plans.waiverClaim!.limits.maxFaabPerClaimPct = 0.5))).widens).toBe(
      true,
    );
  });

  it('lowering the minimum trade gain widens; raising it narrows', () => {
    expect(only(edit((p) => (p.plans.tradePropose!.limits.minTradeGain = 2))).widens).toBe(true);
    expect(only(edit((p) => (p.plans.tradePropose!.limits.minTradeGain = 9))).widens).toBe(false);
  });

  it('unlocking or un-asking a player widens; adding one narrows', () => {
    expect(only(edit((p) => (p.players.locked = []))).widens).toBe(true);
    expect(only(edit((p) => (p.players.ask = []))).widens).toBe(true);
    const added = only(edit((p) => p.players.locked.push('465.p.3')));
    expect(added.widens).toBe(false);
    expect(added.path).toBe('players.locked.465.p.3');
  });

  it('uses the name lookup in labels', () => {
    const [c] = diffPermissions(
      base,
      edit((p) => (p.players.locked = [])),
      () => 'Connor McDavid',
    );
    expect(c!.label).toContain('Connor McDavid');
  });

  it('turning a tool on widens; off narrows (absent means on)', () => {
    expect(only(edit((p) => (p.tools.propose_trade = true))).widens).toBe(true);
    expect(only(edit((p) => delete p.tools.propose_trade)).widens).toBe(true);
    expect(only(edit((p) => (p.tools.propose_lineup = false))).widens).toBe(false);
    expect(
      diffPermissions(
        base,
        edit((p) => (p.tools.propose_lineup = true)),
      ),
    ).toEqual([]);
  });

  it('a lower protected N widens; higher narrows', () => {
    expect(only(edit((p) => (p.protected.topNByVorp = 3))).widens).toBe(true);
    expect(only(edit((p) => (p.protected.topNByVorp = 8))).widens).toBe(false);
  });

  it('widensAutonomy is true when any change widens', () => {
    const mixed = edit((p) => {
      p.protected.topNByVorp = 8;
      p.dryRun = false;
    });
    expect(widensAutonomy(diffPermissions(base, mixed))).toBe(true);
    expect(
      widensAutonomy(
        diffPermissions(
          base,
          edit((p) => (p.paused = true)),
        ),
      ),
    ).toBe(false);
  });
});

describe('parseLimit', () => {
  it('treats blank or junk as no limit', () => {
    expect(parseLimit('maxPerWeek', '')).toBeUndefined();
    expect(parseLimit('maxPerWeek', 'abc')).toBeUndefined();
  });

  it('stores FAAB as a fraction of a typed percentage, clamped', () => {
    expect(parseLimit('maxFaabPerClaimPct', '25')).toBe(0.25);
    expect(parseLimit('maxFaabPerClaimPct', '250')).toBe(1);
  });

  it('rounds weekly caps to a non-negative integer and keeps trade gain as typed', () => {
    expect(parseLimit('maxPerWeek', '2.6')).toBe(3);
    expect(parseLimit('maxPerWeek', '-1')).toBe(0);
    expect(parseLimit('minTradeGain', '-1.5')).toBe(-1.5);
  });
});

describe('auto-grab settings', () => {
  it('parses from a document without the section, with the documented defaults', () => {
    expect(base.autoGrab).toEqual({ enabled: true, minGain: 1.5, ignoreDryRun: false });
  });

  it('enabling, lowering the bar, acting through dry run and loosening the cap widen', () => {
    const off = edit((p) => (p.autoGrab.enabled = false));
    expect(diffPermissions(off, base)[0]).toMatchObject({ path: 'autoGrab.enabled', widens: true });
    expect(only(off).widens).toBe(false);
    expect(only(edit((p) => (p.autoGrab.minGain = 1))).widens).toBe(true);
    expect(only(edit((p) => (p.autoGrab.minGain = 2))).widens).toBe(false);
    const through = only(edit((p) => (p.autoGrab.ignoreDryRun = true)));
    expect(through).toMatchObject({ path: 'autoGrab.ignoreDryRun', widens: true });
    expect(only(edit((p) => (p.autoGrab.maxPerWeek = 2))).widens).toBe(false);
    const capped = edit((p) => (p.autoGrab.maxPerWeek = 2));
    expect(diffPermissions(capped, base)[0]?.widens).toBe(true);
    expect(
      diffPermissions(
        capped,
        edit((p) => (p.autoGrab.maxPerWeek = 3)),
      )[0]?.widens,
    ).toBe(true);
  });

  it('parseMinGain keeps the current value for blank or junk, floors at 0', () => {
    expect(parseMinGain('', 1.5)).toBe(1.5);
    expect(parseMinGain('abc', 1.5)).toBe(1.5);
    expect(parseMinGain('2.25', 1.5)).toBe(2.25);
    expect(parseMinGain('-1', 1.5)).toBe(0);
  });
});

describe('ask with timeout (D-018)', () => {
  const kind = (d: Draft) => d.plans.addDrop;
  const set = (mode: 'ask' | 'askTimeout' | 'allow', timeoutMinutes?: number) =>
    edit((d) => {
      d.plans.addDrop = {
        mode,
        limits: kind(d)?.limits ?? {},
        ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
      };
    });
  const modeChange = (before: Draft, after: Draft) =>
    diffPermissions(before, after).find((c) => c.path.startsWith('plans.addDrop.'));

  it('ask → ask-then-do and ask-then-do → allow widen; back to ask narrows', () => {
    const timed = set('askTimeout');
    expect(modeChange(base, timed)).toMatchObject({
      label: 'Add / drop: ask → ask, then do after 30 min',
      widens: true,
    });
    expect(modeChange(timed, set('allow'))?.widens).toBe(true);
    expect(modeChange(timed, base)?.widens).toBe(false);
  });

  it('lowering the minutes widens; raising them narrows', () => {
    const lower = modeChange(set('askTimeout', 30), set('askTimeout', 10));
    expect(lower).toMatchObject({ path: 'plans.addDrop.timeoutMinutes', widens: true });
    expect(lower?.label).toBe('Add / drop: do it after 30 → 10 min unless you reject');
    expect(modeChange(set('askTimeout'), set('askTimeout', 60))?.widens).toBe(false);
    // The default is 30: setting 30 explicitly is no change.
    expect(modeChange(set('askTimeout'), set('askTimeout', 30))).toBeUndefined();
  });

  it('parseTimeout clamps to 5–1440 whole minutes; blank keeps the current value', () => {
    expect(parseTimeout('2', 30)).toBe(5);
    expect(parseTimeout('9999', 30)).toBe(1440);
    expect(parseTimeout('12.6', 30)).toBe(13);
    expect(parseTimeout('', 45)).toBe(45);
    expect(parseTimeout('abc', 45)).toBe(45);
  });
});
