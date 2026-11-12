import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { App } from './App';
import { ApiError } from './lib/api';
import { StaffAuthProvider } from './lib/auth';
// аудит 2.16: the print pages (QR and barcode code) are their own chunks
const PrintLabels = lazy(() => import('./pages/Labels').then((m) => ({ default: m.PrintLabels })));
const TestPrint = lazy(() => import('./pages/Labels').then((m) => ({ default: m.TestPrint })));
const PrintOrderLabel = lazy(() => import('./pages/OrderLabel').then((m) => ({ default: m.PrintOrderLabel })));
const TestOrderLabel = lazy(() => import('./pages/OrderLabel').then((m) => ({ default: m.TestOrderLabel })));
import './styles.css';

// аудит 2.16: telegram-web-app.js loads only inside Telegram, see lib/telegram-webapp.ts (it calls WebApp.ready())

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={null}>
        <Routes>
          {/* Label printing: full page without the menu, outside the Telegram sign-in so that it opens in Chrome.
              /print/labels authorises with a print ticket from the admin panel; /print/test has only fake data. */}
          <Route path="print/labels" element={<PrintLabels />} />
          <Route path="print/test" element={<TestPrint />} />
          {/* Shipping label of a Mini App order, 75×120: the same idea — a print ticket for one order; the test page has only fake data. */}
          <Route path="print/order-label" element={<PrintOrderLabel />} />
          <Route path="print/order-test" element={<TestOrderLabel />} />
          <Route
            path="*"
            element={
              <StaffAuthProvider>
                <App />
              </StaffAuthProvider>
            }
          />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
