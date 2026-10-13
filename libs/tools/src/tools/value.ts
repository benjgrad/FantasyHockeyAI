import { z } from 'zod';
import { weeklyAddCap } from '@fha/core';
import { DEFAULT_ADD_THRESHOLD, scoreWaivers } from '@fha/model';
import { addsUsedThisWeek } from '../adds.js';
import { defineTool, fail, ok, type RunContext } from '../context.js';
import { fmt, scoringCategories, table } from '../derive.js';
import { modelInputs, seasonHorizonGames } from '../modelInputs.js';
import { gateStateFor } from '../gateState.js';
import { resolvePlayers } from '../resolve.js';
import { rosLensView } from '../valuationLens.js';
import { valueTrend } from '../valueHistory.js';
import { valueNow, type PlayerValueNow, type ValueNow } from '../valueNow.js';

/**
 * The mid-season value family for the agents (D-026). Every number is computed in code (P1);
 * the glossary in the system context says what each one means.
 */

/** The value family, or undefined when it cannot be built (P9: the caller says so). */
export function valueNowFor(ctx: RunContext): ValueNow | undefined {
  try {
    return valueNow(ctx.view, ctx.store);
  } catch {
    return undefined;
  }
}

const signed = (n: number | undefined, d = 2) =>
  n === undefined ? '-' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`;

function lines(ctx: RunContext, v: PlayerValueNow): string[] {
  const name = ctx.view.player(v.playerKey)?.name ?? v.playerKey;
  const t = valueTrend(ctx.view, ctx.store, v.playerKey);
  const cats = Object.entries(v.cwaByCategory)
    .filter(([, x]) => Math.abs(x) >= 0.01)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([c, x]) => `${c} ${signed(x)}`);
  return [
    `${name} (${v.playerKey}) — rest of season, ${v.gpCurrent} ${ctx.view.player(v.playerKey)?.positionType === 'G' ? 'starts' : 'games'} this season (${Math.round(v.weightCurrent * 100)}% weight)${v.lowConfidence ? ', LOW CONFIDENCE' : ''}:`,
    `  ROS value ${fmt(v.value)} (preseason ${fmt(v.preseason.value)}); VOLS ${fmt(v.vols)} (preseason VORP ${fmt(v.preseason.vorp)}); Adj. ${fmt(v.adjusted)}`,
    `  VOFA ${signed(v.vofa)}${v.vofaAgainst === undefined ? '' : ` over ${v.vofaAgainst.name}, the best free agent at ${v.vofaPosition ?? '?'}`}`,
    `  CWA ${signed(v.cwa, 3)} categories/week for us${v.cwaSwap === undefined ? '' : ` (${ctx.view.isFreeAgent(v.cwaSwap.playerKey) ? `replaced by ${v.cwaSwap.name}` : `making room by releasing ${v.cwaSwap.name}`})`}${cats.length > 0 ? `: ${cats.join(', ')}` : ''}; this week ${signed(v.weekCwa, 3)}`,
    `  luck: ${v.luck === undefined ? 'no game history' : `${v.luck.label} (${v.luck.stat} ${fmt(v.luck.recent, 3)} over the last ${v.luck.games} games vs ${fmt(v.luck.baseline, 3)} before, z ${fmt(v.luck.z, 1)})`}`,
    `  trend (VOLS): ${signed(t?.sincePreseason)} since preseason, ${signed(t?.since7d)} in 7 days, ${signed(t?.sinceYesterday)} since yesterday`,
  ];
}

export const getPlayerValue = defineTool({
  name: 'getPlayerValue',
  description:
    "The mid-season value family for up to 12 players, each number computed in code on the rest-of-season lens: ROS value, VOLS (value over last starter), Adj. (VOLS less expected time out), VOFA (value over the best free agent at his position, named), CWA (categories a week he adds for us, by category, and who he displaces), Week CWA (this week's matchup), luck (shooting/save % vs his norm), and the trend since preseason, 7 days and yesterday. The glossary in your context defines each.",
  input: z.object({ playerKeys: z.array(z.string()).min(1).max(12) }),
  risk: 'read',
  execute: (input, ctx) => {
    const r = resolvePlayers(ctx.view, input.playerKeys);
    if (!r.ok) return Promise.resolve(fail(r.error));
    const now = valueNowFor(ctx);
    if (now === undefined) return Promise.resolve(fail('Mid-season values are unavailable right now; use getPlayers (preseason values).', false));
    const found = r.value.flatMap((p) => {
      const v = now.players.get(p.playerKey);
      return v === undefined ? [] : [v];
    });
    const missing = r.value.filter((p) => !now.players.has(p.playerKey)).map((p) => p.name);
    const text = [
      `Lens: ${now.lens}, as of ${now.asOf}.`,
      ...found.flatMap((v) => lines(ctx, v)),
      ...(missing.length > 0 ? [`No projection for: ${missing.join(', ')}.`] : []),
    ].join('\n');
    return Promise.resolve(ok({ lens: now.lens, players: found }, text));
  },
});

export const findPickups = defineTool({
  name: 'findPickups',
  description:
    "Deterministic add/drop candidates on the rest-of-season lens (§12.8 waiver scorer): every free agent against each of our droppable players (locked, ask-listed and protected top-N excluded), judged on the better of season gain (Adj. of the add minus Adj. of the drop) and this week's streaming gain, against the bar an add must clear with the adds left this week. Each row shows the add's VOFA and CWA. Choose among these; do not invent pairs.",
  input: z.object({
    position: z.enum(['C', 'LW', 'RW', 'D', 'G']).optional(),
    limit: z.number().int().min(1).max(15).default(8),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    const now = valueNowFor(ctx);
    if (now === undefined) return Promise.resolve(fail('Mid-season values are unavailable right now; use searchPlayers.', false));
    const lens = rosLensView(ctx.view, ctx.store).view;
    const m = modelInputs(lens);
    const ours = m.rosterIds(lens.teamKey);
    const perms = ctx.permissions;
    const { protectedKeys } = gateStateFor(ctx.view, ctx.store, perms);
    const keep = new Set([...perms.players.locked, ...perms.players.ask, ...protectedKeys]);
    const droppable = ours.filter((id) => !keep.has(m.key(id)));
    const candidates = m
      .freeAgentIds()
      .filter((id) => input.position === undefined || (lens.player(m.key(id))?.eligible ?? []).includes(input.position))
      .flatMap((id) => m.valuationById(id) ?? []);
    const { start, end } = lens.weekOf();
    const games = lens.gamesBetween(lens.snap.date, end);
    const cap = weeklyAddCap(perms) ?? 7;
    const used = addsUsedThisWeek(ctx.view, ctx.store);
    const daysRemaining = Math.max(1, Math.round((Date.parse(end) - Date.parse(lens.snap.date)) / 86_400_000) + 1);
    const result = scoreWaivers({
      settings: lens.settings,
      roster: ours.flatMap((id) => m.valuationById(id) ?? []),
      droppable,
      candidates,
      gamesThisWeek: Object.fromEntries(games),
      addsRemaining: Math.max(0, cap - used),
      addsPerWeek: cap,
      daysRemaining,
      addThreshold: DEFAULT_ADD_THRESHOLD,
      // This week's category weights from the matchup agent (D-029), when it set them.
      ...(() => {
        const w = ctx.store.strategy.get(lens.snap.week)?.weights;
        return w === undefined ? {} : { weights: w };
      })(),
      availability: m.availability,
      seasonGamesRemaining: seasonHorizonGames(lens),
    });
    const name = (id: number | null) => (id === null ? '(no drop)' : (lens.player(m.key(id))?.name ?? String(id)));
    const rows = result.moves.slice(0, input.limit);
    const pick = (id: number) => now.players.get(m.key(id));
    const data = rows.map((mv) => ({
      add: m.key(mv.add),
      drop: mv.drop === null ? null : m.key(mv.drop),
      kind: mv.kind,
      gain: mv.gain,
      rosGain: mv.rosGain,
      streamGain: mv.streamGain,
      addVofa: pick(mv.add)?.vofa,
      addCwa: pick(mv.add)?.cwa,
      addWeekCwa: pick(mv.add)?.weekCwa,
      reasons: mv.reasons,
    }));
    const header = `Week ${start}..${end}: ${Math.max(0, cap - used)} of ${cap} adds left; an add must gain more than ${fmt(result.requiredGain)} (Adj. units). Categories: ${scoringCategories(lens.settings).join(', ')}.`;
    const text =
      rows.length === 0
        ? `${header}\nNo pickup clears the bar.${result.bestRejected === undefined ? '' : ` Closest: add ${name(result.bestRejected.add)} for ${name(result.bestRejected.drop)}, gain ${fmt(result.bestRejected.gain)}. ${result.bestRejected.reasons.at(-1) ?? ''}`}`
        : `${header}\n${table(
            ['add', 'addKey', 'drop', 'dropKey', 'kind', 'gain', 'season', 'week', 'add VOFA', 'add CWA', 'add wk CWA'],
            rows.map((mv, i) => [
              name(mv.add),
              m.key(mv.add),
              name(mv.drop),
              mv.drop === null ? '-' : m.key(mv.drop),
              mv.kind,
              fmt(mv.gain),
              signed(mv.rosGain),
              signed(mv.streamGain),
              signed(data[i]?.addVofa),
              signed(data[i]?.addCwa, 3),
              signed(data[i]?.addWeekCwa, 3),
            ]),
          )}`;
    return Promise.resolve(ok({ requiredGain: result.requiredGain, moves: data }, text));
  },
});
