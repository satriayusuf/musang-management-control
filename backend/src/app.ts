// Fastify application factory. buildApp() is used by server.ts in production
// and by the integration tests (with an injected test Prisma client).

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import type { PrismaClient } from '@prisma/client';

import { createPrismaClient } from './plugins/prisma';
import { seedAdmin } from './services/auth';
import { ensureEnrollmentKey } from './services/enrollment';
import { seedSettings } from './services/settings';
import { seedCommandTemplates } from './services/templates';
import { createPoolProvider, PoolMonitorService } from './services/pool';

import { agentRoutes } from './routes/agents';
import { automationRoutes } from './routes/automation';
import { enrollmentRoutes } from './routes/enrollment';
import { exportRoutes } from './routes/export';
import { scheduleRoutes } from './routes/schedules';
import { userRoutes } from './routes/users';
import { alertRoutes } from './routes/alerts';
import { analyticsRoutes } from './routes/analytics';
import { authRoutes } from './routes/auth';
import { commandRoutes } from './routes/commands';
import { dashboardRoutes } from './routes/dashboard';
import { eventRoutes } from './routes/events';
import { healthRoutes } from './routes/health';
import { settingsRoutes } from './routes/settings';
import { templateRoutes } from './routes/templates';
import { workerRoutes } from './routes/workers';
import { wsRoutes } from './routes/ws';

export interface BuildAppOptions {
  prisma?: PrismaClient;
  logger?: boolean;
  /** Skip seeding (settings defaults + admin) — used by pure unit tests. */
  skipSeed?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  prisma: PrismaClient;
  poolMonitor: PoolMonitorService;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const prisma = options.prisma ?? createPrismaClient();
  const poolProvider = createPoolProvider(process.env);
  const poolMonitor = new PoolMonitorService(prisma, poolProvider);

  const app = Fastify({ logger: options.logger ?? false });

  // The dashboard client sets Content-Type: application/json on every
  // request, including action-only POSTs with no body (revoke, rotate,
  // hold/resume, ...). Fastify's default JSON parser rejects empty bodies
  // ("Body cannot be empty when content-type is set to
  // 'application/json'"), so treat an empty JSON body as {}.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, raw, done) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (text.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret-change-me' });
  await app.register(websocket);
  await app.register(swagger, {
    openapi: {
      info: { title: 'Muse Management Control API', version: '1.0.0' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  const deps = { poolMonitor };
  await healthRoutes(app, prisma);
  await authRoutes(app, prisma);
  await agentRoutes(app, prisma, deps);
  await dashboardRoutes(app, prisma, deps);
  await workerRoutes(app, prisma, deps);
  await commandRoutes(app, prisma);
  await templateRoutes(app, prisma);
  await alertRoutes(app, prisma);
  await eventRoutes(app, prisma);
  await analyticsRoutes(app, prisma);
  await settingsRoutes(app, prisma);
  await userRoutes(app, prisma);
  await automationRoutes(app, prisma);
  await scheduleRoutes(app, prisma);
  await exportRoutes(app, prisma);
  await enrollmentRoutes(app, prisma);
  await wsRoutes(app);

  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; validation?: unknown; message: string };
    const statusCode = err.statusCode ?? 500;
    if (err.validation) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: err.message });
    }
    if (statusCode >= 500) {
      app.log.error(error);
    }
    return reply.status(statusCode).send({ error: err.message });
  });

  if (!options.skipSeed) {
    try {
      await seedSettings(prisma);
      await seedAdmin(prisma);
      await seedCommandTemplates(prisma);
      await ensureEnrollmentKey(prisma);
    } catch (err) {
      app.log.warn({ err }, 'seeding skipped (database not reachable yet)');
    }
  }

  return { app, prisma, poolMonitor };
}
