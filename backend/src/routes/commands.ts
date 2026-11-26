// Command endpoints (JWT): history list + detail, plus Phase 2 broadcast
// creation and batch progress views (CONTRACT-2 §2).

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toBatchDto, toCommandDto } from '../lib/serialize';
import { httpError, requireRole, requireUser } from '../plugins/auth';
import { broadcastBodySchema } from '../schemas';
import { createBroadcast } from '../services/broadcast';

export async function commandRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  // --- Phase 2: broadcast (registered before /api/commands/:id) ---
  app.post<{
    Body: {
      type?: string;
      template_id?: string;
      payload?: Record<string, unknown>;
      agent_ids: string[];
      confirm?: boolean;
      idempotency_key: string;
    };
  }>(
    '/api/commands/broadcast',
    { preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')], schema: { body: broadcastBodySchema } },
    async (request, reply) => {
      const user = request.user as { sub: string; email: string };
      const result = await createBroadcast(prisma, {
        type: request.body.type,
        templateId: request.body.template_id,
        payload: request.body.payload,
        agentIds: request.body.agent_ids,
        confirm: request.body.confirm,
        idempotencyKey: request.body.idempotency_key,
        requestedById: user.sub,
        requestedByEmail: user.email,
      });
      return reply.status(result.replayed ? 200 : 201).send({
        batch_id: result.batch.id,
        batch: toBatchDto(result.batch),
        created: result.created,
        skipped: result.skipped,
      });
    },
  );

  app.get<{ Querystring: { page?: string; page_size?: string } }>(
    '/api/commands/batches',
    { preHandler: requireUser },
    async (request) => {
      const page = Math.max(1, Number(request.query.page ?? 1) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(request.query.page_size ?? 20) || 20));
      const [total, rows] = await Promise.all([
        prisma.broadcastBatch.count(),
        prisma.broadcastBatch.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);
      const items = [] as Array<Record<string, unknown>>;
      for (const batch of rows) {
        const grouped = await prisma.command.groupBy({
          by: ['status'],
          where: { batchId: batch.id },
          _count: { _all: true },
        });
        const statusCounts: Record<string, number> = {};
        for (const g of grouped) statusCounts[g.status] = g._count._all;
        items.push({ ...toBatchDto(batch), command_status_counts: statusCounts });
      }
      return { items, total, page, page_size: pageSize };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/commands/batches/:id',
    { preHandler: requireUser },
    async (request) => {
      const batch = await prisma.broadcastBatch.findUnique({ where: { id: request.params.id } });
      if (!batch) throw httpError(404, 'BATCH_NOT_FOUND');
      const commands = await prisma.command.findMany({
        where: { batchId: batch.id },
        orderBy: { createdAt: 'asc' },
      });
      const statusCounts: Record<string, number> = {};
      for (const c of commands) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
      return {
        ...toBatchDto(batch),
        command_status_counts: statusCounts,
        commands: commands.map(toCommandDto),
      };
    },
  );

  // --- Phase 1: history list + detail ---
  app.get<{
    Querystring: {
      agent_id?: string;
      status?: string;
      type?: string;
      batch_id?: string;
      page?: string;
      page_size?: string;
    };
  }>('/api/commands', { preHandler: requireUser }, async (request) => {
    const page = Math.max(1, Number(request.query.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(request.query.page_size ?? 20) || 20));
    const where: Record<string, unknown> = {};
    if (request.query.agent_id) where.agentId = request.query.agent_id;
    if (request.query.status) where.status = request.query.status;
    if (request.query.type) where.type = request.query.type;
    if (request.query.batch_id) where.batchId = request.query.batch_id;
    const [total, rows] = await Promise.all([
      prisma.command.count({ where: where as never }),
      prisma.command.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(toCommandDto), total, page, page_size: pageSize };
  });

  app.get<{ Params: { id: string } }>('/api/commands/:id', { preHandler: requireUser }, async (request) => {
    const command = await prisma.command.findUnique({ where: { id: request.params.id } });
    if (!command) throw httpError(404, 'COMMAND_NOT_FOUND');
    return toCommandDto(command);
  });
}
