import type { ReactNode } from 'react';

/**
 * The app's few icons as inline stroke SVG: they follow `currentColor`, so a theme or an
 * active state recolours them, and they look the same on every platform (emoji did not).
 */
function Icon({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const ChatIcon = () => (
  <Icon>
    <path d="M4 5h16v11H9l-5 4z" />
  </Icon>
);

/** A hockey jersey. */
export const TeamIcon = () => (
  <Icon>
    <path d="M8 3 3 6l2 5 3-1v11h8V10l3 1 2-5-5-3c-1 2-2.4 3-4 3S9 5 8 3z" />
  </Icon>
);

export const DecisionsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12 3 3 5-6" />
  </Icon>
);

export const PlayersIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m16 16 5 5" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <path d="M4 7h10M18 7h2M16 5v4M4 17h4M12 17h8M10 15v4" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon size={20}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon size={20}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ArrowDownIcon = () => (
  <Icon size={16}>
    <path d="M12 5v14M5 12l7 7 7-7" />
  </Icon>
);

/** Send: an arrow up, as messaging apps draw it. */
export const SendIcon = () => (
  <Icon size={20}>
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
  </Icon>
);

/** Stop a streaming reply: a filled square. */
export const StopIcon = () => (
  <svg aria-hidden width={14} height={14} viewBox="0 0 14 14" fill="currentColor">
    <rect x="1" y="1" width="12" height="12" rx="2" />
  </svg>
);

/** Retry: a circular arrow. */
export const RetryIcon = () => (
  <Icon size={14}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
  </Icon>
);
