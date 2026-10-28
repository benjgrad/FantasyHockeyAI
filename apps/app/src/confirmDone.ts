import type { DecisionActionResult } from '@fha/api';
import type { Plan, TeamKey, Transaction } from '@fha/core';
import { describePlan } from '@fha/pipeline';
import type { LeagueView } from '@fha/tools';
import type { DecisionStatus } from '@fha/store';
import { offering, mustCard } from './decisions.js';
import type { CardContext } from './decisionCard.js';
import { newYorkDate } from './league.js';
import type { Services } from './services.js';
import { rotationSaver, storedCredentials, yahooFailure } from './yahoo.js';

/**
 * "I did it in Yahoo" (D-015): Ben made the move by hand. The plan is marked `executed` only
 * when a fresh read of Yahoo shows it (P10) — never on his word alone, because a mistyped move
 * or a waiver claim still pending would otherwise be recorded as done.
 */
export interface ConfirmSource {
  /** Today in New York: Yahoo's roster date. */
  today: string;
  /** Our roster on a date, as playerKey → slot, read fresh from Yahoo. */
  slotsOn(date: string): Promise<Map<string, string>>;
  pendingTrades(): Promise<Transaction[]>;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** On today's or tomorrow's roster (a move made after games lock lands the next day). */
async function rosterShows(
  src: ConfirmSource,
  has: readonly string[],
  gone: readonly string[],
): Promise<boolean> {
  for (const date of [src.today, nextDay(src.today)]) {
    const slots = await src.slotsOn(date);
    if (has.every((k) => slots.has(k)) && gone.every((k) => !slots.has(k))) return true;
  }
  return false;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Does Yahoo, read now, show the plan's intended state? Unknown kinds: no (P5). */
export async function confirmedInYahoo(
  plan: Plan,
  src: ConfirmSource,
  us: TeamKey,
): Promise<boolean> {
  const p = plan.payload;
  switch (p.kind) {
    case 'addDrop':
    case 'waiverClaim':
      return rosterShows(
        src,
        p.add === undefined ? [] : [p.add],
        p.drop === undefined ? [] : [p.drop],
      );
    case 'lineup': {
      const slots = await src.slotsOn(p.date);
      return p.moves.every((m) => slots.get(m.playerKey) === m.slot);
    }
    case 'tradePropose': {
      const offered = (await src.pendingTrades()).some(
        (t) =>
          t.teamKey === us &&
          t.tradeeTeamKey === p.partnerTeamKey &&
          sameSet(
            t.players.filter((x) => x.fromTeamKey === us).map((x) => x.playerKey),
            p.give,
          ) &&
          sameSet(
            t.players.filter((x) => x.toTeamKey === us).map((x) => x.playerKey),
            p.get,
          ),
      );
      return offered || rosterShows(src, p.get, p.give);
    }
    case 'tradeRespond':
      if (p.action === 'accept') return rosterShows(src, p.get, p.give);
      return !(await src.pendingTrades()).some((t) => t.transactionKey === p.transactionKey);
    case 'draftPick':
      return false;
  }
}

const SETTLE_FROM: readonly DecisionStatus[] = ['dry_run', 'pending', 'approved', 'unverified'];

export async function confirmDone(
  s: Services,
  userId: string,
  planId: string,
  ctx: CardContext,
): Promise<DecisionActionResult> {
  offering(s.store, planId, 'done', ctx);
  const rec = s.store.decisions.get(planId);
  if (rec === undefined) throw new Error('unreachable: offering found the plan');
  // A fresh snapshot, so the team view shows the move too, then the adapter's own check.
  const league = await s.league.get(userId, { refresh: true });
  let ok: boolean;
  try {
    const live = s.wiring.liveAdapter?.(userId, league, {
      describe: (p) => describePlan(p, ctx.name),
      notify: () => undefined,
    });
    if (live !== undefined && rec.plan.payload.kind === 'addDrop') {
      ok = await live.verify(rec.plan);
    } else {
      const deps = { store: s.store, secretKey: s.config.secretKey, log: s.log };
      const reader = s.yahoo.reader(
        storedCredentials(deps, userId),
        league.leagueKey,
        league.teamKey,
        rotationSaver(deps, userId),
      );
      ok = await confirmedInYahoo(
        rec.plan,
        {
          today: newYorkDate(s.now()),
          slotsOn: async (date) =>
            new Map(
              (await reader.rosterDetailed(league.teamKey, date)).roster.entries.map((e) => [
                e.player.playerKey,
                e.slot,
              ]),
            ),
          pendingTrades: () => reader.transactions({ type: 'pending_trade' }),
        },
        league.teamKey,
      );
    }
  } catch (err) {
    throw yahooFailure(s.store, userId, err);
  }
  if (!ok) {
    return {
      card: mustCard(s.store, planId, ctx),
      outcome: 'notConfirmed',
      message: notYetText(rec.plan, league.view),
    };
  }
  settleDone(s, planId, rec.status);
  return {
    card: mustCard(s.store, planId, ctx),
    outcome: 'confirmed',
    message: 'Confirmed: Yahoo shows the move.',
  };
}

/**
 * Why Yahoo does not show the move yet. A claim that is filed but has not processed is the one
 * case Ben has nothing left to do (Phase 5): the fresh snapshot's transactions show it pending.
 */
function notYetText(plan: Plan, view: LeagueView): string {
  if (plan.payload.kind === 'waiverClaim' && view.claimFiledFor(plan.payload.add) !== undefined) {
    const clears = view.player(plan.payload.add)?.waiverDate;
    return `Yahoo shows your claim filed. It processes when he clears waivers${clears === undefined ? '' : ` (${clears})`}; this card is confirmed once he is on the roster.`;
  }
  return 'Yahoo doesn\'t show it yet. If you just made the move, give it a minute and tap "I did it" again.';
}

/** Record Ben's answer (if the plan was still a proposal), then `executed`, both compare-and-set. */
function settleDone(s: Services, planId: string, status: DecisionStatus): void {
  if (status === 'dry_run' || status === 'pending') {
    s.store.approvals.settle(planId, 'approved', 'web', [status], 'done by hand in Yahoo');
  }
  const key = `${planId}:0`;
  if (s.store.executions.get(key) !== undefined) {
    s.store.executions.finish(key, 'done', { confirmedBy: 'roster read after Ben did it' });
  }
  s.store.decisions.updateStatus(planId, 'executed', {
    result: 'Done by hand in Yahoo; a fresh read of Yahoo confirms it.',
    adapter: 'manual',
    from: [...SETTLE_FROM],
  });
}
