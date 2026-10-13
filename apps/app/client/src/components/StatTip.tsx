import { CATEGORY_GLOSSARY, GLOSSARY, type GlossaryKey } from '@fha/core';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * A stat's explainer (D-026): hover on a pointer device, tap on a phone. The text comes from the
 * shared glossary the agents also read, so the page and the chat define a number the same way.
 *
 * `k` names a glossary entry; `cat` a scoring category. The children are the visible label
 * (defaults to the glossary's own label).
 */
export function StatTip({
  k,
  cat,
  children,
  className = '',
}: {
  k?: GlossaryKey;
  cat?: string;
  children?: ReactNode;
  className?: string;
}) {
  const entry = k === undefined ? undefined : GLOSSARY[k];
  const catText = cat === undefined ? undefined : CATEGORY_GLOSSARY[cat];
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>();
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const r = btn.current?.getBoundingClientRect();
    if (r !== undefined) {
      const width = Math.min(288, window.innerWidth - 32);
      const left = Math.min(
        Math.max(16, r.left + r.width / 2 - width / 2),
        window.innerWidth - 16 - width,
      );
      setPos({ left, top: r.bottom + 6, width });
    }
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.target instanceof Node && btn.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  if (entry === undefined && catText === undefined) return <>{children}</>;
  const hoverable = () => window.matchMedia('(hover: hover)').matches;
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseEnter={() => hoverable() && setOpen(true)}
        onMouseLeave={() => hoverable() && setOpen(false)}
        className={`cursor-help underline decoration-mut/60 decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-brand ${className}`}
      >
        {children ?? entry?.label ?? cat}
      </button>
      {open && pos !== undefined ? (
        <span
          id={id}
          role="tooltip"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className="fixed z-50 block rounded-lg border border-line bg-raised p-3 text-left text-xs font-normal normal-case tracking-normal text-soft shadow-lg"
        >
          {entry !== undefined ? (
            <>
              <span className="block font-semibold text-ink">{entry.label}</span>
              <span className="mt-1 block">{entry.short}</span>
              <span className="mt-1 block text-mut">{entry.long}</span>
            </>
          ) : (
            <>
              <span className="block font-semibold text-ink">{cat}</span>
              <span className="mt-1 block">{catText}</span>
            </>
          )}
        </span>
      ) : null}
    </>
  );
}
