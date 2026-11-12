import { api } from './api';

/** Funnel steps the app reports (B3); orders and payments are recorded by the server itself. */
export type AppEvent = 'app_open' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'language_change' | 'cod_selected' | 'payment_soon_click' | 'manifest_open' | 'ai_tab_click' | 'upsell_shown' | 'upsell_add' | 'notification_open' | 'notification_read_all' | 'active_order_click' | 'promo_apply_success' | 'promo_apply_fail' | 'promo_remove' | 'compat_view' | 'map_open' | 'map_locate_me' | 'map_confirm' | 'map_district_auto' | 'campaign_view' | 'campaign_banner_click' | 'campaign_add_to_cart' | 'support_ask_sent' | 'home_banner_view' | 'home_banner_click';

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
