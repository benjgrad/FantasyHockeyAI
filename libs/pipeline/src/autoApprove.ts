import type { Plan } from '@fha/core';

/**
 * When an `askTimeout` plan executes on its own (D-018). Pure: every input is passed in.
 *
 * The time is the **earliest** of
 * - `start + timeoutMinutes`, where `start` is now, or the end of Ben's quiet hours when the
 *   approval push would be suppressed by them (the timer is never run down while Ben cannot see
 *   the push; the extension is said on the card and in the push, never silent), and
 * - the plan's own moment minus a safety margin of {@link AUTO_APPROVE_MARGIN_MS}: for a lineup,
 *   the earliest puck drop among the players it moves (each locks at his own game, U-09); for
 *   any plan, its `deadline`.
 *
 * The deadline cap wins over the quiet-hours extension: a lineup set after puck drop is worse
 * than one set while Ben sleeps, and he chose `askTimeout` for this kind. When that happens the
 * result says so (`duringQuietHours`) so the push can warn him. A cap already in the past gives
 * `now`: the plan is due at the next sweep.
 */
export const AUTO_APPROVE_MARGIN_MS = 5 * 60_000;

/** The start of `playerKey`'s game on `date` (ISO), or undefined when he has no game. */
export type LockTimeOf = (playerKey: string, date: string) => string | undefined;

export interface AutoApproveTime {
  /** ISO instant the plan executes unless Ben rejects it first. */
  at: string;
  /** What set it: the timer, a lineup lock, or the plan's deadline. */
  basis: 'timeout' | 'lock' | 'deadline';
  /** Set when quiet hours pushed the timer's start back to this instant (ISO). */
  quietUntil?: string;
  /** True when a lock or deadline makes it fall before Ben's quiet hours end. */
  duringQuietHours?: boolean;
}

export function autoApproveAt(
  plan: Plan,
  timeoutMinutes: number,
  now: Date,
  lockTimeOf?: LockTimeOf,
  quietUntil?: Date,
): AutoApproveTime {
  const quiet = quietUntil !== undefined && quietUntil.getTime() > now.getTime();
  const start = quiet ? quietUntil.getTime() : now.getTime();
  const timer = start + timeoutMinutes * 60_000;

  const caps: { t: number; basis: 'lock' | 'deadline' }[] = [];
  const lock = earliestLock(plan, lockTimeOf);
  if (lock !== undefined) caps.push({ t: lock - AUTO_APPROVE_MARGIN_MS, basis: 'lock' });
  const deadline = plan.deadline === undefined ? NaN : Date.parse(plan.deadline);
  if (Number.isFinite(deadline)) {
    caps.push({ t: deadline - AUTO_APPROVE_MARGIN_MS, basis: 'deadline' });
  }
  const cap = caps.sort((a, b) => a.t - b.t)[0];

  const capped = cap !== undefined && cap.t < timer;
  const t = Math.max(now.getTime(), capped ? cap.t : timer);
  return {
    at: new Date(t).toISOString(),
    basis: capped ? cap.basis : 'timeout',
    ...(quiet ? { quietUntil: quietUntil.toISOString() } : {}),
    ...(quiet && t < quietUntil.getTime() ? { duringQuietHours: true } : {}),
  };
}

/** The earliest game start among the players a lineup moves, in ms; undefined otherwise. */
function earliestLock(plan: Plan, lockTimeOf: LockTimeOf | undefined): number | undefined {
  const p = plan.payload;
  if (p.kind !== 'lineup' || lockTimeOf === undefined) return undefined;
  const starts = p.moves
    .map((m) => lockTimeOf(m.playerKey, p.date))
    .map((iso) => (iso === undefined ? NaN : Date.parse(iso)))
    .filter((t) => Number.isFinite(t));
  return starts.length === 0 ? undefined : Math.min(...starts);
}

/** The gate reasons a timed ask adds to its card, so every choice above is visible. */
export function autoApproveNotes(t: AutoApproveTime): string[] {
  const notes: string[] = [];
  if (t.basis === 'lock') notes.push('auto-approve set 5 min before the first affected puck drop');
  if (t.basis === 'deadline') notes.push("auto-approve set 5 min before the plan's deadline");
  if (t.quietUntil !== undefined && t.duringQuietHours !== true) {
    notes.push(
      `your quiet hours delayed the auto-approve: its timer started at ${clockTime(t.quietUntil)}`,
    );
  }
  if (t.duringQuietHours === true) {
    notes.push('it happens during your quiet hours: you may not see the notice before it does');
  }
  return notes;
}

const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
});

/** An instant as a New York wall-clock time ("10:45 AM"), the league's time zone. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : CLOCK.format(d);
}
