import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { RequestError } from './api/client';
import { ensureWorker, pushSupported } from './push/notifications';
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
  defaultOptions: {
    queries: {
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
