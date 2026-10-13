import { z } from 'zod';
import type { ToolResult } from '@fha/llm';
import { categoryValue } from '@fha/model';
import { defineTool, fail, ok } from '../context.js';
import { fmt, scoringCategories, table } from '../derive.js';
import { forecastMatchup, forecastPlayer, forecastSeason } from '../forecast.js';
import { formFor, historyFor } from '../history.js';
import { resolvePlayers } from '../resolve.js';

/**
 * Game-level history, form and forecasts for the agents (D-025). Every number is computed in
 * code from stored game rows (P1); the model reads them and decides, it never calculates.
 */

export const getPlayerGames = defineTool({
  name: 'getPlayerGames',
  description:
    "A player's game log, newest first: date, opponent, and every category for each game (goalies: decision, saves, shots against, goals against, minutes). Covers this season and the three before it. Use it to look at the games behind a trend; getPlayerForm already summarises them.",
  input: z.object({
    playerKey: z.string(),
    last: z.number().int().min(1).max(40).default(15),
    season: z.string().regex(/^\d{8}$/).optional().describe('e.g. 20252026'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    const r = resolvePlayers(ctx.view, [input.playerKey]);
    if (!r.ok) return Promise.resolve(fail(r.error));
    const p = r.value[0];
    if (p === undefined) return Promise.resolve(fail('Give one playerKey from another tool.'));
    const h = historyFor(ctx.view, ctx.store, p.playerKey, {
      last: input.last,
      ...(input.season === undefined ? {} : { season: input.season }),
      ...(input.from === undefined ? {} : { from: input.from }),
      to: input.to ?? ctx.view.snap.date,
    });
    if (h === undefined) {
      return Promise.resolve(fail(`${p.name} has no NHL game history mapped. Use getPlayers instead.`, false));
    }
    if (h.games.length === 0) {
      return Promise.resolve(ok({ kind: h.kind, games: h.games as unknown[] }, `${p.name}: no games in that range.`));
    }
    const vs = (g: { home: boolean; opponent: string }) => `${g.home ? 'vs' : '@'} ${g.opponent}`;
    const summary =
      h.kind === 'skater'
        ? `${p.name}, last ${h.games.length} games:\n${table(
            ['date', 'opp', 'G', 'A', '+/-', 'PIM', 'PPP', 'SHP', 'GWG', 'SOG', 'HIT', 'BLK', 'FW', 'TOI'],
            h.games.map((g) => [g.gameDate, vs(g), g.g, g.a, g.pm, g.pim, g.ppp, g.shp, g.gwg, g.sog, g.hit, g.blk, g.fow, fmt(g.toiS / 60, 1)].map(String)),
          )}`
        : `${p.name}, last ${h.games.length} games:\n${table(
            ['date', 'opp', 'GS', 'dec', 'SV', 'SA', 'GA', 'SV%', 'MIN'],
            h.games.map((g) => [g.gameDate, vs(g), g.started ? '1' : '0', g.w ? 'W' : g.l ? 'L' : g.otl ? 'OTL' : '-', String(g.sv), String(g.sa), String(g.ga), g.sa > 0 ? fmt(g.sv / g.sa, 3) : '-', fmt(g.toiS / 60, 0)]),
          )}`;
    return Promise.resolve(ok({ kind: h.kind, games: h.games as unknown[] }, summary));
  },
});

export const getPlayerForm = defineTool({
  name: 'getPlayerForm',
  description:
    "Recent form, computed from game logs: per-game rates over the last 5/10/20 games, the last 7/14/30 days, this season and each past season; per category a trend (last 10 games vs the 82 before, with a z-score and a label: hot, cold, steady, too few games, too rare to tell); ice time trend (goalies: starts); and, for skaters, the rest-of-season projection (preseason projection updated by this season's games) next to the preseason one. Labels already account for sample size; don't relabel a 'steady' as hot.",
  input: z.object({ playerKeys: z.array(z.string()).min(1).max(8) }),
  risk: 'read',
  execute: (input, ctx) => {
    const r = resolvePlayers(ctx.view, input.playerKeys);
    if (!r.ok) return Promise.resolve(fail(r.error));
    const blocks: string[] = [];
    const data: unknown[] = [];
    for (const p of r.value) {
      const f = formFor(ctx.view, ctx.store, p.playerKey);
      if (f === undefined) {
        blocks.push(`${p.name} (${p.playerKey}): no NHL game history mapped.`);
        continue;
      }
      data.push({ playerKey: p.playerKey, ...f });
      const trends = f.form.trends
        .filter((t) => t.label === 'hot' || t.label === 'cold')
        .map((t) => `${t.cat} ${t.label} (${fmt(t.recent, 2)} vs ${fmt(t.baseline, 2)}, z ${fmt(t.z, 1)}, ${t.nRecent} games)`);
      const lines = [`${p.name} (${p.playerKey}):`, `  trends: ${trends.length === 0 ? 'nothing beyond noise' : trends.join('; ')}`];
      if (f.kind === 'skater') {
        const w = f.form.windows;
        const rate = (label: string, cat: string) => w.find((x) => x.label === label)?.perGame[cat];
        const cats = ['G', 'A', 'PPP', 'SOG', 'HIT'];
        lines.push(
          `  per game: ${cats.map((c) => `${c} last10 ${fmt(rate('last 10 games', c) ?? 0, 2)} / season ${fmt(w.find((x) => x.label.startsWith('season'))?.perGame[c] ?? 0, 2)}`).join(', ')}`,
          `  ice time: ${fmt(f.form.usage.toiRecentMin, 1)} min last 10 vs ${fmt(f.form.usage.toiBaselineMin, 1)} before (${f.form.usage.toiChangeMin >= 0 ? '+' : ''}${fmt(f.form.usage.toiChangeMin, 1)})`,
          `  projection per game, rest-of-season vs preseason: ${cats.map((c) => `${c} ${fmt(f.inSeason.perGame[c] ?? 0, 2)} vs ${fmt(f.preseason?.[c] ?? 0, 2)}`).join(', ')} (this season ${f.inSeason.gpCurrent} GP, weight on this season ${fmt(f.inSeason.weightCurrent, 2)}, the preseason projection carries the rest)`,
        );
      } else {
        const season = f.form.windows.find((x) => x.label.startsWith('season'));
        const last10 = f.form.windows.find((x) => x.label === 'last 10 games');
        lines.push(
          `  last 10: ${last10?.starts ?? 0} starts, SV% ${fmt(last10?.svPct ?? 0, 3)}, GAA ${fmt(last10?.gaa ?? 0, 2)}; this season ${season?.gp ?? 0} GP; starts in the last 14 days ${f.form.usage.startsLast14Days}`,
        );
      }
      blocks.push(lines.join('\n'));
    }
    return Promise.resolve(ok({ players: data }, blocks.join('\n')));
  },
});

export const getForecast = defineTool({
  name: 'getForecast',
  description:
    "Forecasts computed by code, each naming its lens. kind 'matchup': this week's final category scores and win chances on the in-season lens (score so far plus projected unplayed games), next to the preseason lens, and P(win the week). kind 'players': each player's expected category totals over the next `days` days (his team's games × his share × availability). kind 'season': every team's typical week on the in-season lens, played against every other: expected categories won and P(win a week).",
  input: z.object({
    kind: z.enum(['matchup', 'players', 'season']),
    playerKeys: z.array(z.string()).max(12).optional(),
    days: z.number().int().min(1).max(14).default(7),
  }),
  risk: 'read',
  execute: (input, ctx): Promise<ToolResult<Record<string, unknown>>> => {
    const { view, store } = ctx;
    const cats = scoringCategories(view.settings);
    if (input.kind === 'matchup') {
      const f = forecastMatchup(view, store);
      if (f === undefined) return Promise.resolve(fail('No opponent is known this week.', false));
      const pre = f.preseason;
      const rows = cats.map((c) => [
        c,
        fmt(categoryValue(f.matchup.us, c), 2),
        fmt(categoryValue(f.matchup.them, c), 2),
        fmt(f.matchup.plan.probabilities[c] ?? 0.5),
        pre === undefined ? '-' : fmt(pre.plan.probabilities[c] ?? 0.5),
      ]);
      const summary = [
        `This week vs ${f.matchup.opponent.name}, ${f.lens}.`,
        f.matchup.banked === undefined ? 'No live scoreboard: projection only.' : `Includes Yahoo's score as of ${f.matchup.banked.asOf}.`,
        table(['cat', 'us final', 'them final', 'P(win)', 'P(win) preseason'], rows),
        `Expected categories won ${fmt(f.matchup.plan.expectedWon)} of ${cats.length}; P(win the week) ${fmt(f.pWinMatchup)}.`,
      ].join('\n');
      return Promise.resolve(ok({ lens: f.lens, pWinMatchup: f.pWinMatchup, expectedWon: f.matchup.plan.expectedWon, probabilities: f.matchup.plan.probabilities }, summary));
    }
    if (input.kind === 'players') {
      const keys = input.playerKeys ?? view.roster().entries.map((e) => e.player.playerKey);
      const r = resolvePlayers(view, keys);
      if (!r.ok) return Promise.resolve(fail(r.error));
      const out = r.value.flatMap((p) => forecastPlayer(view, store, p.playerKey, input.days ?? 7) ?? []);
      const through = out[0]?.scheduleThrough;
      const shown = ['G', 'A', 'PPP', 'SOG', 'HIT'];
      const summary = [
        `Next ${input.days ?? 7} days from ${view.snap.date}${through !== undefined && out[0] !== undefined && through < out[0].to ? ` (schedule known only through ${through})` : ''}:`,
        table(
          ['player', 'games', 'exp. GP', ...shown, 'W', 'SV%', 'GAA', 'lens'],
          out.map((f) => [
            f.name,
            String(f.scheduled),
            fmt(f.expectedGames, 1),
            ...shown.map((c) => (f.goalie ? '-' : fmt(f.totals[c] ?? 0, 1))),
            f.goalie ? fmt(f.totals['W'] ?? 0, 1) : '-',
            f.goalie ? fmt(f.goalie.svPct, 3) : '-',
            f.goalie ? fmt(f.goalie.gaa, 2) : '-',
            f.lens.split(' (')[0] ?? f.lens,
          ]),
        ),
      ].join('\n');
      return Promise.resolve(ok({ players: out }, summary));
    }
    const s = forecastSeason(view, store);
    const us = s.teams.find((t) => t.teamKey === view.teamKey);
    const summary = [
      `Rest of season, ${s.lens}: each team's typical week against every other.`,
      table(
        ['team', 'exp. cats won/wk', 'P(win a week)'],
        s.teams.map((t) => [t.teamKey === view.teamKey ? `${t.name} (us)` : t.name, fmt(t.expectedCatsWon, 2), fmt(t.pWinWeek)]),
      ),
      us === undefined
        ? ''
        : `Us vs each: ${us.vs.map((v) => `${v.name} ${fmt(v.pWin)}`).join(', ')}.`,
    ].join('\n');
    return Promise.resolve(ok({ lens: s.lens, teams: s.teams.map((t) => ({ teamKey: t.teamKey, name: t.name, expectedCatsWon: t.expectedCatsWon, pWinWeek: t.pWinWeek, vs: t.vs })) }, summary));
  },
});
