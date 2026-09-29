import type { ExecResult, ExecutionAdapter, Plan } from '@fha/core';

/**
 * Execution adapters (§10.6). Only these touch the outside world, and only the pipeline calls
 * them, after validation and the gate.
 *
 * There is deliberately no Yahoo adapter yet. Q-007 found the "start active players" endpoint
 * in Yahoo's site JS but never exercised it, and has not observed the custom-lineup, add/drop
 * or trade endpoints at all. An adapter written against an unobserved endpoint would be a stub
 * that looks implemented (§24.11). It arrives when a real roster lets us capture the calls.
 */
export class DryRunAdapter implements ExecutionAdapter {
  readonly name = 'dryRun' as const;
  readonly executed: Plan[] = [];

  execute(plan: Plan): Promise<ExecResult> {
    this.executed.push(plan);
    return Promise.resolve({
      status: 'done',
      detail: `dry run: would execute ${describePlan(plan)}`,
    });
  }
}

/** Prints the exact action for Ben to do by hand, then waits for `fha confirm <planId>`. */
export class ManualAdapter implements ExecutionAdapter {
  readonly name = 'manual' as const;

  constructor(private readonly notify: (text: string) => void) {}

  execute(plan: Plan): Promise<ExecResult> {
    const text = `ACTION NEEDED (${plan.planId}): ${describePlan(plan)}. Then run: fha confirm ${plan.planId}`;
    this.notify(text);
    return Promise.resolve({ status: 'needsHuman', detail: text });
  }
}

export function describePlan(plan: Plan, name: (k: string) => string = (k) => k): string {
  const p = plan.payload;
  switch (p.kind) {
    case 'lineup':
      return `set lineup for ${p.date}: ${p.moves.map((m) => `${name(m.playerKey)}→${m.slot}`).join(', ')}`;
    case 'addDrop':
      return [p.add && `add ${name(p.add)}`, p.drop && `drop ${name(p.drop)}`]
        .filter(Boolean)
        .join(', ');
    case 'waiverClaim':
      return `claim ${name(p.add)}${p.drop === undefined ? '' : `, dropping ${name(p.drop)}`}`;
    case 'tradePropose':
      return `offer ${p.give.map(name).join(' + ')} for ${p.get.map(name).join(' + ')} to ${p.partnerTeamKey}`;
    case 'tradeRespond':
      return `${p.action} trade ${p.transactionKey}`;
    case 'draftPick':
      return `draft ${name(p.playerKey)}`;
  }
}
