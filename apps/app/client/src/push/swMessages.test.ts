import { describe, expect, it } from 'vitest';
import { navigateTargetFor } from './swMessages';

describe('navigateTargetFor', () => {
  it('accepts an in-app path', () => {
    expect(navigateTargetFor('/decisions/abc')).toBe('/decisions/abc');
    expect(navigateTargetFor('/')).toBe('/');
  });

  it('refuses anything that could leave the app', () => {
    for (const bad of [
      'https://evil.example/',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      'decisions',
      3,
      null,
    ]) {
      expect(navigateTargetFor(bad)).toBeNull();
    }
  });
});
