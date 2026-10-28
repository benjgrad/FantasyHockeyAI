import { describe, expect, it } from 'vitest';
import { getPlayers, searchPlayers } from './tools/league.js';
import { findPickups, getPlayerValue } from './tools/value.js';
import { testRun } from './testing.js';

describe('value tools (D-026)', () => {
  const run = testRun({ agent: 'waivers' });
  const ours = run.ctx.view.roster().entries.map((e) => e.player.playerKey);

  it('getPlayerValue explains every measure, naming the lens and the free-agent bar', async () => {
    const r = await getPlayerValue.execute({ playerKeys: ours.slice(0, 2) }, run.ctx);
    expect(r.ok).toBe(true);
    const text = r.ok ? r.summary : '';
    expect(text).toMatch(/^Lens: rest of season/);
    expect(text).toMatch(/VOLS .* \(preseason VORP/);
    expect(text).toMatch(/VOFA [+−]\d/);
    expect(text).toMatch(/CWA [+−]\d.* categories\/week for us/);
    expect(text).toContain('LOW CONFIDENCE');
  });

  it('getPlayerValue refuses a key no tool returned (P3)', async () => {
    const r = await getPlayerValue.execute({ playerKeys: ['999.p.1'] }, run.ctx);
    expect(r.ok).toBe(false);
  });

  it('findPickups pairs free agents with droppable players, in code, against the add bar', async () => {
    const r = await findPickups.execute({ limit: 5 }, run.ctx);
    expect(r.ok).toBe(true);
    // winWeek is the default objective since D-035: upgrades clear the ΔP(win a week) bar.
    expect(r.ok && r.summary).toMatch(/adds left; an upgrade must raise P\(win a typical week\)/);
    if (r.ok) {
      const data = r.data as { moves: { add: string; drop: string | null }[] };
      for (const m of data.moves) {
        expect(run.ctx.view.isFreeAgent(m.add)).toBe(true);
        if (m.drop !== null) expect(ours).toContain(m.drop);
      }
    }
  });

  it('player tables show both lenses side by side', async () => {
    const r = await getPlayers.execute({ playerKeys: ours.slice(0, 1) }, run.ctx);
    expect(r.ok && r.summary).toMatch(/value \(pre\) \| VORP \(pre\) \| VOLS \(ROS\) \| VOFA \| CWA \| Δ7d/);
    const s = await searchPlayers.execute({ sort: [{ by: 'cwa', order: 'desc' }], limit: 3 }, run.ctx);
    expect(s.ok && s.summary).toMatch(/by CWA, .*highest first, top 3/);
  });
});
