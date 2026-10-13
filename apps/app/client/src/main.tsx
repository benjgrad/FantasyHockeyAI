import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { RequestError } from './api/client';
import { ensureWorker, pushSupported } from './push/notifications';
import { listenForInstallPrompt } from './pwa/install';
import { trackAppHeight } from './pwa/appHeight';
import { offlineMutationError } from './pwa/online';
import './styles.css';

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    // Any 401 means the session is gone: re-ask /api/me, which renders the sign-in screen.
    onError: (error, query) => {
      if (error instanceof RequestError && error.signedOut && query.queryKey[0] !== 'me') {
        void queryClient.invalidateQueries({ queryKey: ['me'] });
      }
    },
  }),
  // Offline, a write fails at once with "You're offline" instead of pausing (a hung button),
  // and is never queued to land later than the moment it was meant for.
  mutationCache: new MutationCache({
    onMutate: () => {
      const error = offlineMutationError(navigator.onLine);
      if (error) throw error;
    },
  }),
  defaultOptions: {
    mutations: { networkMode: 'always' },
    queries: {
      // Run the first fetch even when the browser says offline: the service worker may answer
      // it from its cache (marked stale). Retries still pause until the network is back.
      networkMode: 'offlineFirst',
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Never retry a 4xx (our mistake or a lost session) or a server that isn't there.
      retry: (count, error) => {
        if (error instanceof RequestError && (error.status < 500 || error.code === 'offline')) {
          return false;
        }
        return count < 2;
      },
    },
  },
});

// Before render: Chrome fires beforeinstallprompt once, early (see pwa/install.ts).
listenForInstallPrompt();
// Before render too: the installed iOS app's height is measured, not trusted (pwa/appHeight.ts).
trackAppHeight();

// Registered on boot so the app is installable; enabling push reuses this registration.
if (import.meta.env.PROD && pushSupported()) {
  void ensureWorker().catch(() => undefined);
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
