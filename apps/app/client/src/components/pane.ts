import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * A route's scroll area (`.pane`) remembers where Ben was, per page, for the session: going
 * Team → Chat → Team lands back on the same row. The page never scrolls itself, so iOS's
 * tap-the-status-bar-to-top can't work; tapping the active tab does that instead
 * (`scrollPaneToTop`, from Layout).
 */
const positions = new Map<string, number>();
let current: HTMLElement | null = null;

/** How long a restore keeps retrying while the page's data arrives and the content grows. */
const RESTORE_MS = 2000;

export function savedScroll(key: string): number {
  return positions.get(key) ?? 0;
}

export function rememberScroll(key: string, top: number): void {
  if (top > 0) positions.set(key, top);
  else positions.delete(key);
}

function smooth(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Scrolls the visible page back to its top. False when there is no pane to scroll. */
export function scrollPaneToTop(): boolean {
  if (!current) return false;
  current.scrollTo({ top: 0, behavior: smooth() });
  return true;
}

/** A ref for a route's `.pane`: restores its scroll on mount and keeps it up to date. */
export function usePane(): (el: HTMLElement | null) => (() => void) | undefined {
  const { pathname } = useLocation();
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      current = el;
      const target = savedScroll(pathname);
      // Retry each frame until the content is tall enough to land on, or Ben scrolls himself.
      let settled = target === 0;
      let frame = 0;
      const started = performance.now();
      const restore = () => {
        if (settled) return;
        el.scrollTop = target;
        if (Math.abs(el.scrollTop - target) < 2 || performance.now() - started > RESTORE_MS) {
          settled = true;
        } else frame = requestAnimationFrame(restore);
      };
      restore();
      const stop = () => {
        settled = true;
      };
      const onScroll = () => {
        if (settled) rememberScroll(pathname, el.scrollTop);
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      el.addEventListener('touchstart', stop, { passive: true });
      el.addEventListener('wheel', stop, { passive: true });
      return () => {
        cancelAnimationFrame(frame);
        el.removeEventListener('scroll', onScroll);
        el.removeEventListener('touchstart', stop);
        el.removeEventListener('wheel', stop);
        if (current === el) current = null;
      };
    },
    [pathname],
  );
}
