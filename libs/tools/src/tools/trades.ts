import { z } from 'zod';
import type { LeagueTeam, Transaction } from '@fha/core';
import { TradeInputError, type TradeEvaluation } from '@fha/model';
import { defineTool, fail, ok } from '../context.js';
import { fmt } from '../derive.js';
import { evaluateTradeKeys } from '../modelInputs.js';
import { resolvePlayers, resolveTeam, teamName, type Resolved } from '../resolve.js';
import type { LeagueView } from '../view.js';

/** Trade read tools (§12.7). proposeTrade reuses `assessTrade`, so the gain it files is this one. */

export interface TradeAssessment {
  team: LeagueTeam;
  evaluation: TradeEvaluation;
}

/** Resolve names and keys (P3), check ownership, then score the trade. Never throws. */
export function assessTrade(
  view: LeagueView,
  partnerTeamName: string,
  give: readonly string[],
  get: readonly string[],
): Resolved<TradeAssessment> {
  const t = resolveTeam(view, partnerTeamName);
  if (!t.ok) return t;
  const r = resolvePlayers(view, [...give, ...get]);
  if (!r.ok) return r;
  const notOurs = give.filter((k) => view.ownerOf(k) !== view.teamKey);
  if (notOurs.length > 0) {
    return { ok: false, error: `${names(view, notOurs)} not on our roster. Call getRoster.` };
  }
  const notTheirs = get.filter((k) => view.ownerOf(k) !== t.value.teamKey);
  if (notTheirs.length > 0) {
    return {
      ok: false,
      error: `${names(view, notTheirs)} not on ${t.value.name}'s roster. Call getTeamRoster for "${t.value.name}".`,
    };
  }
  try {
    return { ok: true, value: { team: t.value, evaluation: evaluateTradeKeys(view, t.value.teamKey, give, get) } };
  } catch (err) {
    if (err instanceof TradeInputError) {
      return { ok: false, error: `This trade cannot be evaluated: ${err.message}. Choose other players.` };
    }
    throw err;
  }
}

function names(view: LeagueView, keys: readonly string[]): string {
  return keys.map((k) => `${view.player(k)?.name ?? k} (${k})`).join(', ');
}

/** The compact text the model reads for an evaluation. The model's reasons already name players. */
export function describeEvaluation(a: TradeAssessment): string {
  const e = a.evaluation;
  return [
    `Trade with ${a.team.name}: Δ expected categories won per week — us ${fmt(e.deltaUs)}, them ${fmt(e.deltaThem)} (score ${fmt(e.score)}, summed z ${fmt(e.summedZ)}).`,
    ...e.reasons,
  ].join('\n');
}

export const evaluateTrade = defineTool({
  name: 'evaluateTrade',
  description:
    'Score a trade: how it changes expected categories won per week for us and for the partner (§12.7). Name the partner by team name; give = our playerKeys, get = theirs. Evaluate before every proposeTrade or proposeTradeResponse.',
  input: z.object({
    partnerTeamName: z.string().min(1),
    give: z.array(z.string()).min(1).max(4),
    get: z.array(z.string()).min(1).max(4),
  }),
  risk: 'read',
  execute: (input, ctx) => {
    const a = assessTrade(ctx.view, input.partnerTeamName, input.give, input.get);
    if (!a.ok) return Promise.resolve(fail(a.error));
    const e = a.value.evaluation;
    return Promise.resolve(
      ok(
        {
          partner: a.value.team.name,
          deltaUs: e.deltaUs,
          deltaThem: e.deltaThem,
          score: e.score,
          partnerGains: e.partnerGains,
          summedZ: e.summedZ,
          byCategory: e.byCategory,
        },
        describeEvaluation(a.value),
      ),
    );
  },
});

/** Our side of a pending trade: what we would give and get if it went through. */
export function tradeSides(view: LeagueView, t: Transaction): { give: string[]; get: string[] } {
  return {
    give: t.players.filter((p) => p.fromTeamKey === view.teamKey).map((p) => p.playerKey),
    get: t.players.filter((p) => p.toTeamKey === view.teamKey).map((p) => p.playerKey),
  };
}

export const getPendingTrades = defineTool({
  name: 'getPendingTrades',
  description:
    'Pending trades involving us: incoming offers waiting on our answer, and offers we sent. Answer incoming ones with proposeTradeResponse after evaluateTrade.',
  input: z.object({}),
  risk: 'read',
  execute: (_input, ctx) => {
    const { view } = ctx;
    const trades = view.pendingTradesForUs().map((t) => {
      const incoming = t.tradeeTeamKey === view.teamKey;
      const partnerKey = incoming ? t.teamKey : t.tradeeTeamKey;
      const sides = tradeSides(view, t);
      return {
        transactionKey: t.transactionKey,
        direction: incoming ? 'incoming' : 'outgoing',
        partner: teamName(view, partnerKey),
        weGive: sides.give,
        weGet: sides.get,
        proposedAt: t.timestamp,
      };
    });
    const summary =
      trades.length === 0
        ? 'No pending trades.'
        : trades
            .map(
              (t) =>
                `${t.transactionKey} ${t.direction} with ${t.partner}: we give ${names(view, t.weGive)}; we get ${names(view, t.weGet)}`,
            )
            .join('\n');
    return Promise.resolve(ok({ trades }, summary));
  },
});
