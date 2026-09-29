import {
  TOOL_FOR_KIND,
  isToolEnabled,
  playersTouched,
  type GateMode,
  type Permissions,
  type Plan,
  type PlanLimits,
  type PlayerKey,
} from '@fha/core';

/**
 * The gate (§9.2): decides whether a *validated* plan may execute, must wait for Ben, or is
 * refused. This is the code gate that P2 demands. It is pure and fails closed, and a prompt
 * instruction can never widen it.
 *
 * Precedence, most restrictive first. The first `deny` wins; otherwise any `ask` wins:
 *   1. paused (kill switch)                     → deny
 *   2. the plan's propose tool is switched off   → deny
 *   3. the plan kind is missing or set to deny   → deny
 *   4. a locked player would leave our roster    → deny
 *   5. a limit is exceeded                       → deny
 *   6. an ask-listed player is touched           → ask
 *      a protected (top-N) player would leave    → ask
 *   7. otherwise                                 → the plan kind's mode
 */
export interface GateState {
  /** Our top-N players by VORP (N from `protected.topNByVorp`), computed by the caller. */
  protectedKeys: readonly PlayerKey[];
  /** Adds already made this week, plus adds in plans pending or executed this week. */
  addsThisWeek: number;
}

export interface GateResult {
  decision: GateMode;
  reasons: string[];
  /** When true the pipeline logs "would execute" and executes nothing, whatever `decision` is. */
  dryRun: boolean;
}

const ADD_KINDS = new Set<Plan['payload']['kind']>(['addDrop', 'waiverClaim']);

export function gate(plan: Plan, perms: Permissions, state: GateState): GateResult {
  const deny = (reason: string): GateResult => ({
    decision: 'deny',
    reasons: [reason],
    dryRun: perms.dryRun,
  });
  const kind = plan.payload.kind;

  if (perms.paused) return deny('writes are paused (fha stop); run fha resume to re-enable');

  for (const tool of new Set([plan.sourceTool, TOOL_FOR_KIND[kind]])) {
    if (!isToolEnabled(perms, tool)) return deny(`tool ${tool} is switched off in permissions`);
  }

  const rule = perms.plans[kind];
  if (rule === undefined) return deny(`plan kind ${kind} has no permission entry (fails closed)`);
  if (rule.mode === 'deny') return deny(`plan kind ${kind} is set to deny`);

  const touched = playersTouched(plan.payload);
  const locked = touched.outgoing.filter((k) => perms.players.locked.includes(k));
  if (locked.length > 0)
    return deny(`locked player(s) would leave the roster: ${locked.join(', ')}`);

  const limitReason = checkLimits(plan, rule.limits, state);
  if (limitReason !== undefined) return deny(limitReason);

  const reasons: string[] = [];
  const all = [...touched.outgoing, ...touched.incoming, ...touched.moved];
  const askListed = [...new Set(all.filter((k) => perms.players.ask.includes(k)))];
  if (askListed.length > 0) reasons.push(`ask-listed player(s) involved: ${askListed.join(', ')}`);
  const prot = touched.outgoing.filter((k) => state.protectedKeys.includes(k));
  if (prot.length > 0) reasons.push(`protected top-N player(s) would leave: ${prot.join(', ')}`);

  if (reasons.length > 0) return { decision: 'ask', reasons, dryRun: perms.dryRun };
  return {
    decision: rule.mode,
    reasons: [`plan kind ${kind} is ${rule.mode}`],
    dryRun: perms.dryRun,
  };
}

function checkLimits(plan: Plan, limits: PlanLimits, state: GateState): string | undefined {
  const p = plan.payload;
  if (limits.maxPerWeek !== undefined && ADD_KINDS.has(p.kind)) {
    const adds = playersTouched(p).incoming.length;
    if (state.addsThisWeek + adds > limits.maxPerWeek) {
      return `weekly add limit reached: ${state.addsThisWeek} used of ${limits.maxPerWeek}`;
    }
  }
  if (limits.minTradeGain !== undefined && p.kind === 'tradePropose') {
    if (p.expectedGain < limits.minTradeGain) {
      return `expected gain ${p.expectedGain.toFixed(2)} is below minTradeGain ${limits.minTradeGain}`;
    }
  }
  return undefined;
}
