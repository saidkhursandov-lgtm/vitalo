import { api } from './api';

/** Funnel steps the app reports (B3); orders and payments are recorded by the server itself. */
export type AppEvent = 'app_open' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'language_change' | 'cod_selected' | 'payment_soon_click' | 'manifest_open' | 'ai_tab_click';

/** Fire and forget: analytics never blocks or breaks the shop (errors, limits and slow network are ignored). */
export function track(event: AppEvent, props?: Record<string, string | number | boolean>) {
  void api('/analytics/events', { method: 'POST', body: { event, props } }).catch(() => undefined);
}

/** app_open once per opening of the Mini App (not on every screen). */
export function trackAppOpen() {
  try {
    if (sessionStorage.getItem('vitalo.opened')) return;
    sessionStorage.setItem('vitalo.opened', '1');
  } catch {
    // storage blocked: still count it
  }
  track('app_open');
}
