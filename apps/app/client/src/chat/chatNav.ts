import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** How close (px) to the bottom still counts as "following" the conversation. */
const FOLLOW_PX = 80;

/**
 * Keeps the newest turn in view while Ben is at the bottom, and leaves him alone once he
 * scrolls up to read: a streaming reply no longer yanks the view down on every token.
 * `behind` is true when there is newer content below; `jump` scrolls to it.
 */
export function useFollowBottom(deps: readonly unknown[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX);
  }, []);

  useEffect(() => {
    // Re-runs whenever the turns change (deps) or Ben comes back to the bottom.
    if (following) bottom.current?.scrollIntoView({ block: 'end' });
  }, [following, ...deps]);

  const jump = useCallback(() => {
    setFollowing(true);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    bottom.current?.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  return { scroller, bottom, onScroll, behind: !following, jump };
}

const DRAWER = 'conversationsOpen';
/** A leftward swipe (px) on the open drawer that closes it. */
const SWIPE_CLOSE_PX = 60;

/**
 * The phone's conversation drawer lives in history (router state), so the back gesture closes
 * it instead of leaving the chat. Picking a conversation replaces the drawer's entry.
 */
export function useConversationDrawer() {
  const location = useLocation();
  const navigate = useNavigate();
  const isOpen =
    typeof location.state === 'object' && location.state !== null && DRAWER in location.state;
  const open = () =>
    void navigate(location.pathname + location.search, { state: { [DRAWER]: true } });
  const close = () => void navigate(-1);

  const startX = useRef<number | null>(null);
  const swipe = {
    onPointerDown: (e: PointerEvent) => {
      startX.current = e.clientX;
    },
    onPointerUp: (e: PointerEvent) => {
      if (startX.current !== null && startX.current - e.clientX > SWIPE_CLOSE_PX) close();
      startX.current = null;
    },
  };
  return { isOpen, open, close, swipe };
}
