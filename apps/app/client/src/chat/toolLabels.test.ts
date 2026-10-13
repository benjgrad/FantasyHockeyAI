import { describe, expect, it } from 'vitest';
import { inputPreview, toolLabel } from './toolLabels';

describe('tool chips', () => {
  it('names tools in plain words, falling back to the raw name', () => {
    expect(toolLabel('getRoster')).toBe('Read your roster');
    expect(toolLabel('somethingNew')).toBe('somethingNew');
  });

  it('previews the arguments on one line', () => {
    expect(inputPreview('partnerTeamName: Mock Team 3\ngive: 477.p.1, 477.p.2')).toBe(
      'Mock Team 3 · 477.p.1, 477.p.2',
    );
    expect(inputPreview(undefined)).toBeUndefined();
    expect(inputPreview('q: ' + 'x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});
