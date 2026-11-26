// Command template endpoints (JWT) — Phase 2, CONTRACT-2 §1.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toTemplateDto } from '../lib/serialize';
import { requireRole, requireUser } from '../plugins/auth';
import { templateCreateBodySchema, templatePatchBodySchema } from '../schemas';
import { createAuditLog } from '../services/audit';
import { createTemplate, deleteTemplate, updateTemplate } from '../services/templates';

export async function templateRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.get('/api/command-templates', { preHandler: requireUser }, async () => {
    const rows = await prisma.commandTemplate.findMany({ orderBy: { name: 'asc' } });
    return { items: rows.map(toTemplateDto), total: rows.length };
  });

  app.post<{ Body: { name: string; type: string; payload?: Record<string, unknown>; description?: string; sensitive?: boolean } }>(
    '/api/command-templates',
    { preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')], schema: { body: templateCreateBodySchema } },
    async (request, reply) => {
      const user = request.user as { email: string };
      const template = await createTemplate(prisma, request.body);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'command_template.create',
        target: template.id,
        metadata: { name: template.name, type: template.type },
      });
      return reply.status(201).send(toTemplateDto(template));
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; type?: string; payload?: Record<string, unknown>; description?: string; sensitive?: boolean };
  }>(
    '/api/command-templates/:id',
    { preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')], schema: { body: templatePatchBodySchema } },
    async (request) => {
      const user = request.user as { email: string };
      const template = await updateTemplate(prisma, request.params.id, request.body);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'command_template.update',
        target: template.id,
        metadata: { keys: Object.keys(request.body) },
      });
      return toTemplateDto(template);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/command-templates/:id',
    { preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')] },
    async (request, reply) => {
      const user = request.user as { email: string };
      await deleteTemplate(prisma, request.params.id);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'command_template.delete',
        target: request.params.id,
        metadata: {},
      });
      return reply.status(204).send();
    },
  );
}
