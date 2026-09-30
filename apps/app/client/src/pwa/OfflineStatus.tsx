import { useEffect, useState, useSyncExternalStore } from 'react';
import { describeStale } from './offlineData';
import { useOnline } from './online';
import { oldestStale, subscribeStale } from './staleStore';

/** A compact header badge: shown only when the browser has no network at all. */
export function OnlineBadge() {
  const online = useOnline();
  if (online) return null;
  return (
    <span className="text-warn" role="status">
      ● Offline
    </span>
  );
}

/** Re-renders every minute so "5 min ago" stays true. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** "Offline — showing data from …" while any on-screen data came from the worker's cache. */
export function StaleDataBanner() {
  const cachedAt = useSyncExternalStore(subscribeStale, oldestStale);
  const now = useNow();
  if (cachedAt === null) return null;
  return (
    <div
      role="status"
      className="border-b border-line bg-warn/15 px-3 py-1.5 text-center text-xs text-warn"
    >
      {describeStale(cachedAt, now)}. Changes need a connection.
    </div>
  );
}
