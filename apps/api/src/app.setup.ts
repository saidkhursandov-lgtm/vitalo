import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { SystemErrorsService, UnexpectedErrorFilter } from './notifications/system-errors';
import { static as serveStatic } from 'express';
import { uploadDir } from './storage/file-storage';

/** Dev servers of the Mini App and admin panel; used only when CORS_ORIGINS is not set outside production. */
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'];

/**
 * Browser origins allowed to call the API directly (CORS). From CORS_ORIGINS (comma separated);
 * if it is not set: dev servers in development, nobody in production.
 * (The Mini App normally calls /api through its own server, so no CORS is involved at all.)
 */
export function corsOrigins(config: Pick<ConfigService, 'get'>): string[] {
  const raw = config.get<string>('CORS_ORIGINS')?.trim();
  if (raw) return raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return config.get<string>('NODE_ENV') === 'production' ? [] : DEV_ORIGINS;
}

/** Shared by main.ts and e2e tests so both run the exact same HTTP pipeline. */
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: corsOrigins(config) });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  // Unexpected 500 errors -> system_errors + the tech chat (D5); normal 4xx answers are not reported.
  app.useGlobalFilters(new UnexpectedErrorFilter(app.get(HttpAdapterHost).httpAdapter, app.get(SystemErrorsService)));
  // Uploaded product photos (LocalFileStorage). With S3 this line goes away.
  app.use('/uploads', serveStatic(uploadDir(config), { index: false, maxAge: '7d' }));
  // Аудит 10.11, п. 1.13: ответы админки (заказы, клиенты, деньги) не сохраняются в кэше браузера и прокси.
  // Здесь, а не в nginx: add_header внутри location отключил бы общие заголовки безопасности сайта.
  app.use('/api/staff', (_req: unknown, res: { setHeader(n: string, v: string): void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
}
