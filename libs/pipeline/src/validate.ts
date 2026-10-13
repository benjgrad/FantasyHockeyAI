import {
  playersTouched,
  type Plan,
  type PlanPayload,
  type Player,
  type RosterSlot,
  type TeamKey,
  type Transaction,
} from '@fha/core';
import { DEFAULT_RESERVE_STATUSES, reserveAllows } from '@fha/model';

/**
 * Deterministic plan validation (§9.1), applied to every plan before the gate.
 *
 * Each error is written as an instruction to the agent that proposed the plan. The propose tools
 * run this before anything is recorded and send the errors back for a fix, up to three retries
 * (§9.1, `submitProposal`); the pipeline runs it again as the backstop. So the text says what is
 * wrong *and what to do*, never just "invalid". `terminal` marks a failure no edit can fix (a
 * duplicate of an open plan, a passed deadline): the agent is told not to retry at all.
 */
export interface ValidationContext {
  now: string;
  teamKey: TeamKey;
  slots: readonly RosterSlot[];
  player(key: string): Player | undefined;
  ownerOf(key: string): TeamKey | undefined;
  isFreeAgent(key: string): boolean;
  /** Our roster as playerKey → current slot. */
  ourSlots(): Map<string, string>;
  teamExists(teamKey: TeamKey): boolean;
  /** True once the player's game on `date` has started (intraday lock, §12.4). */
  isLocked(playerKey: string, date: string): boolean;
  pendingTrade(transactionKey: string): Transaction | undefined;
  /**
   * planIds of plans pending or executed today that touch any of these players, other than
   * `excludePlanId`. Re-validating an approved plan must not find the plan itself. `plan` lets
   * the context ignore what cannot collide with it (a lineup for another date).
   */
  conflicting(playerKeys: string[], excludePlanId?: string, plan?: Plan): string[];
  /**
   * Keys of trades *we* have pending in Yahoo that involve any of these players. A proposal
   * re-offering them would be a second copy of an offer already sent (Ben's trade went out
   * three times). An offer made to us does not count: countering it is a new trade.
   */
  pendingTradesTouching?(playerKeys: string[]): string[];
  /** The league's trade deadline (YYYY-MM-DD, from Yahoo's settings, D-029); absent → none known. */
  tradeDeadline?: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[]; terminal: boolean };

export function validatePlan(plan: Plan, ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];
  const p = plan.payload;
  const touched = playersTouched(p);
  const all = [...new Set([...touched.outgoing, ...touched.incoming, ...touched.moved])];

  const unknown = all.filter((k) => ctx.player(k) === undefined);
  if (unknown.length > 0) {
    errors.push(
      `Unknown playerKey(s) ${unknown.join(', ')}. Use only playerKeys returned by getRoster, searchPlayers or getPlayers.`,
    );
    return { ok: false, errors, terminal: false };
  }
  let terminal = p.kind === 'draftPick';
  if (plan.deadline !== undefined && plan.deadline <= ctx.now) {
    errors.push(`The plan's deadline ${plan.deadline} has passed. Do not re-propose it.`);
    terminal = true;
  }
  const conflicts = ctx.conflicting(all, plan.planId, plan);
  if (conflicts.length > 0) {
    errors.push(
      `Plan(s) ${conflicts.join(', ')} already open or executed today touch these players: that move is already filed. Do not propose a duplicate; point Ben to the existing decision.`,
    );
    terminal = true;
  }
  if ((p.kind === 'tradePropose' || p.kind === 'tradeRespond') && pastDeadline(ctx)) {
    errors.push(
      `The trade deadline (${ctx.tradeDeadline ?? ''}) has passed: Yahoo accepts no trades. Do not propose one.`,
    );
    terminal = true;
  }
  const undroppable = touched.outgoing.filter((k) => ctx.player(k)?.undroppable === true);
  if (undroppable.length > 0 && p.kind !== 'lineup') {
    errors.push(
      `Yahoo marks ${undroppable.map((k) => ctx.player(k)?.name ?? k).join(', ')} undroppable: he cannot leave the roster.`,
    );
    terminal = true;
  }
  if (p.kind === 'tradePropose') {
    const offered = ctx.pendingTradesTouching?.([...p.give, ...p.get]) ?? [];
    if (offered.length > 0) {
      errors.push(
        `These players are already in a trade pending in Yahoo (${offered.join(', ')}). Do not offer them again; tell Ben the offer is out.`,
      );
      terminal = true;
    }
  }
  errors.push(...kindErrors(p, ctx));
  return errors.length === 0 ? { ok: true } : { ok: false, errors, terminal };
}

function kindErrors(p: PlanPayload, ctx: ValidationContext): string[] {
  switch (p.kind) {
    case 'lineup':
      return lineupErrors(p, ctx);
    case 'addDrop':
      return [...addDropErrors(p.add, p.drop, ctx), ...waiverErrors(p.add, ctx)];
    case 'waiverClaim':
      return addDropErrors(p.add, p.drop, ctx);
    case 'tradePropose':
      return tradeErrors(p, ctx);
    case 'tradeRespond':
      return respondErrors(p, ctx);
    case 'draftPick':
      return ['Draft picks are made by the live draft client, not through this pipeline.'];
  }
}

