import { randomUUID } from 'node:crypto';
import type { Clock, Db } from '../db.js';

/**
 * Ben's standing guidance (D-041, migration 013): one lesson or lasting preference per row,
 * written from chat and read by every agent run and chat session.
 */
export type GuidanceSource = 'chat' | 'ben';

export interface GuidanceEntry {
  /** Short and stable (`g` + 8 hex), so the model can name one to forget. */
  id: string;
  leagueKey: string;
  text: string;
  why?: string;
  source: GuidanceSource;
  conversationId?: string;
  createdAt: string;
  retiredAt?: string;
}

export interface NewGuidance {
  leagueKey: string;
  text: string;
  why?: string;
  source: GuidanceSource;
  conversationId?: string;
}

/** How many entries a prompt carries at most: the newest win. */
export const GUIDANCE_LIMIT = 20;

export interface GuidanceRepo {
  add(g: NewGuidance): GuidanceEntry;
  /** Retires an active entry of this league; false when there is none with that id. */
  retire(leagueKey: string, id: string): boolean;
  /** Active entries, newest first. */
  active(leagueKey: string, limit?: number): GuidanceEntry[];
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function row(r: Raw): GuidanceEntry {
  const why = str(r['why']);
  const conversationId = str(r['conversation_id']);
  const retiredAt = str(r['retired_at']);
  return {
    id: r['id'] as string,
    leagueKey: r['league_key'] as string,
    text: r['text'] as string,
    source: r['source'] as GuidanceSource,
    createdAt: r['created_at'] as string,
    ...(why === undefined ? {} : { why }),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(retiredAt === undefined ? {} : { retiredAt }),
  };
}

export function guidanceRepo(db: Db, now: Clock): GuidanceRepo {
  const insert = db.prepare(
    `INSERT INTO guidance (id, league_key, text, why, source, conversation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare('SELECT * FROM guidance WHERE id = ?');
  const retire = db.prepare(
    'UPDATE guidance SET retired_at = ? WHERE league_key = ? AND id = ? AND retired_at IS NULL',
  );
  // rowid breaks ties between entries written in the same millisecond.
  const active = db.prepare(
    `SELECT * FROM guidance WHERE league_key = ? AND retired_at IS NULL
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  );
  return {
    add: (g) => {
      const id = `g${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      insert.run(
        id,
        g.leagueKey,
        g.text,
        g.why ?? null,
        g.source,
        g.conversationId ?? null,
        now().toISOString(),
      );
      return row(byId.get(id) as Raw);
    },
    retire: (leagueKey, id) => retire.run(now().toISOString(), leagueKey, id).changes > 0,
    active: (leagueKey, limit = GUIDANCE_LIMIT) => (active.all(leagueKey, limit) as Raw[]).map(row),
  };
}
