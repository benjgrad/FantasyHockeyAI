import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Which player's sheet is open. Two ways in, both deep-linkable: `/players/:playerKey` (a
 * shared link, the browser's own rows) and `?player=` on any page (a name tapped in Team,
 * Decisions or chat), so the sheet opens over the page without leaving it.
 */
export const SHEET_PARAM = 'player';
const PATH = /^\/players\/([^/]+)$/;

export function usePlayerSheet(): {
  key: string | null;
  open: (k: string) => void;
  close: () => void;
} {
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const fromPath = PATH.exec(pathname)?.[1];
  const key = params.get(SHEET_PARAM) ?? (fromPath ? decodeURIComponent(fromPath) : null);

  const open = useCallback(
    (k: string) => {
      const next = new URLSearchParams(params);
      next.set(SHEET_PARAM, k);
      setParams(next);
    },
    [params, setParams],
  );
  const close = useCallback(() => {
    if (params.has(SHEET_PARAM)) {
      const next = new URLSearchParams(params);
      next.delete(SHEET_PARAM);
      setParams(next);
    } else if (fromPath) void navigate('/players');
  }, [params, setParams, fromPath, navigate]);
  return { key, open, close };
}

/** Router state key the chat composer reads to prefill its text ("Ask the GM about him"). */
export const CHAT_PREFILL = 'prefill';

export function chatPrefillFrom(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const v = (state as Record<string, unknown>)[CHAT_PREFILL];
  return typeof v === 'string' ? v : undefined;
}
