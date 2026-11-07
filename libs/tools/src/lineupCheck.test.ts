import { describe, expect, it } from 'vitest';
import { checkOurLineup, lineupInputProblems, lineupInputWarnings } from './lineupCheck.js';
import { MOCK_NOW, mockView } from './testing.js';

const DATE = '2026-10-13';

describe('lineupInputProblems (D-044)', () => {
  it('finds nothing wrong with the recorded league', () => {
    expect(lineupInputProblems(mockView(), DATE)).toEqual([]);
  });

  it('refuses a date the schedule does not cover', () => {
    const view = mockView((s) => {
      s.schedule = s.schedule.filter((d) => d.date !== DATE);
    });
    expect(lineupInputProblems(view, DATE)).toEqual([
      `The NHL schedule for ${DATE} is not loaded, so no one's games can be verified.`,
    ]);
  });

  it("names a rostered player whose team appears in no scheduled game", () => {
    const view = mockView((s) => {
      const key = s.rosters[s.teamKey]?.[0]?.playerKey;
      const p = s.players.find((x) => x.playerKey === key);
      if (p) p.nhlTeam = 'XXX';
    });
    const problems = lineupInputProblems(view, DATE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/team XXX plays no game in the loaded schedule/);
  });
});

describe('checkOurLineup', () => {
  it('audits the current lineup and a planned one', () => {
    const view = mockView();
    const check = checkOurLineup(view, undefined, undefined, DATE, MOCK_NOW);
    if (!check.ok) throw new Error(check.problems.join());
    expect(check.entries).toHaveLength(view.roster().entries.length);
    const fixed = checkOurLineup(view, undefined, undefined, DATE, MOCK_NOW, {
      assignments: check.audit.optimal.assignments,
    });
    expect(fixed.ok && fixed.audit.lostStarts).toBe(0);
  });

  it('passes an override error back as a problem', () => {
    const check = checkOurLineup(mockView(), undefined, undefined, DATE, MOCK_NOW, {
      overrides: [{ playerKey: '477.p.424242', bench: true }],
    });
    expect(check.ok ? '' : check.problems.join()).toMatch(/not on our roster/);
  });

  it('warns about players with no valuation', () => {
    const view = mockView((s) => {
      const key = s.rosters[s.teamKey]?.[0]?.playerKey;
      s.valuations = Object.fromEntries(Object.entries(s.valuations).filter(([k]) => k !== key));
    });
    expect(lineupInputWarnings(view)).toHaveLength(1);
  });
});
