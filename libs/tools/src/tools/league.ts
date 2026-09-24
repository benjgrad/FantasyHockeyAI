import { z } from 'zod';
import type { Player } from '@fha/core';
import { defineTool, fail, ok, type RunContext } from '../context.js';
import { fmt, label, scoringCategories, table, weekBounds } from '../derive.js';
import { resolvePlayers, resolveTeam, teamName } from '../resolve.js';
import type { LeagueView } from '../view.js';

/** Read tools over the league as a whole: settings, player details, search, other rosters. */

export const getLeagueContext = defineTool({
  name: 'getLeagueContext',
  description:
    'League settings and where we stand: scoring categories, roster slots, this week, adds used and the limits Ben set. Call it first when you need the rules.',
  input: z.object({}),
  risk: 'read',
  execute: (_input, ctx) => {
    const { view, settings, permissions: perms } = ctx;
    const week = weekBounds(view.snap.date);
    const addsUsed = ctx.store.decisions.addsThisWeek(`${week.start}T00:00:00.000Z`);
    const maxAdds = perms.plans.addDrop?.limits.maxPerWeek;
    const data = {
      league: settings.name,
      source: view.snap.source,
      date: view.snap.date,
      week: view.snap.week,
      weekStart: week.start,
      weekEnd: week.end,
      ourTeam: teamNameOf(view, view.teamKey),
      otherTeams: view.otherTeams().map((t) => t.name),
      categories: scoringCategories(settings),
      slots: settings.rosterSlots.map((s) => `${s.position}×${s.count}`),
      draftStatus: settings.draftStatus,
      addsUsedThisWeek: addsUsed,
      maxAddsPerWeek: maxAdds,
      minTradeGain: perms.plans.tradePropose?.limits.minTradeGain,
      dryRun: perms.dryRun,
      paused: perms.paused,
    };
    const lines = [
      `${data.league} (${data.source} data) — ${data.date}, week ${data.week} (${week.start}..${week.end})`,
      `Our team: ${data.ourTeam}. Other teams: ${data.otherTeams.join(', ')}`,
      `Categories: ${data.categories.join(', ')}`,
      `Slots: ${data.slots.join(', ')}`,
      `Adds this week: ${addsUsed} used of ${maxAdds ?? 'no limit'}. Min trade gain: ${data.minTradeGain ?? 'none'}.`,
      `Draft status: ${data.draftStatus}. Writes: ${perms.paused ? 'PAUSED' : perms.dryRun ? 'dry run' : 'live'}.`,
    ];
    return Promise.resolve(ok(data, lines.join('\n')));
  },
});

function teamNameOf(view: LeagueView, key: string): string {
  return view.snap.teams.find((t) => t.teamKey === key)?.name ?? key;
}

/** One row of player detail, shared by getPlayers and searchPlayers. */
function playerRow(ctx: RunContext, p: Player) {
  const v = ctx.view.valuation(p.playerKey);
  return {
    playerKey: p.playerKey,
    name: p.name,
    nhlTeam: p.nhlTeam,
    eligible: p.eligible,
    status: p.status ?? 'healthy',
    owner: teamName(ctx.view, ctx.view.ownerOf(p.playerKey)),
    percentOwned: p.percentOwned,
    value: v?.value,
    vorp: v?.vorp,
    perGameValue: v?.perGameValue,
    lowConfidence: v?.lowConfidence,
  };
}

type Row = ReturnType<typeof playerRow>;
const ROW_HEADERS = ['playerKey', 'player', 'status', 'owner', 'value', 'vorp', 'perGame', '%own'];
function rowCells(r: Row, p: Player): string[] {
  return [
    r.playerKey,
    label(p),
    r.status,
    r.owner,
    fmt(r.value),
    fmt(r.vorp),
    fmt(r.perGameValue, 3),
    r.percentOwned === undefined ? '-' : String(r.percentOwned),
  ];
}

