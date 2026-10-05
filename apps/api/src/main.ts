import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  // API docs: on in development; in production only when API_DOCS=true (they list every endpoint).
  const docs = process.env.NODE_ENV !== 'production' || process.env.API_DOCS === 'true';
  if (docs) {
    const docConfig = new DocumentBuilder().setTitle('VITALO API').setVersion('0.1').addBearerAuth().build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, docConfig));
  }

  const port = Number(process.env.PORT ?? 3000);
  // HOST=127.0.0.1 on the server: only nginx (same machine) can reach the API port.
  const host = process.env.HOST || undefined;
  await app.listen(port, host as string);
  console.log(`VITALO API: http://${host ?? 'localhost'}:${port}/api${docs ? `  |  docs: http://${host ?? 'localhost'}:${port}/api/docs` : ''}`);
}

bootstrap();
