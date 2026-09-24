import { describe, expect, it } from 'vitest';
import {
  jaroWinkler,
  matchPlayer,
  normalizeName,
  resolveDraftName,
  type Candidate,
} from './names.js';

const pool: Candidate[] = [
  { nhlId: 1, name: 'Connor McDavid', position: 'C', team: 'EDM' },
  { nhlId: 2, name: 'Nikita Kucherov', position: 'RW', team: 'TBL' },
  { nhlId: 3, name: 'Elias Pettersson', position: 'C', team: 'VAN' },
  { nhlId: 4, name: 'Elias Pettersson', position: 'D', team: 'VAN' },
  { nhlId: 5, name: 'Tim Stützle', position: 'C', team: 'OTT' },
  { nhlId: 6, name: 'Sebastian Aho', position: 'C', team: 'CAR' },
  { nhlId: 7, name: 'Sebastian Aho', position: 'D', team: 'NYI' },
  { nhlId: 8, name: 'Alex Ovechkin', position: 'LW', team: 'WSH' },
];

describe('normalizeName', () => {
  it('should strip diacritics so an ASCII query matches', () => {
    expect(normalizeName('Tim Stützle')).toBe('tim stutzle');
  });

  it('should drop punctuation and collapse whitespace', () => {
    expect(normalizeName("T.J.  O'Brien")).toBe('t j o brien');
  });

  it('should drop a generational suffix', () => {
    expect(normalizeName('Bobby Brink Jr.')).toBe('bobby brink');
  });
});

describe('jaroWinkler', () => {
  it('should score identical strings 1', () => {
    expect(jaroWinkler('mcdavid', 'mcdavid')).toBe(1);
  });

  it('should score a shared prefix above an unrelated string', () => {
    expect(jaroWinkler('mcdavid', 'mcdavis')).toBeGreaterThan(jaroWinkler('mcdavid', 'kucherov'));
  });

  it('should score an empty comparison 0', () => {
    expect(jaroWinkler('', 'mcdavid')).toBe(0);
  });
});

describe('matchPlayer', () => {
  it('should resolve an exact full name', () => {
    const r = matchPlayer('Connor McDavid', pool);
    expect(r.kind).toBe('exact');
    expect(r.kind === 'exact' && r.candidate.nhlId).toBe(1);
  });

  it('should resolve a bare surname when it is unique', () => {
    const r = matchPlayer('kucherov', pool);
    expect(r.kind).toBe('exact');
    expect(r.kind === 'exact' && r.candidate.nhlId).toBe(2);
  });

  it('should resolve a diacritic name typed in plain ASCII', () => {
    const r = matchPlayer('stutzle', pool);
    expect(r.kind).toBe('exact');
    expect(r.kind === 'exact' && r.candidate.nhlId).toBe(5);
  });

  it('should refuse to guess between two players with the same name', () => {
    const r = matchPlayer('Elias Pettersson', pool);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates).toHaveLength(2);
  });

  it('should refuse to guess on an ambiguous surname', () => {
    const r = matchPlayer('aho', pool);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.map((c) => c.nhlId).sort()).toEqual([6, 7]);
  });

  it('should tolerate a small typo via fuzzy matching', () => {
    const r = matchPlayer('Conor McDavid', pool);
    expect(r.kind).toBe('fuzzy');
    expect(r.kind === 'fuzzy' && r.candidate.nhlId).toBe(1);
  });

  it('should return none with suggestions rather than the closest name for a bad query', () => {
    const r = matchPlayer('Wayne Gretzky', pool);
    expect(r.kind).toBe('none');
    expect(r.kind === 'none' && r.best.length).toBeGreaterThan(0);
  });

  it('should return none for an empty query instead of matching something', () => {
    expect(matchPlayer('   ', pool).kind).toBe('none');
  });
});

describe('resolveDraftName', () => {
  const none = new Set<number>();

  it('should resolve a live player', () => {
    const r = resolveDraftName('Connor McDavid', pool, none);
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.candidate.nhlId).toBe(1);
  });

  it('should report an already-drafted player rather than failing to match', () => {
    const r = resolveDraftName('Connor McDavid', pool, new Set([1]));
    expect(r.kind).toBe('alreadyDrafted');
    expect(r.kind === 'alreadyDrafted' && r.candidate.name).toBe('Connor McDavid');
  });

  it('should resolve an ambiguous name once only one candidate remains, and say so', () => {
    const r = resolveDraftName('aho', pool, new Set([6]));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.candidate.nhlId).toBe(7);
    // The note must exist: silently picking the other Aho is how a draft goes wrong.
    expect(r.note).toMatch(/already drafted/i);
  });

  it('should stay ambiguous while more than one candidate is live', () => {
    const r = resolveDraftName('aho', pool, none);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates).toHaveLength(2);
  });

  it('should report already-drafted when every candidate for a name is gone', () => {
    const r = resolveDraftName('aho', pool, new Set([6, 7]));
    expect(r.kind).toBe('alreadyDrafted');
  });

  it('should still refuse an unknown name', () => {
    expect(resolveDraftName('Wayne Gretzky', pool, none).kind).toBe('none');
  });

  it('should annotate a fuzzy match so the operator can catch a bad correction', () => {
    const r = resolveDraftName('Conor McDavid', pool, none);
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.note).toMatch(/fuzzy/i);
  });
});