export const getPlayers = defineTool({
  name: 'getPlayers',
  description:
    'Details for up to 25 players at once: owner, status, rest-of-season value and VORP, per-game value and projected category totals. Pass playerKeys from other tools; never type one from memory.',
  input: z.object({ playerKeys: z.array(z.string()).min(1).max(25) }),
  risk: 'read',
  execute: (input, ctx) => {
    const r = resolvePlayers(ctx.view, input.playerKeys);
    if (!r.ok) return Promise.resolve(fail(r.error));
    const cats = scoringCategories(ctx.settings);
    const rows = r.value.map((p) => {
      const totals = ctx.view.projection(p.playerKey)?.totals ?? {};
      return { ...playerRow(ctx, p), projected: Object.fromEntries(cats.map((c) => [c, totals[c]])) };
    });
    const summary = table(
      [...ROW_HEADERS, 'projected'],
      rows.map((row, i) => [
        ...rowCells(row, r.value[i] as Player),
        cats
          .filter((c) => row.projected[c] !== undefined)
          .map((c) => `${c} ${fmt(row.projected[c], c === 'SV%' ? 3 : 1)}`)
          .join(' '),
      ]),
    );
    return Promise.resolve(ok(rows, summary));
  },
});

export const searchPlayers = defineTool({
  name: 'searchPlayers',
  description:
    'Find available players (free agents), ranked by rest-of-season value or % owned. Filter by name fragment and position (C, LW, RW, D, G). Use the playerKeys it returns in proposals.',
  input: z.object({
    query: z.string().optional(),
    position: z.string().optional(),
    status: z.enum(['FA', 'W', 'A']).default('FA'),
    sort: z.enum(['value', 'owned']).default('value'),
    limit: z.number().int().min(1).max(25).default(15),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    if (input.status === 'W') {
      const note =
        'This league data does not record players on waivers, so none can be listed. Search status FA instead.';
      return Promise.resolve(ok({ players: [], note }, note));
    }
    const q = input.query?.trim().toLowerCase();
    const found = ctx.view.snap.players.filter(
      (p) =>
        ctx.view.isFreeAgent(p.playerKey) &&
        (input.position === undefined || p.eligible.includes(input.position)) &&
        (q === undefined || q === '' || p.name.toLowerCase().includes(q)),
    );
    const score = (p: Player) =>
      input.sort === 'owned'
        ? (p.percentOwned ?? 0)
        : (ctx.view.valuation(p.playerKey)?.value ?? Number.NEGATIVE_INFINITY);
    const top = found.sort((a, b) => score(b) - score(a)).slice(0, input.limit);
    const rows = top.map((p) => playerRow(ctx, p));
    const summary =
      rows.length === 0
        ? 'No free agents match. Loosen the query or position.'
        : table(
            ROW_HEADERS,
            rows.map((row, i) => rowCells(row, top[i] as Player)),
          );
    return Promise.resolve(ok({ players: rows }, summary));
  },
});

export const getTeamRoster = defineTool({
  name: 'getTeamRoster',
  description:
    "Another team's roster, by the team's name as getLeagueContext lists it (not a key). Use it before evaluateTrade or proposeTrade to pick players they own.",
  input: z.object({ teamName: z.string().min(1) }),
  risk: 'read',
  execute: (input, ctx) => {
    const t = resolveTeam(ctx.view, input.teamName);
    if (!t.ok) return Promise.resolve(fail(t.error));
    const entries = ctx.view.roster(t.value.teamKey).entries;
    const rows = entries.map((e) => ({ slot: e.slot, ...playerRow(ctx, e.player) }));
    const summary =
      `${t.value.name}:\n` +
      table(
        ['slot', ...ROW_HEADERS],
        rows.map((row, i) => [row.slot, ...rowCells(row, (entries[i] as { player: Player }).player)]),
      );
    return Promise.resolve(ok({ team: t.value.name, players: rows }, summary));
  },
});
