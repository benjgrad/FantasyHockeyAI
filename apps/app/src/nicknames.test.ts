import { describe, expect, it } from 'vitest';
import { aliasesFor } from './nicknames.js';

describe('aliasesFor', () => {
  it('gives nicknames and the other forms of the first name, with the surname', () => {
    expect(aliasesFor('Alex Ovechkin')).toEqual(
      expect.arrayContaining(['Ovi', 'Alexander Ovechkin', 'Sasha Ovechkin']),
    );
    expect(aliasesFor('Nathan MacKinnon')).toEqual(expect.arrayContaining(['Nate MacKinnon']));
  });

  it('matches the table ignoring accents and case, and never repeats the name itself', () => {
    expect(aliasesFor('juraj slafkovsky')).toContain('Slaf');
    expect(aliasesFor('Matthew Tkachuk')).not.toContain('Matthew Tkachuk');
  });

  it('gives nothing for a one-word name or a player with no other names', () => {
    expect(aliasesFor('Ovechkin')).toEqual([]);
    expect(aliasesFor('Kirby Dach')).toEqual([]);
  });
});
