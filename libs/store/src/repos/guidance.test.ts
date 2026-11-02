import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openStore } from '../store.js';
import { GUIDANCE_LIMIT } from './guidance.js';

const L = '477.l.1';

function clockStore() {
  let t = Date.parse('2026-11-02T12:00:00Z');
  const store = openStore(':memory:', {
    now: () => {
      t += 1000;
      return new Date(t);
    },
  });
  return store;
}

describe('guidance (migration 013)', () => {
  it('adds entries and lists the active ones newest first', () => {
    const store = clockStore();
    const a = store.guidance.add({ leagueKey: L, text: 'Target weak categories', source: 'chat' });
    const b = store.guidance.add({
      leagueKey: L,
      text: 'A trade must be one the partner would accept',
      why: 'Ben rejected a one-sided offer',
      source: 'chat',
      conversationId: 'conv-1',
    });
    expect(a.id).toMatch(/^g[0-9a-f]{8}$/);
    expect(b).toMatchObject({ why: 'Ben rejected a one-sided offer', conversationId: 'conv-1' });
    expect(store.guidance.active(L).map((g) => g.id)).toEqual([b.id, a.id]);
  });

  it('retires an entry once, and only within its league', () => {
    const store = clockStore();
    const a = store.guidance.add({ leagueKey: L, text: 'x', source: 'ben' });
    expect(store.guidance.retire('other', a.id)).toBe(false);
    expect(store.guidance.retire(L, a.id)).toBe(true);
    expect(store.guidance.retire(L, a.id)).toBe(false);
    expect(store.guidance.active(L)).toEqual([]);
  });

  it('keeps leagues apart and caps the list at the newest entries', () => {
    const store = clockStore();
    store.guidance.add({ leagueKey: 'other', text: 'elsewhere', source: 'chat' });
    for (let i = 0; i < GUIDANCE_LIMIT + 3; i++) {
      store.guidance.add({ leagueKey: L, text: `lesson ${String(i)}`, source: 'chat' });
    }
    const active = store.guidance.active(L);
    expect(active).toHaveLength(GUIDANCE_LIMIT);
    expect(active[0]?.text).toBe(`lesson ${String(GUIDANCE_LIMIT + 2)}`);
    expect(active.some((g) => g.text === 'elsewhere')).toBe(false);
    expect(store.guidance.active(L, 2)).toHaveLength(2);
  });

  it('applies to a database already at migration 12', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fha-guidance-'));
    const path = join(dir, 'fha.sqlite');
    try {
      openStore(path).close();
      // Roll back to "before 013" as a real file from last week would be.
      const db = new Database(path);
      db.exec('DROP TABLE guidance; DELETE FROM schema_migrations WHERE version = 13;');
      db.close();
      const store = openStore(path);
      expect(store.migrationsApplied).toEqual([13]);
      store.guidance.add({ leagueKey: L, text: 'x', source: 'chat' });
      expect(store.guidance.active(L)).toHaveLength(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
