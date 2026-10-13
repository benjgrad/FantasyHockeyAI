import { useQuery } from '@tanstack/react-query';
import { ErrorNote } from '../components/ErrorNote';
import { Sheet } from '../components/Sheet';
import { playersApi } from './api';
import { PlayerCardView } from './PlayerCardView';
import { usePlayerSheet } from './sheet';

/**
 * The player sheet, mounted once for the whole app. It opens whenever the URL names a player
 * (see `usePlayerSheet`), so a card is deep-linkable and the back button closes it.
 */
export function PlayerSheetHost() {
  const { key, close } = usePlayerSheet();
  if (key === null) return null;
  return (
    <Sheet label="Player" onClose={close}>
      <SheetBody playerKey={key} />
    </Sheet>
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
