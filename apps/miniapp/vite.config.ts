import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { brand } from './brand-plugin';
import { devTelegramLogin, TUNNEL_HOSTS } from './dev-login-plugin';

// Where /api goes; VITALO_API_URL lets a second copy run against the test database (see .claude/launch.json).
const API = process.env.VITALO_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), devTelegramLogin(), brand()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    allowedHosts: TUNNEL_HOSTS,
    // Same origin for the browser: /api goes to the NestJS API (npm run start:dev in apps/api).
    proxy: { '/api': API, '/uploads': API },
  },
  test: {
    environment: 'jsdom',
  },
});
