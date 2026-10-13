import { useCallback, useState } from 'react';

/**
 * Light, dark, or follow the phone (D-019). The colours themselves are CSS (`light-dark()` in
 * styles.css); a choice only sets `data-theme` on <html>, which pins `color-scheme`. The same
 * key is read by the inline script in index.html before first paint, so a forced theme never
 * flashes the other one. Stored per device: it's a viewing preference, not account data.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'fha.theme';

/** The status-bar / title-bar colour per theme: each theme's page background. */
export const THEME_COLOR = { light: '#f3f7fa', dark: '#0a1520' } as const;

export function parseTheme(value: string | null): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readTheme(): ThemeChoice {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/**
 * The `theme-color` each <meta> should carry: index.html has one per colour scheme (by
 * `media`); a forced theme gives both its own colour, so the status bar matches the app.
 */
export function metaThemeColor(choice: ThemeChoice, media: string | null): string {
  if (choice !== 'system') return THEME_COLOR[choice];
  return media?.includes('dark') ? THEME_COLOR.dark : THEME_COLOR.light;
}

export function applyTheme(choice: ThemeChoice, doc: Document = document): void {
  if (choice === 'system') delete doc.documentElement.dataset['theme'];
  else doc.documentElement.dataset['theme'] = choice;
  doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = metaThemeColor(choice, meta.getAttribute('media'));
  });
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const set = useCallback((next: ThemeChoice) => {
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode or blocked storage: the choice still applies until the app is closed.
    }
    applyTheme(next);
    setChoice(next);
  }, []);
  return [choice, set];
}
