import { addsUsedThisWeek } from '../adds.js';
import { z } from 'zod';
import { weeklyAddCap, type Player } from '@fha/core';
import { normalizeName } from '@fha/model';
import { fitLens, needWeights, playerFit } from '../fit.js';
import { formFor } from '../history.js';
import { SortSpec, compareBy, sortColumn, sortDigits, sortLabel, sortProblem, sortValues } from '../playerSort.js';
import { pendingClaimLines, waiverOrderText } from '../claims.js';
import { defineTool, fail, ok, type Ctx, type RunContext } from '../context.js';
import { asOfLine, isStale } from '../freshness.js';
import { openDecisions } from '../openDecisions.js';
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
      asOf: view.freshness.builtAt,
      statsThrough: view.freshness.statsThrough ?? null,
      stale: isStale(view),
      waiverPriority: view.waiverPriority() ?? null,
      pendingClaims: view.pendingClaims().map((t) => t.transactionKey),
    };
    const order = waiverOrderText(view);
    const lines = [
      `${data.league} (${data.source} data) — ${data.date}, week ${data.week} (${week.start}..${week.end})`,
      asOfLine(view),
      `Our team: ${data.ourTeam}. Other teams: ${data.otherTeams.join(', ')}`,
      `Categories: ${data.categories.join(', ')}`,
      `Slots: ${data.slots.join(', ')}`,
      `Adds this week: ${addsUsed} used of ${maxAdds ?? 'no limit'}. Min trade gain: ${data.minTradeGain ?? 'none'}.`,
      `Draft status: ${data.draftStatus}. Writes: ${perms.paused ? 'PAUSED' : perms.dryRun ? 'dry run' : 'live'}.`,
      ...(order === undefined ? [] : [`Waivers: rolling, no FAAB; ${order}.`]),
      ...pendingClaimLines(view, openDecisions(ctx.store, ctx.now)),
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
    fit: playerFit(fitLens(ctx.view, ctx.store), needWeights(ctx.view, ctx.store), p).fit ?? undefined,
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
  'Fit',
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
    fmt(r.fit),
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
    "Find players by name fragment and position (C, LW, RW, D, G): status FA (free agents: add with proposeAddDrop), W (on waivers: claim with proposeWaiverClaim; the owner column shows when he clears) or A (every player in the league's pool, owned ones too: the owner column says whose, 'us' for ours). sort is required: one to three keys, each with its order, applied in turn (the second breaks ties in the first). A key is a named value (fit, value, ros, vofa, cwa, win, weekCwa, perGame, delta7d, gp, owned) or a scored category with a basis (projected, season, seasonPerGame, last10), e.g. [{by:'PPP', basis:'season', order:'desc'}] or [{by:'GAA', basis:'projected', order:'asc'}]. Each row shows both lenses (value and VORP preseason; VOLS, VOFA, CWA and Δ7d rest of season), Fit, and a column per sort key. A name not in the pool is looked up on Yahoo when that is available. Use the playerKeys it returns in proposals.",
  input: z.object({
    query: z.string().optional(),
    position: z.string().optional(),
    status: z.enum(['FA', 'W', 'A']).default('FA'),
    sort: SortSpec.describe('Required. The ranking, most important key first; state each order.'),
    limit: z.number().int().min(1).max(25).default(15),
  }),
  risk: 'read',
  execute: async (input, ctx) => {
    const problem = sortProblem(ctx.view, input.sort);
    if (problem !== undefined) return fail(problem);
    // Accent-insensitive: "stutzle" finds Stützle.
    const q = input.query === undefined ? undefined : normalizeName(input.query.trim());
    const status = input.status ?? 'FA';
    const named = (p: Player) => q === undefined || q === '' || normalizeName(p.name).includes(q);
    const found = ctx.view.snap.players.filter(
      (p) =>
        inPool(ctx.view, status, p.playerKey) &&
        (input.position === undefined || p.eligible.includes(input.position)) &&
        named(p),
    );
    const keysOf = sortValues({ view: ctx.view, store: ctx.store, now: valueNowFor(ctx)?.players }, input.sort);
    const cmp = compareBy(input.sort);
    const top = found
      .map((p) => ({ p, k: keysOf(p) }))
      .sort((a, b) => cmp(a.k, b.k))
      .slice(0, input.limit);
    const rows = top.map(({ p, k }) => ({
      ...playerRow(ctx, p),
      sortedBy: Object.fromEntries(input.sort.map((s, i) => [sortColumn(s), k[i] ?? null])),
    }));
    // Say what was searched first: the chat shows the result, and Ben reads what was asked.
    const pool = { FA: 'free agents', W: 'players on waivers', A: 'all players (owned players too)' }[
      status
    ];
    const asked = [
      `Searched ${pool}`,
      ...(input.query ? [`matching "${input.query}"`] : []),
      ...(input.position ? [`at ${input.position}`] : []),
      `by ${input.sort.map(sortLabel).join('; then ')}`,
    ].join(' ');
    const preseasonFit =
      input.sort.some((k) => k.by === 'fit') && fitLens(ctx.view, ctx.store).name === 'preseason'
        ? ' (Fit on preseason values: the rest-of-season lens is unavailable)'
        : '';
    if (rows.length > 0) {
      const summary = `${asked}${preseasonFit}, top ${rows.length}:\n${asOfLine(ctx.view)}\n${table(
        [...input.sort.map(sortColumn), ...ROW_HEADERS],
        top.map(({ p, k }, i) => [
          ...input.sort.map((s, j) => fmt(k[j], sortDigits(s))),
          ...rowCells(rows[i] as Row, p),
        ]),
      )}`;
      return ok({ players: rows }, summary);
    }
    const others = ctx.view.snap.players.filter((p) => q !== undefined && q !== '' && named(p));
    const miss =
      others.length > 0
        ? elsewhereText(ctx.view, others)
        : q === undefined || q === ''
          ? 'Loosen the position.'
          : await outsidePool(ctx, input.query?.trim() ?? '');
    return ok({ players: rows }, `${asked}: no players match. ${miss}\n${asOfLine(ctx.view)}`);
  },
});

