import { addsUsedThisWeek } from '../adds.js';
import { z } from 'zod';
import { weeklyAddCap, type Player } from '@fha/core';
import { normalizeName } from '@fha/model';
import { formFor } from '../history.js';
import { defineTool, fail, ok, type RunContext } from '../context.js';
import { availabilityOf, fmt, label, scoringCategories, table } from '../derive.js';
import { resolvePlayers, resolveTeam, teamName } from '../resolve.js';
import type { LeagueView } from '../view.js';
import { weekChanges } from '../valueHistory.js';
import { valueNowFor } from './value.js';

/** Read tools over the league as a whole: settings, player details, search, other rosters. */

export const getLeagueContext = defineTool({
  name: 'getLeagueContext',
  description:
    'League settings and where we stand: scoring categories, roster slots, this week, adds used and the limits Ben set. Call it first when you need the rules.',
  input: z.object({}),
  risk: 'read',
  execute: (_input, ctx) => {
    const { view, settings, permissions: perms } = ctx;
    const week = view.weekOf();
    const addsUsed = addsUsedThisWeek(view, ctx.store);
    const maxAdds = weeklyAddCap(perms);
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
      ...pendingClaims(view),
    ];
    return Promise.resolve(ok(data, lines.join('\n')));
  },
});

/** Our waiver claims waiting in Yahoo (D-029): a second claim on the same player is wasted. */
function pendingClaims(view: LeagueView): string[] {
  const ours = view.snap.transactions.filter(
    (t) => t.type === 'waiver' && t.teamKey === view.teamKey,
  );
  if (ours.length === 0) return [];
  const name = (k: string) => view.player(k)?.name ?? k;
  return [
    `Pending waiver claims: ${ours
      .map((t) => t.players.map((p) => `${p.toTeamKey === view.teamKey ? 'add' : 'drop'} ${name(p.playerKey)}`).join(', '))
      .join('; ')}.`,
  ];
}

function teamNameOf(view: LeagueView, key: string): string {
  return view.snap.teams.find((t) => t.teamKey === key)?.name ?? key;
}

/** One row of player detail, shared by getPlayers and searchPlayers. */
function playerRow(ctx: RunContext, p: Player) {
  const v = ctx.view.valuation(p.playerKey);
  const a = availabilityOf(ctx.view, p);
  return {
    playerKey: p.playerKey,
    name: p.name,
    nhlTeam: p.nhlTeam,
    eligible: p.eligible,
    status: p.status ?? 'healthy',
    ...(p.onWaivers === true ? { waiversUntil: p.waiverDate ?? null } : {}),
    ...(p.undroppable === true ? { undroppable: true } : {}),
    availability: a.label,
    playProb: a.playProb,
    expectedReturn: a.expectedReturn ?? null,
    owner: teamName(ctx.view, ctx.view.ownerOf(p.playerKey)),
    percentOwned: p.percentOwned,
    value: v?.value,
    vorp: v?.vorp,
    perGameValue: v?.perGameValue,
    lowConfidence: v?.lowConfidence,
    ...nowColumns(ctx, p.playerKey),
    form: formSummary(ctx, p.playerKey),
  };
}

/** The rest-of-season columns (D-026); blank when the value family is unavailable (P9). */
function nowColumns(ctx: RunContext, playerKey: string) {
  const v = valueNowFor(ctx)?.players.get(playerKey);
  let d7: number | undefined;
  try {
    d7 = weekChanges(ctx.view, ctx.store).get(playerKey);
  } catch {
    d7 = undefined;
  }
  return { vols: v?.vols, vofa: v?.vofa, cwa: v?.cwa, delta7d: d7, gpThisSeason: v?.gpCurrent };
}

/**
 * The form column: categories labelled hot or cold over the last ten games (code-computed, with
 * sample size accounted for), or "steady"; "-" when there is no game history. Details are in
 * getPlayerForm.
 */
function formSummary(ctx: RunContext, playerKey: string): string {
  const f = formFor(ctx.view, ctx.store, playerKey);
  if (f === undefined) return '-';
  const pick = (l: string) => f.form.trends.filter((t) => t.label === l).map((t) => t.cat);
  const hot = pick('hot');
  const cold = pick('cold');
  if (hot.length === 0 && cold.length === 0) return 'steady';
  return [hot.length > 0 ? `hot ${hot.join('/')}` : '', cold.length > 0 ? `cold ${cold.join('/')}` : '']
    .filter((x) => x !== '')
    .join('; ');
}

