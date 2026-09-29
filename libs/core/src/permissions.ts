import { z } from 'zod';
import { PLAN_KINDS } from './plans.js';
import { PlayerKey } from './types.js';

/**
 * `config/permissions.yaml` (§18.3, extended 2026-09-24 at Ben's request): what the agents may
 * do without asking. Three independent controls, all enforced in code (P2):
 *
 * - **plans**: per plan kind, `allow` (execute), `ask` (queue for Ben's approval) or `deny`.
 * - **players**: `locked` players are never dropped or traded away; `ask` players make any plan
 *   that touches them need approval, even when the kind is `allow`.
 * - **tools**: a propose tool switched off is removed from every agent's tool list *and* its
 *   plans are denied, so disabling one is not merely a suggestion to the model.
 *
 * The gate fails closed: a plan kind missing from `plans` is `deny`.
 */
export const GateMode = z.enum(['allow', 'ask', 'deny']);
export type GateMode = z.infer<typeof GateMode>;

export const PlanLimits = z
  .object({
    maxPerWeek: z.number().int().nonnegative().optional(),
    maxFaabPerClaimPct: z.number().min(0).max(1).optional(),
    minTradeGain: z.number().optional(),
  })
  .strict();
export type PlanLimits = z.infer<typeof PlanLimits>;

export const PlanPermission = z.object({ mode: GateMode, limits: PlanLimits.default({}) }).strict();
export type PlanPermission = z.infer<typeof PlanPermission>;

const planKeys = z.enum(PLAN_KINDS);

export const Permissions = z
  .object({
    /** Overrides every mode: nothing executes, everything is logged as "would execute". */
    dryRun: z.boolean().default(true),
    /** Kill switch (`fha stop`): every write is refused until `fha resume`. */
    paused: z.boolean().default(false),
    plans: z.record(planKeys, PlanPermission).default({}),
    players: z
      .object({
        locked: z.array(PlayerKey).default([]),
        ask: z.array(PlayerKey).default([]),
      })
      .strict()
      .default({}),
    /** Tool name → enabled. A tool absent here is enabled; only an explicit `false` disables. */
    tools: z.record(z.string(), z.boolean()).default({}),
    protected: z
      .object({
        /** Our top-N players by VORP are never dropped or traded without approval. */
        topNByVorp: z.number().int().nonnegative().default(6),
      })
      .strict()
      .default({}),
  })
  .strict();
export type Permissions = z.infer<typeof Permissions>;

/** The tightest weekly add cap across the kinds that add a player, or undefined if none is set. */
export function weeklyAddCap(perms: Permissions): number | undefined {
  const caps = [
    perms.plans.addDrop?.limits.maxPerWeek,
    perms.plans.waiverClaim?.limits.maxPerWeek,
  ].filter((n): n is number => n !== undefined);
  return caps.length === 0 ? undefined : Math.min(...caps);
}

export function isToolEnabled(perms: Permissions, tool: string): boolean {
  return perms.tools[tool] !== false;
}
