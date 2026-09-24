import { describe, expect, it } from 'vitest';
import { normalizeTeam, sameTeam } from './teams.js';

describe('normalizeTeam', () => {
  it('should map each of the four Yahoo spellings to the NHL form', () => {
    expect(normalizeTeam('LA')).toBe('LAK');
    expect(normalizeTeam('NJ')).toBe('NJD');
    expect(normalizeTeam('SJ')).toBe('SJS');
    expect(normalizeTeam('TB')).toBe('TBL');
  });

  it('should leave an already-canonical abbreviation alone', () => {
    for (const t of ['EDM', 'COL', 'TBL', 'LAK', 'WSH']) expect(normalizeTeam(t)).toBe(t);
  });

  it('should fold a relocated franchise onto its current club', () => {
    expect(normalizeTeam('ARI')).toBe('UTA');
    expect(normalizeTeam('ATL')).toBe('WPG');
  });

  it('should be case and whitespace insensitive', () => {
    expect(normalizeTeam(' tb ')).toBe('TBL');
  });

  it('should return UNK for missing or empty input rather than throwing', () => {
    expect(normalizeTeam(undefined)).toBe('UNK');
    expect(normalizeTeam('')).toBe('UNK');
    expect(normalizeTeam('   ')).toBe('UNK');
  });

  it('should pass an unknown abbreviation through instead of guessing', () => {
    expect(normalizeTeam('ZZZ')).toBe('ZZZ');
  });
});

describe('sameTeam', () => {
  it('should match across the two spellings', () => {
    expect(sameTeam('TB', 'TBL')).toBe(true);
    expect(sameTeam('SJS', 'SJ')).toBe(true);
  });

  it('should not match different clubs', () => {
    expect(sameTeam('EDM', 'COL')).toBe(false);
  });

  it('should treat unknown as no-match, never as a wildcard', () => {
    // A wildcard here would let a missing team silently confirm a wrong join.
    expect(sameTeam('UNK', 'EDM')).toBe(false);
    expect(sameTeam(undefined, 'EDM')).toBe(false);
  });
});
