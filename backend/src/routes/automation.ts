// Automation rule endpoints (JWT, OPERATOR+) — Phase 3, CONTRACT-3 §2.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toRuleDto } from '../lib/serialize';
import { requireRole, requireUser } from '../plugins/auth';
import { ruleCreateBodySchema, rulePatchBodySchema, toggleBodySchema } from '../schemas';
import { createAuditLog } from '../services/audit';
import {
  createRule,
  deleteRule,
  toggleRule,
  updateRule,
  type RuleInput,
} from '../services/automation';

interface RuleBody {
  name: string;
  enabled?: boolean;
  condition: unknown;
  action: unknown;
  target: unknown;
  cooldown_sec?: number;
  max_per_day?: number;
}

export async function automationRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  const operatorPlus = { preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')] };

  app.get('/api/automation/rules', operatorPlus, async () => {
    const rows = await prisma.automationRule.findMany({ orderBy: { createdAt: 'asc' } });
    return { items: rows.map(toRuleDto), total: rows.length };
  });

  app.post<{ Body: RuleBody }>(
    '/api/automation/rules',
    { ...operatorPlus, schema: { body: ruleCreateBodySchema } },
    async (request, reply) => {
      const user = request.user as { email: string };
      const rule = await createRule(prisma, request.body as RuleInput);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'automation.rule_create',
        target: rule.id,
        metadata: { name: rule.name },
      });
      return reply.status(201).send(toRuleDto(rule));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<RuleBody> }>(
    '/api/automation/rules/:id',
    { ...operatorPlus, schema: { body: rulePatchBodySchema } },
    async (request) => {
      const user = request.user as { email: string };
      const rule = await updateRule(prisma, request.params.id, request.body as Partial<RuleInput>);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'automation.rule_update',
        target: rule.id,
        metadata: { keys: Object.keys(request.body) },
      });
      return toRuleDto(rule);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/automation/rules/:id',
    operatorPlus,
    async (request, reply) => {
      const user = request.user as { email: string };
      await deleteRule(prisma, request.params.id);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'automation.rule_delete',
        target: request.params.id,
        metadata: {},
      });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/automation/rules/:id/toggle',
    { ...operatorPlus, schema: { body: toggleBodySchema } },
    async (request) => {
      const user = request.user as { email: string };
      const rule = await toggleRule(prisma, request.params.id, request.body.enabled);
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'automation.rule_toggle',
        target: rule.id,
        metadata: { enabled: rule.enabled },
      });
      return toRuleDto(rule);
    },
  );
}
