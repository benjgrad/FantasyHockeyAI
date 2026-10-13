import { describe, expect, it } from 'vitest';
import { buildMatcher, findMentions, type Segment } from './match';

const idx = {
  players: [
    { playerKey: 'p.mcd', name: 'Connor McDavid' },
    { playerKey: 'p.stu', name: 'Tim Stützle' },
    { playerKey: 'p.aho1', name: 'Sebastian Aho' },
    { playerKey: 'p.aho2', name: 'Sebastian Aho' },
    { playerKey: 'p.pow', name: 'Owen Power' },
    { playerKey: 'p.qhu', name: 'Quinn Hughes' },
    { playerKey: 'p.jhu', name: 'Jack Hughes' },
    { playerKey: 'p.tka', name: 'Matthew Tkachuk' },
  ],
  teams: [
    { teamKey: 't.1', name: 'apple seider 🧃🐐' },
    { teamKey: 't.2', name: "Ben's Astonishing Team" },
  ],
};
const m = buildMatcher(idx);
const run = (...texts: string[]) => findMentions(texts, m);
const keys = (segs: Segment[]) =>
  segs.flatMap((s) => (typeof s === 'string' ? [] : [`${s.mention.key}:${s.text}`]));

describe('findMentions', () => {
  it('links full names, keeping the text exactly as written', () => {
    const [segs = []] = run('Start Connor McDavid tonight.');
    expect(segs).toEqual([
      'Start ',
      { text: 'Connor McDavid', mention: { kind: 'player', key: 'p.mcd' } },
      ' tonight.',
    ]);
  });

  it('ignores case and accents, and maps back to the original characters', () => {
    expect(keys(run('tim stutzle and TIM STÜTZLE')[0] ?? [])).toEqual([
      'p.stu:tim stutzle',
      'p.stu:TIM STÜTZLE',
    ]);
  });

  it('needs a word boundary, and refuses a name two players share', () => {
    expect(keys(run('Connor McDavidson; Sebastian Aho scored')[0] ?? [])).toEqual([]);
  });

  it('links team names with or without their emoji, and curly apostrophes', () => {
    expect(keys(run('apple seider leads; Ben’s Astonishing Team trails')[0] ?? [])).toEqual([
      't.1:apple seider',
      't.2:Ben’s Astonishing Team',
    ]);
  });

  it('links a capitalised surname anywhere in a message that names him in full', () => {
    const out = run('McDavid first. Connor McDavid had 3 points; ', "McDavid's line too");
    expect(out.map(keys)).toEqual([['p.mcd:McDavid', 'p.mcd:Connor McDavid'], ['p.mcd:McDavid']]);
  });

  it('leaves a lowercase surname alone ("power play")', () => {
    expect(keys(run('Owen Power is on the power play. Power scored.')[0] ?? [])).toEqual([
      'p.pow:Owen Power',
      'p.pow:Power',
    ]);
  });

  it('skips a surname two named players share', () => {
    expect(keys(run('Quinn Hughes and Jack Hughes; Hughes scored')[0] ?? [])).toEqual([
      'p.qhu:Quinn Hughes',
      'p.jhu:Jack Hughes',
    ]);
  });

  it('matches across a line break inside a name', () => {
    expect(keys(run('Matthew\nTkachuk')[0] ?? [])).toEqual(['p.tka:Matthew\nTkachuk']);
  });

  it('returns text untouched with an empty index', () => {
    expect(findMentions(['Connor McDavid'], buildMatcher({ players: [], teams: [] }))).toEqual([
      ['Connor McDavid'],
    ]);
  });

  describe('surnames alone and aliases', () => {
    const big = buildMatcher({
      players: [
        { playerKey: 'p.drai', name: 'Leon Draisaitl', aliases: ['Leon', 'Drai'] },
        { playerKey: 'p.mcd', name: 'Connor McDavid' },
        { playerKey: 'p.kc', name: 'Kyle Connor' },
        { playerKey: 'p.pt', name: 'Brayden Point' },
        { playerKey: 'p.qhu', name: 'Quinn Hughes' },
        { playerKey: 'p.jhu', name: 'Jack Hughes' },
        { playerKey: 'p.ovi', name: 'Alex Ovechkin', aliases: ['Ovi', 'Alexander Ovechkin'] },
        { playerKey: 'p.shes', name: 'Igor Shesterkin', aliases: ['Igor'] },
        { playerKey: 'p.cher', name: 'Igor Chernyshov' },
      ],
      teams: [],
    });
    const linked = (text: string) => keys(findMentions([text], big)[0] ?? []);

    it('links a unique, capitalised surname with no full name in the message', () => {
      expect(linked('Draisaitl and McDavid both scored; draisaitl again')).toEqual([
        'p.drai:Draisaitl',
        'p.mcd:McDavid',
      ]);
    });

    it('leaves a surname alone when shared, a first name, or a common word', () => {
      expect(linked('Hughes, Connor and Point all scored on the Point')).toEqual([]);
    });

    it('still links those after the message names the player in full', () => {
      expect(linked('Brayden Point is hot: Point has 3 goals')).toEqual([
        'p.pt:Brayden Point',
        'p.pt:Point',
      ]);
    });

    it('links nicknames when capitalised, and first-name forms in any case', () => {
      expect(linked('Ovi and Drai; ovi; alexander ovechkin')).toEqual([
        'p.ovi:Ovi',
        'p.drai:Drai',
        'p.ovi:alexander ovechkin',
      ]);
    });

    it('drops a one-word alias that is another player’s first name', () => {
      expect(linked('Igor starts tonight; Leon too')).toEqual(['p.drai:Leon']);
    });
  });
});
