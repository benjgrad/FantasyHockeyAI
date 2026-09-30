import { useSyncExternalStore } from 'react';

/**
 * The Android/desktop install prompt. Chrome fires `beforeinstallprompt` once, early, and only
 * if the page is installable; the event must be kept to call `prompt()` later from a click.
 * `listenForInstallPrompt()` is called from main.tsx before React renders so the event is not
 * missed. (iOS never fires it — see iosHint.ts.)
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallState {
  /** The browser offered an install prompt we can show. */
  readonly canInstall: boolean;
  /** Installed during this session (`appinstalled`). */
  readonly installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canInstall: false, installed: false };
const listeners = new Set<() => void>();

function set(next: InstallState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function listenForInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress the mini-infobar: the Settings button is where installing is offered.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    set({ ...state, canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canInstall: false, installed: true });
  });
}

/** Shows the browser's install dialog. The event is single-use either way. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  set({ ...state, canInstall: false });
  await event.prompt();
  return (await event.userChoice).outcome;
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
