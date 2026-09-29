import { PLAN_KINDS, Permissions } from '@fha/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { api, type PermissionsViewT, type PlayerRefT } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';
import { Toggle } from '../components/Toggle';
import { diffPermissions, widensAutonomy, type Change } from './permissionsDiff';
import { PlanRow, PlayerLists, ToolSwitches } from './permissionsParts';

/**
 * The full Permissions editor. Edits a local draft; Save shows every change and needs an
 * explicit confirmation for anything that widens autonomy. The server's gate is still the
 * enforcement (P2) — this screen only makes widening deliberate.
 */
export function PermissionsEditor() {
  const view = useQuery({ queryKey: ['permissions'], queryFn: api.permissions });
  if (view.error) return <ErrorNote error={view.error} />;
  if (!view.data) return <p className="text-mut">Loading…</p>;
  const parsed = Permissions.safeParse(view.data.permissions);
  if (!parsed.success) {
    // Unreadable: edit nothing rather than overwrite a document we don't understand (P5).
    return (
      <ErrorNote
        message={`The stored permissions don’t match the schema: ${parsed.error.issues[0]?.message ?? ''}`}
      />
    );
  }
  return <Editor key={view.data.updatedAt ?? 'initial'} view={view.data} saved={parsed.data} />;
}

function Editor({ view, saved }: { view: PermissionsViewT; saved: Permissions }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Permissions>(() => structuredClone(saved));
  const [known, setKnown] = useState(() => new Map(view.players.map((p) => [p.playerKey, p])));
  const [reviewing, setReviewing] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const edit = useCallback((fn: (d: Permissions) => void) => {
    setDraft((current) => {
      const next = structuredClone(current);
      fn(next);
      return next;
    });
    setReviewing(false);
    setUnderstood(false);
  }, []);
  const nameOf = useCallback((key: string) => known.get(key), [known]);
  const remember = useCallback(
    (p: PlayerRefT) => setKnown((m) => new Map(m).set(p.playerKey, p)),
    [],
  );

  const changes = useMemo(
    () => diffPermissions(saved, draft, (k) => known.get(k)?.name ?? k),
    [saved, draft, known],
  );
  const widens = widensAutonomy(changes);

  const save = useMutation({
    mutationFn: () => api.savePermissions(draft as unknown as Record<string, unknown>),
    onSuccess: (next) => {
      queryClient.setQueryData(['permissions'], next);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="card flex flex-col gap-3">
        <SwitchRow
          title="Dry run"
          body={
            draft.dryRun
              ? 'Nothing executes on Yahoo; everything is logged as “would execute”.'
              : 'LIVE: allowed plans really execute on Yahoo.'
          }
          on={draft.dryRun}
          tone="warn"
          onChange={(on) => edit((d) => void (d.dryRun = on))}
        />
        <SwitchRow
          title="Kill switch (pause)"
          body={
            draft.paused
              ? 'Every write is refused until you resume.'
              : 'Writes are allowed, subject to the rules below.'
          }
          on={draft.paused}
          tone="bad"
          onChange={(on) => edit((d) => void (d.paused = on))}
        />
      </div>

      <div className="card">
        <div className="tag">Per plan kind</div>
        <p className="text-xs text-mut">
          Allow = execute · Ask = wait for your approval · Deny = never.
        </p>
        {PLAN_KINDS.map((kind) => (
          <PlanRow key={kind} kind={kind} draft={draft} edit={edit} />
        ))}
      </div>

      <div className="card">
        <div className="tag mb-2">Players</div>
        <PlayerLists draft={draft} edit={edit} nameOf={nameOf} remember={remember} />
      </div>

      <div className="card">
        <div className="tag mb-1">Tools</div>
        <p className="text-xs text-mut">
          A tool switched off is removed from every agent and its plans are denied.
        </p>
        <ToolSwitches tools={view.tools} draft={draft} edit={edit} />
      </div>

      <div className="card flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">Protected players</div>
          <div className="text-xs text-mut">
            Your top N by VORP are never dropped or traded without approval.
          </div>
        </div>
        <input
          className="input w-20"
          type="number"
          min={0}
          value={draft.protected.topNByVorp}
          onChange={(e) => {
            const n = Math.max(0, Math.round(Number(e.target.value) || 0));
            edit((d) => void (d.protected.topNByVorp = n));
          }}
        />
      </div>

      <div className="sticky bottom-0 flex flex-col gap-2 rounded-xl border border-line bg-bg/95 p-3 backdrop-blur">
        {reviewing ? (
          <Review
            changes={changes}
            widens={widens}
            understood={understood}
            setUnderstood={setUnderstood}
          />
        ) : null}
        {save.error ? <ErrorNote error={save.error} /> : null}
        {save.isSuccess && changes.length === 0 ? (
          <div className="text-sm text-good">Saved.</div>
        ) : null}
        <div className="flex gap-2">
          {reviewing ? (
            <>
              <button
                className={`btn ${widens ? 'btn-danger' : 'btn-primary'}`}
                disabled={save.isPending || (widens && !understood)}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : widens ? 'Confirm and save' : 'Save'}
              </button>
              <button className="btn" onClick={() => setReviewing(false)}>
                Back
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-primary"
                disabled={changes.length === 0}
                onClick={() => setReviewing(true)}
              >
                Review {changes.length} change{changes.length === 1 ? '' : 's'}
              </button>
              <button
                className="btn"
                disabled={changes.length === 0}
                onClick={() => setDraft(structuredClone(saved))}
              >
                Discard
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SwitchRow(props: {
  title: string;
  body: string;
  on: boolean;
  tone: 'warn' | 'bad';
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{props.title}</div>
        <div className="text-xs text-mut">{props.body}</div>
      </div>
      <Toggle label={props.title} on={props.on} tone={props.tone} onChange={props.onChange} />
    </div>
  );
}

function Review(props: {
  changes: Change[];
  widens: boolean;
  understood: boolean;
  setUnderstood: (b: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="tag">Changes</div>
      <ul className="flex flex-col gap-1 text-sm">
        {props.changes.map((c) => (
          <li key={c.path} className={c.widens ? 'text-warn' : 'text-soft'}>
            {c.widens ? '▲ ' : '▼ '}
            {c.label}
          </li>
        ))}
      </ul>
      {props.widens ? (
        <label className="flex items-start gap-2 rounded-lg border border-warn/60 bg-warn/10 p-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={props.understood}
            onChange={(e) => props.setUnderstood(e.target.checked)}
          />
          <span>
            The changes marked ▲ give the agents <b>more autonomy</b> to act on your Yahoo team
            without asking. I want that.
          </span>
        </label>
      ) : null}
    </div>
  );
}
