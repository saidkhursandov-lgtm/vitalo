/** e2e tests run against a separate database, never the dev one. */
export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://vitalo:vitalo@localhost:5432/vitalo_test',
  TELEGRAM_BOT_TOKEN: '123456:E2E_TEST_TOKEN',
  SESSION_TTL_HOURS: '720',
  INIT_DATA_MAX_AGE_SECONDS: '3600',
};
