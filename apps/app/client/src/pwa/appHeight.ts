/**
 * The installed iOS app's height, measured instead of trusted.
 *
 * An app added to the Home Screen with a black-translucent status bar draws under the clock, and
 * iOS 26 WebKit reports its height short by the status-bar height (dvh, svh, %, the fixed inset):
 * a dead strip under the bottom nav. 100lvh came out too tall on Ben's phone, cutting the nav off.
 * The app fills the physical screen in that case, so `screen` is the one reliable number.
 *
 * Only then: an app drawn below an opaque status bar (top inset 0), or any browser tab, keeps the
 * normal layout, where the keyboard still resizes things.
 */
export function fullHeight(o: {
  standalone: boolean;
  topInset: number;
  screenW: number;
  screenH: number;
  landscape: boolean;
}): number | undefined {
  if (!o.standalone || o.topInset <= 0) return undefined;
  // iOS keeps `screen` in portrait terms whatever the orientation.
  return o.landscape ? Math.min(o.screenW, o.screenH) : Math.max(o.screenW, o.screenH);
}

/** The top safe-area inset in px, read from CSS (JS has no direct access to env()). */
function topInset(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top);visibility:hidden';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}

/** Sets `--app-height` on the root element when the installed app needs it; keeps it current. */
export function trackAppHeight(): void {
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (!standalone) return;
  const apply = () => {
    const h = fullHeight({
      standalone,
      topInset: topInset(),
      screenW: window.screen.width,
      screenH: window.screen.height,
      landscape: window.matchMedia('(orientation: landscape)').matches,
    });
    const root = document.documentElement.style;
    if (h === undefined) root.removeProperty('--app-height');
    else root.setProperty('--app-height', `${h}px`);
  };
  apply();
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  window.addEventListener('resize', apply);
}
