import { Permissions } from '@fha/core';
import { loadPermissions } from '@fha/pipeline';
import type { Store } from '@fha/store';
import { ALL_TOOLS, type LeagueView } from '@fha/tools';
import { HttpError } from './http.js';

/**
 * Per-user permissions (D-008), edited in Settings → Permissions.
 *
 * A user with no row gets `config/permissions.yaml` copied in on first read, so the file stays
 * the default and the import. Every change is validated with core `Permissions` (the same
 * schema the gate reads) and audited as a `permissions.changed` event with before and after.
 * The pipeline reads these per plan, so an edit applies to the very next proposal.
 */
export function userPermissions(store: Store, file: string, userId: string): Permissions {
  const current = store.permissions.get(userId);
  if (current !== undefined) return current;
  return store.permissions.set(userId, loadPermissions(file), 'import');
}

export function updatePermissions(
  store: Store,
  file: string,
  userId: string,
  raw: unknown,
): Permissions {
  const parsed = Permissions.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(permissions)'}: ${i.message}`)
      .join('; ');
    throw new HttpError(400, 'invalid_permissions', detail);
  }
  const before = userPermissions(store, file, userId);
  return store.transaction(() => {
    const after = store.permissions.set(userId, parsed.data, userId);
    store.events.record({ userId, kind: 'permissions.changed', payload: { before, after } });
    return after;
  });
}

export interface PlayerRef {
  playerKey: string;
  name: string;
  team: string;
  positions: string;
}

/** Names for the locked and ask lists; a key the league view lacks is shown as the key. */
export function playerRefs(keys: readonly string[], view: LeagueView | undefined): PlayerRef[] {
  return [...new Set(keys)].map((k) => {
    const p = view?.player(k);
    return p === undefined
      ? { playerKey: k, name: k, team: '', positions: '' }
      : { playerKey: k, name: p.name, team: p.nhlTeam, positions: p.eligible.join(',') };
  });
}

/** The propose tools a switch can apply to, with the first sentence of each description. */
export function proposeToolList(): { name: string; description: string }[] {
  return Object.values(ALL_TOOLS)
    .filter((t) => t.risk === 'propose')
    .map((t) => ({ name: t.name, description: firstSentence(t.description) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return m?.[1] ?? s;
}

export function permissionsView(
  store: Store,
  file: string,
  userId: string,
  view: LeagueView | undefined,
): {
  permissions: Record<string, unknown>;
  players: PlayerRef[];
  tools: { name: string; description: string }[];
  updatedAt: string | null;
} {
  const permissions = userPermissions(store, file, userId);
  return {
    permissions,
    players: playerRefs([...permissions.players.locked, ...permissions.players.ask], view),
    tools: proposeToolList(),
    updatedAt: store.permissions.record(userId)?.updatedAt ?? null,
  };
}
