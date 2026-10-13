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
