import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import compression from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from './core/app/app.module';
import { ConfigService } from '@/core/config/config.service';
import { ProblemDetailsExceptionFilter } from '@/modules/auth/errors/problem-details-exception.filter';

async function bootstrap() {
  initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Fastify answers 404 for a path param over 100 chars; the profile routes
    // accept 128 and must answer 400 above that, so the guard has to see them.
    new FastifyAdapter({ routerOptions: { maxParamLength: 256 } }),
  );

  await app.register(compression);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());

  const configService = app.get(ConfigService);

  // Exact origins only: credentials are allowed, so a wildcard is never used.
  const trustedOrigin = configService.get('AUTH_TRUSTED_ORIGIN');
  app.enableCors({
    origin: [
      'http://localhost:5174',
      'http://localhost:4200',
      'http://localhost:8080',
      ...(trustedOrigin ? [trustedOrigin] : []),
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Protection'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Interactive API docs; not exposed in production.
  if (String(configService.get('NODE_ENV')) !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('NestJS Monolith API')
      .setVersion('1.0')
      .addCookieAuth('access_token')
      .build();
    SwaggerModule.setup(
      'docs',
      app,
      SwaggerModule.createDocument(app, swaggerConfig),
    );
  }

  await app.register(fastifyCookie, {
    secret: configService.get('COOKIE_SECRET'),
  });

  const port = configService.get('PORT');

  await app.listen(port);
}

void bootstrap();
