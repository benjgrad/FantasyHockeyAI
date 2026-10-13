import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { CloseIcon } from './icons';

/** How far (px) the sheet must be dragged down before letting go closes it. */
const DISMISS_PX = 96;

/**
 * A bottom sheet on a phone, a side panel on a wider screen. Escape, the scrim, the ✕ and (on a
 * phone) a swipe down on the handle all close it; its own content scrolls without dragging the
 * page behind it. `escape: false` when another sheet is open on top, so one Escape closes one.
 */
export function Sheet({
  label,
  onClose,
  escape = true,
  children,
}: {
  label: string;
  onClose: () => void;
  escape?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!escape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escape, onClose]);
  const drag = useSwipeDown(onClose);
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={label}>
      <button
        className="absolute inset-0 bg-scrim"
        aria-label={`Close ${label.toLowerCase()}`}
        onClick={onClose}
      />
      <div
        style={drag.offset > 0 ? { transform: `translateY(${drag.offset}px)` } : undefined}
        className={`absolute inset-x-0 bottom-0 flex animate-sheet-in sm:animate-none max-h-[88dvh] flex-col rounded-t-2xl border border-line bg-card shadow-2xl sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[440px] sm:rounded-none sm:rounded-l-2xl ${drag.active ? '' : 'transition-transform'}`}
      >
        <div className="relative flex touch-none justify-center px-4 pt-1" {...drag.handlers}>
          <span aria-hidden className="mt-2 h-1.5 w-10 rounded-full bg-line sm:hidden" />
          <button className="icon-btn absolute top-0 right-1" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pt-6 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Drag-to-dismiss on the sheet's handle row: follows the finger down, closes past DISMISS_PX. */
function useSwipeDown(onDismiss: () => void) {
  const start = useRef<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState(false);
  const end = (dismiss: boolean) => {
    start.current = null;
    setActive(false);
    setOffset(0);
    if (dismiss) onDismiss();
  };
  return {
    offset,
    active,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        start.current = e.clientY;
        setActive(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: PointerEvent) => {
        if (start.current !== null) setOffset(Math.max(0, e.clientY - start.current));
      },
      onPointerUp: () => end(offset > DISMISS_PX),
      onPointerCancel: () => end(false),
    },
  };
}
