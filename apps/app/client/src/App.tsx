import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { RequestError, describeError } from './api/client';
import { api } from './api/endpoints';
import { Layout } from './components/Layout';
import { Compare } from './players/Compare';
import { PlayerSheetHost } from './players/PlayerSheet';
import { Players } from './players/Players';
import { NAVIGATE_MESSAGE, navigateTargetFor } from './push/swMessages';
import { Chat } from './routes/Chat';
import { Decisions } from './routes/Decisions';
import { Settings } from './routes/Settings';
import { SignIn } from './routes/SignIn';
import { Team } from './routes/Team';

export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 60_000 });
  useServiceWorkerNavigation();

  if (me.isPending) {
    return <div className="grid h-full place-items-center text-mut">Loading…</div>;
  }
  if (me.error) {
    if (me.error instanceof RequestError && me.error.signedOut) return <SignIn />;
    return (
      <div className="grid h-full place-items-center p-4">
        <div className="card max-w-sm text-center">
          <p className="mb-3">{describeError(me.error)}</p>
          <button className="btn" onClick={() => void me.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return (
    <Layout me={me.data}>
      <Routes>
        <Route path="/" element={<Chat />} />
        <Route path="/c/:conversationId" element={<Chat />} />
        <Route path="/team" element={<Team />} />
        <Route path="/decisions" element={<Decisions />} />
        <Route path="/decisions/:planId" element={<Decisions />} />
        <Route path="/settings" element={<Settings me={me.data} />} />
        <Route path="/players" element={<Players />} />
        <Route path="/players/:playerKey" element={<Players />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <PlayerSheetHost />
    </Layout>
  );
}

/** A tapped notification focuses this tab and asks it to route (see sw.ts). */
function useServiceWorkerNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== NAVIGATE_MESSAGE) return;
      const target = navigateTargetFor(data.url);
      if (target) void navigate(target);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
}
