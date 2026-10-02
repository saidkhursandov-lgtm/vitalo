import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Shared by main.ts and e2e tests so both run the exact same HTTP pipeline. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  app.enableCors(); // MVP: Mini App dev server runs on another origin; restrict before production
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
}
