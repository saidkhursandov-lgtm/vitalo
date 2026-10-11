import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { App } from './App';
import { ApiError } from './lib/api';
import { StaffAuthProvider } from './lib/auth';
import { PrintLabels, TestPrint } from './pages/Labels';
import { PrintOrderLabel, TestOrderLabel } from './pages/OrderLabel';
import './styles.css';

window.Telegram?.WebApp?.ready();

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
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
