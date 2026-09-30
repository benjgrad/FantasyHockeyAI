import { IOS_HINT_DISMISSED_KEY, shouldShowIosHint } from './iosHint';

/**
 * The browser-facing half of the PWA helpers: reads of `navigator`, `matchMedia` and
 * localStorage, each guarded, so a private window or a blocked storage never breaks the app.
 */

/** Running as the installed app (Home Screen on iOS, an app window on Android/desktop). */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Storage blocked: the hint may show again next time, which is harmless.
  }
}

export function iosHintVisible(): boolean {
  return shouldShowIosHint({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: isStandalone(),
    dismissed: readFlag(IOS_HINT_DISMISSED_KEY),
  });
}

export function dismissIosHint(): void {
  writeFlag(IOS_HINT_DISMISSED_KEY);
}
