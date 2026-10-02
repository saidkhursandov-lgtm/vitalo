import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const docConfig = new DocumentBuilder().setTitle('VITALO API').setVersion('0.1').addBearerAuth().build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, docConfig));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`VITALO API: http://localhost:${port}/api  |  docs: http://localhost:${port}/api/docs`);
}

bootstrap();
