import { describe, expect, it } from 'vitest';
import { DecisionStatus, NotificationKind } from '@fha/api';
import { DECISION_STATUSES } from '@fha/store';
import { NOTIFICATION_KINDS } from './push.js';

/** The contract's enums must match what the server actually stores and sends. */
describe('HTTP contract enums', () => {
  it('DecisionStatus is exactly the store’s decision statuses', () => {
    expect([...DecisionStatus.options].sort()).toEqual([...DECISION_STATUSES].sort());
  });

  it('NotificationKind is exactly the kinds the push service sends', () => {
    expect([...NotificationKind.options].sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });
});
