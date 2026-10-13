/**
 * Finds player and team names in chat text, so each can open its sheet (P3: a name links only
 * when it resolves to exactly one key in the league index; a name two players share links to
 * neither). Matching ignores case, accents and curly-vs-straight apostrophes, and needs a word
 * boundary on both sides. A player is found by his full name, any alias the server sends
 * (nicknames, first-name forms: "Ovi", "Nate MacKinnon"), or his surname alone. One-word forms
 * link only when capitalised ("Pasta", not "pasta"). A surname alone links when no other indexed
 * player has it and it is neither a first name nor a common word ("Connor", "Point"); inside a
 * message that names a player in full, his surname links even when shared ("Quinn Hughes …
 * Hughes"), unless two players named there share it.
 */
export interface Mention {
  kind: 'player' | 'team';
  key: string;
}
export type Segment = string | { text: string; mention: Mention };

export interface NameIndex {
  players: readonly { playerKey: string; name: string; aliases?: readonly string[] }[];
  teams: readonly { teamKey: string; name: string }[];
}

export interface Matcher {
  /** Folded alias → mention; null when the alias names more than one. */
  readonly byAlias: ReadonlyMap<string, Mention | null>;
  /** Aliases that link only when written capitalised (one-word player forms). */
  readonly proper: ReadonlySet<string>;
  readonly pattern: RegExp | null;
  /** playerKey → folded surname, for players whose name has more than one word. */
  readonly surname: ReadonlyMap<string, string>;
  /** Surnames safe to link on their own anywhere: one player's, not a first name or a word. */
  readonly loneSurname: ReadonlyMap<string, Mention>;
  readonly lonePattern: RegExp | null;
}

const MIN_ALIAS = 3;
const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv']);
/**
 * Surnames that are ordinary words or trophies in a hockey chat ("Point", "Hart Trophy"): they
 * link on their own only inside a message that names the player in full.
 */
const COMMON_WORDS = new Set(
  (
    'point power hill hall knight fox wolf stone nurse rust hart norris lee king young brown ' +
    'white green black gray grey hunt cross rose page may love wood field bird best hope mark ' +
    'will rich long short little strong fast free sharp bean price hunter mercer cash'
  ).split(' '),
);

export function buildMatcher(idx: NameIndex): Matcher {
  const byAlias = new Map<string, Mention | null>();
  const proper = new Set<string>();
  const add = (alias: string, m: Mention) => {
    const cur = byAlias.get(alias);
    if (cur === undefined) byAlias.set(alias, m);
    else if (cur !== null && (cur.kind !== m.kind || cur.key !== m.key)) byAlias.set(alias, null);
  };
  for (const t of idx.teams) {
    for (const a of aliasesOf(t.name)) add(a, { kind: 'team', key: t.teamKey });
  }
  for (const p of idx.players) {
    const m: Mention = { kind: 'player', key: p.playerKey };
    for (const a of [p.name, ...(p.aliases ?? [])].flatMap(aliasesOf)) {
      add(a, m);
      if (!a.includes(' ')) proper.add(a);
    }
  }
  blockOthersFirstNames(idx, proper, byAlias);
  const surname = new Map<string, string>();
  for (const p of idx.players) {
    const s = surnameOf(fold(p.name));
    if (s !== undefined) surname.set(p.playerKey, s);
  }
  const loneSurname = loneSurnames(idx, surname, byAlias);
  return {
    byAlias,
    proper,
    pattern: alternation([...byAlias].filter(([, m]) => m !== null).map(([a]) => a)),
    surname,
    loneSurname,
    lonePattern: alternation([...loneSurname.keys()]),
  };
}

/** A one-word alias that is another player's first name ("Igor") names neither. */
function blockOthersFirstNames(
  idx: NameIndex,
  proper: ReadonlySet<string>,
  byAlias: Map<string, Mention | null>,
): void {
  for (const p of idx.players) {
    const first = fold(p.name).split(/\s+/)[0] ?? '';
    const m = proper.has(first) ? byAlias.get(first) : undefined;
    if (m != null && m.key !== p.playerKey) byAlias.set(first, null);
  }
}

function loneSurnames(
  idx: NameIndex,
  surname: ReadonlyMap<string, string>,
  byAlias: ReadonlyMap<string, Mention | null>,
): Map<string, Mention> {
  const firstNames = new Set(idx.players.map((p) => fold(p.name).split(/\s+/)[0] ?? ''));
  const owners = new Map<string, string[]>();
  for (const [key, s] of surname) owners.set(s, [...(owners.get(s) ?? []), key]);
  const out = new Map<string, Mention>();
  for (const [s, keys] of owners) {
    const [key] = keys;
    if (keys.length !== 1 || key === undefined) continue;
    if (firstNames.has(s) || COMMON_WORDS.has(s) || byAlias.has(s)) continue;
    out.set(s, { kind: 'player', key });
  }
  return out;
}

