import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { AppError, isAppError, type ApiErrorBody } from '@rag/shared';
import { enterContext } from '@rag/shared/server';
import Fastify, { type FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import type { AppDeps } from './context';
import { createAuthenticator } from './plugins/auth';
import { adminRoutes } from './routes/admin';
import { chatRoutes } from './routes/chat';
import { conversationRoutes } from './routes/conversations';
import { documentRoutes } from './routes/documents';
import { evaluationRoutes } from './routes/evaluations';
import { healthRoutes } from './routes/health';

const CORRELATION_RE = /^[A-Za-z0-9-]{8,64}$/;

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp(deps: AppDeps) {
  const { env, logger } = deps.runtime;
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const h = req.headers['x-correlation-id'];
      return typeof h === 'string' && CORRELATION_RE.test(h) ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('principal', null as never);

  app.addHook('onRequest', async (req, reply) => {
    enterContext({ correlationId: req.id });
    reply.header('x-correlation-id', req.id);
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, { origin: [env.WEB_ORIGIN], credentials: false, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] });
  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    max: env.API_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis: deps.redis,
    nameSpace: `${env.QUEUE_PREFIX}:ratelimit:`,
    keyGenerator: (req) => (req.principal?.id ? `u:${req.principal.id}` : `ip:${req.ip}`),
    errorResponseBuilder: (_req, ctx) => {
      const err = new AppError('RATE_LIMITED', `Muitas requisições. Tente novamente em ${Math.ceil(ctx.ttl / 1000)} segundos.`);
      (err as unknown as { statusCode: number }).statusCode = ctx.statusCode;
      return err;
    },
  });
  await app.register(multipart, {
    limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1, fields: 20, fieldSize: 64 * 1024, parts: 25, headerPairs: 200 },
  });

  if (env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: { info: { title: 'API — Assistente Documental Institucional', version: '0.1.0' } },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  app.setErrorHandler((error: FastifyError, req, reply) => {
    const correlationId = req.id;
    let status = 500;
    let body: ApiErrorBody;
    if (hasZodFastifySchemaValidationErrors(error)) {
      status = 400;
      body = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Dados inválidos na requisição.',
          details: error.validation.map((v) => ({
            path: v.instancePath || (v.params as { issue?: { path?: PropertyKey[] } }).issue?.path?.map(String).join('.') || '',
            message: v.message,
          })),
          correlationId,
        },
      };
    } else if (isAppError(error)) {
      status = (error as unknown as { statusCode?: number }).statusCode ?? error.statusCode;
      body = { error: { code: error.code, message: error.message, details: error.details, correlationId } };
    } else if (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.statusCode === 413) {
      status = 413;
      body = { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Arquivo ou requisição excede o tamanho máximo permitido.', correlationId } };
    } else if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      status = error.statusCode;
      body = { error: { code: 'VALIDATION_ERROR', message: 'Requisição inválida.', correlationId } };
    } else {
      body = { error: { code: 'INTERNAL_ERROR', message: 'Erro interno. Informe o código de correlação ao suporte.', correlationId } };
    }
    if (status >= 500) req.log.error({ err: error }, 'request failed');
    else req.log.warn({ code: body.error.code, status }, 'request rejected');
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.', correlationId: req.id } });
  });

  await app.register(healthRoutes, { deps });

  const authenticate = createAuthenticator({ token: env.ADMIN_API_TOKEN, defaultClearance: env.DEFAULT_ACCESS_CLEARANCE });
  await app.register(
    async (api) => {
      api.addHook('onRequest', authenticate);
      await api.register(documentRoutes, { deps });
      await api.register(conversationRoutes, { deps });
      await api.register(chatRoutes, { deps });
      await api.register(adminRoutes, { deps });
      await api.register(evaluationRoutes, { deps });
    },
    { prefix: '/api' },
  );

  return app;
}
