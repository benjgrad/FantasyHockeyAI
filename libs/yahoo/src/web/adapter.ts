import type { ExecResult, ExecutionAdapter, Plan, Roster, TeamKey, Transaction } from '@fha/core';
import { NotObservedError, WriteOutcomeUnknownError, YahooAuthError } from '../errors.js';
import type { TradeRequest } from './trade.js';
import type { AddDropRequest, LineupRequest, WriteResult } from './writer.js';

/**
 * `ExecutionAdapter` over Yahoo's website (§10.6), for the writes we have observed (U-12, U-23):
 * add, or add and drop, a lineup for one date, and a trade proposal. It lives in libs/yahoo so
 * libs/pipeline stays free of Yahoo.
 *
 * Every other plan kind — waiver claims, answering a trade offer, a pure drop — is answered `needsHuman` with the
 * exact action for Ben, *because* those writes have never been observed; guessing an endpoint
 * would be a stub that looks implemented (§24.11). The adapter never reports `done`: the
 * pipeline calls {@link YahooWebAdapter.verify}, which re-reads our roster.
 */
export interface YahooWriter {
  addDrop(req: AddDropRequest, signal?: AbortSignal): Promise<WriteResult>;
  setLineup(req: LineupRequest, signal?: AbortSignal): Promise<WriteResult>;
  proposeTrade(req: TradeRequest, signal?: AbortSignal): Promise<WriteResult>;
}

export interface RosterSource {
  roster(teamKey: TeamKey, date: string): Promise<Roster>;
  /** Pending trades, to confirm a proposal landed. */
  transactions(q: { type?: Transaction['type'] }): Promise<Transaction[]>;
}

export interface YahooWebAdapterOptions {
  writer: YahooWriter;
  /** The existing read path, used only by `verify`. */
  reader: RosterSource;
  /** Our team, from config or the stored connection (P8). */
  teamKey: TeamKey;
  /** How a plan reads to Ben, e.g. the pipeline's `describePlan` with player names. */
  describe: (plan: Plan) => string;
  /** Where "do this in Yahoo" goes, in the ManualAdapter's format so pushes read the same. */
  notify?: (text: string) => void;
  /** Today's roster date (New York). An add can land today or, once games lock, tomorrow. */
  today?: () => string;
  /** Called when Yahoo says the session is dead, so the connection can be marked expired. */
  onAuthExpired?: () => void;
}

export class YahooWebAdapter implements ExecutionAdapter {
  readonly name = 'yahooWeb' as const;

  constructor(private readonly o: YahooWebAdapterOptions) {}

  async execute(plan: Plan): Promise<ExecResult> {
    const p = plan.payload;
    try {
      if (p.kind === 'lineup') {
        const res = await this.o.writer.setLineup({ date: p.date, moves: p.moves });
        return { status: res.status, detail: res.detail };
      }
      if (p.kind === 'tradePropose') {
        const res = await this.o.writer.proposeTrade({
          partnerTeamKey: p.partnerTeamKey,
          give: p.give,
          get: p.get,
          ...(p.note === undefined ? {} : { note: p.note }),
        });
        return { status: res.status, detail: res.detail };
      }
      if (p.kind !== 'addDrop')
        return this.byHand(plan, `Yahoo's ${p.kind} write is unobserved (U-12)`);
      const req: AddDropRequest = {
        ...(p.add === undefined ? {} : { addPlayerKey: p.add }),
        ...(p.drop === undefined ? {} : { dropPlayerKey: p.drop }),
      };
      const res = await this.o.writer.addDrop(req);
      return { status: res.status, detail: res.detail };
    } catch (err) {
      return this.onError(plan, err);
    }
  }

  /**
   * Did the add/drop land? Re-reads our roster for today and tomorrow (an add made after a
   * player's game locks takes effect the next day) and wants the added player present and the
   * dropped one gone on the same date. Any read failure is "cannot confirm", never success.
   */
  async verify(plan: Plan): Promise<boolean> {
    const p = plan.payload;
    if (p.kind === 'lineup') return this.verifyLineup(p.date, p.moves);
    if (p.kind === 'tradePropose') return this.verifyTrade(p.partnerTeamKey, p.give, p.get);
    if (p.kind !== 'addDrop') return false;
    const today = (this.o.today ?? newYorkToday)();
    for (const date of [today, nextDay(today)]) {
      try {
        const keys = new Set(
          (await this.o.reader.roster(this.o.teamKey, date)).entries.map((e) => e.player.playerKey),
        );
        const added = p.add === undefined || keys.has(p.add);
        const dropped = p.drop === undefined || !keys.has(p.drop);
        if (added && dropped) return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Did the lineup land? Every moved player must sit in his requested slot on that date. */
  private async verifyLineup(
    date: string,
    moves: readonly { playerKey: string; slot: string }[],
  ): Promise<boolean> {
    try {
      const slots = new Map(
        (await this.o.reader.roster(this.o.teamKey, date)).entries.map((e) => [
          e.player.playerKey,
          e.slot,
        ]),
      );
      return moves.every((m) => slots.get(m.playerKey) === m.slot);
    } catch {
      return false;
    }
  }

  /** Did the offer land? A pending trade from us to that partner with exactly these players. */
  private async verifyTrade(
    partner: TeamKey,
    give: readonly string[],
    get: readonly string[],
  ): Promise<boolean> {
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && [...a].sort().join() === [...b].sort().join();
    try {
      const pending = await this.o.reader.transactions({ type: 'pending_trade' });
      return pending.some((t) => {
        if (t.teamKey !== this.o.teamKey || t.tradeeTeamKey !== partner) return false;
        const ours = t.players
          .filter((x) => x.fromTeamKey === this.o.teamKey)
          .map((x) => x.playerKey);
        const theirs = t.players.filter((x) => x.fromTeamKey === partner).map((x) => x.playerKey);
        return same(ours, give) && same(theirs, get);
      });
    } catch {
      return false;
    }
  }

  private onError(plan: Plan, err: unknown): ExecResult {
    if (err instanceof WriteOutcomeUnknownError) {
      // It may have landed. Never retry (P7); report it as sent so verify settles it.
      return { status: 'submitted', detail: err.message };
    }
    if (err instanceof NotObservedError) return this.byHand(plan, err.message);
    if (err instanceof YahooAuthError) {
      this.o.onAuthExpired?.();
      return { status: 'failed', detail: `${err.message} Nothing was sent.` };
    }
    // Everything else is thrown before the POST: nothing reached Yahoo.
    const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { status: 'failed', detail: `Not sent to Yahoo: ${why}` };
  }

  private byHand(plan: Plan, why: string): ExecResult {
    const text = `ACTION NEEDED (${plan.planId}): do this in Yahoo: ${this.o.describe(plan)}. (${why}, so it is not automated.)`;
    this.o.notify?.(text);
    return { status: 'needsHuman', detail: text };
  }
}

function newYorkToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
