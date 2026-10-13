import { describe, expect, it } from 'vitest';
import { THEME_COLOR, metaThemeColor, parseTheme } from './theme';

describe('theme choice', () => {
  it('reads only light and dark as a pinned theme; anything else follows the system', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme(null)).toBe('system');
    expect(parseTheme('sepia')).toBe('system');
  });

  it('gives the status bar the pinned theme on both scheme metas, or each its own', () => {
    expect(metaThemeColor('dark', '(prefers-color-scheme: light)')).toBe(THEME_COLOR.dark);
    expect(metaThemeColor('light', '(prefers-color-scheme: dark)')).toBe(THEME_COLOR.light);
    expect(metaThemeColor('system', '(prefers-color-scheme: dark)')).toBe(THEME_COLOR.dark);
    expect(metaThemeColor('system', '(prefers-color-scheme: light)')).toBe(THEME_COLOR.light);
  });
});
