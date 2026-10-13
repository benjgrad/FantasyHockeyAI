import { clockTime } from '@fha/pipeline';
import { recordNotice } from './activity.js';
import type { NotificationPrefs, Store } from '@fha/store';
import type { VapidKeys } from './config.js';

/**
 * Web push (plan Phase 6, ported from the draft board's web-push use and personal-os
 * `core/push.ts`), with subscriptions in the database rather than a JSON file.
 *
 * Every notification is recorded first, so the in-app list is complete even when a push is
 * suppressed or fails. Then prefs decide: a kind switched off, or quiet hours, suppresses the
 * push but not the record. A 404/410 from a push service means the browser is gone, so that
 * subscription is pruned; any other failure keeps it for next time.
 */
export type PushSend = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<unknown>;

export type NotificationKind =
  'approval' | 'injury' | 'executed' | 'failed' | 'digest' | 'league' | 'chat';
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'approval',
  'injury',
  'executed',
  'failed',
  'digest',
  'league',
  'chat',
];

export interface Notice {
  kind: NotificationKind;
  title: string;
  body?: string;
  url?: string;
  planId?: string;
}

export interface NotifyResult {
  id: number;
  sent: number;
  suppressed?: 'kind_off' | 'quiet_hours' | 'push_off';
}

export const DEFAULT_PREFS: NotificationPrefs = {
  kinds: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])),
};

/** True when `at` falls in the quiet window, which may wrap midnight (22:00–07:00). */
export function inQuietHours(prefs: NotificationPrefs, at: Date): boolean {
  const q = prefs.quietHours;
  if (q === undefined || q.start === q.end) return false;
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: q.tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  return q.start < q.end ? hhmm >= q.start && hhmm < q.end : hhmm >= q.start || hhmm < q.end;
}

/** Local "HH:MM" of `at` in `tz`, as minutes since midnight. */
function minutesIn(tz: string, at: Date): number {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * When the quiet window containing `at` ends, or undefined when `at` is not in quiet hours. By
 * wall-clock minutes, so on a night the clocks change it can be an hour off; that only moves an
 * ask-with-timeout's timer (D-018), which is capped by the plan's own deadline anyway.
 */
export function quietHoursEnd(prefs: NotificationPrefs, at: Date): Date | undefined {
  const q = prefs.quietHours;
  if (q === undefined || !inQuietHours(prefs, at)) return undefined;
  const [h, m] = q.end.split(':').map(Number);
  const end = (h ?? 0) * 60 + (m ?? 0);
  const wait = (end - minutesIn(q.tz, at) + 1440) % 1440;
  const minute = Math.floor(at.getTime() / 60_000) * 60_000;
  return new Date(minute + wait * 60_000);
}

export class PushService {
  constructor(
    private readonly d: {
      store: Store;
      vapid: VapidKeys | undefined;
      send: PushSend;
      now: () => Date;
      log: (line: string) => void;
    },
  ) {}

  get publicKey(): string | undefined {
    return this.d.vapid?.publicKey;
  }

  prefs(userId: string): NotificationPrefs {
    return this.d.store.notificationPrefs.get(userId) ?? DEFAULT_PREFS;
  }

  /**
   * The end of quiet hours when a push of `kind` at `at` would be suppressed by them (and only by
   * them: with push off or the kind switched off, Ben chose not to be pushed, so nothing waits).
   */
  quietUntil(userId: string, at: Date, kind: NotificationKind = 'approval'): Date | undefined {
    if (this.d.vapid === undefined) return undefined;
    const prefs = this.prefs(userId);
    if (prefs.kinds[kind] === false) return undefined;
    return quietHoursEnd(prefs, at);
  }

  /** Record, then push unless prefs say not to. Never throws: a push is best effort (P9). */
  async notify(userId: string, n: Notice): Promise<NotifyResult> {
    const id = this.d.store.notifications.record({ userId, ...n });
    recordNotice(this.d.store, userId, n);
    if (this.d.vapid === undefined) return { id, sent: 0, suppressed: 'push_off' };
    const prefs = this.prefs(userId);
    if (prefs.kinds[n.kind] === false) return { id, sent: 0, suppressed: 'kind_off' };
    if (inQuietHours(prefs, this.d.now())) return { id, sent: 0, suppressed: 'quiet_hours' };
    const sent = await this.sendAll(userId, {
      title: n.title,
      body: n.body ?? '',
      url: n.url ?? '/',
      kind: n.kind,
      planId: n.planId ?? null,
      id,
    });
    if (sent > 0) this.d.store.notifications.markSent(id);
    return { id, sent };
  }

  /** "Send a test": ignores prefs and quiet hours, records nothing. */
  async test(userId: string): Promise<number> {
    if (this.d.vapid === undefined) return 0;
    return this.sendAll(userId, {
      title: 'Hockey GM',
      body: 'Notifications are working.',
      url: '/',
      kind: 'test',
    });
  }

  private async sendAll(userId: string, payload: Record<string, unknown>): Promise<number> {
    const text = JSON.stringify(payload);
    let sent = 0;
    for (const s of this.d.store.pushSubscriptions.forUser(userId)) {
      try {
        await this.d.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, text);
        this.d.store.pushSubscriptions.markOk(s.endpoint);
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.d.store.pushSubscriptions.remove(s.endpoint);
        this.d.log(
          `push to user ${userId} failed (${code ?? 'no status'})${code === 404 || code === 410 ? ', subscription pruned' : ''}`,
        );
      }
    }
    return sent;
  }
}

