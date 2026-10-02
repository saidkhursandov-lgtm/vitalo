/**
 * Adds (or re-activates) ONE employee in staff_users. Not a seed: touches nothing else.
 * Usage (apps/api): npm run staff:add -- --telegram-id 123456789 --name "Admin" --role admin
 * Roles: admin | manager | warehouse | marketer. Uses DATABASE_URL from apps/api/.env.
 */
import 'dotenv/config';
import { PrismaClient, StaffRole } from '@prisma/client';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const telegramId = arg('telegram-id') ?? '';
  const name = arg('name')?.trim() ?? '';
  const role = (arg('role') ?? 'manager') as StaffRole;
  if (!/^\d{5,15}$/.test(telegramId)) throw new Error('--telegram-id must be digits');
  if (!name) throw new Error('--name is required');
  if (!Object.values(StaffRole).includes(role)) throw new Error(`--role must be one of ${Object.values(StaffRole).join(', ')}`);

  const prisma = new PrismaClient();
  try {
    const db = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
    const staff = await prisma.staff_users.upsert({
      where: { telegram_user_id: BigInt(telegramId) },
      create: { telegram_user_id: BigInt(telegramId), name, role },
      update: { name, role, status: 'active' },
    });
    console.log(`Database "${db}": employee ${staff.name} (Telegram ${telegramId}) is ${staff.role}, status ${staff.status}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
