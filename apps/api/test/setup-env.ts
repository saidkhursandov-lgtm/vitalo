import { TEST_ENV } from './test-env';

// Runs in every test worker before the app (and its .env loading) starts; .env never overrides these.
Object.assign(process.env, TEST_ENV);
