import { NotificationKind } from '@fha/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { api, type NotificationPrefsT } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';
import { Toggle } from '../components/Toggle';
import {
  currentSubscription,
  disablePush,
  enablePush,
  isIos,
  permissionState,
  pushSupported,
} from '../push/notifications';

type Kind = z.infer<typeof NotificationKind>;

const KIND_LABEL: Record<Kind, { title: string; body: string }> = {
  approval: { title: 'Approvals', body: 'A plan is waiting for your Approve / Reject.' },
  injury: { title: 'Injuries', body: 'A rostered player’s status changes.' },
  executed: { title: 'Executed', body: 'A move went through on Yahoo.' },
  failed: { title: 'Failures', body: 'A move or a scheduled job failed.' },
  digest: { title: 'Daily digest', body: 'The morning summary.' },
  league: { title: 'League', body: 'Trades offered to you and league news.' },
};

export function NotificationSettings() {
  return (
    <>
      <DevicePush />
      <Preferences />
    </>
  );
}

function DevicePush() {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void currentSubscription().then((s) => setSubscribed(s !== null));
  }, []);
  const test = useMutation({ mutationFn: api.testPush });

  const toggle = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
      } else {
        const result = await enablePush();
        if (result.ok) setSubscribed(true);
        else setMessage(result.message);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const state = permissionState();
  return (
    <div className="card flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Push on this device</div>
          <div className="text-xs text-mut">
            {subscribed
              ? 'This device gets notifications.'
              : 'Get approvals and injuries as they happen.'}
          </div>
        </div>
        <button
          className={`btn ${subscribed ? '' : 'btn-primary'}`}
          disabled={busy || subscribed === null}
          onClick={() => void toggle()}
        >
          {busy ? '…' : subscribed ? 'Turn off' : 'Enable'}
        </button>
      </div>
      {!pushSupported() && isIos() ? (
        <p className="text-sm text-soft">
          On iPhone and iPad, push only works in the installed app: tap{' '}
          <b>Share → Add to Home Screen</b>, open FantasyHockeyAI from the Home Screen, then enable
          here.
        </p>
      ) : null}
      {state === 'denied' ? (
        <p className="text-sm text-bad">
          Notifications are blocked for this site in the browser’s settings.
        </p>
      ) : null}
      {message ? <p className="text-sm text-warn">{message}</p> : null}
      <div className="flex items-center gap-2">
        <button className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
          Send test
        </button>
        {test.data ? (
          <span className="text-xs text-mut">
            Sent to {test.data.sent} device{test.data.sent === 1 ? '' : 's'}.
          </span>
        ) : null}
      </div>
      {test.error ? <ErrorNote error={test.error} /> : null}
    </div>
  );
}

const browserTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function Preferences() {
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: ['notificationPrefs'], queryFn: api.notificationPrefs });
  const save = useMutation({
    mutationFn: api.saveNotificationPrefs,
    onSuccess: (next) => queryClient.setQueryData(['notificationPrefs'], next),
  });
  if (prefs.error) return <ErrorNote error={prefs.error} />;
  if (!prefs.data) return <p className="text-mut">Loading…</p>;
  const current = prefs.data;
  const update = (next: NotificationPrefsT) => save.mutate(next);

  return (
    <div className="card flex flex-col">
      <div className="tag mb-1">What to send</div>
      {NotificationKind.options.map((kind) => (
        <div
          key={kind}
          className="flex items-center gap-3 border-b border-line py-2 last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{KIND_LABEL[kind].title}</div>
            <div className="text-xs text-mut">{KIND_LABEL[kind].body}</div>
          </div>
          <Toggle
            label={KIND_LABEL[kind].title}
            on={current.kinds[kind] !== false}
            disabled={save.isPending}
            onChange={(on) => update({ ...current, kinds: { ...current.kinds, [kind]: on } })}
          />
        </div>
      ))}
      <QuietHours prefs={current} busy={save.isPending} onSave={update} />
      {save.error ? <ErrorNote error={save.error} /> : null}
    </div>
  );
}

function QuietHours({
  prefs,
  busy,
  onSave,
}: {
  prefs: NotificationPrefsT;
  busy: boolean;
  onSave: (p: NotificationPrefsT) => void;
}) {
  const q = prefs.quietHours;
  const [start, setStart] = useState(q?.start ?? '22:00');
  const [end, setEnd] = useState(q?.end ?? '07:00');
  const dirty = q !== null && (start !== q.start || end !== q.end);
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Quiet hours</div>
          <div className="text-xs text-mut">
            Hold non-urgent notifications overnight{q ? ` (${q.tz})` : ''}.
          </div>
        </div>
        <Toggle
          label="Quiet hours"
          on={q !== null}
          disabled={busy}
          onChange={(on) =>
            onSave({ ...prefs, quietHours: on ? { start, end, tz: q?.tz ?? browserTz() } : null })
          }
        />
      </div>
      {q ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs text-mut">
            From
            <input
              className="input py-1"
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="flex flex-col text-xs text-mut">
            To
            <input
              className="input py-1"
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <button
            className="btn"
            disabled={!dirty || busy}
            onClick={() => onSave({ ...prefs, quietHours: { start, end, tz: browserTz() } })}
          >
            Save hours
          </button>
        </div>
      ) : null}
    </div>
  );
}
