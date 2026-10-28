import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db.js';
import { openStore } from '../store.js';
import { plan, P } from '../test-helpers.js';
import { MIGRATIONS } from './index.js';

const now = () => new Date('2026-10-06T12:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('migration 004 (auto_approve)', () => {
  it('upgrades a v3 database with a pending approval: the row stays a plain ask', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fha-store-004-'));
    dirs.push(dir);
    const path = join(dir, 'fha.db');

    const v3 = openDb(path);
    expect(migrate(v3, now, MIGRATIONS.slice(0, 3))).toEqual([1, 2, 3]);
    const p = plan({ kind: 'addDrop', add: P(1) });
    v3.prepare(
      `INSERT INTO decisions (plan_id, run_id, kind, plan_json, gate, status, rationale,
         created_at, updated_at)
       VALUES (?, 'run-1', 'addDrop', ?, 'ask', 'pending', 'because', ?, ?)`,
    ).run(p.planId, JSON.stringify(p), now().toISOString(), now().toISOString());
    v3.prepare(
      `INSERT INTO approvals (plan_id, status, requested_at, deadline)
       VALUES (?, 'pending', ?, '2026-10-06T22:00:00.000Z')`,
    ).run(p.planId, now().toISOString());
    v3.close();

    const after = openStore(path, { now });
    expect(after.migrationsApplied).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const row = after.approvals.get(p.planId);
    expect(row).toMatchObject({ status: 'pending', deadline: '2026-10-06T22:00:00.000Z' });
    expect(row?.autoApproveAt).toBeUndefined();
    expect(row?.userId).toBeUndefined();
    expect(after.approvals.dueAutoApprovals('2030-01-01T00:00:00Z')).toEqual([]);
    after.close();
  });
});