/**
 * The pipeline's notices (plain text, from `libs/pipeline`) → push notifications. Approval
 * requests and dry-run proposals deep-link to their decision card. The pipeline's wording is matched on its fixed
 * prefixes; anything unrecognised is still delivered, as a `failed`-kind notice, rather than
 * dropped (P5: when unsure, tell Ben).
 */
export function noticeFromPipeline(text: string): Notice | undefined {
  const firstLine = text.split('\n')[0] ?? text;
  const approval = /^Approval needed \(([^)]+)\): (.*)$/.exec(firstLine);
  if (approval?.[1] !== undefined) {
    const planId = approval[1];
    return {
      kind: 'approval',
      title: 'Approval needed',
      body: approval[2] ?? '',
      url: `/decisions/${planId}`,
      planId,
    };
  }
  // An ask with timeout (D-018): it happens on its own unless Ben rejects it.
  const timed = /^Auto-approve \(([^)]+)\) at (\S+): (.*)$/.exec(firstLine);
  if (timed?.[1] !== undefined && timed[2] !== undefined) {
    const planId = timed[1];
    const note = text.split('\n').find((l) => l.startsWith('Note: '));
    return {
      kind: 'approval',
      title: 'Happens unless you reject',
      body:
        `Will ${timed[3] ?? ''} at ${clockTime(timed[2])} unless you reject — tap to review` +
        (note === undefined ? '' : ` (${note.slice('Note: '.length).replace(/\.$/, '')})`),
      url: `/decisions/${planId}`,
      planId,
    };
  }
  // A dry-run proposal (D-015): Ben can do it from the card, so it deep-links there too.
  const proposed = /^Proposed \(([^)]+)\): (.*)$/.exec(firstLine);
  if (proposed?.[1] !== undefined) {
    const planId = proposed[1];
    return {
      kind: 'approval',
      title: 'New proposal',
      body: `Proposed: ${proposed[2] ?? ''} — tap to review`,
      url: `/decisions/${planId}`,
      planId,
    };
  }
  const manual = /^ACTION NEEDED \(([^)]+)\): (.*)$/.exec(firstLine);
  if (manual?.[1] !== undefined) {
    const planId = manual[1];
    return {
      kind: 'executed',
      title: 'Do this in Yahoo',
      body: manual[2] ?? '',
      url: `/decisions/${planId}`,
      planId,
    };
  }
  // A refusal is already reported where it happened (the chat or the run); no push.
  if (firstLine.startsWith('Refused ')) return undefined;
  return {
    kind: 'failed',
    title: 'Needs your attention',
    body: firstLine.slice(0, 300),
    url: '/decisions',
  };
}
