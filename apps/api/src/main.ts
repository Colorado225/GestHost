/**
 * Bootstrap API GestHost (README §61, §72) : helmet, Swagger, filtre d'erreurs
 * standardisé { success:false, error:{ code, message, details, correlationId } }.
 */
import 'reflect-metadata';
import { Catch, ExceptionFilter, HttpException, HttpStatus, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import { AppModule } from './app.module';
import { DomainError } from './common/errors';
import { env, assertProductionSafety } from './common/env';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: any) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Erreur interne. Réessayez ou contactez le support.';
    let details: Record<string, unknown> = {};

    if (exception instanceof DomainError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp: any = exception.getResponse();
      code = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
      message = typeof resp === 'string' ? resp : (resp?.message ?? exception.message);
      if (Array.isArray(resp?.message)) {
        code = 'VALIDATION_ERROR';
        details = { fields: resp.message };
        message = 'Données invalides';
        status = 422;
      }
    }

    if (status >= 500) console.error(`[ERREUR ${correlationId}]`, exception);

    res.status(status).json({
      success: false,
      error: { code, message, details, correlationId },
    });
  }
}

async function bootstrap() {
  assertProductionSafety();
  const app = await NestFactory.create(AppModule, { logger: ['log', 'error', 'warn'] });

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix('');
  app.useGlobalFilters(new AllExceptionsFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('GestHost API')
    .setDescription('PMS GestHost — Property Management System (Côte d\'Ivoire / FNE)')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, doc);

  const port = env().PORT;
  await app.listen(port, '0.0.0.0');
  console.log(`✔ GestHost API prête sur http://0.0.0.0:${port} (Swagger: /docs)`);
}

bootstrap().catch((e) => {
  console.error('Échec du bootstrap API :', e);
  process.exit(1);
});
