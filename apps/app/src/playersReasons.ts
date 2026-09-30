import type { PlayerCard } from '@fha/api';
import type { CardContext } from './players.js';
import { weakestOurs } from './playersStrength.js';

/**
 * Turn a card's numbers into sentences, in the draft board's style (apps/web `explain`).
 *
 * Nobody reads `fit +1.4` on a phone and works out why it matters. Each sentence is derived
 * from a number on the card, so the explanation cannot drift from the numbers beside it.
 */
const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;

/** Days, not a status code: "IR-NR, out ~120 days" says more than "IR-NR". */
function availabilityReason(card: Omit<PlayerCard, 'reasons'>): string | undefined {
  const a = card.availability;
  if (a.source === 'healthy') return undefined;
  if (a.playProb > 0) return `Questionable: ${a.label}.`;
  const missed = Math.round(a.expectedGamesMissed);
  return `Out: ${a.label}${missed > 0 ? `, about ${String(missed)} games missed` : ''}.`;
}

function fitReason(card: Omit<PlayerCard, 'reasons'>): string | undefined {
  const { fit, targetHits } = card.fit;
  if (fit === null || Math.abs(fit) < 0.5) return undefined;
  if (fit > 0) {
    const where =
      targetHits.length > 0
        ? targetHits.join(' and ')
        : card.categories
            .filter((c) => c.z !== null)
            .sort((a, b) => (b.z ?? 0) - (a.z ?? 0))
            .slice(0, 2)
            .map((c) => c.cat)
            .join(' and ');
    return `Helps where we are behind (${where}): fit ${signed(fit)}.`;
  }
  return `Piles into categories we already lead: fit ${signed(fit)}.`;
}

function valueReason(card: Omit<PlayerCard, 'reasons'>, c: CardContext): string | undefined {
  const v = card.value;
  if (v === null) return 'Not valued: no projection for him, so judge this one yourself.';
  if (card.owner.kind !== 'us') {
    const weakest = weakestOurs(c.view, card.positionType);
    if (weakest !== undefined && v.adjustedVorp - weakest.worth > 0.5) {
      return `Worth more than ${weakest.name}, our weakest ${card.positionType === 'G' ? 'goalie' : 'skater'} (${v.adjustedVorp.toFixed(2)} vs ${weakest.worth.toFixed(2)} VORP after injuries).`;
    }
  }
  if (v.vorp < 0) return `Below replacement level (VORP ${v.vorp.toFixed(2)}): a streamer at best.`;
  return undefined;
}

function weekReason(card: Omit<PlayerCard, 'reasons'>): string | undefined {
  const n = card.schedule.gamesThisWeek;
  if (card.availability.playProb === 0) return undefined;
  if (n >= 4) return `Heavy week: ${String(n)} games left this week.`;
  if (n <= 1) return `Light week: ${n === 0 ? 'no games' : 'one game'} left this week.`;
  return undefined;
}

/**
 * A free agent the market would draft: his ADP falls inside the league's rostered pool
 * (teams × non-reserve roster spots), so someone would normally hold him.
 */
function marketReason(card: Omit<PlayerCard, 'reasons'>, c: CardContext): string | undefined {
  const adp = card.market.adp;
  if (adp === null || card.owner.kind !== 'freeAgent') return undefined;
  const spots = c.view.settings.rosterSlots
    .filter((s) => s.position !== 'IR' && s.position !== 'IR+' && s.position !== 'NA')
    .reduce((n, s) => n + s.count, 0);
  if (adp > c.view.settings.numTeams * spots) return undefined;
  return `The market drafts him around pick ${adp.toFixed(0)}, yet he is a free agent.`;
}

export function reasonsFor(card: Omit<PlayerCard, 'reasons'>, c: CardContext): string[] {
  const out = [
    availabilityReason(card),
    fitReason(card),
    valueReason(card, c),
    weekReason(card),
    marketReason(card, c),
    card.lowConfidence && card.value !== null
      ? 'Thin data: projection is unreliable, judge this one yourself.'
      : undefined,
  ];
  return out.filter((r): r is string => r !== undefined);
}
