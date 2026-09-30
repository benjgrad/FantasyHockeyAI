import { EVENT_KINDS, MatchupUpdatePayload } from '@fha/tools';
import type { DecisionCard } from '@fha/api';
import { listCards } from '../decisionCard.js';
import type { Services } from '../services.js';
import { cardContext } from '../services.js';
import { teamView } from '../team.js';
import { addDays, nyAt, nyDate } from './schedule.js';

/**
 * The 09:00 daily digest (§14.2): yesterday's decisions, what waits for Ben, the roster's health
 * and the matchup. Deterministic text, no model: every line is a stored fact.
 */
export interface DigestInput {
  date: string;
  yesterday: Pick<DecisionCard, 'summary' | 'status'>[];
  pending: Pick<DecisionCard, 'summary' | 'deadline'>[];
  health: string[];
  matchup: MatchupUpdatePayload | undefined;
  /** The projected outlook, when no scoreboard reading exists yet. */
  projected: { opponent: string; ahead: number; behind: number } | undefined;
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  dry_run: 'dry run',
  executed: 'done',
  unverified: 'sent, not confirmed',
  failed: 'failed',
  denied: 'refused by permissions',
  rejected: 'rejected',
  expired: 'expired',
  pending: 'waiting for you',
  approved: 'approved',
  invalid: 'invalid',
};

const MAX_ITEMS = 5;

function list<T>(items: readonly T[], line: (t: T) => string): string[] {
  const shown = items.slice(0, MAX_ITEMS).map((t) => `• ${line(t)}`);
  return items.length > MAX_ITEMS ? [...shown, `• …and ${items.length - MAX_ITEMS} more`] : shown;
}

function matchupLine(i: DigestInput): string | undefined {
  if (i.matchup !== undefined) {
    const m = i.matchup;
    const cats = Object.keys(m.us).length;
    const tied = Math.max(0, cats - m.winning.length - m.losing.length);
    return `Week ${m.week} vs ${m.opponentName}: winning ${m.winning.length}, losing ${m.losing.length}, tied ${tied} (Yahoo scoreboard).`;
  }
  if (i.projected !== undefined) {
    const p = i.projected;
    return `This week vs ${p.opponent}: projected ahead in ${p.ahead}, behind in ${p.behind}.`;
  }
  return undefined;
}

/** Pure: the digest's title and body. */
export function digestText(i: DigestInput): { title: string; body: string } {
  const lines: string[] = [];
  if (i.yesterday.length === 0) lines.push('Yesterday: no moves.');
  else {
    lines.push(`Yesterday: ${i.yesterday.length} decision(s).`);
    lines.push(...list(i.yesterday, (d) => `${d.summary} (${STATUS_WORDS[d.status] ?? d.status})`));
  }
  if (i.pending.length > 0) {
    lines.push(`Waiting for you: ${i.pending.length} approval(s).`);
    lines.push(
      ...list(i.pending, (d) =>
        d.deadline === null
          ? d.summary
          : `${d.summary} (by ${d.deadline.slice(0, 16).replace('T', ' ')} UTC)`,
      ),
    );
  }
  lines.push(...i.health);
  const m = matchupLine(i);
  if (m !== undefined) lines.push(m);
  return { title: `Daily digest, ${i.date}`, body: lines.join('\n') };
}

/** Gather the digest's facts for one user. Yahoo is not read: the cached league is enough. */
export function gatherDigest(s: Services, userId: string, now: Date): DigestInput {
  const today = nyDate(now);
  const from = nyAt(addDays(today, -1), '00:00').toISOString();
  const to = nyAt(today, '00:00').toISOString();
  const cards = { ...cardContext(s, userId), now };
  const yesterday = listCards(s.store, 'all', cards).filter(
    (c) => c.createdAt >= from && c.createdAt < to && c.status !== 'proposed',
  );
  const pending = listCards(s.store, 'pending', cards);
  const since = new Date(now.getTime() - 36 * 3_600_000).toISOString();
  const reading = s.store.events.recent(userId, since, [EVENT_KINDS.matchupUpdate]).at(-1);
  const parsed = MatchupUpdatePayload.safeParse(reading?.payload);
  const league = s.league.peek(userId);
  const team = league === undefined ? undefined : teamView(league, now);
  const cats = team?.categories.filter((c) => c.winProb !== null) ?? [];
  return {
    date: today,
    yesterday,
    pending,
    health: team?.health ?? ['Roster: no league data cached yet.'],
    matchup: parsed.success ? parsed.data : undefined,
    projected:
      team?.opponent == null
        ? undefined
        : {
            opponent: team.opponent,
            ahead: cats.filter((c) => (c.winProb ?? 0) > 0.5).length,
            behind: cats.filter((c) => (c.winProb ?? 1) < 0.5).length,
          },
  };
}
