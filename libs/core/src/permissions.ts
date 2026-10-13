import { z } from 'zod';
import { PLAN_KINDS } from './plans.js';
import { PlayerKey } from './types.js';

/**
 * `config/permissions.yaml` (§18.3, extended 2026-09-24 at Ben's request): what the agents may
 * do without asking. Three independent controls, all enforced in code (P2):
 *
 * - **plans**: per plan kind, `allow` (execute), `ask` (queue for Ben's approval), `askTimeout`
 *   (queue for Ben's approval, and execute on its own if he has not rejected it by an
 *   auto-approve time, D-018) or `deny`.
 * - **players**: `locked` players are never dropped or traded away; `ask` players make any plan
 *   that touches them need approval, even when the kind is `allow`.
 * - **tools**: a propose tool switched off is removed from every agent's tool list *and* its
 *   plans are denied, so disabling one is not merely a suggestion to the model.
 *
 * The gate fails closed: a plan kind missing from `plans` is `deny`.
 */
export const GateMode = z.enum(['allow', 'ask', 'askTimeout', 'deny']);
export type GateMode = z.infer<typeof GateMode>;

/**
 * `askTimeout` (D-018): minutes Ben has to reject before the plan executes on its own. Stored
 * only when set, so documents written before D-018 parse unchanged; read it through
 * {@link askTimeoutMinutes}, which applies the default.
 */
export const ASK_TIMEOUT_DEFAULT_MINUTES = 30;
export const ASK_TIMEOUT_MIN_MINUTES = 5;
export const ASK_TIMEOUT_MAX_MINUTES = 1440;

export const PlanLimits = z
  .object({
    maxPerWeek: z.number().int().nonnegative().optional(),
    maxFaabPerClaimPct: z.number().min(0).max(1).optional(),
    minTradeGain: z.number().optional(),
  })
  .strict();
export type PlanLimits = z.infer<typeof PlanLimits>;

export const PlanPermission = z
  .object({
    mode: GateMode,
    limits: PlanLimits.default({}),
    /** Only meaningful for `askTimeout`; absent means {@link ASK_TIMEOUT_DEFAULT_MINUTES}. */
    timeoutMinutes: z
      .number()
      .int()
      .min(ASK_TIMEOUT_MIN_MINUTES)
      .max(ASK_TIMEOUT_MAX_MINUTES)
      .optional(),
  })
  .strict();
export type PlanPermission = z.infer<typeof PlanPermission>;

/** The minutes an `askTimeout` plan of this kind waits for Ben, with the default applied. */
export function askTimeoutMinutes(rule: PlanPermission | undefined): number {
  return rule?.timeoutMinutes ?? ASK_TIMEOUT_DEFAULT_MINUTES;
}

const planKeys = z.enum(PLAN_KINDS);

/**
 * Auto-grab (D-016): when a substantial upgrade appears between scheduled waiver runs (a free
 * agent back from injury, a healthy player another team dropped), act at once instead of
 * waiting for the 08:00 waivers job.
 *
 * `minGain` is in **VORP units over the rest of the season**, net of the player dropped and
 * discounted for expected time out (`waiverWorth` in libs/model): the same z-score units as
 * `addThreshold` (§18.3, default 0.5). The default 1.5 is three times the ordinary add bar, so
 * only a clear upgrade (about a starter-for-a-replacement swap) acts without the daily agent
 * run; the right value is an open question (U-21). Using the league's last weekly add needs
 * twice `minGain`, because an add spent now cannot answer a later injury this week.
 *
 * Every auto-grab still goes through the pipeline and the gate (P2): locks, pause, tool
 * switches, plan-kind modes, the weekly add cap and ask/protected players all apply.
 */
export const AutoGrab = z
  .object({
    enabled: z.boolean().default(true),
    /** Net rest-of-season VORP gain an opportunity must exceed. */
    minGain: z.number().nonnegative().default(1.5),
    /**
     * Execute a free-agent add even while `dryRun` is on. Off: with dry run on, an auto-grab is
     * an urgent proposal push that Ben completes with one tap (D-015).
     */
    ignoreDryRun: z.boolean().default(false),
    /** At most this many auto-grabs (executed or proposed) per scoring week. Unset: no own cap. */
    maxPerWeek: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AutoGrab = z.infer<typeof AutoGrab>;

export const ValueLens = z.enum(['preseason', 'rest-of-season']);
export type ValueLens = z.infer<typeof ValueLens>;

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
    autoGrab: AutoGrab.default({}),
    /**
     * Which value lens each automated decision uses (D-026): the preseason projection, or the
     * rest-of-season one (updated by this season's games). Every decision also runs on the
     * other lens in shadow and records where it would have decided differently.
     */
    valueLens: z
      .object({
        lineup: ValueLens.default('preseason'),
        autoGrab: ValueLens.default('preseason'),
        protected: ValueLens.default('preseason'),
        trades: ValueLens.default('preseason'),
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
