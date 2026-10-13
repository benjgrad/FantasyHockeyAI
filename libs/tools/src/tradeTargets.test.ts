import { describe, expect, it } from 'vitest';
import { findTradeTargets } from './tools/tradeTargets.js';
import { mockPermissions, testRun } from './testing.js';

describe('findTradeTargets tool', () => {
  it('returns scored swaps with one partner, never with a locked player', async () => {
    const { ctx } = testRun({ agent: 'trades' });
    // The recorded mock league has swaps that help both sides with this team.
    const partner = 'Mock Team 3';
    const r = await findTradeTargets.execute({ partnerTeamName: partner }, ctx);
    if (!r.ok) throw new Error(r.error);
    for (const t of r.data.trades) {
      expect(t.partner).toBe(partner);
      expect(t.deltaUs).toBeGreaterThan(0);
      expect(t.deltaThem).toBeGreaterThanOrEqual(0);
    }
    expect(r.data.trades.length).toBeGreaterThan(0);
    const first = r.data.trades[0];
    if (first === undefined) return;
    const locked = mockPermissions({ players: { locked: first.give, ask: [] } });
    const again = await findTradeTargets.execute(
      { partnerTeamName: partner },
      { ...ctx, permissions: locked },
    );
    if (!again.ok) throw new Error(again.error);
    expect(again.data.trades.some((t) => t.give.some((k) => first.give.includes(k)))).toBe(false);
    // The exhaustive search is CPU-bound: seconds alone, longer beside the full suite.
  }, 60_000);

  it('refuses an unknown team name', async () => {
    const { ctx } = testRun({ agent: 'trades' });
    const r = await findTradeTargets.execute({ partnerTeamName: 'Nobody FC' }, ctx);
    expect(r.ok).toBe(false);
  });
});
