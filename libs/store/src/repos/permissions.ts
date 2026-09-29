import { Permissions } from '@fha/core';
import { parseJson, type Clock, type Db } from '../db.js';

/**
 * Per-user permissions (D-008), edited in Settings → Permissions. `config/permissions.yaml`
 * becomes the import and the default for a user with no row.
 *
 * Validated on both sides: `set` refuses a shape the gate could not read (throws a ZodError), and
 * `get` throws `StoreError` on a stored row that no longer parses, rather than handing the gate a
 * half-understood policy (P2, P5).
 */
export interface PermissionsRecord {
  permissions: Permissions;
  updatedAt: string;
  /** Who made the change: a user id, `'import'`, `'cli'`, …. */
  updatedBy?: string;
}

export interface PermissionsRepo {
  get(userId: string): Permissions | undefined;
  /** `get` plus the audit fields, for the settings page. */
  record(userId: string): PermissionsRecord | undefined;
  /** Replaces the user's permissions; stores the parsed form, so defaults are made explicit. */
  set(userId: string, perms: unknown, by: string): Permissions;
}

interface PermissionsRow {
  permissions_json: string;
  updated_at: string;
  updated_by: string | null;
}

export function permissionsRepo(db: Db, now: Clock): PermissionsRepo {
  const select = db.prepare('SELECT * FROM user_permissions WHERE user_id = ?');
  const upsert = db.prepare(
    `INSERT INTO user_permissions (user_id, permissions_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET permissions_json = excluded.permissions_json,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  );
  const record = (userId: string): PermissionsRecord | undefined => {
    const r = select.get(userId) as PermissionsRow | undefined;
    if (r === undefined) return undefined;
    return {
      permissions: parseJson(Permissions, r.permissions_json, `user_permissions[${userId}]`),
      updatedAt: r.updated_at,
      ...(r.updated_by === null ? {} : { updatedBy: r.updated_by }),
    };
  };
  return {
    get: (userId) => record(userId)?.permissions,
    record,
    set(userId, perms, by) {
      const checked = Permissions.parse(perms);
      upsert.run(userId, JSON.stringify(checked), now().toISOString(), by);
      return checked;
    },
  };
}
