import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { api } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';

export function ConversationList({ onPick }: { onPick: () => void }) {
  const list = useQuery({ queryKey: ['conversations'], queryFn: api.conversations });
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <NavLink to="/" end className="btn btn-primary" onClick={onPick}>
        + New chat
      </NavLink>
      {list.error ? <ErrorNote error={list.error} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.data?.conversations.length === 0 ? (
          <p className="p-2 text-sm text-mut">No conversations yet.</p>
        ) : null}
        {list.data?.conversations.map((c) => (
          <NavLink
            key={c.id}
            to={`/c/${encodeURIComponent(c.id)}`}
            onClick={onPick}
            className={({ isActive }) =>
              `block rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-raised text-ink' : 'text-soft hover:bg-raised/60'}`
            }
          >
            <div className="truncate">{c.title ?? 'Untitled'}</div>
            <div className="text-[11px] text-mut">{new Date(c.updatedAt).toLocaleDateString()}</div>
          </NavLink>
        ))}
      </div>
    </div>
  );
}
