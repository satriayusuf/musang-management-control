// Event timeline endpoint (JWT) with filters.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toEventDto } from '../lib/serialize';
import { requireUser } from '../plugins/auth';

export async function eventRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.get<{
    Querystring: {
      agent_id?: string;
      worker_id?: string;
      type?: string;
      from?: string;
      to?: string;
      outcome?: string;
      page?: string;
      page_size?: string;
    };
  }>('/api/events', { preHandler: requireUser }, async (request) => {
    const page = Math.max(1, Number(request.query.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(request.query.page_size ?? 20) || 20));
    const where: Record<string, unknown> = {};
    if (request.query.agent_id) where.agentId = request.query.agent_id;
    if (request.query.worker_id) where.workerId = request.query.worker_id;
    if (request.query.type) where.type = request.query.type;
    if (request.query.from || request.query.to) {
      const range: Record<string, Date> = {};
      if (request.query.from) range.gte = new Date(request.query.from);
      if (request.query.to) range.lte = new Date(request.query.to);
      where.createdAt = range;
    }
    if (request.query.outcome) {
      where.metadata = { path: ['outcome'], equals: request.query.outcome };
    }
    const [total, rows] = await Promise.all([
      prisma.event.count({ where: where as never }),
      prisma.event.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(toEventDto), total, page, page_size: pageSize };
  });
}
