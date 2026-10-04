/** e2e tests run against a separate database, never the dev one. */
export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://vitalo:vitalo@localhost:5432/vitalo_test',
  TELEGRAM_BOT_TOKEN: '123456:E2E_TEST_TOKEN',
  SESSION_TTL_HOURS: '720',
  STAFF_SESSION_TTL_HOURS: '12',
  INIT_DATA_MAX_AGE_SECONDS: '3600',
  JOBS_ENABLED: 'false', // tests call ReservationExpiryService.runOnce() directly
  BOT_API_SECRET: 'e2e-bot-secret-0123456789abcdef0123456789',
  CORS_ORIGINS: 'http://localhost:5173,https://shop.example.com',
  // Never message a real chat from tests; buttons only where a test sets MINIAPP_URL itself.
  TECH_CHAT_ID: '',
  MINIAPP_URL: '',
  UPLOAD_DIR: require('path').join(require('os').tmpdir(), 'vitalo-e2e-uploads'),
};
