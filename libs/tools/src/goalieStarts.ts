import type { Player } from '@fha/core';
import { isOut } from '@fha/model';
import type { Store } from '@fha/store';
import { dayStatus } from './derive.js';
import { rosLensView } from './valuationLens.js';
import { EVENT_KINDS, GoalieStartingPayload, NewsPayload } from './tools/leagueEvents.js';
import type { LeagueView } from './view.js';

/**
 * Who starts in goal (D-029), from what we already collect, in code (P1):
 *
 * 1. **Yahoo's starting flag** (`starting_status.is_starting`, recorded by the goalie watcher as
 *    `goalie.starting` events): true → confirmed, false → not starting [U-15: matched Ben's own
 *    call on Kuemper, 2026-10-03].
 * 2. **Starter notes** (Rotowire, through Yahoo's notes): a sentence that names the game's day (or
 *    "tonight") and says he will start ("expected to patrol the home crease … Saturday") or sit
 *    ("will back up"). Only notes from the day before or the day itself count.
 * 3. **A teammate's start:** another goalie of the same NHL team confirmed or likely for that day
 *    makes ours the backup.
 *
 * The lineup solver reads `pStart`; the agents read the status with its evidence.
 */
export type GoalieStart = 'confirmed' | 'likely' | 'notStarting' | 'unknown' | 'noGame' | 'out';

export interface GoalieStartSignal {
  playerKey: string;
  name: string;
  nhlTeam: string;
  start: GoalieStart;
  /** Probability he starts, for the lineup solver (U-31). */
  pStart: number;
  /** What the status rests on, newest first: "Yahoo flag 2026-10-03T18:33Z", a note's headline. */
  evidence: string[];
  opponent: string | null;
}

/** U-31: how much a starter note is worth against Yahoo's confirmation. */
export const LIKELY_START_P = 0.9;
const TEAM_GAMES = 82;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? '';
}

/** The New York calendar day of an instant: a 10 pm ET note is that day's, not tomorrow's. */
function nyDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const START =
  /\b(?:will|is expected to|expected to|is set to|set to|is slated to|slated to|is projected to|projected to|is scheduled to|is in line to|gets?|is getting|draws?|will get)\b[^.;]{0,40}?\b(?:start|guard|patrol|defend|man|tend|mind|protect|be between the pipes|the nod|the start|the call)\b/i;
