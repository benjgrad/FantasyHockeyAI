import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/endpoints';

/** Search the league by name and pick one; picks are playerKeys from the server's index (P3). */
export function AddPlayer({
  onPick,
  exclude,
  disabled = false,
  placeholder = 'Add a player…',
}: {
  onPick: (playerKey: string) => void;
  exclude: readonly string[];
  disabled?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const term = q.trim();
  const found = useQuery({
    queryKey: ['player-search', term],
    queryFn: () => api.searchPlayers(term),
    enabled: term.length >= 2,
  });
  const rows = (found.data?.players ?? [])
    .filter((p) => !exclude.includes(p.playerKey))
    .slice(0, 8);
  return (
    <div className="relative">
      <input
        className="input"
        value={q}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
      />
      {term.length >= 2 && rows.length > 0 ? (
        <div className="absolute inset-x-0 top-full z-10 mt-1 rounded-lg border border-line bg-card p-1 shadow-xl">
          {rows.map((p) => (
            <button
              key={p.playerKey}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-raised"
              onClick={() => {
                onPick(p.playerKey);
                setQ('');
              }}
            >
              {p.name}{' '}
              <span className="text-mut">
                {p.team} · {p.positions}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
