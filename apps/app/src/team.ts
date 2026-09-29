import type { Player } from '@fha/core';
import { categoryValue, rosterHealth } from '@fha/model';
import {
  availabilityOf,
  currentMatchup,
  dayStatus,
  scoringCategories,
  weekBounds,
  type LeagueView,
} from '@fha/tools';
import type { LeagueState } from './league.js';
import { newYorkDate } from './league.js';

/**
 * The Team page: today's roster with availability, games this week, the roster health check
 * and the week's category outlook. Every number comes from `libs/model` and `libs/tools`, the
 * same code the agents read (P1): the page and the agents cannot disagree.
 */
export interface TeamView {
  asOf: string;
  source: 'yahoo' | 'mock';
  teamName: string;
  week: number;
  opponent: string | null;
  roster: {
    playerKey: string;
    name: string;
    nhlTeam: string;
    positions: string;
    slot: string;
    availability: { label: string; status: string | null; playProb: number; note: string | null };
    gamesThisWeek: number;
    gameToday: string | null;
    value: number | null;
  }[];
  health: string[];
  categories: { cat: string; us: number | null; them: number | null; winProb: number | null }[];
}

/** The newest note on a player: the status line if it names an injury, else the first note. */
function noteFor(view: LeagueView, p: Player): string | null {
  const lines = view.snap.news[p.playerKey] ?? [];
  return lines[0] ?? null;
}

function gameToday(view: LeagueView, p: Player, date: string, now: string): string | null {
  const g = dayStatus(view, p, date, now);
  if (g.opponent === undefined || g.startTimeUtc === undefined) return null;
  const time = new Date(g.startTimeUtc).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `vs ${g.opponent} ${time} ET${g.locked ? ' (locked)' : ''}`;
}

export function teamView(league: LeagueState, now: Date): TeamView {
  const { view } = league;
  const nowIso = now.toISOString();
  const today = view.snap.date > newYorkDate(now) ? view.snap.date : newYorkDate(now);
  const games = view.gamesBetween(today, weekBounds(view.snap.date).end);
  const entries = view.roster().entries;
  const roster = entries.map(({ player: p, slot }) => {
    const a = availabilityOf(view, p);
    return {
      playerKey: p.playerKey,
      name: p.name,
      nhlTeam: p.nhlTeam,
      positions: p.eligible.join(','),
      slot,
      availability: {
        label: a.label,
        status: p.status ?? null,
        playProb: a.playProb,
        note: a.source === 'healthy' ? null : noteFor(view, p),
      },
      gamesThisWeek: games.get(p.nhlTeam) ?? 0,
      gameToday: gameToday(view, p, today, nowIso),
      value: view.valuation(p.playerKey)?.value ?? null,
    };
  });
  const health = rosterHealth({
    entries: entries.map(({ player: p, slot }) => ({
      playerKey: p.playerKey,
      name: p.name,
      eligible: p.eligible,
      status: p.status,
      slot,
      value: view.valuation(p.playerKey)?.perGameValue ?? 0,
      // Unknown without a schedule for the day: never read as "no game" (see rosterHealth).
      ...(view.snap.schedule.some((d) => d.date === today)
        ? { hasGame: dayStatus(view, p, today, nowIso).opponent !== undefined }
        : {}),
      label: availabilityOf(view, p).label,
    })),
    slots: view.settings.rosterSlots,
  });
  return {
    asOf: view.snap.recordedAt,
    source: view.snap.source,
    teamName: league.teamName ?? view.teamKey,
    week: view.snap.week,
    roster,
    health: health.summary,
    ...matchupPart(view),
  };
}

function matchupPart(view: LeagueView): Pick<TeamView, 'opponent' | 'categories'> {
  const cats = scoringCategories(view.settings);
  let m: ReturnType<typeof currentMatchup>;
  try {
    m = currentMatchup(view);
  } catch {
    m = undefined; // A matchup that cannot be projected leaves the rest of the page (P9).
  }
  if (m === undefined) {
    return {
      opponent: null,
      categories: cats.map((cat) => ({ cat, us: null, them: null, winProb: null })),
    };
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    opponent: m.opponent.name,
    categories: cats.map((cat) => ({
      cat,
      us: round(categoryValue(m.us, cat)),
      them: round(categoryValue(m.them, cat)),
      winProb: m.plan.probabilities[cat] ?? null,
    })),
  };
}
