import { describe, expect, it } from 'vitest';
import { GLOSSARY, Permissions } from '@fha/core';
import { mockView } from '@fha/tools';
import { buildLeagueContext } from './leagueContext.js';

describe('buildLeagueContext', () => {
  it('gives every agent the same stat definitions the app shows (D-026)', () => {
    const view = mockView();
    const text = buildLeagueContext(view.settings, Permissions.parse({}), view, '2026-10-02');
    for (const e of Object.values(GLOSSARY)) expect(text).toContain(`- ${e.label}: ${e.short}`);
    expect(text).toContain('PPP = Power-play points');
  });
});

describe('league rules (D-029)', () => {
  it("puts Yahoo's goalie minimum, trade deadline and week dates in every agent's context", () => {
    const view = mockView((s) => {
      s.rules = {
        minGoalieGames: 3,
        tradeEndDate: '2027-03-03',
        playoffStartWeek: 22,
        waiverDays: 2,
      };
    });
    const text = buildLeagueContext(view.settings, Permissions.parse({}), view, '2026-10-13');
    expect(text).toMatch(/goalie minimum 3 games a week/);
    expect(text).toMatch(/trade deadline 2027-03-03 \(141 days\)/);
    expect(text).toMatch(/playoffs from week 22/);
    expect(text).toMatch(/This fantasy week: 2026-10-12\.\.2026-10-18/);
  });
});

describe('freshness and waivers (4b, Phase 5)', () => {
  it('says when Yahoo was read, how far the stats go, and warns when the read failed', () => {
    const view = mockView();
    view.freshness = { builtAt: '2026-10-24T15:44:00.000Z', statsThrough: '2026-10-23' };
    const fresh = buildLeagueContext(view.settings, Permissions.parse({}), view, '2026-10-24');
    expect(fresh).toContain(
      'As of Oct 24, 11:44 AM ET (Yahoo read); NHL stats through 2026-10-23.',
    );
    expect(fresh).not.toContain('STALE');
    view.freshness = {
      ...view.freshness,
      stale: { failedAt: '2026-10-24T16:00:00.000Z', reason: 'yahoo_unavailable' },
    };
    const stale = buildLeagueContext(view.settings, Permissions.parse({}), view, '2026-10-24');
    expect(stale).toMatch(/STALE: the last Yahoo read failed at Oct 24, 12:00 PM ET/);
  });

  it('explains rolling waivers with our place in the order, the unknowns marked [U]', () => {
    const view = mockView((s) => {
      s.rules = { waiverDays: 2 };
      s.teams = s.teams.map((t) => ({ ...t, waiverPriority: t.teamKey === s.teamKey ? 8 : 1 }));
    });
    const text = buildLeagueContext(view.settings, Permissions.parse({}), view, '2026-10-13');
    expect(text).toContain(
      'Waivers: rolling priority, no FAAB; we are #8 of 8 in waiver priority.',
    );
    expect(text).toMatch(/highest in the order wins and that team drops to last/);
    expect(text).toMatch(/free-agent add \(status FA\) costs no priority/);
    expect(text).toMatch(/sits on waivers 2 days/);
    expect(text).toMatch(/Unverified \[U\]: the exact time Yahoo processes claims/);
    expect(text).toMatch(/which fantasy week the add counts toward/);
  });

  it('never says a timed claim goes through on its own (U-22)', () => {
    const view = mockView();
    const perms = Permissions.parse({
      plans: { waiverClaim: { mode: 'askTimeout', timeoutMinutes: 60 } },
    });
    const text = buildLeagueContext(view.settings, perms, view, '2026-10-13');
    expect(text).toMatch(
      /waiverClaim ask \(after 60 min unless Ben rejects, handed to Ben to file in Yahoo/,
    );
    expect(text).not.toMatch(/waiverClaim ask \(done after/);
  });
});
