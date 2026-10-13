import type { PlayerFormView, SeasonForecastView } from '@fha/api';
import type { Store } from '@fha/store';
import { forecastPlayer, forecastSeason, formFor, historyFor, type LeagueView } from '@fha/tools';

/**
 * The player sheet's form section and the league's season forecast (D-025): every number from
 * `libs/tools` / `libs/model`, the same functions the agents call (P1).
 */
const SKATER_SHOWN = ['G', 'A', 'P', 'PPP', 'SOG', 'HIT', 'BLK'];
const SERIES_GAMES = 40;
const ROLL = 10;

export function playerFormView(view: LeagueView, store: Store, playerKey: string): PlayerFormView {
  const asOf = view.snap.date;
  const f = formFor(view, store, playerKey);
  const forecast = [7, 14].flatMap((days) => {
    const x = forecastPlayer(view, store, playerKey, days);
    if (x === undefined) return [];
    return [
      {
        days,
        scheduled: x.scheduled,
        expectedGames: x.expectedGames,
        totals: x.totals,
        lens: x.lens,
        goalie:
          x.goalie === undefined
            ? null
            : { svPct: x.goalie.svPct, gaa: x.goalie.gaa, startShare: x.goalie.startShare },
      },
    ];
  });
  if (f === undefined) {
    return {
      playerKey,
      kind: 'none',
      asOf,
      trends: [],
      windows: [],
      series: [],
      lens: null,
      forecast,
      games: [],
    };
  }
  const trends = f.form.trends.map((t) => ({
    cat: t.cat,
    recent: t.recent,
    baseline: t.baseline,
    z: t.z,
    nRecent: t.nRecent,
    label: t.label,
  }));
  const h = historyFor(view, store, playerKey, { to: asOf, last: SERIES_GAMES + ROLL - 1 });
  if (f.kind === 'skater') {
    const games = h?.kind === 'skater' ? [...h.games].reverse() : [];
    const field: Record<string, keyof (typeof games)[number]> = {
      G: 'g',
      A: 'a',
      P: 'pts',
      PPP: 'ppp',
      SOG: 'sog',
      HIT: 'hit',
      BLK: 'blk',
    };
    return {
      playerKey,
      kind: 'skater',
      asOf,
      trends,
      windows: f.form.windows.map((w) => ({
        label: w.label,
        gp: w.gp,
        values: {
          ...Object.fromEntries(SKATER_SHOWN.map((c) => [c, w.perGame[c] ?? 0])),
          TOI: w.toiPerGameMin,
        },
      })),
      series: SKATER_SHOWN.map((cat) => ({
        cat,
        points: rolling(
          games.map((g) => Number(g[field[cat] ?? 'g'])),
          ROLL,
        ),
        baseline: f.form.trends.find((t) => t.cat === cat)?.baseline ?? 0,
      })),
      lens: {
        inSeason: pick(f.inSeason.perGame, SKATER_SHOWN),
        preseason: pick(f.preseason ?? {}, SKATER_SHOWN),
        gpCurrent: f.inSeason.gpCurrent,
        weightCurrent: f.inSeason.weightCurrent,
      },
      forecast,
      games: (h?.kind === 'skater' ? h.games : []).slice(0, 20).map((g) => ({
        date: g.gameDate,
        opponent: g.opponent,
        home: g.home,
        line: {
          G: g.g,
          A: g.a,
          '+/-': g.pm,
          PPP: g.ppp,
          SOG: g.sog,
          HIT: g.hit,
          BLK: g.blk,
          TOI: g.toiS / 60,
        },
      })),
    };
  }
  const games = h?.kind === 'goalie' ? h.games : [];
  const chrono = [...games].reverse();
  return {
    playerKey,
    kind: 'goalie',
    asOf,
    trends,
    windows: f.form.windows.map((w) => ({
      label: w.label,
      gp: w.gp,
      values: { GS: w.starts, W: w.wins, 'SV%': w.svPct, GAA: w.gaa },
    })),
    series: [
      {
        cat: 'SV%',
        points: rollingRatio(
          chrono.map((g) => [g.sv, g.sa]),
          ROLL,
        ),
        baseline: f.form.trends.find((t) => t.cat === 'SV%')?.baseline ?? 0,
      },
      {
        cat: 'GAA',
        points: rollingRatio(
          chrono.map((g) => [g.ga * 60, g.toiS / 60]),
          ROLL,
        ),
        baseline: f.form.trends.find((t) => t.cat === 'GAA')?.baseline ?? 0,
      },
    ],
    lens: null,
    forecast,
    games: games.slice(0, 20).map((g) => ({
      date: g.gameDate,
      opponent: g.opponent,
      home: g.home,
      line: { GS: g.started ? 1 : 0, W: g.w, SV: g.sv, SA: g.sa, GA: g.ga, MIN: g.toiS / 60 },
    })),
  };
}

/** Rolling mean of the last `n` values at each point once `n` are available. */
export function rolling(values: readonly number[], n: number): number[] {
  const out: number[] = [];
  for (let i = n - 1; i < values.length; i++) {
    out.push(values.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  }
  return out;
}

/** Rolling Σnum / Σden (rates rebuilt from volume, never averaged). */
export function rollingRatio(pairs: readonly [number, number][], n: number): number[] {
  const out: number[] = [];
  for (let i = n - 1; i < pairs.length; i++) {
    const w = pairs.slice(i - n + 1, i + 1);
    const den = w.reduce((a, [, d]) => a + d, 0);
    out.push(den > 0 ? w.reduce((a, [x]) => a + x, 0) / den : 0);
  }
  return out;
}

function pick(
  r: Readonly<Record<string, number>>,
  keys: readonly string[],
): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, r[k] ?? 0]));
}

/** Hot and cold categories over his last 10 games, or null without game history. */
export function formFlags(
  view: LeagueView,
  store: Store,
  playerKey: string,
): { hot: string[]; cold: string[] } | null {
  const f = formFor(view, store, playerKey);
  if (f === undefined) return null;
  const pick = (l: string) => f.form.trends.filter((t) => t.label === l).map((t) => t.cat);
  return { hot: pick('hot'), cold: pick('cold') };
}

export function seasonForecastView(view: LeagueView, store: Store): SeasonForecastView {
  const s = forecastSeason(view, store);
  const us = s.teams.find((t) => t.teamKey === view.teamKey);
  return {
    lens: s.lens,
    categories: s.categories.length,
    teams: s.teams.map((t) => ({
      teamKey: t.teamKey,
      name: t.name,
      us: t.teamKey === view.teamKey,
      expectedCatsWon: t.expectedCatsWon,
      pWinWeek: t.pWinWeek,
      vsUs: us?.vs.find((v) => v.teamKey === t.teamKey)?.pWin ?? null,
    })),
  };
}
