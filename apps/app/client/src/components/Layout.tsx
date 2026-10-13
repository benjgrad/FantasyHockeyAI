import type { Me } from '@fha/api';
import { useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { chatHref, isChatPath, lastConversation } from '../chat/lastConversation';
import { api } from '../api/endpoints';
import { clearApiCache } from '../pwa/cache';
import { OnlineBadge } from '../pwa/OfflineStatus';
import { PwaBanners } from '../pwa/PwaBanners';
import { ChatIcon, DecisionsIcon, PlayersIcon, SettingsIcon, TeamIcon } from './icons';
import { scrollPaneToTop } from './pane';

const TABS = [
  { to: '/', label: 'Chat', icon: <ChatIcon />, end: true },
  { to: '/team', label: 'Team', icon: <TeamIcon />, end: false },
  { to: '/decisions', label: 'Decisions', icon: <DecisionsIcon />, end: false },
  { to: '/players', label: 'Players', icon: <PlayersIcon />, end: false },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon />, end: false },
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
  // Tapping the tab you're already on scrolls its page back to the top (the iOS status-bar tap
  // can't: the page itself never scrolls, only its pane).
  const onTab = (href: string) => (e: ReactMouseEvent) => {
    if (pathname === href.split('?')[0] && scrollPaneToTop()) e.preventDefault();
  };

  return (
    <div className="flex h-full flex-col">
      {/* Solid, not translucent: nothing scrolls under the bars (each page scrolls in its own
          pane), so a blur only smeared the status-bar strip on iOS. */}
      <header className="z-20 shrink-0 border-b border-line bg-bg pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-3 py-2">
          <img src="/favicon.svg" alt="" className="size-8 rounded-lg ring-1 ring-line" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{me.yahoo.teamName ?? 'Hockey GM'}</div>
            <ModeBadges me={me} />
          </div>
          <nav className="hidden gap-1 sm:flex">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.href}
                end={t.end}
                onClick={onTab(t.href)}
                className={({ isActive }) =>
                  `relative rounded-lg px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-brand ${active(t, isActive) ? 'bg-raised text-ink shadow-[inset_0_-2px_0_var(--color-brand)]' : 'text-mut hover:text-ink'}`
                }
              >
                {t.label}
                {t.to === '/decisions' && pendingCount > 0 ? (
                  <Count n={pendingCount} at="-top-1 -right-1" />
                ) : null}
              </NavLink>
            ))}
          </nav>
          <AccountMenu me={me} />
        </div>
        <PwaBanners />
      </header>
      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">{children}</main>
      <nav className="z-20 grid shrink-0 grid-cols-5 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] sm:hidden">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.href}
            end={t.end}
            onClick={onTab(t.href)}
            className={({ isActive }) =>
              `relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-2xs transition-transform focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand active:scale-95 ${active(t, isActive) ? 'font-semibold text-brand-ink' : 'text-mut'}`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  aria-hidden
                  className={`absolute top-0 h-0.5 w-7 rounded-b ${active(t, isActive) ? 'bg-brand' : ''}`}
                />
                {t.icon}
                {t.label}
                {t.to === '/decisions' && pendingCount > 0 ? (
                  <Count n={pendingCount} at="top-1 right-[calc(50%-1.375rem)]" />
                ) : null}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Count({ n, at }: { n: number; at: string }) {
  return (
    <span
      className={`absolute ${at} min-w-4 rounded-full bg-warn px-1 text-center text-3xs leading-4 font-bold text-bg`}
    >
      {n}
    </span>
  );
}

function ModeBadges({ me }: { me: Me }) {
  return (
    <div className="flex gap-1.5 text-2xs">
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
        className="icon-btn border border-line bg-raised text-sm text-ink"
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
