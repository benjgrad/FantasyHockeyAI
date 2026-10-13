import type { ReactNode } from 'react';
import { usePlayerSheet } from './sheet';

/** A player's name that opens his card over the current page. */
export function PlayerLink({
  playerKey,
  children,
  className = '',
}: {
  playerKey: string;
  children: ReactNode;
  className?: string;
}) {
  const { open } = usePlayerSheet();
  return (
    <button
      type="button"
      className={`cursor-pointer text-left underline decoration-line decoration-dotted underline-offset-2 hover:text-acc focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-brand ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        open(playerKey);
      }}
    >
      {children}
    </button>
  );
}
