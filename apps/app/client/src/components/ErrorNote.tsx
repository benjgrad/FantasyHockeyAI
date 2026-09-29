import { Link } from 'react-router-dom';
import { RequestError, describeError, isYahooCode } from '../api/client';

/** An inline error. Yahoo connection problems point at Settings instead of just complaining. */
export function ErrorNote({
  error,
  code,
  message,
}: {
  error?: unknown;
  code?: string;
  message?: string;
}) {
  const resolvedCode = code ?? (error instanceof RequestError ? error.code : undefined);
  if (!error && !code && !message) return null;
  if (resolvedCode && isYahooCode(resolvedCode)) return <YahooNeeded code={resolvedCode} />;
  const text = error
    ? describeError(error)
    : describeError(new RequestError(0, code ?? '', message ?? ''));
  return (
    <div
      role="alert"
      className="rounded-lg border border-bad/50 bg-bad/10 px-3 py-2 text-sm text-soft"
    >
      {text}
    </div>
  );
}

export function YahooNeeded({ code }: { code: string }) {
  const expired = code === 'yahoo_reconnect_required';
  return (
    <div className="card border-warn/60">
      <div className="font-semibold text-warn">
        {expired ? 'Yahoo needs reconnecting' : 'Yahoo isn’t connected'}
      </div>
      <p className="mt-1 text-sm text-soft">
        {expired
          ? 'The Yahoo session this app uses has expired. Paste fresh cookies in Settings.'
          : 'Connect your Yahoo Fantasy account in Settings so I can read your team.'}
      </p>
      <Link className="btn mt-2" to="/settings#yahoo">
        Open Settings
      </Link>
    </div>
  );
}
