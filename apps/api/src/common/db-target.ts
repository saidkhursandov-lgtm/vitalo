/**
 * Which database DATABASE_URL points to (never the password): banners and safety checks of CLI scripts.
 * Local databases of this computer: vitalo_dev (working) and vitalo_test (e2e tests); the real shop's
 * database lives on the server and is called vitalo.
 */
export interface DbTarget {
  host: string;
  port: string;
  database: string;
  /** host is a unix socket directory (production: ?host=/var/run/postgresql) */
  socket: boolean;
}

/** Databases that demo/dev scripts may touch: names ending with _dev or _test. */
export const DEV_OR_TEST_DB = /_(dev|test)$/;

export function dbTarget(url = process.env.DATABASE_URL): DbTarget {
  if (!url) throw new Error('DATABASE_URL is empty (apps/api/.env)');
  const u = new URL(url);
  const socketDir = u.searchParams.get('host');
  return {
    host: socketDir || u.hostname || 'localhost',
    port: u.port || '5432',
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    socket: !!socketDir,
  };
}

export function describeDb(t: DbTarget): string {
  return t.socket ? `«${t.database}» (сокет ${t.host})` : `«${t.database}» на ${t.host}:${t.port}`;
}

/**
 * Seed and dev:* scripts: refuse NODE_ENV=production and any database whose name does not end with _dev/_test
 * (the server's vitalo and the old local vitalo). The message says why and what to do instead.
 */
export function assertDevOrTestDatabase(script: string, env: NodeJS.ProcessEnv = process.env): DbTarget {
  if (env.NODE_ENV === 'production') {
    throw new Error(`${script} refuses NODE_ENV=production: это скрипт для разработки, на сервере его запускать нельзя. Для первого запуска магазина: npm run bootstrap:prod`);
  }
  const t = dbTarget(env.DATABASE_URL);
  if (!DEV_OR_TEST_DB.test(t.database)) {
    throw new Error(
      `${script} отказывается работать с базой ${describeDb(t)}: разрешены только базы, чьё имя оканчивается на _dev или _test ` +
        '(на этом компьютере — vitalo_dev и vitalo_test). Так демо-данные не попадут в базу магазина. ' +
        'Если локальная база ещё называется vitalo, переименуйте её: scripts/rename-local-db.ps1.',
    );
  }
  return t;
}

/** One line at the start of scripts that write to whatever DATABASE_URL says (staff:add, import, photos, bootstrap). */
export function printDbBanner(script: string, env: NodeJS.ProcessEnv = process.env): DbTarget {
  const t = dbTarget(env.DATABASE_URL);
  console.log(`=== ${script}: база ${describeDb(t)}${env.NODE_ENV ? `, NODE_ENV=${env.NODE_ENV}` : ''} ===`);
  return t;
}
