import type { Plan, PlanPayload } from '@fha/core';
import { openStore, type Store } from './store.js';

/** A settable clock, so tests move time explicitly instead of sleeping. */
export function fakeClock(start = '2026-10-06T12:00:00.000Z') {
  let t = new Date(start);
  return {
    now: () => new Date(t),
    set: (iso: string) => {
      t = new Date(iso);
    },
    advance: (ms: number) => {
      t = new Date(t.getTime() + ms);
    },
  };
}

export function memStore(clock = fakeClock()): {
  store: Store;
  clock: ReturnType<typeof fakeClock>;
} {
  return { store: openStore(':memory:', { now: clock.now }), clock };
}

let seq = 0;
export function plan(payload: PlanPayload, over: Partial<Plan> = {}): Plan {
  seq += 1;
  return {
    planId: `plan-${seq}`,
    runId: 'run-1',
    agent: 'waivers',
    sourceTool: 'proposeAddDrop',
    createdAt: '2026-10-06T12:00:00.000Z',
    rationale: 'because',
    payload,
    ...over,
  };
}

export const P = (id: number) => `465.p.${id}`;
