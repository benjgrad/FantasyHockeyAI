import { z } from 'zod';
import { PlayerKey, TeamKey } from './types.js';

/**
 * Plans (§9): typed proposals an agent emits through a propose tool. A plan is inert until the
 * action pipeline validates it, gates it and hands it to an ExecutionAdapter. Agents cannot
 * write; they can only produce these (P1, P2).
 */
export const PLAN_KINDS = [
  'lineup',
  'addDrop',
  'waiverClaim',
  'tradePropose',
  'tradeRespond',
  'draftPick',
] as const;
export const PlanKind = z.enum(PLAN_KINDS);
export type PlanKind = z.infer<typeof PlanKind>;

export const AGENT_NAMES = [
  'gm',
  'draft',
  'lineup',
  'waivers',
  'matchup',
  'trades',
  'leagueReview',
  'strategy',
] as const;
export const AgentName = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentName>;

export const LineupMove = z.object({ playerKey: PlayerKey, slot: z.string().min(1) });
export type LineupMove = z.infer<typeof LineupMove>;

export const PlanPayload = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('lineup'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    moves: z.array(LineupMove).min(1),
  }),
  z.object({
    kind: z.literal('addDrop'),
    add: PlayerKey.optional(),
    drop: PlayerKey.optional(),
  }),
  z.object({
    kind: z.literal('waiverClaim'),
    add: PlayerKey,
    drop: PlayerKey.optional(),
    faabBid: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('tradePropose'),
    /** Resolved by the tool from a team *name* against the league's teams; never model-typed (P8). */
    partnerTeamKey: TeamKey,
    give: z.array(PlayerKey).min(1),
    get: z.array(PlayerKey).min(1),
    note: z.string().optional(),
    /** Δ expected categories won for us, from evaluateTrade (§12.7). Code-computed, not model-typed. */
    expectedGain: z.number(),
  }),
  z.object({
    kind: z.literal('tradeRespond'),
    transactionKey: z.string().min(1),
    action: z.enum(['accept', 'reject']),
    /** The players we would give up if accepting, filled from the pending trade by code. */
    give: z.array(PlayerKey),
    get: z.array(PlayerKey),
    note: z.string().optional(),
  }),
  z.object({ kind: z.literal('draftPick'), playerKey: PlayerKey }),
]);
export type PlanPayload = z.infer<typeof PlanPayload>;

export const Plan = z.object({
  planId: z.string().min(1),
  runId: z.string().min(1),
  agent: AgentName,
  /** The propose tool that produced it, so a switched-off tool also blocks its plans (P2). */
  sourceTool: z.string().min(1),
  createdAt: z.string(),
  /** After this instant the plan is stale: validation rejects it and pending approvals expire. */
  deadline: z.string().optional(),
  rationale: z.string().min(1),
  payload: PlanPayload,
});
export type Plan = z.infer<typeof Plan>;

/** Which propose tool emits which plan kind. The gate and the registry both key off this. */
export const TOOL_FOR_KIND: Record<PlanKind, string> = {
  lineup: 'proposeLineup',
  addDrop: 'proposeAddDrop',
  waiverClaim: 'proposeWaiverClaim',
  tradePropose: 'proposeTrade',
  tradeRespond: 'proposeTradeResponse',
  draftPick: 'proposeDraftPick',
};

export interface PlayersTouched {
  /** Players leaving our roster if the plan executes: drops, and trade gives. */
  outgoing: PlayerKey[];
  /** Players joining our roster. */
  incoming: PlayerKey[];
  /** Players whose lineup slot changes. */
  moved: PlayerKey[];
}

/** Every player a plan affects, split by direction. Pure, so the gate can reason over it. */
export function playersTouched(payload: PlanPayload): PlayersTouched {
  switch (payload.kind) {
    case 'lineup':
      return { outgoing: [], incoming: [], moved: payload.moves.map((m) => m.playerKey) };
    case 'addDrop':
      return {
        outgoing: payload.drop === undefined ? [] : [payload.drop],
        incoming: payload.add === undefined ? [] : [payload.add],
        moved: [],
      };
    case 'waiverClaim':
      return {
        outgoing: payload.drop === undefined ? [] : [payload.drop],
        incoming: [payload.add],
        moved: [],
      };
    case 'tradePropose':
      return { outgoing: [...payload.give], incoming: [...payload.get], moved: [] };
    case 'tradeRespond':
      return payload.action === 'accept'
        ? { outgoing: [...payload.give], incoming: [...payload.get], moved: [] }
        : { outgoing: [], incoming: [], moved: [] };
    case 'draftPick':
      return { outgoing: [], incoming: [payload.playerKey], moved: [] };
  }
}
