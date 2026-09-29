import { describe, expect, it } from 'vitest';
import { availability } from './availability.js';
import { daysOutFromNote } from './injuryNote.js';

/**
 * The notes are the live Rotowire texts from `fixtures/league/live-2026-09-29.json` (`news`),
 * as the snapshot's news lines carry them.
 */
const NOW = '2026-09-29';
const GAMES_PER_DAY = 82 / 186;

const JARVIS =
  '2026-09-27 Moves to non-roster list — Jarvis (shoulder) was placed on the injured non-roster list Sunday. Advice: Jarvis was initially pegged to miss about 4-6 months after having shoulder surgery in June. However, he believes he could return ahead of schedule after taking to the ice during training camp. Jarvis amassed 32 goals, 66 points, 224 shots on net and 81 hits in 71 games for the Hurricanes during the 2025-26 regular season. (Rotowire.com)';
const GUSTAVSSON =
  '2026-09-28 Moves to injured reserve — Gustavsson (hip) was placed on injured reserve Monday, according to Dylan Loucks of The Hockey News. Advice: Gustavsson is expected to be out until at least early November. He posted a 28-15-6 record with two shutouts, a 2.69 GAA and a .903 save percentage in 50 appearances for Minnesota during the 2025-26 regular season.';
const BEDARD =
  '2026-09-28 Starting on injured non-roster list — Bedard (shoulder) will begin the 2026-27 regular season on the injured non-roster list. Advice: Bedard continues to recover from a shoulder procedure he underwent in early July. The expectation for the 21-year-old superstar is for him to rejoin the team sometime in November, barring any setbacks.';
const DEMKO =
  '2026-09-28 Hopes to return by Christmas — Co-president of hockey operations Henrik Sedin said Monday that he hopes Demko (hip) will be ready to return before Christmas, Kevin Woodley of NHL.com reports. Advice: Demko missed the second half of the 2025-26 season after undergoing hip surgery in January.';
const TERRY =
  '2026-09-28 Placed on injured non-roster list — Terry (hip) shifted to non-roster injured reserve Monday. Advice: Terry is slated to miss a large chunk of the season, as it was announced Sept. 19 that the 29-year-old is expected to be out for another 2-3 months.';
const MAILLOUX =
  '2026-09-28 Facing multi-week absence — General manager Alexander Steen said Monday that Mailloux is slated to be re-evaluated in approximately eight weeks after undergoing a successful procedure to address a hand injury.';
const ZUCKER =
  '2026-09-28 Placed on injured reserve — Zucker (abdomen) was placed on injured reserve by the Sabres on Monday. Advice: General manager Jarmo Kekalainen announced in mid-September that Zucker wouldn\'t be ready for the start of the season while recovering from sports hernia surgery, so his move to injured reserve isn\'t very surprising. Kekalainen said that Zucker could miss "a couple of weeks," so the 34-year-old could be in the mix to return as early as';
const MCAVOY =
  "2026-09-21 Receives whopping 28:35 of ice time Sunday — McAvoy (suspension) logged an even-strength goal on three shots and four PIM in a game-high 28:35 of ice time. Advice: McAvoy is set to serve a six-game suspension to begin the year after slashing the Sabres' Zach Benson.";
const SAMUELSSON =
  '2026-09-28 Shifted to IR — Samuelsson (lower body) was moved to injured reserve by the Sabres on Monday. Advice: Samuelsson should probably be expected to miss the first two games of the season, though it could still be longer.';
const HUBERDEAU =
  "2026-09-28 Lands on IR — Huberdeau (hip) was placed on injured reserve Monday. Advice: Huberdeau missed the final 26 games of the 2025-26 regular season. He won't be available at the beginning of the 2026-27 campaign, and it's unclear when he will be available to return.";

describe('daysOutFromNote — real notes (2026-09-29)', () => {
  it('Jarvis: "4-6 months after shoulder surgery in June" counts from June, not from today', () => {
    // 2026-06-15 + 6 months ≈ 2026-12-15, 77 days after 2026-09-29.
    expect(daysOutFromNote(JARVIS, NOW)).toBe(77);
    // Never "71 games" from his stat line.
    expect(daysOutFromNote(JARVIS)).toBe(Math.round(6 * (365.25 / 12)));
  });

  it('Gustavsson: "until at least early November" → 7 November', () => {
    expect(daysOutFromNote(GUSTAVSSON, NOW)).toBe(39);
    // Without a date anchor the note says nothing usable (the record line is not an absence).
    expect(daysOutFromNote(GUSTAVSSON)).toBeUndefined();
  });

  it('Bedard: "sometime in November" → mid-November; Demko: "before Christmas"', () => {
    expect(daysOutFromNote(BEDARD, NOW)).toBe(47);
    expect(daysOutFromNote(DEMKO, NOW)).toBe(87);
  });

  it('spans in words and ranges: "another 2-3 months", "eight weeks", "a couple of weeks"', () => {
    expect(daysOutFromNote(TERRY, NOW)).toBe(91);
    expect(daysOutFromNote(MAILLOUX, NOW)).toBe(56);
    expect(daysOutFromNote(ZUCKER, NOW)).toBe(14);
    expect(daysOutFromNote('Out four to six weeks with a sprain', NOW)).toBe(42);
  });

  it('game counts need an absence word: a suspension, "miss the first two games"', () => {
    expect(daysOutFromNote(MCAVOY, NOW)).toBe(Math.ceil(6 / GAMES_PER_DAY));
    expect(daysOutFromNote(SAMUELSSON, NOW)).toBe(Math.ceil(2 / GAMES_PER_DAY));
    // "missed the final 26 games" of last season is history, not an absence.
    expect(daysOutFromNote(HUBERDEAU, NOW)).toBeUndefined();
  });

  it('feeds availability: Jarvis IR-NR is out ~77 days from the note, not the 25-day default', () => {
    const a = availability({ status: 'IR-NR', injuryNote: JARVIS, now: NOW });
    expect(a.source).toBe('note');
    expect(a.daysOut).toBe(77);
    expect(a.expectedReturn).toBe('2026-12-15');
  });

  it('a date already past is 0 days, not negative', () => {
    expect(daysOutFromNote('Out until early October', '2026-10-20')).toBe(0);
  });
});
