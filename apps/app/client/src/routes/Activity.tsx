import type { ActivityView } from '@fha/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';
import { SkeletonRows } from '../components/Skeleton';
import { usePane } from '../components/pane';
import { PlayerLink } from '../players/PlayerLink';

/**
 * What the agents follow and when they act (D-027): the players the watchers follow and why,
 * each watcher's last check, the schedule, what each kind of change triggers, and a way into the
 * Background activity chat, where every run and notification is recorded.
 */
export function Activity() {
  const pane = usePane();
  const q = useQuery({ queryKey: ['activity'], queryFn: api.activity, refetchInterval: 60_000 });
  return (
    <div ref={pane} className="pane flex flex-col gap-3 p-3">
      <div>
        <h1 className="display text-2xl leading-tight">Activity</h1>
        <p className="text-xs text-mut">What the agents watch, and when they act without you.</p>
      </div>
      {q.error ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? <SkeletonRows label="Loading activity" /> : null}
      {q.data ? <Body v={q.data} /> : null}
    </div>
  );
}

function Body({ v }: { v: ActivityView }) {
  return (
    <>
      <section className="card flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Background activity chat</div>
          <div className="text-xs text-mut">
            Every scheduled or triggered run, what it did and every notification, in one
            conversation. Reply there to ask why.
          </div>
        </div>
        {v.conversationId ? (
          <Link className="btn" to={`/c/${encodeURIComponent(v.conversationId)}`}>
            Open
          </Link>
        ) : (
          <span className="text-xs text-mut">Nothing yet</span>
        )}
      </section>
      <Agents v={v} />
      <Followed v={v} />
      <Watching v={v} />
      <section className="card p-0">
        <div className="tag border-b border-line px-3 py-2">Watchers</div>
        {v.watchers.map((w) => (
          <div
            key={w.name}
            className="flex items-start gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium">{w.name}</div>
              <div className="text-xs text-mut">
                {w.what} · every {w.everyMinutes} min
              </div>
            </div>
            <div className="text-right text-xs">
              {w.last === null ? (
                <span className="text-mut">not run yet</span>
              ) : (
                <>
                  <div className={w.last.ok ? 'text-good' : 'text-bad'}>
                    {w.last.ok ? 'ok' : 'failed'} · {ago(w.last.at)}
                  </div>
                  <div className="text-mut">
                    {w.last.ok
                      ? `${w.last.events} new event${w.last.events === 1 ? '' : 's'}`
                      : w.last.error}
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </section>
      <section className="card">
        <div className="tag mb-1">When something changes</div>
        <ul className="flex flex-col gap-1.5 text-sm">
          {v.rules.map((r) => (
            <li key={r.when}>
              <span className="font-medium">{r.when}</span>
              <span className="text-mut"> → {r.then}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <div className="tag mb-1">Schedule (New York time)</div>
        <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          {v.schedule.map((x, i) => (
            <li key={`${x.job}-${i}`}>
              <span className="font-medium">{x.job}</span>{' '}
              <span className="text-mut">{x.when}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Agents({ v }: { v: ActivityView }) {
  return (
    <section className="card p-0">
      <div className="tag border-b border-line px-3 py-2">Agents</div>
      {v.agents.map((a) => (
        <div key={a.name} className="border-b border-line px-3 py-2 text-sm last:border-b-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">{a.name}</span>
            <span className="text-2xs text-mut">{a.model}</span>
          </div>
          <p className="text-xs text-soft">{a.purpose}</p>
          <div className="mt-1 flex flex-col gap-0.5 text-xs text-mut">
            {a.schedule.length > 0 ? <div>Runs: {a.schedule.join(' · ')}</div> : null}
            {a.triggers.length > 0 ? <div>Also when: {a.triggers.join(' · ')}</div> : null}
            {a.lastRun ? (
              <div>
                Last run {ago(a.lastRun.at)}:{' '}
                <span className={a.lastRun.status === 'failed' ? 'text-bad' : 'text-soft'}>
                  {a.lastRun.status}
                </span>
                {a.lastRun.summary ? ` · ${a.lastRun.summary}` : ''}
              </div>
            ) : (
              <div>Not run yet</div>
            )}
          </div>
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer text-acc">
              What it can do ({a.tools.length} tools)
            </summary>
            <div className="mt-1 text-soft">May: {a.may.join(' · ')}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {a.tools.map((t) => (
                <span key={t} className="pill font-mono text-2xs">
                  {t}
                </span>
              ))}
            </div>
          </details>
        </div>
      ))}
    </section>
  );
}

function Followed({ v }: { v: ActivityView }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: api.stopFollowing,
    onSuccess: (next) => qc.setQueryData(['activity'], next),
  });
  return (
    <section className="card p-0">
      <div className="tag border-b border-line px-3 py-2">
        Followed by the agents · {v.followed.length}
      </div>
      {v.followed.length === 0 ? (
        <p className="px-3 py-2 text-sm text-mut">
          None. Agents can follow a player they want to hear about (a stash, a trade target); ask in
          chat to have one followed.
        </p>
      ) : null}
      {stop.error ? <ErrorNote error={stop.error} /> : null}
      {v.followed.map((f) => (
        <div
          key={f.playerKey}
          className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <PlayerLink playerKey={f.playerKey}>{f.name}</PlayerLink>
            <div className="text-xs text-mut">
              {f.addedBy}: {f.reason} · until {new Date(f.expiresAt).toLocaleDateString()}
            </div>
          </div>
          <button
            className="btn btn-sm"
            disabled={stop.isPending}
            onClick={() => stop.mutate(f.playerKey)}
          >
            Stop following
          </button>
        </div>
      ))}
    </section>
  );
}

function Watching({ v }: { v: ActivityView }) {
  const groups = new Map<string, ActivityView['players']>();
  for (const p of v.players) {
    const key = p.reasons[0] ?? 'other';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return (
    <section className="card p-0">
      <div className="tag border-b border-line px-3 py-2">
        Following {v.players.length} players
        {v.watchedAt ? (
          <span className="normal-case text-mut"> · checked {ago(v.watchedAt)}</span>
        ) : null}
      </div>
      {v.players.length === 0 ? (
        <p className="px-3 py-2 text-sm text-mut">The players watcher has not run yet.</p>
      ) : null}
      {[...groups.entries()].map(([reason, ps]) => (
        <details
          key={reason}
          open={reason === 'our roster'}
          className="border-b border-line px-3 py-2 last:border-b-0"
        >
          <summary className="cursor-pointer text-sm font-medium">
            {reason} <span className="text-mut">· {ps.length}</span>
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-sm">
            {ps.map((p) => (
              <li key={p.playerKey} className="flex items-center gap-2">
                <PlayerLink playerKey={p.playerKey}>{p.name}</PlayerLink>
                <span className="text-xs text-mut">{p.nhlTeam}</span>
                {p.status ? (
                  <span className="pill border-warn/60 text-warn">{p.status}</span>
                ) : null}
                {p.reasons.length > 1 ? (
                  <span className="text-2xs text-mut">also {p.reasons.slice(1).join(', ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

function ago(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min)) return '';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
}
