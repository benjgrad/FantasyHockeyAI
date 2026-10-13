import { normalizeName } from './playersList.js';

/**
 * Other names chat may use for a player, sent with the mention index so the client can link
 * them (D-030). Two sources, both hand-maintained:
 *
 * - `NICKNAMES`: what fans and writers call him, keyed by the name as Yahoo spells it. A player
 *   not in the league index is simply never matched. An alias two indexed players would share
 *   links to neither (the client's rule), so a nickname can never pick the wrong one.
 * - `FIRST_NAME_FORMS`: short and long forms of a first name ("Nate MacKinnon", "Alexander
 *   Ovechkin"), always with the surname, so they are as safe as the full name.
 */
const NICKNAMES: Readonly<Record<string, readonly string[]>> = {
  'Alex Ovechkin': ['Ovi', 'Ovie', 'The Great 8'],
  'Sidney Crosby': ['Sid', 'Sid the Kid'],
  'Connor McDavid': ['McJesus'],
  'Leon Draisaitl': ['Leon', 'Drai'],
  'Nathan MacKinnon': ['Mack', 'MacK'],
  'Nikita Kucherov': ['Kuch'],
  'Andrei Vasilevskiy': ['Vasy', 'Vasi', 'Big Cat'],
  'Auston Matthews': ['Papi'],
  'Mitch Marner': ['Mitchy'],
  'David Pastrnak': ['Pasta'],
  'Ryan Nugent-Hopkins': ['Nuge', 'RNH'],
  'Evgeni Malkin': ['Geno'],
  'Kirill Kaprizov': ['Kap', 'Kirill the Thrill'],
  'Matthew Tkachuk': ['Chucky', 'Matty T'],
  'Igor Shesterkin': ['Shesty', 'Igor'],
  'Connor Hellebuyck': ['Bucky', 'Helle'],
  'Juuse Saros': ['Juice'],
  'Ilya Sorokin': ['Soro'],
  'Jeremy Swayman': ['Sway'],
  'Mikko Rantanen': ['Moose'],
  'Elias Pettersson': ['Petey', 'EP40'],
  'Steven Stamkos': ['Stammer'],
  'Patrick Kane': ['Kaner'],
  'Victor Hedman': ['Heddy'],
  'Tage Thompson': ['Tage'],
  'Erik Karlsson': ['EK65'],
  'William Karlsson': ['Wild Bill'],
  'Moritz Seider': ['Mo Seider'],
  'J.T. Miller': ['JT Miller'],
  'Jake Guentzel': ['Guentz'],
  'Mark Scheifele': ['Scheif'],
  'Artemi Panarin': ['Bread', 'Breadman', 'Bread Man'],
  'Sergei Bobrovsky': ['Bob', 'Bobby Lou'],
  'Andrei Svechnikov': ['Svech'],
  'Aleksander Barkov': ['Barky'],
  'Mathew Barzal': ['Barzy'],
  'Jason Robertson': ['Robo'],
  'Miro Heiskanen': ['Miro'],
  'Macklin Celebrini': ['Macklin'],
  'Jordan Binnington': ['Binner'],
  'Thatcher Demko': ['Thatcher'],
  'Jake Oettinger': ['Otter'],
  'Juraj Slafkovský': ['Slaf'],
  'William Nylander': ['Willy Styles'],
  'Morgan Rielly': ['Mo Rielly'],
  'Nico Hischier': ['Nico'],
  'Brad Marchand': ['Marchy', 'The Rat'],
  'Gabriel Landeskog': ['Landy'],
  'Evan Bouchard': ['Bouch'],
  'Joel Eriksson Ek': ['Eriksson Ek', 'JEEK'],
  'Pierre-Luc Dubois': ['PLD'],
  "Ryan O'Reilly": ['ROR'],
  'Andrei Kuzmenko': ['Kuzy'],
  'Dougie Hamilton': ['Dougie'],
  'MacKenzie Weegar': ['Weegs'],
  'Matt Duchene': ['Dutchy'],
  'Quinn Hughes': ['Q Hughes'],
  'Cale Makar': ['Cale'],
  'Rasmus Dahlin': ['Dahls'],
  'Lane Hutson': ['L Hutson'],
};

/** Each group is one first name's forms; a player gets the others with his surname. */
const FIRST_NAME_FORMS: readonly (readonly string[])[] = [
  ['alex', 'alexander', 'aleksander', 'alexandre', 'sasha'],
  ['matt', 'matthew', 'mathew', 'matty'],
  ['mitch', 'mitchell'],
  ['nate', 'nathan'],
  ['mike', 'michael'],
  ['nick', 'nicholas', 'nicolas'],
  ['jake', 'jacob'],
  ['tim', 'timothy'],
  ['zach', 'zachary', 'zack'],
  ['will', 'william', 'willy'],
  ['joe', 'joseph'],
  ['josh', 'joshua'],
  ['chris', 'christopher'],
  ['dan', 'daniel', 'danny'],
  ['tom', 'thomas', 'tommy'],
  ['rob', 'robert', 'bobby'],
  ['sam', 'samuel'],
  ['ben', 'benjamin'],
  ['tony', 'anthony'],
  ['jon', 'jonathan', 'johnny'],
  ['pat', 'patrick'],
  ['andy', 'andrew', 'drew'],
  ['cam', 'cameron'],
  ['gabe', 'gabriel'],
  ['max', 'maxim', 'maxime', 'maximilian'],
  ['evgeni', 'evgeny', 'evgenii'],
  ['dmitri', 'dmitry'],
  ['steve', 'steven', 'stephen'],
  ['ed', 'edward', 'eddie'],
  ['fred', 'frederick', 'freddie'],
  ['jeff', 'jeffrey'],
  ['greg', 'gregory'],
];

const NICKNAMES_BY_NAME = new Map(
  Object.entries(NICKNAMES).map(([name, aliases]) => [normalizeName(name), aliases]),
);
const FORMS_OF = new Map(FIRST_NAME_FORMS.flatMap((g) => g.map((f) => [f, g] as const)));

/** Every other name `name` goes by, excluding the name itself. */
export function aliasesFor(name: string): string[] {
  const out = [...(NICKNAMES_BY_NAME.get(normalizeName(name)) ?? [])];
  const [firstName, ...rest] = name.trim().split(/\s+/);
  const forms = FORMS_OF.get(normalizeName(firstName ?? ''));
  if (forms !== undefined && rest.length > 0) {
    const own = normalizeName(firstName ?? '');
    for (const f of forms) {
      if (f !== own) out.push(`${f[0]?.toUpperCase() ?? ''}${f.slice(1)} ${rest.join(' ')}`);
    }
  }
  return out;
}
