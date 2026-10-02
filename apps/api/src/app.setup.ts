import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { static as serveStatic } from 'express';
import { uploadDir } from './storage/file-storage';

/** Shared by main.ts and e2e tests so both run the exact same HTTP pipeline. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  app.enableCors(); // MVP: Mini App dev server runs on another origin; restrict before production
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  // Uploaded product photos (LocalFileStorage). With S3 this line goes away.
  app.use('/uploads', serveStatic(uploadDir(app.get(ConfigService)), { index: false, maxAge: '7d' }));
}
