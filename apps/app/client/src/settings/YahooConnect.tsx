import type { Me } from '@fha/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type CSSProperties, type FormEvent } from 'react';
import { api, type YahooTeamChoiceT } from '../api/endpoints';
import { formatWhen } from '../components/DecisionCardView';
import { ErrorNote } from '../components/ErrorNote';
import { extractOtherCookies, extractYahooCookies } from './yahooPaste';

/**
 * Connecting Yahoo from a signed-in desktop browser's session (the same pasted-session pattern
 * as personal-os's Slack connection). One paste of DevTools' "Copy as cURL" is enough: the `T`
 * and `Y` cookies are extracted here, in the browser, and only those two are sent. The server
 * validates them live before storing anything, encrypted; the form clears as soon as they're sent.
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
        <CookieForm
          reconnect={me.yahoo.status !== 'none'}
          onTeams={setTeams}
          onSelected={() => void queryClient.invalidateQueries({ queryKey: ['me'] })}
        />
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
      {y.status === 'expired' && y.expiredBy === 'site' ? (
        <div className="mt-1 text-sm text-warn">
          Reads still work, but Yahoo&apos;s website refused the session, so lineups and adds
          can&apos;t be sent. Reconnect below.
        </div>
      ) : null}
      {y.siteOkAt ? (
        <div className="text-xs text-mut">Website checked {formatWhen(y.siteOkAt)}</div>
      ) : null}
      {y.status === 'connected' && !y.teamKey ? (
        <div className="mt-1 text-sm text-warn">No team chosen yet: reconnect and pick yours.</div>
      ) : null}
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
  onSelected,
}: {
  reconnect: boolean;
  onTeams: (t: YahooTeamChoiceT[]) => void;
  /** The server kept the chosen team, or picked the account's only one: no picker. */
  onSelected: () => void;
}) {
  const [pasted, setPasted] = useState('');
  const [manualT, setManualT] = useState('');
  const [manualY, setManualY] = useState('');
  // Extracted in the browser: only the cookies leave this page, never the URL or the headers.
  const found = extractYahooCookies(pasted);
  const others = extractOtherCookies(pasted);
  const T = found.T ?? manualT.trim();
  const Y = found.Y ?? manualY.trim();
  const connect = useMutation({
    mutationFn: () => api.connectYahoo(T, Y, found.T === undefined ? {} : others),
    onSuccess: (res) => {
      // Cleared on success: a credential left in an input survives a screenshot.
      setPasted('');
      setManualT('');
      setManualY('');
      if (res.selected) onSelected();
      else onTeams(res.teams);
    },
  });
  const ready = T.length >= 10 && Y.length >= 10;
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
      <textarea
        className="input h-24 font-mono text-xs"
        style={{ WebkitTextSecurity: 'disc' } as CSSProperties}
        placeholder="Paste the copied cURL command here"
        autoComplete="off"
        spellCheck={false}
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
      />
      {pasted.trim() ? (
        <div className="flex gap-4 text-sm">
          <Found name="T" ok={found.T !== undefined} />
          <Found name="Y" ok={found.Y !== undefined} />
          {found.T === undefined ? (
            <span className="text-warn">
              No <code>T</code>: copy the request with <b>Copy as cURL</b>, not from the console.
            </span>
          ) : null}
        </div>
      ) : null}
      <details className="text-sm text-soft">
        <summary className="cursor-pointer">Enter the two cookies separately instead</summary>
        <div className="mt-2 flex flex-col gap-2">
          <ManualField label="T cookie" value={manualT} onChange={setManualT} />
          <ManualField label="Y cookie" value={manualY} onChange={setManualY} />
          <p className="text-xs text-mut">
            DevTools → Application (Firefox/Safari: Storage) → Cookies → a yahoo.com site → copy the
            Value of <code>T</code> and <code>Y</code>.
          </p>
        </div>
      </details>
      {connect.error ? <ErrorNote error={connect.error} /> : null}
      <button className="btn btn-primary" type="submit" disabled={!ready || connect.isPending}>
        {connect.isPending ? 'Checking with Yahoo…' : 'Connect'}
      </button>
    </form>
  );
}

function Found({ name, ok }: { name: string; ok: boolean }) {
  return (
    <span className={ok ? 'text-good' : 'text-bad'}>
      {ok ? '✓' : '✗'} <code>{name}</code>
    </span>
  );
}

function ManualField(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium">{props.label}</span>
      <input
        className="input font-mono"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

function Instructions() {
  return (
    <div className="flex flex-col gap-2 text-sm text-soft">
      <p>
        On a <b>computer</b> where you’re signed in to Yahoo Fantasy:
      </p>
      <ol className="list-decimal pl-5">
        <li>
          Open <code>hockey.fantasysports.yahoo.com</code>.
        </li>
        <li>
          Press <b>F12</b> (Mac: <b>⌥⌘I</b>), choose the <b>Network</b> tab, then reload the page.
        </li>
        <li>
          Right-click the first request in the list → <b>Copy</b> → <b>Copy as cURL</b>.
        </li>
        <li>Paste it below and press Connect.</li>
      </ol>
      <p className="text-xs text-mut">
        Only the cookies are taken from what you paste (<code>T</code> and <code>Y</code> are
        required); the URL and headers never leave this page. The other cookies keep Yahoo’s website
        signed in, so lineups don’t stall when <code>T</code> ages. (A console script can’t do this:
        Yahoo hides <code>T</code> from page scripts.) Safari needs Settings → Advanced → “Show
        features for web developers” first.
      </p>
      <p className="rounded-lg border border-warn/50 bg-warn/10 p-2">
        <b>What this grants:</b> the cookies are a live session for your <b>whole Yahoo account</b>.
        They’re checked against Yahoo, stored <b>encrypted</b>, and never shown again or logged. To
        revoke access, <b>sign out of Yahoo</b> in that browser, or press Disconnect here.
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