const SIT =
  /\b(?:will (?:back up|serve as (?:the )?backup|sit|get the night off|be the backup)|won't start|will not start|gets? the night off|is expected to back up|expected to back up)\b/i;

export interface NoteVerdict {
  verdict: 'start' | 'sit';
  headline: string;
}

/**
 * A note's verdict for `date`, or undefined. `noteDate` is the note's day; `text` is its headline
 * and body. A sentence counts only when it names the game's weekday (or says tonight on the day).
 */
export function readStarterNote(noteDate: string, text: string, date: string): NoteVerdict | undefined {
  if (noteDate !== date && noteDate !== dayBefore(date)) return undefined;
  const day = weekdayOf(date);
  const headline = text.split(' — ')[0] ?? text;
  const dayRe = new RegExp(`\\b${day}\\b|\\b${day}'s\\b`, 'i');
  const tonight = noteDate === date ? /\btonight\b|\bthis evening\b/i : /$^/;
  // The note's own text, without the advice paragraph (which recaps past games).
  const body = text.split(/\bAdvice:/)[0] ?? text;
  for (const sentence of body.split(/(?<=[.!?])\s+|\s+—\s+/)) {
    if (!dayRe.test(sentence) && !tonight.test(sentence)) continue;
    if (SIT.test(sentence)) return { verdict: 'sit', headline };
    if (START.test(sentence)) return { verdict: 'start', headline };
  }
  return undefined;
}

/** Snapshot news lines are "YYYY-MM-DD headline — body"; events carry their own fields. */
function notesFor(
  view: LeagueView,
  newsEvents: ReadonlyMap<string, { date: string; text: string }[]>,
  key: string,
): { date: string; text: string }[] {
  const fromSnap = (view.snap.news[key] ?? []).flatMap((line) => {
    const m = /^(\d{4}-\d{2}-\d{2}) (.*)$/.exec(line);
    return m === null ? [] : [{ date: m[1] ?? '', text: m[2] ?? '' }];
  });
  return [...(newsEvents.get(key) ?? []), ...fromSnap];
}

interface Flag {
  isStarting: boolean;
  at: string;
}

function readEvents(
  store: Store | undefined,
  userId: string | undefined,
  date: string,
): { flags: Map<string, Flag>; news: Map<string, { date: string; text: string }[]> } {
  const flags = new Map<string, Flag>();
  const news = new Map<string, { date: string; text: string }[]>();
  if (store === undefined || userId === undefined) return { flags, news };
  const since = `${dayBefore(date)}T00:00:00.000Z`;
  for (const e of store.events.recent(userId, since, [EVENT_KINDS.goalieStarting, EVENT_KINDS.news])) {
    if (e.kind === EVENT_KINDS.goalieStarting) {
      const p = GoalieStartingPayload.safeParse(e.payload);
      if (p.success && p.data.date === date) flags.set(p.data.playerKey, { isStarting: p.data.isStarting, at: e.createdAt });
    } else {
      const p = NewsPayload.safeParse(e.payload);
      if (!p.success) continue;
      const noteDate = nyDay(p.data.at === '' ? e.createdAt : p.data.at);
      const text = `${p.data.headline}${p.data.news ? ` — ${p.data.news}` : ''}`;
      news.set(p.data.playerKey, [...(news.get(p.data.playerKey) ?? []), { date: noteDate, text }]);
    }
  }
  return { flags, news };
}

function ownSignal(
  p: Player,
  date: string,
  flags: ReadonlyMap<string, Flag>,
  notes: { date: string; text: string }[],
): { start: 'confirmed' | 'likely' | 'notStarting' | undefined; evidence: string[] } {
  const flag = flags.get(p.playerKey);
  if (flag !== undefined) {
    return {
      start: flag.isStarting ? 'confirmed' : 'notStarting',
      evidence: [`Yahoo flag: ${flag.isStarting ? 'starting' : 'not starting'} (${flag.at.slice(0, 16)}Z)`],
    };
  }
  for (const n of notes) {
    const v = readStarterNote(n.date, n.text, date);
    if (v !== undefined) {
      return {
        start: v.verdict === 'start' ? 'likely' : 'notStarting',
        evidence: [`note ${n.date}: "${v.headline}"`],
      };
    }
  }
  return { start: undefined, evidence: [] };
}

function lensOf(view: LeagueView, store: Store | undefined): LeagueView | undefined {
  if (store === undefined) return undefined;
  try {
    return rosLensView(view, store).view;
  } catch {
    return undefined;
  }
}

/** Every goalie of ours on `date`, with status, evidence and pStart. */
export function goalieStartsFor(
  view: LeagueView,
  store: Store | undefined,
  userId: string | undefined,
  date: string,
  now: string,
): GoalieStartSignal[] {
  const { flags, news } = readEvents(store, userId, date);
  const goaliesOf = (team: string) =>
    view.snap.players.filter((x) => x.positionType === 'G' && x.nhlTeam === team);
  return view
    .roster()
    .entries.filter((e) => e.player.positionType === 'G')
    .map(({ player: p }): GoalieStartSignal => {
      const day = dayStatus(view, p, date, now);
      const base = { playerKey: p.playerKey, name: p.name, nhlTeam: p.nhlTeam, opponent: day.opponent ?? null };
      if (day.opponent === undefined) return { ...base, start: 'noGame', pStart: 0, evidence: [] };
      if (isOut(p.status)) return { ...base, start: 'out', pStart: 0, evidence: [`status ${p.status ?? ''}`] };
      const own = ownSignal(p, date, flags, notesFor(view, news, p.playerKey));
      if (own.start === 'confirmed') return { ...base, start: 'confirmed', pStart: 1, evidence: own.evidence };
      if (own.start === 'notStarting') return { ...base, start: 'notStarting', pStart: 0, evidence: own.evidence };
      // A teammate named the starter: ours is the backup (unless his own note says he starts).
      for (const mate of goaliesOf(p.nhlTeam).filter((x) => x.playerKey !== p.playerKey)) {
        const m = ownSignal(mate, date, flags, notesFor(view, news, mate.playerKey));
        if (m.start === 'confirmed' || (m.start === 'likely' && own.start !== 'likely')) {
          return {
            ...base,
            start: 'notStarting',
            pStart: 0,
            evidence: [`${mate.name} ${m.start === 'confirmed' ? 'confirmed' : 'likely'}: ${m.evidence[0] ?? ''}`],
          };
        }
      }
      if (own.start === 'likely') return { ...base, start: 'likely', pStart: LIKELY_START_P, evidence: own.evidence };
      // His start share on the rest-of-season lens (this season's starts update it), else preseason.
      const gp = (lensOf(view, store)?.projection(p.playerKey) ?? view.projection(p.playerKey))?.gp;
      const share = Math.min(1, (gp ?? TEAM_GAMES / 2) / TEAM_GAMES);
      return { ...base, start: 'unknown', pStart: share, evidence: [`no report yet; his usual start share ${Math.round(share * 100)}%`] };
    });
}

export interface GoalieMinimum {
  min: number;
  /** Appearances so far this week by the goalies now on our roster (NHL game logs). */
  played: number;
  /** Games our goalies' teams still play this week, from today. */
  remaining: number;
  weekStart: string;
  weekEnd: string;
}

/**
 * The league's weekly goalie minimum against our goalies' appearances so far (D-029). [U] Yahoo
 * counts only games played from an active G slot; the game logs count every appearance by a
 * goalie on our roster now, so this is an upper bound when a goalie played from the bench.
 */
export function goalieMinimum(view: LeagueView, store: Store | undefined): GoalieMinimum | undefined {
  const min = view.snap.rules?.minGoalieGames;
  if (min === undefined) return undefined;
  const { start, end } = view.weekOf();
  const goalies = view.roster().entries.filter((e) => e.player.positionType === 'G' && e.slot !== 'IR' && e.slot !== 'IR+');
  let played = 0;
  if (store !== undefined) {
    for (const { player } of goalies) {
      if (player.nhlId === undefined) continue;
      played += store.nhlGames
        .goalieGames(player.nhlId, { from: start, to: view.snap.date })
        .filter((g) => g.gameDate < view.snap.date || g.toiS > 0).length;
    }
  }
  const games = view.gamesBetween(view.snap.date, end);
  const remaining = goalies.reduce((n, { player }) => n + (games.get(player.nhlTeam) ?? 0), 0);
  return { min, played, remaining, weekStart: start, weekEnd: end };
}
