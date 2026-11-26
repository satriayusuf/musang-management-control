// Liveness/readiness probe.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

export async function healthRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.get('/healthz', async (_request, reply) => {
    let db = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = false;
    }
    return reply.status(db ? 200 : 503).send({ status: db ? 'ok' : 'degraded', db });
  });
}
