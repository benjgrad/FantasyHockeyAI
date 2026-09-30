import type { Me } from '@fha/api';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { chatHref, isChatPath, lastConversation } from '../chat/lastConversation';
import { api } from '../api/endpoints';
import { clearApiCache } from '../pwa/cache';
import { OnlineBadge } from '../pwa/OfflineStatus';
import { PwaBanners } from '../pwa/PwaBanners';

const TABS = [
  { to: '/', label: 'Chat', icon: '💬', end: true },
  { to: '/team', label: 'Team', icon: '🏒', end: false },
  { to: '/decisions', label: 'Decisions', icon: '✅', end: false },
  { to: '/players', label: 'Players', icon: '🔎', end: false },
  { to: '/settings', label: 'Settings', icon: '⚙️', end: false },
];

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const pending = useQuery({
    queryKey: ['decisions', 'pending'],
    queryFn: () => api.decisions('pending'),
    refetchInterval: 60_000,
  });
  const pendingCount = pending.data?.decisions.length ?? 0;
  const { pathname } = useLocation();
  // The Chat tab goes back to the conversation Ben was in, not a blank new chat.
  const tabs = TABS.map((t) =>
    t.to === '/' ? { ...t, href: chatHref(lastConversation()) } : { ...t, href: t.to },
  );
  // Chat covers new and saved conversations; Team covers its League view too.
  const active = (t: (typeof tabs)[number], isActive: boolean) =>
    t.to === '/'
      ? isChatPath(pathname)
      : t.to === '/team'
        ? isActive || pathname.startsWith('/league')
        : isActive;

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-3 py-2">
          <img src="/icon-192.png" alt="" className="h-7 w-7 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">
              {me.yahoo.teamName ?? 'FantasyHockeyAI'}
            </div>
            <ModeBadges me={me} />
          </div>
          <nav className="hidden gap-1 sm:flex">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.href}
                end={t.end}
                className={({ isActive }) =>
                  `relative rounded-lg px-3 py-1.5 text-sm ${active(t, isActive) ? 'bg-raised text-ink' : 'text-mut hover:text-ink'}`
                }
              >
                {t.label}
                {t.to === '/decisions' && pendingCount > 0 ? <Count n={pendingCount} /> : null}
              </NavLink>
            ))}
          </nav>
          <AccountMenu me={me} />
        </div>
        <PwaBanners />
      </header>
      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">{children}</main>
      <nav className="sticky bottom-0 z-20 grid grid-cols-5 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.href}
            end={t.end}
            className={({ isActive }) =>
              `relative flex flex-col items-center py-2 text-[11px] ${active(t, isActive) ? 'text-acc' : 'text-mut'}`
            }
          >
            <span aria-hidden className="text-lg leading-none">
              {t.icon}
            </span>
            {t.label}
            {t.to === '/decisions' && pendingCount > 0 ? <Count n={pendingCount} /> : null}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="absolute top-0.5 right-1 min-w-4 rounded-full bg-warn px-1 text-center text-[10px] leading-4 font-bold text-bg">
      {n}
    </span>
  );
}

function ModeBadges({ me }: { me: Me }) {
  return (
    <div className="flex gap-1.5 text-[11px]">
      <OnlineBadge />
      {me.paused ? <span className="text-bad">● Paused</span> : null}
      {me.dryRun ? (
        <span className="text-warn">● Dry run</span>
      ) : (
        <span className="text-good">● Live</span>
      )}
      {me.yahoo.status !== 'connected' ? (
        <span className="text-mut">
          · Yahoo {me.yahoo.status === 'none' ? 'not connected' : me.yahoo.status}
        </span>
      ) : null}
    </div>
  );
}

function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const signOut = async (everywhere: boolean) => {
    setBusy(true);
    // A shared device must not keep this account's team data in the offline cache.
    await clearApiCache();
    try {
      await (everywhere ? api.logoutEverywhere() : api.logout());
    } finally {
      window.location.assign('/');
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        className="grid h-8 w-8 place-items-center rounded-full border border-line bg-raised text-sm"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {(me.displayName ?? '?').slice(0, 1).toUpperCase()}
      </button>
      {open ? (
        <div className="absolute right-0 mt-2 w-56 rounded-xl border border-line bg-card p-1 shadow-xl">
          <div className="px-3 py-2 text-xs text-mut">
            Signed in as {me.displayName ?? me.userId}
          </div>
          <button
            className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-raised"
            disabled={busy}
            onClick={() => void signOut(false)}
          >
            Sign out
          </button>
          <button
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-bad hover:bg-raised"
            disabled={busy}
            onClick={() => void signOut(true)}
          >
            Sign out everywhere
          </button>
        </div>
      ) : null}
    </div>
  );
}
