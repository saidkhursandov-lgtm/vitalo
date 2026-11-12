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
  // аудит 2.16: the libraries (React, router, React Query) are a chunk of their own — it does not change between
  // releases, so the browser keeps it cached and after an update downloads only the panel's own code
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@tanstack)[\\/]/.test(id) ? 'vendor' : undefined),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 20_000,
  },
});
