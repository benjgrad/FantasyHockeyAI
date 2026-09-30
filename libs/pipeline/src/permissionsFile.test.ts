import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editPermissions, loadPermissions } from './permissionsFile.js';

const A = '477.p.1';

function tmpFile(content?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'fha-perms-')), 'permissions.yaml');
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

describe('permissions file', () => {
  it('a missing file fails closed: dry run and nothing allowed', () => {
    const p = loadPermissions(tmpFile());
    expect(p.dryRun).toBe(true);
    expect(p.plans).toEqual({});
  });

  it('a malformed file is an error, not a default', () => {
    expect(() => loadPermissions(tmpFile('plans: [oops'))).toThrow();
    expect(() => loadPermissions(tmpFile('plans: { lineup: { mode: yes } }'))).toThrow();
  });

  it('the shipped config parses, starts in dry run, and asks before trades', () => {
    const p = loadPermissions(join(import.meta.dirname, '../../../config/permissions.yaml'));
    expect(p.dryRun).toBe(true);
    expect(p.plans.tradePropose?.mode).toBe('ask');
    expect(p.plans.draftPick).toBeUndefined();
    expect(p.autoGrab).toEqual({ enabled: true, minGain: 1.5, ignoreDryRun: false });
  });

  it('lock moves a player off the ask list, and unlock clears both', () => {
    const path = tmpFile('# keep me\nplayers: { ask: ["477.p.1"] }\n');
    const locked = editPermissions({ op: 'lock', playerKey: A }, path);
    expect(locked.players).toEqual({ locked: [A], ask: [] });
    expect(readFileSync(path, 'utf-8')).toContain('# keep me');
    expect(editPermissions({ op: 'unlock', playerKey: A }, path).players).toEqual({
      locked: [],
      ask: [],
    });
  });

  it('locking twice does not duplicate', () => {
    const path = tmpFile('{}');
    editPermissions({ op: 'lock', playerKey: A }, path);
    expect(editPermissions({ op: 'lock', playerKey: A }, path).players.locked).toEqual([A]);
  });

  it('switches tools and the kill switch', () => {
    const path = tmpFile('{}');
    expect(
      editPermissions({ op: 'tool', tool: 'proposeTrade', enabled: false }, path).tools,
    ).toEqual({
      proposeTrade: false,
    });
    expect(editPermissions({ op: 'pause' }, path).paused).toBe(true);
    expect(editPermissions({ op: 'resume' }, path).paused).toBe(false);
    expect(loadPermissions(path).tools.proposeTrade).toBe(false);
  });

  it('refuses to write an invalid player key', () => {
    const path = tmpFile('{}');
    expect(() => editPermissions({ op: 'lock', playerKey: 'Connor McDavid' }, path)).toThrow();
    expect(loadPermissions(path).players.locked).toEqual([]);
  });
});