export function slotAccepts(slot: string, player: Player): boolean {
  if (slot === 'BN') return true;
  // Yahoo's own list of reserve seats for him, when the snapshot has it (U-10).
  if (slot in DEFAULT_RESERVE_STATUSES && player.reserveEligible !== undefined) {
    return player.reserveEligible.includes(slot);
  }
  // One table for the solver and the validator, so they cannot disagree about who fits IR.
  if (slot in DEFAULT_RESERVE_STATUSES) {
    return reserveAllows(DEFAULT_RESERVE_STATUSES, slot, player.status);
  }
  if (slot === 'Util') return player.positionType === 'P';
  return player.eligible.includes(slot);
}

function lineupErrors(
  p: Extract<PlanPayload, { kind: 'lineup' }>,
  ctx: ValidationContext,
): string[] {
  const errors: string[] = [];
  const current = ctx.ourSlots();
  const next = new Map(current);
  const known = new Set(ctx.slots.map((s) => s.position));

  for (const m of p.moves) {
    const player = ctx.player(m.playerKey);
    if (player === undefined) continue;
    if (!current.has(m.playerKey)) {
      errors.push(
        `${player.name} (${m.playerKey}) is not on our roster. Call getRoster and use its playerKeys.`,
      );
      continue;
    }
    if (!known.has(m.slot)) errors.push(`Slot ${m.slot} does not exist in this league.`);
    else if (!slotAccepts(m.slot, player)) {
      errors.push(
        `${player.name} is not eligible for ${m.slot} (eligible: ${player.eligible.join('/')}).`,
      );
    }
    if (current.get(m.playerKey) !== m.slot && ctx.isLocked(m.playerKey, p.date)) {
      errors.push(
        `${player.name}'s game has started, so he is locked and cannot move. Leave him where he is.`,
      );
    }
    next.set(m.playerKey, m.slot);
  }

  for (const s of ctx.slots) {
    const used = [...next.values()].filter((x) => x === s.position).length;
    if (used > s.count)
      errors.push(`The lineup puts ${used} players in ${s.position}, which holds ${s.count}.`);
  }
  return errors;
}

/** New York's calendar day of an instant (the league's day boundary). */
function nyDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function pastDeadline(ctx: ValidationContext): boolean {
  return ctx.tradeDeadline !== undefined && nyDay(ctx.now) > ctx.tradeDeadline;
}

/** A player on waivers is claimed, not added (D-029). */
function waiverErrors(add: string | undefined, ctx: ValidationContext): string[] {
  const p = add === undefined ? undefined : ctx.player(add);
  if (p?.onWaivers !== true) return [];
  return [
    `${p.name} is on waivers${p.waiverDate === undefined ? '' : ` until ${p.waiverDate}`}: use proposeWaiverClaim, not proposeAddDrop.`,
  ];
}

function addDropErrors(
  add: string | undefined,
  drop: string | undefined,
  ctx: ValidationContext,
): string[] {
  const errors: string[] = [];
  if (add === undefined && drop === undefined)
    return ['An add/drop needs an add, a drop, or both.'];
  if (add !== undefined && !ctx.isFreeAgent(add)) {
    const owner = ctx.ownerOf(add);
    errors.push(
      owner === ctx.teamKey
        ? `${add} is already on our roster.`
        : `${add} is not a free agent. Call searchPlayers with status FA for candidates.`,
    );
  }
  if (drop !== undefined && ctx.ownerOf(drop) !== ctx.teamKey) {
    errors.push(`${drop} is not on our roster, so it cannot be dropped. Call getRoster.`);
  }
  const rosterMax = ctx.slots
    .filter((s) => s.position !== 'IR' && s.position !== 'IR+')
    .reduce((n, s) => n + s.count, 0);
  const size = [...ctx.ourSlots().values()].filter((s) => s !== 'IR' && s !== 'IR+').length;
  if (add !== undefined && drop === undefined && size + 1 > rosterMax) {
    errors.push(`The roster is full (${size}/${rosterMax}); an add needs a drop.`);
  }
  return errors;
}

function tradeErrors(
  p: Extract<PlanPayload, { kind: 'tradePropose' }>,
  ctx: ValidationContext,
): string[] {
  const errors: string[] = [];
  if (p.partnerTeamKey === ctx.teamKey || !ctx.teamExists(p.partnerTeamKey)) {
    return [
      'The trade partner is not another team in this league. Name a team from getLeagueContext.',
    ];
  }
  const notOurs = p.give.filter((k) => ctx.ownerOf(k) !== ctx.teamKey);
  if (notOurs.length > 0) errors.push(`We cannot give ${notOurs.join(', ')}: not on our roster.`);
  const notTheirs = p.get.filter((k) => ctx.ownerOf(k) !== p.partnerTeamKey);
  if (notTheirs.length > 0) {
    errors.push(
      `${notTheirs.join(', ')} not on the partner's roster. Call getTeamRoster for that team.`,
    );
  }
  return errors;
}

function respondErrors(
  p: Extract<PlanPayload, { kind: 'tradeRespond' }>,
  ctx: ValidationContext,
): string[] {
  const t = ctx.pendingTrade(p.transactionKey);
  if (t === undefined || t.tradeeTeamKey !== ctx.teamKey) {
    return [`${p.transactionKey} is not a pending trade offered to us. Call getPendingTrades.`];
  }
  const give = t.players
    .filter((x) => x.fromTeamKey === ctx.teamKey)
    .map((x) => x.playerKey)
    .sort();
  const get = t.players
    .filter((x) => x.toTeamKey === ctx.teamKey)
    .map((x) => x.playerKey)
    .sort();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(give, [...p.give].sort()) || !same(get, [...p.get].sort())) {
    return [
      'The players in the response do not match the pending trade. Respond to the trade as offered.',
    ];
  }
  return [];
}
