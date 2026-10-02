import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { TEST_ENV } from './test-env';

/** Brings vitalo_test to a known state: apply migrations, wipe all rows, re-seed. */
export default async function globalSetup() {
  const dbName = new URL(TEST_ENV.DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to wipe non-test database "${dbName}"`);

  const env = { ...process.env, ...TEST_ENV };
  execSync('npx prisma migrate deploy', { env, stdio: 'inherit' });

  const prisma = new PrismaClient({ datasourceUrl: TEST_ENV.DATABASE_URL });
  try {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    // TRUNCATE bypasses the row-level "no delete" triggers on products / bonus_ledger.
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  } finally {
    await prisma.$disconnect();
  }

  execSync('npx ts-node prisma/seed.ts', { env, stdio: 'inherit' });
}
