import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// One implementation of the dev login for both apps (security rules are documented there).
import { devTelegramLogin, TUNNEL_HOSTS } from '../miniapp/dev-login-plugin';
// Logo and icons: one folder (apps/miniapp/public/brand) for both apps.
import { brand } from '../miniapp/brand-plugin';

// Where /api goes; VITALO_API_URL lets a second copy run against the test database (see .claude/launch.json).
const API = process.env.VITALO_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), devTelegramLogin(), brand({ shareFiles: true })],
  server: {
    port: Number(process.env.VITE_PORT ?? 5174),
    allowedHosts: TUNNEL_HOSTS,
    proxy: { '/api': API, '/uploads': API },
  },
  test: {
    environment: 'jsdom',
  },
});
