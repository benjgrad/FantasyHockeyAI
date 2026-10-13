import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { api } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';

/** `replace`: in the phone drawer, a pick takes the drawer's history entry (see chatNav). */
export function ConversationList({
  onPick,
  replace = false,
}: {
  onPick: () => void;
  replace?: boolean;
}) {
  const list = useQuery({ queryKey: ['conversations'], queryFn: api.conversations });
  const activity = useQuery({ queryKey: ['activity'], queryFn: api.activity, staleTime: 60_000 });
  const activityId = activity.data?.conversationId ?? null;
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <NavLink to="/" end replace={replace} className="btn btn-primary" onClick={onPick}>
        + New chat
      </NavLink>
      {activityId !== null ? (
        <NavLink
          to={`/c/${encodeURIComponent(activityId)}`}
          replace={replace}
          onClick={onPick}
          className={({ isActive }) =>
            `block rounded-lg border border-line px-3 py-2 text-sm ${isActive ? 'bg-raised text-ink' : 'text-soft hover:bg-raised/60'}`
          }
        >
          <div className="truncate">Background activity</div>
          <div className="text-2xs text-mut">What the agents did without you</div>
        </NavLink>
      ) : null}
      <NavLink
        to="/activity"
        replace={replace}
        onClick={onPick}
        className="rounded-lg px-3 py-1.5 text-xs text-acc hover:bg-raised/60"
      >
        What the agents watch →
      </NavLink>
      {list.error ? <ErrorNote error={list.error} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {list.data?.conversations.length === 0 ? (
          <p className="p-2 text-sm text-mut">No conversations yet.</p>
        ) : null}
        {list.data?.conversations.map((c) => (
          <NavLink
            key={c.id}
            to={`/c/${encodeURIComponent(c.id)}`}
            replace={replace}
            onClick={onPick}
            className={({ isActive }) =>
              `block rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-raised text-ink' : 'text-soft hover:bg-raised/60'}`
            }
          >
            <div className="truncate">{c.title ?? 'Untitled'}</div>
            <div className="text-2xs text-mut">{new Date(c.updatedAt).toLocaleDateString()}</div>
          </NavLink>
        ))}
      </div>
    </div>
  );
}
