/**
 * The conversation Ben was last in, so the Chat tab returns to it instead of a blank new chat.
 *
 * Per device, in localStorage. Storage can be unavailable (private mode, blocked site data), so
 * every access is guarded and the fallback is simply a new chat.
 */
const KEY = 'fha.lastConversation';

export function rememberConversation(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    // Storage unavailable: the Chat tab falls back to a new chat.
  }
}

export function lastConversation(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Where the Chat tab should go. */
export function chatHref(last: string | null): string {
  return last === null || last === '' ? '/' : `/c/${encodeURIComponent(last)}`;
}

/** The Chat tab is "current" on a new chat and on any conversation. */
export function isChatPath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/c/');
}
