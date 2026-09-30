import type { DecisionActionResult, DecisionCard } from '@fha/api';

/**
 * Pure helpers behind a decision card's buttons (D-015). What a card offers is decided by the
 * server (`card.actions`); these only word it.
 */

/** Waiting on Ben: something to do, confirm or answer. Mirrors the server's `needsBen`. */
export function needsYou(card: DecisionCard): boolean {
  return card.actions.some((a) => a === 'execute' || a === 'done' || a === 'reject');
}

/** The confirm step before "Do it": the server's exact sentence, then what it means. */
export function confirmLines(card: DecisionCard, dryRun: boolean): string[] {
  return [
    card.confirmText ?? `${card.summary}?`,
    'This makes the move in Yahoo now.',
    ...(dryRun ? ['Dry run is on; this approval applies to this move only.'] : []),
  ];
}

export type Tone = 'good' | 'warn' | 'bad' | 'mut';

/** How an action's result reads in place on the card. */
export function resultView(r: Pick<DecisionActionResult, 'outcome' | 'message'>): {
  tone: Tone;
  title: string;
  message: string;
} {
  const v = (tone: Tone, title: string) => ({ tone, title, message: r.message });
  switch (r.outcome) {
    case 'executed':
      return v('good', 'Done ✓ verified in Yahoo');
    case 'confirmed':
      return v('good', 'Confirmed ✓ Yahoo shows it');
    case 'unverified':
      return v('warn', 'Sent, not yet verified');
    case 'notConfirmed':
      return v('warn', "Yahoo doesn't show it yet");
    case 'needsHuman':
      return v('warn', 'Do this one in Yahoo');
    case 'failed':
      return v('bad', 'Yahoo did not make the move');
    case 'denied':
      return v('bad', 'Not allowed');
    case 'invalid':
      return v('bad', 'No longer valid');
    case 'dismissed':
      return v('mut', 'Dismissed');
  }
}

/** A result that may have changed the roster, so the team view should be re-read. */
export function changesRoster(r: Pick<DecisionActionResult, 'outcome'>): boolean {
  return r.outcome === 'executed' || r.outcome === 'unverified' || r.outcome === 'confirmed';
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** How long until `ms` from now, in words: "in 12 min", "in 1 h 5 min", "in under a minute". */
export function timeLeft(ms: number): string {
  if (ms < 60_000) return 'in under a minute';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
}

/**
 * The live countdown on an ask-with-timeout card (D-018): "Happens at 10:45 AM unless you reject
 * · in 12 min". Past its time it is running (or, with dry run on, waiting for Ben: dry run wins).
 * Null when the card has no timer.
 */
export function autoApproveLine(
  card: Pick<DecisionCard, 'autoApproveAt' | 'status'>,
  now: Date,
  dryRun: boolean,
  clock: (d: Date) => string = (d) => d.toLocaleTimeString([], CLOCK),
): { text: string; due: boolean } | null {
  if (card.autoApproveAt === null || card.status !== 'pending') return null;
  const at = new Date(card.autoApproveAt);
  if (Number.isNaN(at.getTime())) return null;
  const left = at.getTime() - now.getTime();
  const when = clock(at);
  if (left <= 0) {
    return dryRun
      ? { text: `Was due at ${when}; dry run is on, so it waits for you`, due: true }
      : { text: `Due at ${when}: happening now unless you reject`, due: true };
  }
  const note = dryRun ? ' (dry run is on: it will wait for you instead)' : '';
  return { text: `Happens at ${when} unless you reject · ${timeLeft(left)}${note}`, due: false };
}
