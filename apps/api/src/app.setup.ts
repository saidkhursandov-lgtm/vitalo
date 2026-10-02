import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  // Uploaded product photos (LocalFileStorage). With S3 this line goes away.
  app.use('/uploads', serveStatic(uploadDir(config), { index: false, maxAge: '7d' }));
}
