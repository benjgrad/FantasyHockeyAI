import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { Permissions, type PlayerKey } from '@fha/core';

/**
 * Reading and editing `config/permissions.yaml`.
 *
 * A missing file is not an error. It yields the fail-closed default (dry run, every plan kind
 * denied), so a lost config can never widen what the agents may do. A malformed file *is* an
 * error: guessing at a permissions file would be the worst place to degrade gracefully.
 *
 * Edits go through the YAML document model so Ben's comments survive `fha perms …`, and the
 * file is replaced atomically so a reader never sees half a file.
 */
export const DEFAULT_PERMISSIONS_PATH = 'config/permissions.yaml';

export function loadPermissions(path = DEFAULT_PERMISSIONS_PATH): Permissions {
  if (!existsSync(path)) return Permissions.parse({});
  const doc = parseDocument(readFileSync(path, 'utf-8'));
  if (doc.errors.length > 0)
    throw new Error(`${path}: ${doc.errors[0]?.message ?? 'invalid YAML'}`);
  return Permissions.parse(doc.toJS() ?? {});
}

export type PermissionEdit =
  | { op: 'lock' | 'ask' | 'unlock'; playerKey: PlayerKey }
  | { op: 'tool'; tool: string; enabled: boolean }
  | { op: 'pause' | 'resume' }
  | { op: 'dryRun'; enabled: boolean };

/** Apply one edit to the file and return the resulting, validated permissions. */
export function editPermissions(
  edit: PermissionEdit,
  path = DEFAULT_PERMISSIONS_PATH,
): Permissions {
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf-8') : '{}');
  const current = Permissions.parse(doc.toJS() ?? {});

  switch (edit.op) {
    case 'lock':
    case 'ask': {
      const other = edit.op === 'lock' ? 'ask' : 'locked';
      const target = edit.op === 'lock' ? 'locked' : 'ask';
      doc.setIn(
        ['players', other],
        current.players[other].filter((k) => k !== edit.playerKey),
      );
      doc.setIn(['players', target], [...new Set([...current.players[target], edit.playerKey])]);
      break;
    }
    case 'unlock':
      doc.setIn(
        ['players', 'locked'],
        current.players.locked.filter((k) => k !== edit.playerKey),
      );
      doc.setIn(
        ['players', 'ask'],
        current.players.ask.filter((k) => k !== edit.playerKey),
      );
      break;
    case 'tool':
      doc.setIn(['tools', edit.tool], edit.enabled);
      break;
    case 'pause':
    case 'resume':
      doc.set('paused', edit.op === 'pause');
      break;
    case 'dryRun':
      doc.set('dryRun', edit.enabled);
      break;
  }

  const next = Permissions.parse(doc.toJS() ?? {});
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, doc.toString());
  renameSync(tmp, path);
  return next;
}
