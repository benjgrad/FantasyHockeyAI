import { describe, expect, it } from 'vitest';
import { conceptsText } from './concepts.js';

describe('conceptsText (D-041)', () => {
  const text = conceptsText();

  it('covers the ideas Ben raised that the agents never did', () => {
    expect(text).toMatch(/games played/i);
    // "Wouldn't we have more games if we had fewer goalies?"
    expect(text).toMatch(/goalie beyond the two we start holds a bench spot/);
    expect(text).toMatch(/ice time/i);
    expect(text).toMatch(/power-play unit/i);
    expect(text).toMatch(/hat trick/);
    expect(text).toMatch(/other manager gains on his own needs/);
  });

  it('names the tools that measure each idea', () => {
    for (const tool of ['getSchedule', 'getForecast', 'getPlayerForm', 'getTeamRoster']) {
      expect(text).toContain(tool);
    }
  });

  it('marks reusing a seat after its game as unverified (U-49)', () => {
    expect(text).toMatch(/reused after its player's game ends is unverified \[U\]/);
  });

  it('stays short and static, so it is cheap and keeps the cached prefix', () => {
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(conceptsText()).toBe(text);
  });

  it('avoids the over-prompting words current models over-trigger on', () => {
    expect(text).not.toMatch(/CRITICAL|IMPORTANT|\bMUST\b|double-check|re-verify/i);
  });
});
