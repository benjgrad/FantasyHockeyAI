import {
  ASK_TIMEOUT_MAX_MINUTES,
  ASK_TIMEOUT_MIN_MINUTES,
  PLAN_KINDS,
  askTimeoutMinutes,
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

/** Ask with timeout (D-018) sits between ask and allow: it acts unless Ben says no in time. */
const MODE_RANK: Record<GateMode, number> = { deny: 0, ask: 1, askTimeout: 2, allow: 3 };

/** How a mode reads in the editor and the review list. */
export const MODE_LABELS: Record<GateMode, string> = {
  deny: 'deny',
  ask: 'ask',
  askTimeout: 'ask, then do',
  allow: 'allow',
};

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

/** Minutes an ask with timeout waits for a reject, with the default applied. */
export function timeoutOf(perms: Permissions, kind: PlanKind): number {
  return askTimeoutMinutes(perms.plans[kind]);
}

/** The minutes field as typed: blank or junk keeps `current`; clamped to 5–1440 whole minutes. */
export function parseTimeout(raw: string, current: number): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return current;
  return Math.min(ASK_TIMEOUT_MAX_MINUTES, Math.max(ASK_TIMEOUT_MIN_MINUTES, Math.round(n)));
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
    ...diffAutoGrab(before.autoGrab, after.autoGrab),
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
    const minutes = (p: Permissions, m: GateMode) =>
      m === 'askTimeout' ? ` after ${timeoutOf(p, kind)} min` : '';
    if (from !== to) {
      out.push({
        path: `plans.${kind}.mode`,
        label: `${PLAN_LABELS[kind]}: ${MODE_LABELS[from]}${minutes(before, from)} → ${MODE_LABELS[to]}${minutes(after, to)}`,
        widens: MODE_RANK[to] > MODE_RANK[from],
      });
    } else if (to === 'askTimeout' && timeoutOf(before, kind) !== timeoutOf(after, kind)) {
      // Less time to say no is more autonomy.
      out.push({
        path: `plans.${kind}.timeoutMinutes`,
        label: `${PLAN_LABELS[kind]}: do it after ${timeoutOf(before, kind)} → ${timeoutOf(after, kind)} min unless you reject`,
        widens: timeoutOf(after, kind) < timeoutOf(before, kind),
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

/** Auto-grab's minimum gain as typed; blank or junk keeps `current`, negatives become 0. */
export function parseMinGain(raw: string, current: number): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return current;
  return Math.max(0, Math.round(n * 100) / 100);
}

/**
 * Auto-grab (D-016) acts between scheduled runs, so switching it on, lowering its bar, letting it
 * act through dry run or loosening its weekly cap all widen autonomy.
 */
export function diffAutoGrab(
  before: Permissions['autoGrab'],
  after: Permissions['autoGrab'],
): Change[] {
  const out: Change[] = [];
  if (before.enabled !== after.enabled) {
    out.push({
      path: 'autoGrab.enabled',
      label: after.enabled
        ? 'Auto-grab ON: substantial upgrades are acted on at once'
        : 'Auto-grab OFF: upgrades wait for the daily waivers run',
      widens: after.enabled,
    });
  }
  if (before.minGain !== after.minGain) {
    out.push({
      path: 'autoGrab.minGain',
      label: `Auto-grab minimum gain: ${before.minGain} → ${after.minGain}`,
      widens: after.minGain < before.minGain,
    });
  }
  if (before.ignoreDryRun !== after.ignoreDryRun) {
    out.push({
      path: 'autoGrab.ignoreDryRun',
      label: after.ignoreDryRun
        ? 'Auto-grab acts even while dry run is on: free-agent adds really execute on Yahoo'
        : 'Auto-grab respects dry run: it proposes instead of acting',
      widens: after.ignoreDryRun,
    });
  }
  const from = before.maxPerWeek;
  const to = after.maxPerWeek;
  if (from !== to) {
    out.push({
      path: 'autoGrab.maxPerWeek',
      label: `Auto-grab max per week: ${from ?? 'none'} → ${to ?? 'none'}`,
      widens: to === undefined ? true : from === undefined ? false : to > from,
    });
  }
  return out;
}

export function widensAutonomy(changes: Change[]): boolean {
  return changes.some((c) => c.widens);
}
