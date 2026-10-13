import { describe, expect, it } from 'vitest';
import { fullHeight } from './appHeight';

const iphone = { screenW: 390, screenH: 844 };

describe('fullHeight', () => {
  it('sizes the installed app to the screen when it draws under the status bar', () => {
    expect(fullHeight({ standalone: true, topInset: 47, landscape: false, ...iphone })).toBe(844);
    expect(fullHeight({ standalone: true, topInset: 47, landscape: true, ...iphone })).toBe(390);
  });

  it('leaves the normal layout alone in a browser tab or below an opaque status bar', () => {
    expect(
      fullHeight({ standalone: false, topInset: 47, landscape: false, ...iphone }),
    ).toBeUndefined();
    expect(
      fullHeight({ standalone: true, topInset: 0, landscape: false, ...iphone }),
    ).toBeUndefined();
  });
});
