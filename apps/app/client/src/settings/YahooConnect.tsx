import type { Me } from '@fha/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type YahooTeamChoiceT } from '../api/endpoints';
import { formatWhen } from '../components/DecisionCardView';
import { ErrorNote } from '../components/ErrorNote';

/**
 * Connecting Yahoo by pasting the `T` and `Y` session cookies from a signed-in desktop browser
 * (the same pasted-session pattern as personal-os's Slack connection). The server validates
 * them live before storing anything, encrypted; this form clears them as soon as they're sent.
 */
export function YahooConnect({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [teams, setTeams] = useState<YahooTeamChoiceT[] | null>(null);
  const setMe = (next: Me) => {
    queryClient.setQueryData(['me'], next);
    void queryClient.invalidateQueries({ queryKey: ['team'] });
  };
  const select = useMutation({
    mutationFn: (t: YahooTeamChoiceT) => api.selectTeam(t.leagueKey, t.teamKey),
    onSuccess: (next) => {
      setMe(next);
      setTeams(null);
    },
  });
  const disconnect = useMutation({ mutationFn: api.disconnectYahoo, onSuccess: setMe });
  const connected = me.yahoo.status === 'connected';

  return (
    <>
      <StatusCard me={me} />
      {teams ? (
        <TeamPicker
          teams={teams}
          busy={select.isPending}
          error={select.error}
          onPick={(t) => select.mutate(t)}
        />
      ) : (
        <CookieForm reconnect={me.yahoo.status !== 'none'} onTeams={setTeams} />
      )}
      {me.yahoo.status !== 'none' ? (
        <div>
          <button
            className="btn btn-danger"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect Yahoo'}
          </button>
          {disconnect.error ? <ErrorNote error={disconnect.error} /> : null}
          {connected ? null : (
            <span className="ml-2 text-xs text-mut">Removes the stored cookies.</span>
          )}
        </div>
      ) : null}
    </>
  );
}

const STATUS: Record<Me['yahoo']['status'], { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'text-good' },
  expired: { label: 'Session expired — reconnect below', tone: 'text-warn' },
  error: { label: 'Connection error', tone: 'text-bad' },
  none: { label: 'Not connected', tone: 'text-mut' },
};

function StatusCard({ me }: { me: Me }) {
  const y = me.yahoo;
  const s = STATUS[y.status];
  return (
    <div className="card">
      <div className={`font-semibold ${s.tone}`}>● {s.label}</div>
      {y.teamName ? (
        <div className="mt-1 text-sm">
          {y.teamName} <span className="text-mut">({y.teamKey})</span>
        </div>
      ) : null}
      {y.lastOkAt ? (
        <div className="text-xs text-mut">Last worked {formatWhen(y.lastOkAt)}</div>
      ) : null}
      {y.error ? <div className="mt-1 text-sm text-bad">{y.error}</div> : null}
    </div>
  );
}