/** FA: free agents (an add); W: on waivers (a claim, clears on the date shown); A: everyone. */
function inPool(view: LeagueView, status: 'FA' | 'W' | 'A', key: string): boolean {
  if (status === 'A') return true;
  return view.isFreeAgent(key) && (status === 'W') === view.onWaivers(key);
}

/** The name is in the pool, just not under this status: say whose (or that he is on waivers). */
function elsewhereText(view: LeagueView, players: readonly Player[]): string {
  const where = (p: Player) =>
    view.onWaivers(p.playerKey)
      ? 'on waivers'
      : view.isFreeAgent(p.playerKey)
        ? 'free agent'
        : teamName(view, view.ownerOf(p.playerKey));
  const list = players.slice(0, 5).map((p) => `${p.name} (${where(p)})`);
  return `The name matches ${list.join(', ')}: search with status A to see them.`;
}

/**
 * A name the pool does not hold (it has rostered players and the top free agents only): ask
 * Yahoo when the app can (D-032). Hits are named, not keyed: their keys reach the view with the
 * next rebuild (P3). No live search, or Yahoo down, is a note (P9).
 */
async function outsidePool(ctx: Ctx, name: string): Promise<string> {
  const pool = "He is not in the snapshot's player pool (rostered players and the top free agents)";
  if (ctx.searchYahoo === undefined) {
    return `${pool}, and a live Yahoo search is not available here. Check the spelling, or ask Ben.`;
  }
  try {
    const r = await ctx.searchYahoo(name);
    if (r.found.length === 0) return `${pool}, and Yahoo's search found no one new by that name.`;
    const who = r.found.map((f) => `${f.name} (${f.nhlTeam})`).join(', ');
    return `Found on Yahoo, outside the pool: ${who}. They are now followed and get values with the next refresh (a few minutes); search again then for their playerKeys.`;
  } catch {
    return `${pool}, and Yahoo could not be searched just now.`;
  }
}

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
