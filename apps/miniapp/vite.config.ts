import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devTelegramLogin, TUNNEL_HOSTS } from './dev-login-plugin';

export default defineConfig({
  plugins: [react(), devTelegramLogin()],
  server: {
    port: 5173,
    allowedHosts: TUNNEL_HOSTS,
    // Same origin for the browser: /api goes to the NestJS API (npm run start:dev in apps/api).
    proxy: { '/api': 'http://localhost:3000', '/uploads': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
  },
});
