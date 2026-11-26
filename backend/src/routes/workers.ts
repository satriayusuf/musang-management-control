// Worker endpoints (JWT): list, detail, create command.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toAgentDto, toCommandDto, toEventDto, toSessionDto, toWorkerDto } from '../lib/serialize';
import { httpError, requireRole, requireUser } from '../plugins/auth';
import { createCommandBodySchema } from '../schemas';
import { createCommand } from '../services/commands';
import { poolFieldsForAgents } from '../services/pool-status';
import { getTemplateOrThrow, mergePayload } from '../services/templates';
import type { PoolMonitorService } from '../services/pool';

interface Deps {
  poolMonitor: PoolMonitorService;
}

export async function workerRoutes(app: FastifyInstance, prisma: PrismaClient, deps: Deps): Promise<void> {
  app.get<{ Querystring: { page?: string; page_size?: string; status?: string } }>(
    '/api/workers',
    { preHandler: requireUser },
    async (request) => {
      const page = Math.max(1, Number(request.query.page ?? 1) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(request.query.page_size ?? 50) || 50));
      const where = request.query.status ? { status: request.query.status } : {};
      const [total, rows] = await Promise.all([
        prisma.worker.count({ where }),
        prisma.worker.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { agent: true },
        }),
      ]);
      const poolFields = await poolFieldsForAgents(
        prisma,
        rows.map((w) => w.agentId),
        new Date(),
      );
      return {
        items: rows.map((w) => ({
          ...toWorkerDto(w),
          pool: poolFields.get(w.agentId) ?? null,
          agent: {
            id: w.agent.id,
            name: w.agent.name,
            status: w.agent.status,
            replacement_count: w.agent.replacementCount,
            // "Tanggal ditambahkan" untuk baris worker = tanggal agent-nya
            // terdaftar; record Worker sendiri tidak menyimpan created_at.
            created_at: w.agent.createdAt.toISOString(),
          },
        })),
        total,
        page,
        page_size: pageSize,
        pool_configured: deps.poolMonitor.isConfigured(),
        pool_totals: (() => {
          const t = deps.poolMonitor.getPoolTotals();
          return t
            ? { hashrate: t.hashrate, worker_count: t.workerCount, fetched_at: t.fetchedAt.toISOString() }
            : null;
        })(),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/workers/:id', { preHandler: requireUser }, async (request) => {
    const worker = await prisma.worker.findUnique({
      where: { id: request.params.id },
      include: { agent: true },
    });
    if (!worker) throw httpError(404, 'WORKER_NOT_FOUND');
    const [sessions, events] = await Promise.all([
      prisma.session.findMany({
        where: { agentId: worker.agentId },
        orderBy: { startedAt: 'desc' },
        take: 50,
      }),
      prisma.event.findMany({ where: { workerId: worker.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    const currentSession = sessions.find((s) => s.id === worker.agent.currentSessionId) ?? null;
    const poolFields = await poolFieldsForAgents(prisma, [worker.agentId], new Date());
    return {
      ...toWorkerDto(worker),
      pool: poolFields.get(worker.agentId) ?? null,
      agent: toAgentDto(worker.agent, { current_session: currentSession }),
      session_timeline: sessions.map(toSessionDto),
      recent_events: events.map(toEventDto),
      pool_configured: deps.poolMonitor.isConfigured(),
    };
  });

  app.post<{
    Params: { id: string };
    Body: {
      type?: string;
      template_id?: string;
      payload?: Record<string, unknown>;
      idempotency_key: string;
      confirm?: boolean;
    };
  }>(
    '/api/workers/:id/commands',
    { preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')], schema: { body: createCommandBodySchema } },
    async (request, reply) => {
      const user = request.user as { email: string };
      const worker = await prisma.worker.findUnique({
        where: { id: request.params.id },
        include: { agent: true },
      });
      if (!worker) throw httpError(404, 'WORKER_NOT_FOUND');
      // Phase 2: a template resolves to type + default payload; an explicit
      // payload merges over the template's, and template_id is recorded.
      let type = request.body.type;
      let payload = request.body.payload;
      let templateId: string | null = null;
      if (request.body.template_id) {
        const template = await getTemplateOrThrow(prisma, request.body.template_id);
        if (type && type !== template.type) {
          throw httpError(400, 'Tipe perintah tidak cocok dengan tipe template');
        }
        type = template.type;
        payload = mergePayload(template.payload, payload);
        templateId = template.id;
      }
      if (!type) throw httpError(400, 'type atau template_id wajib diisi');
      const { command, created } = await createCommand(prisma, {
        worker,
        agent: worker.agent,
        type,
        payload,
        idempotencyKey: request.body.idempotency_key,
        requestedBy: user.email,
        confirm: request.body.confirm,
        templateId,
      });
      return reply.status(created ? 201 : 200).send(toCommandDto(command));
    },
  );
}
