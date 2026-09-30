/**
 * Whether to show the "Share → Add to Home Screen" hint. iOS Safari has no install prompt
 * (`beforeinstallprompt` never fires), and on iOS web push only works in the installed app,
 * so without this hint an iPhone user has no way to learn either fact.
 */
export const IOS_HINT_DISMISSED_KEY = 'fha:ios-install-hint-dismissed';

export interface IosHintEnv {
  readonly userAgent: string;
  /** `navigator.maxTouchPoints`: iPadOS reports a desktop Mac user agent, but has touch. */
  readonly maxTouchPoints: number;
  /** Already running from the Home Screen. */
  readonly standalone: boolean;
  /** Dismissed before (remembered in localStorage). */
  readonly dismissed: boolean;
}

export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/** Safari itself: the other iOS browsers wrap WebKit but have their own (different) share UI. */
export function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  return (
    isIosDevice(userAgent, maxTouchPoints) &&
    /Safari/.test(userAgent) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|DuckDuckGo/.test(userAgent)
  );
}

export function shouldShowIosHint(env: IosHintEnv): boolean {
  return !env.standalone && !env.dismissed && isIosSafari(env.userAgent, env.maxTouchPoints);
}