type Row = ReturnType<typeof playerRow>;
const ROW_HEADERS = [
  'playerKey',
  'player',
  'status',
  'availability',
  'owner',
  'value (pre)',
  'VORP (pre)',
  'VOLS (ROS)',
  'VOFA',
  'CWA',
  'Δ7d',
  'GP now',
  'perGame',
  '%own',
  'form (last 10)',
];
function rowCells(r: Row, p: Player): string[] {
  return [
    r.playerKey,
    label(p),
    r.status,
    r.availability,
    'waiversUntil' in r ? `waivers until ${r.waiversUntil ?? '?'}` : r.owner,
    fmt(r.value),
    fmt(r.vorp),
    fmt(r.vols),
    fmt(r.vofa),
    fmt(r.cwa, 3),
    fmt(r.delta7d),
    r.gpThisSeason === undefined ? '-' : String(r.gpThisSeason),
    fmt(r.perGameValue, 3),
    r.percentOwned === undefined ? '-' : String(r.percentOwned),
    r.form,
  ];
}

export const getPlayers = defineTool({
  name: 'getPlayers',
  description:
    'Details for up to 25 players at once: owner, status and availability (chance to play, expected return), preseason value and VORP next to the rest-of-season VOLS, VOFA, CWA and Δ7d, games this season, per-game value and projected category totals. getPlayerValue explains the rest-of-season numbers. Pass playerKeys from other tools; never type one from memory.',
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
    // A heading first: the chat's saved copy of a result keeps its first lines.
    const summary = `${rows.length} player${rows.length === 1 ? '' : 's'}:\n${table(
      [...ROW_HEADERS, 'projected'],
      rows.map((row, i) => [
        ...rowCells(row, r.value[i] as Player),
        cats
          .filter((c) => row.projected[c] !== undefined)
          .map((c) => `${c} ${fmt(row.projected[c], c === 'SV%' ? 3 : 1)}`)
          .join(' '),
      ]),
    )}`;
    return Promise.resolve(ok(rows, summary));
  },
});

export const searchPlayers = defineTool({
  name: 'searchPlayers',
  description:
    'Find available players: status FA (free agents: add with proposeAddDrop), W (on waivers: claim with proposeWaiverClaim; the owner column shows when he clears) or A (both), ranked by preseason value, rest-of-season VOLS, VOFA, CWA or % owned. Each row shows both lenses: value and VORP (preseason) next to VOLS, VOFA, CWA and Δ7d (rest of season). Filter by name fragment and position (C, LW, RW, D, G). Use the playerKeys it returns in proposals.',
  input: z.object({
    query: z.string().optional(),
    position: z.string().optional(),
    status: z.enum(['FA', 'W', 'A']).default('FA'),
    sort: z
      .enum(['value', 'owned', 'vofa', 'cwa', 'ros'])
      .default('value')
      .describe(
        "value: preseason value; ros: rest-of-season VOLS; vofa: over the best free agent; cwa: categories a week added for us; owned: % owned",
      ),
    limit: z.number().int().min(1).max(25).default(15),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    // Accent-insensitive: "stutzle" finds Stützle.
    const q = input.query === undefined ? undefined : normalizeName(input.query.trim());
    // FA: free agents (an add); W: on waivers (a claim, clears on the date shown); A: either.
    const inPool = (key: string) =>
      ctx.view.isFreeAgent(key) &&
      (input.status === 'A' || (input.status === 'W') === ctx.view.onWaivers(key));
    const found = ctx.view.snap.players.filter(
      (p) =>
        inPool(p.playerKey) &&
        (input.position === undefined || p.eligible.includes(input.position)) &&
        (q === undefined || q === '' || normalizeName(p.name).includes(q)),
    );
    const now = valueNowFor(ctx)?.players;
    const lens = (p: Player) => now?.get(p.playerKey);
    const score = (p: Player): number => {
      const missing = Number.NEGATIVE_INFINITY;
      if (input.sort === 'owned') return p.percentOwned ?? 0;
      if (input.sort === 'ros') return lens(p)?.vols ?? missing;
      if (input.sort === 'vofa') return lens(p)?.vofa ?? missing;
      if (input.sort === 'cwa') return lens(p)?.cwa ?? missing;
      return ctx.view.valuation(p.playerKey)?.value ?? missing;
    };
    const top = found.sort((a, b) => score(b) - score(a)).slice(0, input.limit);
    const rows = top.map((p) => playerRow(ctx, p));
    // Say what was searched first: the chat shows the result, and Ben reads what was asked.
    const pool = { FA: 'free agents', W: 'players on waivers', A: 'all players' }[
      input.status ?? 'FA'
    ];
    const asked = [
      `Searched ${pool}`,
      ...(input.query ? [`matching "${input.query}"`] : []),
      ...(input.position ? [`at ${input.position}`] : []),
      `by ${{ owned: '% owned', value: 'preseason value', ros: 'rest-of-season VOLS', vofa: 'VOFA', cwa: 'CWA' }[input.sort ?? 'value']}`,
    ].join(' ');
    const summary =
      rows.length === 0
        ? `${asked}: no players match. Loosen the query or position.`
        : `${asked}, top ${rows.length}:\n${table(
            ROW_HEADERS,
            rows.map((row, i) => rowCells(row, top[i] as Player)),
          )}`;
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
