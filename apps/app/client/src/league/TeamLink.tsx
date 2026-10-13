import type { ReactNode } from 'react';
import { useTeamSheet } from './teamSheet';

/** A fantasy team's name that opens its sheet over the current page. */
export function TeamLink({ teamKey, children }: { teamKey: string; children: ReactNode }) {
  const { open } = useTeamSheet();
  return (
    <button
      type="button"
      className="cursor-pointer text-left underline decoration-line decoration-dotted underline-offset-2 hover:text-acc focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-brand"
      onClick={(e) => {
        e.stopPropagation();
        open(teamKey);
      }}
    >
      {children}
    </button>
  );
}
