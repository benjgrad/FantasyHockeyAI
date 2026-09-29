import { isRaw } from './raw.js';
import type { YahooTransport } from './transport.js';

/**
 * Strip personal identifiers from a Yahoo response before it is written anywhere.
 *
 * League data (teams, rosters, players, notes) stays; what identifies a *person* goes:
 * manager emails, GUIDs, nicknames and avatars, and chat channel ids. Recordings are
 * committed as eval fixtures (§20.4), so this runs on every recorded body.
 */
const REDACT: ReadonlySet<string> = new Set([
  'email',
  'guid',
  'nickname',
  'sendbird_channel_url',
  'iris_group_chat_id',
]);
const DROP_UNDER_MANAGER: ReadonlySet<string> = new Set(['image_url', 'felo_score', 'felo_tier']);

export function redactPersonal(v: unknown, parentKey = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => redactPersonal(x, parentKey));
  if (!isRaw(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (REDACT.has(k)) {
      out[k] = x === null ? null : 'REDACTED';
    } else if (parentKey === 'manager' && DROP_UNDER_MANAGER.has(k)) {
      continue;
    } else {
      out[k] = redactPersonal(x, k);
    }
  }
  return out;
}

/** A transport that hands every (path, redacted body) to `sink` as it passes through. */
export function recordingTransport(
  inner: YahooTransport,
  sink: (path: string, body: unknown) => void,
): YahooTransport {
  return {
    async get(path: string): Promise<unknown> {
      const body = await inner.get(path);
      sink(path, redactPersonal(body));
      return body;
    },
  };
}
