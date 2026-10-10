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
  // Yandex Market: tests never talk to the real Yandex. These win over apps/api/.env (it may hold a real token and
  // the live mode); the suites that test the sync set their own fake key and inject a fake fetch.
  YANDEX_API_KEY: '',
  YANDEX_SYNC_ENABLED: 'false',
  YANDEX_SYNC_DRY_RUN: 'true',
  YANDEX_WEBHOOK_ENABLED: 'false',
  YANDEX_WEBHOOK_SECRET: '',
  UPLOAD_DIR: require('path').join(require('os').tmpdir(), 'vitalo-e2e-uploads'),
};
