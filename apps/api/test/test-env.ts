/** e2e tests run against a separate database, never the dev one. */
export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://vitalo:vitalo@localhost:5432/vitalo_test',
  TELEGRAM_BOT_TOKEN: '123456:E2E_TEST_TOKEN',
  SESSION_TTL_HOURS: '720',
  STAFF_SESSION_TTL_HOURS: '12',
  INIT_DATA_MAX_AGE_SECONDS: '3600',
  JOBS_ENABLED: 'false', // tests call ReservationExpiryService.runOnce() directly
  UPLOAD_DIR: require('path').join(require('os').tmpdir(), 'vitalo-e2e-uploads'),
};
