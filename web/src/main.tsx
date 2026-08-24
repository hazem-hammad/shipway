import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import App from './App';
import { initTheme } from './lib/theme';
import './index.css';

// Resolve light/dark before anything renders so there is no theme flash on load.
initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // An internal tool on a fast local network: a stale query is more likely a real state
      // change (deploy finished, session expired) than a network blip worth retrying silently.
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('missing #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router>
        <App />
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
