import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { signInitData } from '../src/auth/sign-init-data';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

export function makeInitData(
  user: Record<string, unknown>,
  opts: { authDate?: number; botToken?: string } = {},
): string {
  const authDate = opts.authDate ?? Math.floor(Date.now() / 1000);
  return signInitData(
    { auth_date: String(authDate), user: JSON.stringify(user) },
    opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN!,
  );
}
