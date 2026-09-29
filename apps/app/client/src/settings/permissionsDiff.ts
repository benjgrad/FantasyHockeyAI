import {
  PLAN_KINDS,
  type GateMode,
  type Permissions,
  type PlanKind,
  type PlanLimits,
} from '@fha/core';

/**
 * What a Permissions edit changes, and which changes *widen* the agents' autonomy.
 *
 * Saving shows every change; any widening change needs an explicit confirmation. This is the
 * UI half only — the server gate stays the enforcement (P2) — but a one-tap "dry run off" is
 * exactly the kind of irreversible-feeling change that should never happen by accident.
 */
export interface Change {
  /** A stable key, e.g. `plans.addDrop.mode`. */
  path: string;
  /** A readable sentence. */
  label: string;
  widens: boolean;
}

const MODE_RANK: Record<GateMode, number> = { deny: 0, ask: 1, allow: 2 };

export const PLAN_LABELS: Record<PlanKind, string> = {
  lineup: 'Lineup changes',
  addDrop: 'Add / drop',
  waiverClaim: 'Waiver claims',
  tradePropose: 'Propose trades',
  tradeRespond: 'Respond to trades',
  draftPick: 'Draft picks',
};

/** The gate fails closed: a kind missing from `plans` is `deny`. */
export function modeOf(perms: Permissions, kind: PlanKind): GateMode {
  return perms.plans[kind]?.mode ?? 'deny';
}

export function limitsOf(perms: Permissions, kind: PlanKind): PlanLimits {
  return perms.plans[kind]?.limits ?? {};
}

export function toolEnabled(perms: Permissions, name: string): boolean {
  return perms.tools[name] !== false;
}

/** A limit field's text as a stored value; blank or junk means no limit. FAAB is typed as %. */
export function parseLimit(key: keyof PlanLimits, raw: string): number | undefined {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return undefined;
  if (key === 'maxFaabPerClaimPct') return Math.min(Math.max(n, 0), 100) / 100;
  if (key === 'maxPerWeek') return Math.max(0, Math.round(n));
  return n;
}

type NameOf = (playerKey: string) => string;

export function diffPermissions(
  before: Permissions,
  after: Permissions,
  nameOf: NameOf = (k) => k,
): Change[] {
  return [
    ...diffSwitches(before, after),
    ...diffPlans(before, after),
    ...diffPlayers(before, after, nameOf),
    ...diffTools(before, after),
    ...diffProtected(before, after),
  ];
}

function diffSwitches(before: Permissions, after: Permissions): Change[] {
  const out: Change[] = [];
  if (before.dryRun !== after.dryRun) {
    out.push({
      path: 'dryRun',
      label: after.dryRun
        ? 'Dry run ON: nothing will be executed on Yahoo'
        : 'Dry run OFF: allowed plans will really execute on Yahoo',
      widens: !after.dryRun,
    });
  }
  if (before.paused !== after.paused) {
    out.push({
      path: 'paused',
      label: after.paused
        ? 'Pause every write (kill switch on)'
        : 'Resume writes (kill switch off)',
      widens: !after.paused,
    });
  }
  return out;
}

function diffPlans(before: Permissions, after: Permissions): Change[] {
  const out: Change[] = [];
  for (const kind of PLAN_KINDS) {
    const from = modeOf(before, kind);
    const to = modeOf(after, kind);
    if (from !== to) {
      out.push({
        path: `plans.${kind}.mode`,
        label: `${PLAN_LABELS[kind]}: ${from} → ${to}`,
        widens: MODE_RANK[to] > MODE_RANK[from],
      });
    }
    out.push(...diffLimits(kind, limitsOf(before, kind), limitsOf(after, kind)));
  }
  return out;
}

const LIMITS: { key: keyof PlanLimits; label: string; higherWidens: boolean }[] = [
  { key: 'maxPerWeek', label: 'max per week', higherWidens: true },
  { key: 'maxFaabPerClaimPct', label: 'max FAAB per claim', higherWidens: true },
  { key: 'minTradeGain', label: 'min trade gain', higherWidens: false },
];

function diffLimits(kind: PlanKind, before: PlanLimits, after: PlanLimits): Change[] {
  const out: Change[] = [];
  for (const { key, label, higherWidens } of LIMITS) {
    const from = before[key];
    const to = after[key];
    if (from === to) continue;
    // Removing a limit widens; adding one narrows; otherwise the direction decides.
    const widens =
      to === undefined ? true : from === undefined ? false : higherWidens ? to > from : to < from;
    out.push({
      path: `plans.${kind}.limits.${key}`,
      label: `${PLAN_LABELS[kind]}: ${label} ${show(key, from)} → ${show(key, to)}`,
      widens,
    });
  }
  return out;
}

function show(key: keyof PlanLimits, value: number | undefined): string {
  if (value === undefined) return 'none';
  return key === 'maxFaabPerClaimPct' ? `${Math.round(value * 100)}%` : String(value);
}

function diffPlayers(before: Permissions, after: Permissions, nameOf: NameOf): Change[] {
  const out: Change[] = [];
  for (const list of ['locked', 'ask'] as const) {
    const was = new Set(before.players[list]);
    const now = new Set(after.players[list]);
    const what = list === 'locked' ? 'locked' : 'always ask';
    for (const key of now) {
      if (!was.has(key)) {
        out.push({
          path: `players.${list}.${key}`,
          label: `${nameOf(key)}: now ${what}`,
          widens: false,
        });
      }
    }
    for (const key of was) {
      if (!now.has(key)) {
        out.push({
          path: `players.${list}.${key}`,
          label: `${nameOf(key)}: no longer ${what}`,
          widens: true,
        });
      }
    }
  }
  return out;
}

function diffTools(before: Permissions, after: Permissions): Change[] {
  const names = new Set([...Object.keys(before.tools), ...Object.keys(after.tools)]);
  const out: Change[] = [];
  for (const name of [...names].sort()) {
    const from = toolEnabled(before, name);
    const to = toolEnabled(after, name);
    if (from === to) continue;
    out.push({ path: `tools.${name}`, label: `Tool ${name}: ${to ? 'on' : 'off'}`, widens: to });
  }
  return out;
}

function diffProtected(before: Permissions, after: Permissions): Change[] {
  const from = before.protected.topNByVorp;
  const to = after.protected.topNByVorp;
  if (from === to) return [];
  return [
    {
      path: 'protected.topNByVorp',
      label: `Protected top players by VORP: ${from} → ${to}`,
      widens: to < from,
    },
  ];
}

export function widensAutonomy(changes: Change[]): boolean {
  return changes.some((c) => c.widens);
}