function CookieForm({
  reconnect,
  onTeams,
}: {
  reconnect: boolean;
  onTeams: (t: YahooTeamChoiceT[]) => void;
}) {
  const [T, setT] = useState('');
  const [Y, setY] = useState('');
  const connect = useMutation({
    mutationFn: () => api.connectYahoo(T.trim(), Y.trim()),
    onSuccess: (res) => {
      // Cleared on success: a credential left in a controlled input survives a screenshot.
      setT('');
      setY('');
      onTeams(res.teams);
    },
  });
  const ready = T.trim().length >= 10 && Y.trim().length >= 10;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) connect.mutate();
  };

  return (
    <form className="card flex flex-col gap-3" onSubmit={onSubmit}>
      <div className="font-semibold">
        {reconnect ? 'Reconnect Yahoo Fantasy' : 'Connect Yahoo Fantasy'}
      </div>
      <Instructions />
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">T cookie</span>
        <input
          className="input font-mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={T}
          onChange={(e) => setT(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Y cookie</span>
        <input
          className="input font-mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={Y}
          onChange={(e) => setY(e.target.value)}
        />
      </label>
      {connect.error ? <ErrorNote error={connect.error} /> : null}
      <button className="btn btn-primary" type="submit" disabled={!ready || connect.isPending}>
        {connect.isPending ? 'Checking with Yahoo…' : 'Connect'}
      </button>
    </form>
  );
}

function Instructions() {
  return (
    <div className="flex flex-col gap-2 text-sm text-soft">
      <p>
        This app reads your team using your Yahoo session. On a <b>desktop</b> browser where you’re
        signed in to Yahoo Fantasy, copy the values of two cookies, <code>T</code> and{' '}
        <code>Y</code>:
      </p>
      <details className="rounded-lg bg-well p-2" open>
        <summary className="cursor-pointer font-medium text-ink">Chrome / Edge</summary>
        <ol className="mt-1 list-decimal pl-5">
          <li>
            Open <code>https://sports.yahoo.com/fantasy</code> and make sure you’re signed in.
          </li>
          <li>
            Open DevTools (F12, or ⌥⌘I on a Mac) → <b>Application</b> tab.
          </li>
          <li>
            Under <b>Storage → Cookies</b>, pick <code>https://*.yahoo.com</code> (e.g.
            sports.yahoo.com).
          </li>
          <li>
            Find the rows named <code>T</code> and <code>Y</code>, and copy each <b>Value</b> in
            full.
          </li>
        </ol>
      </details>
      <details className="rounded-lg bg-well p-2">
        <summary className="cursor-pointer font-medium text-ink">Firefox</summary>
        <ol className="mt-1 list-decimal pl-5">
          <li>
            Open a Yahoo Fantasy page while signed in, then DevTools (F12) → <b>Storage</b> tab.
          </li>
          <li>
            Expand <b>Cookies</b>, pick the <code>yahoo.com</code> site, and copy the Value of{' '}
            <code>T</code> and <code>Y</code>.
          </li>
        </ol>
      </details>
      <details className="rounded-lg bg-well p-2">
        <summary className="cursor-pointer font-medium text-ink">Safari</summary>
        <ol className="mt-1 list-decimal pl-5">
          <li>Enable Settings → Advanced → “Show features for web developers”.</li>
          <li>
            On a Yahoo Fantasy page, Develop → Show Web Inspector → <b>Storage</b> → Cookies.
          </li>
          <li>
            Copy the Value of <code>T</code> and <code>Y</code>.
          </li>
        </ol>
      </details>
      <p className="rounded-lg border border-warn/50 bg-warn/10 p-2">
        <b>What this grants:</b> these two cookies are a live session for your{' '}
        <b>whole Yahoo account</b> — not a fantasy-only grant. They’re sent once over HTTPS, checked
        against Yahoo, and stored <b>encrypted</b>; they’re never shown again or logged. To revoke
        access at any time, <b>sign out of Yahoo</b> in that browser (which kills the session), or
        press Disconnect here.
      </p>
    </div>
  );
}

function TeamPicker({
  teams,
  busy,
  error,
  onPick,
}: {
  teams: YahooTeamChoiceT[];
  busy: boolean;
  error: unknown;
  onPick: (t: YahooTeamChoiceT) => void;
}) {
  return (
    <div className="card flex flex-col gap-2">
      <div className="font-semibold text-good">
        Yahoo accepted the session. Which team is yours to manage?
      </div>
      {teams.length === 0 ? (
        <p className="text-sm text-mut">No NHL fantasy teams found on this account.</p>
      ) : null}
      {teams.map((t) => (
        <button
          key={t.teamKey}
          className="btn justify-between text-left"
          disabled={busy}
          onClick={() => onPick(t)}
        >
          <span>
            <b>{t.teamName}</b>
            <span className="block text-xs text-mut">
              {t.leagueName} · {t.season}
            </span>
          </span>
          <span className="text-acc">Select</span>
        </button>
      ))}
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}
