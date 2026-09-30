import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ErrorNote } from '../components/ErrorNote';
import { playersApi } from './api';
import { PlayerCardView } from './PlayerCardView';
import { usePlayerSheet } from './sheet';

/**
 * The player sheet, mounted once for the whole app: a bottom sheet on a phone, a side panel on
 * a wider screen. It opens whenever the URL names a player (see `usePlayerSheet`), so a card is
 * deep-linkable and the back button closes it.
 */
export function PlayerSheetHost() {
  const { key, close } = usePlayerSheet();
  useEffect(() => {
    if (key === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, close]);
  if (key === null) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Player">
      <button className="absolute inset-0 bg-black/50" aria-label="Close player" onClick={close} />
      <div className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-2xl border border-line bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[440px] sm:rounded-none sm:rounded-l-2xl">
        <div className="mb-2 flex justify-between">
          <span className="mx-auto h-1 w-10 rounded bg-line sm:hidden" />
          <button className="btn ml-auto px-2 py-1" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        <SheetBody playerKey={key} />
      </div>
    </div>
  );
}

function SheetBody({ playerKey }: { playerKey: string }) {
  const card = useQuery({
    queryKey: ['player', playerKey],
    queryFn: () => playersApi.card(playerKey),
  });
  if (card.error) return <ErrorNote error={card.error} />;
  if (!card.data) return <p className="text-mut">Loading…</p>;
  return <PlayerCardView card={card.data} />;
}
