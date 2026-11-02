import { describe, expect, it } from 'vitest';
import { marginalWeights } from '@fha/model';
import { openStore } from '@fha/store';
import { auditWeek, LeagueView, MOCK_SETTINGS } from '@fha/tools';
import { FIXTURE } from '../testing.js';
import { writeCodeWeights } from './jobs.js';

/** The week's code weights take the strategy's punts, and nothing else of it (D-034, D-041). */
describe('writeCodeWeights', () => {
  it('stores the week’s ΔP(win) weights with the punts at 0, as before the policy module', () => {
    const view = LeagueView.fromFile(FIXTURE, MOCK_SETTINGS);
    const store = openStore(':memory:');
    const week = auditWeek(view, store);
    if (week === undefined) throw new Error('fixture needs a matchup this week');
    store.seasonStrategy.add({
      leagueKey: view.snap.leagueKey,
      author: 'strategy',
      stance: 'contend',
      targets: ['SOG'],
      surplus: ['HIT'],
      punts: ['SHP'],
      principles: ['x'],
      rationale: 'x',
      reviewBy: undefined,
    });
    writeCodeWeights(store, view);
    const stored = store.strategy.get(view.snap.week);
    expect(stored?.weights).toEqual(marginalWeights(week.audit, { punts: ['SHP'] }));
    expect(stored?.weights['SHP']).toBe(0);
  });
});
