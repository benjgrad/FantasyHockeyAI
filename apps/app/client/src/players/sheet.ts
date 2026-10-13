import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Which player's sheet is open. Two ways in, both deep-linkable: `/players/:playerKey` (a
 * shared link, the browser's own rows) and `?player=` on any page (a name tapped in Team,
 * Decisions or chat), so the sheet opens over the page without leaving it.
 */
export const SHEET_PARAM = 'player';
/** Router state marking a sheet opened from inside the app, so closing it can go back. */
const OPENED_HERE = 'sheetOpenedHere';
const PATH = /^\/players\/([^/]+)$/;

export function usePlayerSheet(): {
  key: string | null;
  open: (k: string) => void;
  close: () => void;
} {
  const sheet = useParamSheet(SHEET_PARAM);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const fromPath = PATH.exec(pathname)?.[1];
  const key = sheet.key ?? (fromPath ? decodeURIComponent(fromPath) : null);
  const { close: closeParam } = sheet;
  const close = useCallback(() => {
    if (sheet.key !== null) closeParam();
    else if (fromPath) void navigate('/players');
  }, [sheet.key, closeParam, fromPath, navigate]);
  return { key, open: sheet.open, close };
}

/**
 * A sheet named by one query parameter (`?player=`, `?team=`), opened over whatever page is
 * showing. Opening pushes history, so the back gesture closes it.
 */
export function useParamSheet(param: string): {
  key: string | null;
  open: (k: string) => void;
  close: () => void;
} {
  const [params, setParams] = useSearchParams();
  const { state } = useLocation();
  const navigate = useNavigate();
  const key = params.get(param);

  const open = useCallback(
    (k: string) => {
      const next = new URLSearchParams(params);
      next.set(param, k);
      setParams(next, { state: { [OPENED_HERE]: true } });
    },
    [params, setParams, param],
  );
  const close = useCallback(() => {
    if (!params.has(param)) return;
    // Opened here: step back, so the ✕, a swipe and the back gesture all leave the same
    // history (otherwise ✕ then Back would reopen the sheet).
    if (openedHere(state)) void navigate(-1);
    else {
      const next = new URLSearchParams(params);
      next.delete(param);
      setParams(next);
    }
  }, [params, setParams, param, navigate, state]);
  return { key, open, close };
}

function openedHere(state: unknown): boolean {
  return typeof state === 'object' && state !== null && OPENED_HERE in state;
}

/** Router state key the chat composer reads to prefill its text ("Ask the GM about him"). */
export const CHAT_PREFILL = 'prefill';

export function chatPrefillFrom(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const v = (state as Record<string, unknown>)[CHAT_PREFILL];
  return typeof v === 'string' ? v : undefined;
}
