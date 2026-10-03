import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// One implementation of the dev login for both apps (security rules are documented there).
import { devTelegramLogin, TUNNEL_HOSTS } from '../miniapp/dev-login-plugin';
// Logo and icons: one folder (apps/miniapp/public/brand) for both apps.
import { brand } from '../miniapp/brand-plugin';

export default defineConfig({
  plugins: [react(), devTelegramLogin(), brand({ shareFiles: true })],
  server: {
    port: 5174,
    allowedHosts: TUNNEL_HOSTS,
    proxy: { '/api': 'http://localhost:3000', '/uploads': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
  },
});
