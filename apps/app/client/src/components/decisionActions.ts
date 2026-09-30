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
