import { describe, expect, it } from 'vitest';
import { availabilityTone, groupOf } from './roster';

describe('roster grouping', () => {
  it('sorts Yahoo slots into active, bench and IR', () => {
    expect(groupOf('C')).toBe('active');
    expect(groupOf('Util')).toBe('active');
    expect(groupOf('G')).toBe('active');
    expect(groupOf('BN')).toBe('bench');
    expect(groupOf('IR+')).toBe('ir');
    expect(groupOf('ir')).toBe('ir');
  });

  it('colours availability by play probability', () => {
    expect(availabilityTone(1)).toBe('good');
    expect(availabilityTone(0.5)).toBe('warn');
    expect(availabilityTone(0)).toBe('bad');
  });
});
