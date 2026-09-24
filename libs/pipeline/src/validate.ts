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
 * Each error is written as an instruction to the agent that proposed the plan. The pipeline
 * sends the errors back once for a fix, and rejects the plan the second time (§9.1). So the
 * text says what is wrong *and what to do*, never just "invalid".
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
  /** planIds of plans pending or executed today that touch any of these players. */
  conflicting(playerKeys: string[]): string[];
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

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
    return { ok: false, errors };
  }
  if (plan.deadline !== undefined && plan.deadline <= ctx.now) {
    errors.push(`The plan's deadline ${plan.deadline} has passed. Do not re-propose it.`);
  }
  const conflicts = ctx.conflicting(all);
  if (conflicts.length > 0) {
    errors.push(
      `Plan(s) ${conflicts.join(', ')} already pending or executed today touch these players. Do not propose a duplicate.`,
    );
  }
  errors.push(...kindErrors(p, ctx));
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function kindErrors(p: PlanPayload, ctx: ValidationContext): string[] {
  switch (p.kind) {
    case 'lineup':
      return lineupErrors(p, ctx);
    case 'addDrop':
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
