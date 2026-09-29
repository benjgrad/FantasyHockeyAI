import { z } from 'zod';
import { isOut } from '@fha/model';
import { defineTool, fail, ok } from '../context.js';
import { DATE_RE, availabilityOf, dateProblem, dayStatus, label, table } from '../derive.js';
import { resolvePlayers } from '../resolve.js';

/** Read tools over time: the NHL schedule, goalie starts and player news. */

const MAX_SCHEDULE_DAYS = 14;

export const getSchedule = defineTool({
  name: 'getSchedule',
  description:
    'Games per NHL team between two dates (inclusive, at most 14 days), and how many games each of our players has in that span. Use it to count games left this week.',
  input: z.object({
    from: z.string().regex(DATE_RE, 'use YYYY-MM-DD'),
    to: z.string().regex(DATE_RE, 'use YYYY-MM-DD'),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    const { view } = ctx;
    if (input.to < input.from) return Promise.resolve(fail('`to` is before `from`. Swap them.'));
    const problem = dateProblem(view, input.from) ?? dateProblem(view, input.to);
    if (problem !== undefined) return Promise.resolve(fail(problem));
    const days = view.snap.schedule.filter((d) => d.date >= input.from && d.date <= input.to);
    if (days.length > MAX_SCHEDULE_DAYS) {
      return Promise.resolve(fail(`Ask for at most ${MAX_SCHEDULE_DAYS} days at a time.`));
    }
    const perTeam = Object.fromEntries(
      [...view.gamesBetween(input.from, input.to)].sort((a, b) => b[1] - a[1]),
    );
    const ours = view.roster().entries.map(({ player }) => ({
      playerKey: player.playerKey,
      name: player.name,
      nhlTeam: player.nhlTeam,
      games: perTeam[player.nhlTeam] ?? 0,
    }));
    const perDay = days.map((d) => ({ date: d.date, games: d.games.length }));
    const summary = [
      `Schedule ${input.from}..${input.to}: ${perDay.map((d) => `${d.date} ${d.games}g`).join(', ')}`,
      `Games per NHL team: ${Object.entries(perTeam)
        .map(([t, n]) => `${t} ${n}`)
        .join(', ')}`,
      `Our players: ${ours.map((p) => `${p.name} ${p.games}`).join(', ')}`,
    ].join('\n');
    return Promise.resolve(ok({ perDay, perTeam, ours }, summary));
  },
});

export const getGoalieStarts = defineTool({
  name: 'getGoalieStarts',
  description:
    'Start status for our goalies on a date: whether their team plays, and whether the start is confirmed. Call it before proposeLineup.',
  input: z.object({ date: z.string().regex(DATE_RE, 'use YYYY-MM-DD') }),
  risk: 'read',
  execute: (input, ctx) => {
    const problem = dateProblem(ctx.view, input.date);
    if (problem !== undefined) return Promise.resolve(fail(problem));
    // No confirmation source is connected yet (§11: DailyFaceoff et al.). Saying "unknown" is
    // honest; inventing "probable" would be a stub that looks like data (§24.11).
    const goalies = ctx.view
      .roster()
      .entries.filter((e) => e.player.positionType === 'G')
      .map(({ player }) => {
        const day = dayStatus(ctx.view, player, input.date, ctx.now);
        const start =
          day.opponent === undefined ? 'noGame' : isOut(player.status) ? 'out' : 'unknown';
        return {
          playerKey: player.playerKey,
          name: player.name,
          start,
          opponent: day.opponent ?? null,
          source: 'none',
          label: label(player),
        };
      });
    const summary =
      `Goalie starts on ${input.date} (no confirmation source is connected: "unknown" means not yet known, not unlikely):\n` +
      table(
        ['playerKey', 'goalie', 'start', 'opponent'],
        goalies.map((g) => [g.playerKey, g.label, g.start, g.opponent ?? '-']),
      );
    return Promise.resolve(ok({ date: input.date, goalies }, summary));
  },
});

export const getNews = defineTool({
  name: 'getNews',
  description:
    'Status, availability (chance to play, expected return) and recent news notes for up to 25 players. Use it for anyone whose status or role is in doubt before overriding the solver or dropping him.',
  input: z.object({ playerKeys: z.array(z.string()).min(1).max(25) }),
  risk: 'read',
  execute: (input, ctx) => {
    const r = resolvePlayers(ctx.view, input.playerKeys);
    if (!r.ok) return Promise.resolve(fail(r.error));
    const items = r.value.map((p) => {
      const a = availabilityOf(ctx.view, p);
      return {
        playerKey: p.playerKey,
        name: p.name,
        status: p.status ?? 'healthy',
        availability: a.label,
        playProb: a.playProb,
        expectedReturn: a.expectedReturn ?? null,
        news: ctx.view.snap.news[p.playerKey] ?? [],
      };
    });
    const summary = items
      .map(
        (i) =>
          `${i.playerKey} ${i.name} [${i.status}]: ${i.news.length === 0 ? 'no news recorded' : i.news.join(' / ')} — availability: ${i.availability}`,
      )
      .join('\n');
    return Promise.resolve(ok(items, summary));
  },
});
