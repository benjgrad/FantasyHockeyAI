import { describe, expect, it } from 'vitest';
import {
  askText,
  compareHref,
  deltaTone,
  fmtCat,
  fmtDelta,
  linkify,
  parseKeys,
  strengthBar,
  termTone,
  toggleKey,
  topBottom,
  zBar,
} from './helpers';

const cats = (zs: Record<string, number | null>) =>
  Object.entries(zs).map(([cat, z]) => ({ cat, z }));

describe('topBottom', () => {
  it('takes the best four and the worst two, worst last', () => {
    const r = topBottom(cats({ G: 1, A: -2, PIM: 3, PPP: 0.5, SHP: -0.1, SOG: 2, HIT: -1 }));
    expect(r.best.map((c) => c.cat)).toEqual(['PIM', 'SOG', 'G', 'PPP']);
    expect(r.worst.map((c) => c.cat)).toEqual(['HIT', 'A']);
  });

  it('never repeats a category when there are fewer than six', () => {
    const r = topBottom(cats({ W: 1, GAA: 0.8, 'SV%': -0.2, SHO: -1 }));
    expect(r.best.map((c) => c.cat)).toEqual(['W', 'GAA', 'SV%', 'SHO']);
    expect(r.worst).toEqual([]);
  });

  it('skips unscored categories', () => {
    expect(topBottom(cats({ G: null, A: 1 })).best.map((c) => c.cat)).toEqual(['A']);
  });
});

describe('delta colouring', () => {
  it('follows `better`, so a lower GAA reads green', () => {
    expect(deltaTone(-0.18, true)).toBe('up');
    expect(deltaTone(0.18, false)).toBe('down');
    expect(deltaTone(12, true)).toBe('up');
  });

  it('is flat for no difference or an unknown one', () => {
    expect(deltaTone(0, false)).toBe('flat');
    expect(deltaTone(null, true)).toBe('flat');
    expect(termTone(0.001)).toBe('flat');
    expect(termTone(-1)).toBe('down');
  });
});

describe('formatting', () => {
  it('writes categories the hockey way', () => {
    expect(fmtCat('SV%', 0.9123)).toBe('.912');
    expect(fmtCat('GAA', 2.5432)).toBe('2.54');
    expect(fmtCat('SOG', 220.6)).toBe('221');
    expect(fmtCat('G', null)).toBe('—');
    expect(fmtDelta('GAA', -0.18)).toBe('−0.18');
    expect(fmtDelta('SV%', 0.002)).toBe('+.002');
    expect(fmtDelta('HIT', 12.4)).toBe('+12');
  });

  it('maps z to a clamped bar coloured by direction', () => {
    expect(zBar(0)).toEqual({ pct: 50, tone: 'flat' });
    expect(zBar(5)).toEqual({ pct: 100, tone: 'up' });
    expect(zBar(-1).tone).toBe('down');
    expect(strengthBar(-4)).toEqual({ left: 25, width: 25 });
    expect(strengthBar(20)).toEqual({ left: 50, width: 50 });
  });
});

describe('compare keys', () => {
  it('parses, de-duplicates and caps at four', () => {
    expect(parseKeys('a, b,a,,c,d,e')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseKeys(null)).toEqual([]);
    expect(compareHref(['477.p.1', '477.p.2'])).toBe('/compare?keys=477.p.1,477.p.2');
  });

  it('toggles a key without passing four', () => {
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleKey(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleKey(['a', 'b', 'c', 'd'], 'e')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('prefills the chat with the player named', () => {
    expect(askText({ name: 'Seth Jarvis', nhlTeam: 'CAR', positions: ['LW', 'RW'] })).toContain(
      'Seth Jarvis (CAR, LW/RW)',
    );
  });
});

describe('linkify', () => {
  it('links every named player, longest name first', () => {
    const players = [
      { playerKey: 'k1', name: 'Aho' },
      { playerKey: 'k2', name: 'Sebastian Aho' },
      { playerKey: 'k3', name: 'Seth Jarvis' },
    ];
    expect(linkify('Add Sebastian Aho, drop Seth Jarvis.', players)).toEqual([
      { text: 'Add ' },
      { text: 'Sebastian Aho', playerKey: 'k2' },
      { text: ', drop ' },
      { text: 'Seth Jarvis', playerKey: 'k3' },
      { text: '.' },
    ]);
  });

  it('leaves text without names alone', () => {
    expect(linkify('Set the lineup', [])).toEqual([{ text: 'Set the lineup' }]);
  });
});