/**
 * Splits one message's text runs (in reading order) into plain text and mentions. Runs are
 * matched together so a surname in one run can lean on a full name in another.
 */
export function findMentions(runs: readonly string[], m: Matcher): Segment[][] {
  const first = runs.map((r) =>
    split(r, m.pattern, (a, raw) =>
      m.proper.has(a) && !isCapitalized(raw) ? undefined : (m.byAlias.get(a) ?? undefined),
    ),
  );
  const named = namedSurnames(first.flat(), m);
  const surnames = new Map<string, Mention | null>([...m.loneSurname, ...named]);
  const pattern =
    named.size === 0
      ? m.lonePattern
      : alternation([...surnames].filter(([, x]) => x !== null).map(([s]) => s));
  if (pattern === null) return first;
  return first.map((segs) =>
    segs.flatMap((seg) =>
      typeof seg === 'string'
        ? split(seg, pattern, (a, raw) =>
            isCapitalized(raw) ? (surnames.get(a) ?? undefined) : undefined,
          )
        : [seg],
    ),
  );
}

/** Surnames of the players a message names in full; null where two of them share one. */
function namedSurnames(segs: readonly Segment[], m: Matcher): Map<string, Mention | null> {
  const named = new Map<string, Mention | null>();
  for (const seg of segs) {
    if (typeof seg === 'string' || seg.mention.kind !== 'player') continue;
    const s = m.surname.get(seg.mention.key);
    if (s === undefined || m.byAlias.has(s)) continue;
    const cur = named.get(s);
    const same = cur === undefined || (cur !== null && cur.key === seg.mention.key);
    named.set(s, same ? seg.mention : null);
  }
  return named;
}

function split(
  text: string,
  pattern: RegExp | null,
  resolve: (alias: string, raw: string) => Mention | undefined,
): Segment[] {
  if (pattern === null || text === '') return [text];
  const { folded, starts } = foldWithOffsets(text);
  const out: Segment[] = [];
  let at = 0;
  for (const hit of folded.matchAll(pattern)) {
    const from = starts[hit.index] ?? text.length;
    const to = starts[hit.index + hit[0].length] ?? text.length;
    const mention = resolve(hit[0].replace(/\s+/g, ' '), text.slice(from, to));
    if (mention === undefined) continue;
    if (from > at) out.push(text.slice(at, from));
    out.push({ text: text.slice(from, to), mention });
    at = to;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** A surname alone links only as a proper noun: "Power" after Owen Power, not "power play". */
function isCapitalized(raw: string): boolean {
  const c = raw.charAt(0);
  return c !== c.toLowerCase();
}

/** Case-, accent- and apostrophe-insensitive form of a name or a run of text. */
export function fold(s: string): string {
  return foldWithOffsets(s).folded;
}

function foldChar(ch: string): string {
  return ch
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'");
}

/** `starts[i]`: where folded char i came from in `text`; one extra entry for the end. */
function foldWithOffsets(text: string): { folded: string; starts: number[] } {
  let folded = '';
  const starts: number[] = [];
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
    const f = foldChar(ch);
    folded += f;
    for (let k = 0; k < f.length; k++) starts.push(i);
    i += ch.length;
  }
  starts.push(text.length);
  return { folded, starts };
}

/** The name as written, and without leading/trailing emoji or punctuation ("apple seider 🧃"). */
function aliasesOf(name: string): string[] {
  const full = fold(name).replace(/\s+/g, ' ').trim();
  const bare = full.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
  return [...new Set([full, bare])].filter((a) => a.length >= MIN_ALIAS && /\p{L}/u.test(a));
}

function surnameOf(folded: string): string | undefined {
  const words = folded.split(/\s+/).filter((w) => w !== '');
  while (words.length > 2 && SUFFIXES.has(words[words.length - 1] ?? '')) words.pop();
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return last !== undefined && last.length >= MIN_ALIAS ? last : undefined;
}

/** One regex over every alias, longest first, bounded so "Aho" never matches inside "Ahonen". */
function alternation(aliases: readonly string[]): RegExp | null {
  if (aliases.length === 0) return null;
  const body = [...aliases]
    .sort((a, b) => b.length - a.length)
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
    .join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'gu');
}
