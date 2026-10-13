import { z } from 'zod';
import { defineTool, fail, ok } from '../context.js';
import { fmt, nameKeys } from '../derive.js';
import { modelInputs } from '../modelInputs.js';
import { resolveTeam } from '../resolve.js';
import { searchTrades } from '../tradeSearch.js';
import { lensesFor, recordShadow } from '../lensSwitch.js';

/**
 * The trade search as a tool (§12.7): code tries every swap and scores both sides; the model
 * chooses among the results instead of guessing candidates one evaluateTrade at a time (which
 * ran a trades run out of its budget with nothing filed, 2026-10-01).
 *
 * Players Ben locked, or that are already in a pending trade, are left out: the gate would refuse
 * them anyway, and a candidate the model cannot propose only wastes its turns.
 */
const SHOWN = 8;

export const findTradeTargets = defineTool({
  name: 'findTradeTargets',
  description:
    'Search for trades that help us and do not hurt the partner, scored by evaluateTrade’s model for both sides, best first. With partnerTeamName: every 1-for-1, 2-for-1 and 1-for-2 with that team (a few seconds). Without: every team, 1-for-1 only. Call it before proposing a new trade; use evaluateTrade only to test a variation.',
  input: z.object({ partnerTeamName: z.string().min(1).optional() }),
  risk: 'read',
  execute: (input, ctx) => {
    const { view, permissions } = ctx;
    let only = view.otherTeams().map((t) => t.teamKey);
    if (input.partnerTeamName !== undefined) {
      const t = resolveTeam(view, input.partnerTeamName);
      if (!t.ok) return Promise.resolve(fail(t.error));
      only = [t.value.teamKey];
    }
    // The lens Ben chose for the trade search (D-026); the other runs in shadow.
    const lenses = lensesFor(view, ctx.store, permissions, 'trades');
    const blocked = new Set([
      ...permissions.players.locked,
      ...view.pendingTradesForUs().flatMap((t) => t.players.map((p) => p.playerKey)),
    ]);
    const minGain = permissions.plans.tradePropose?.limits.minTradeGain;
    const shape = input.partnerTeamName === undefined ? 1 : 2;
    const search = (v: typeof view) => {
      const mv = modelInputs(v);
      return searchTrades(v, only, shape, minGain)
        .map((c) => ({ c, give: c.give.map((id) => mv.key(id)), get: c.get.map((id) => mv.key(id)) }))
        .filter((x) => ![...x.give, ...x.get].some((k) => blocked.has(k)))
        .slice(0, SHOWN);
    };
    const found = search(lenses.active);
    if (lenses.other !== undefined) shadowTrades(ctx, lenses, found, search(lenses.other));
    const teamName = (k: string) => view.snap.teams.find((t) => t.teamKey === k)?.name ?? k;
    const who = (keys: string[]) => keys.map((k) => `${view.player(k)?.name ?? k} (${k})`).join(' + ');
    const trades = found.map((x) => ({
      partner: teamName(x.c.partner),
      give: x.give,
      get: x.get,
      deltaUs: x.c.evaluation.deltaUs,
      deltaThem: x.c.evaluation.deltaThem,
    }));
    if (trades.length === 0) {
      return Promise.resolve(
        ok({ trades }, 'No trade found that helps us without hurting the partner. Abstain unless an offer is waiting.'),
      );
    }
    const lines = found.map(
      (x, i) =>
        `${i + 1}. ${teamName(x.c.partner)}: give ${who(x.give)} for ${who(x.get)} — Δ us ${fmt(x.c.evaluation.deltaUs)}, them ${fmt(x.c.evaluation.deltaThem)}. ${x.c.evaluation.reasons.slice(0, 2).map((r) => nameKeys(view, r)).join(' ')}`,
    );
    return Promise.resolve(ok({ trades }, [`Best trades found (${trades.length}):`, ...lines].join('\n')));
  },
});

type Found = { c: { partner: string }; give: string[]; get: string[] };

/** Record when the other lens's best trade differs from this one's (never acted on). */
function shadowTrades(
  ctx: Parameters<typeof findTradeTargets.execute>[1],
  lenses: ReturnType<typeof lensesFor>,
  found: readonly Found[],
  other: readonly Found[],
): void {
  const id = (x: Found | undefined) =>
    x === undefined ? 'none' : `${x.c.partner}:${[...x.give].sort().join('+')}>${[...x.get].sort().join('+')}`;
  if (id(found[0]) === id(other[0])) return;
  const name = (k: string) => ctx.view.player(k)?.name ?? k;
  const text = (x: Found | undefined) =>
    x === undefined ? 'nothing' : `give ${x.give.map(name).join(' + ')} for ${x.get.map(name).join(' + ')}`;
  recordShadow(ctx.store, ctx.view, lenses, {
    decision: 'trades',
    subject: id(found[0]),
    chosen: found[0] ?? null,
    other: other[0] ?? null,
    summary: `Best trade: ${lenses.lens} found ${text(found[0])}; ${lenses.otherLens} would have found ${text(other[0])}.`,
  });
}
