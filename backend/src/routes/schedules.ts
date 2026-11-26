// Schedule endpoints (JWT, OPERATOR+) — Phase 3, CONTRACT-3 §3.
// Responses always include next_run_at (server local timezone evaluation).

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toScheduleDto } from '../lib/serialize';
import { requireRole, requireUser } from '../plugins/auth';
import { scheduleCreateBodySchema, schedulePatchBodySchema, toggleBodySchema } from '../schemas';
import { createAuditLog } from '../services/audit';
import {
  createSchedule,
  deleteSchedule,
  toggleSchedule,
  updateSchedule,
  type ScheduleInput,
} from '../services/schedules';

interface ScheduleBody {
  name: string;
  enabled?: boolean;
  cron: string;
  action: unknown;
  target: unknown;
  broadcast?: boolean;
}

export async function scheduleRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  const operatorPlus = { preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')] };

  app.get('/api/schedules', operatorPlus, async () => {
    const rows = await prisma.schedule.findMany({ orderBy: { createdAt: 'asc' } });
    return { items: rows.map(toScheduleDto), total: rows.length };
  });

  app.post<{ Body: ScheduleBody }>(
    '/api/schedules',
    { ...operatorPlus, schema: { body: scheduleCreateBodySchema } },
    async (request, reply) => {
      const user = request.user as { email: string };
      const schedule = await createSchedule(prisma, request.body as ScheduleInput);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'schedule.create',
        target: schedule.id,
        metadata: { name: schedule.name, cron: schedule.cron },
      });
      return reply.status(201).send(toScheduleDto(schedule));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<ScheduleBody> }>(
    '/api/schedules/:id',
    { ...operatorPlus, schema: { body: schedulePatchBodySchema } },
    async (request) => {
      const user = request.user as { email: string };
      const schedule = await updateSchedule(prisma, request.params.id, request.body as Partial<ScheduleInput>);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'schedule.update',
        target: schedule.id,
        metadata: { keys: Object.keys(request.body) },
      });
      return toScheduleDto(schedule);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/schedules/:id',
    operatorPlus,
    async (request, reply) => {
      const user = request.user as { email: string };
      await deleteSchedule(prisma, request.params.id);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'schedule.delete',
        target: request.params.id,
        metadata: {},
      });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/schedules/:id/toggle',
    { ...operatorPlus, schema: { body: toggleBodySchema } },
    async (request) => {
      const user = request.user as { email: string };
      const schedule = await toggleSchedule(prisma, request.params.id, request.body.enabled);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'schedule.toggle',
        target: schedule.id,
        metadata: { enabled: schedule.enabled },
      });
      return toScheduleDto(schedule);
    },
  );
}
