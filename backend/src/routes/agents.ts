// Agent-facing endpoints (agent-token auth), CONTRACT.md paths:
//   POST /api/agents/register
//   POST /api/agents/:id/heartbeat
//   GET  /api/agents/:id/commands?status=queued
//   POST /api/agents/:id/commands/:cmdId/ack
//   POST /api/agents/:id/commands/:cmdId/result
//   POST /api/agents/:id/events

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { authenticateAgent, bearerToken, httpError } from '../plugins/auth';
import { verifyAgentToken } from '../lib/crypto';
import { toCommandDto } from '../lib/serialize';
import {
  ackBodySchema,
  agentEventBodySchema,
  heartbeatBodySchema,
  registerBodySchema,
  resultBodySchema,
} from '../schemas';
import {
  ackCommand,
  claimCommands,
  reportCommandResult,
  type CommandResultBody,
} from '../services/commands';
import { createEvent } from '../services/events';
import { processHeartbeat, type HeartbeatBody } from '../services/heartbeat';
import { getSettings } from '../services/settings';
import { reattachAgent, registerWithPairing, type RegisterBody } from '../services/session';
import type { PoolMonitorService } from '../services/pool';

interface Deps {
  poolMonitor: PoolMonitorService;
}

/** Reject ack/result/claim calls carrying a non-current session id (409). */
function assertSessionCurrent(agentCurrentSessionId: string | null, sessionId?: string): void {
  if (sessionId && agentCurrentSessionId && sessionId !== agentCurrentSessionId) {
    throw httpError(409, 'SESSION_SUPERSEDED');
  }
}

export async function agentRoutes(app: FastifyInstance, prisma: PrismaClient, deps: Deps): Promise<void> {
  // --- Registration: pairing (unauthenticated) or re-attach (Bearer token) ---
  app.post<{ Body: RegisterBody }>(
    '/api/agents/register',
    {
      schema: { body: registerBodySchema },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = request.body;
      const settings = await getSettings(prisma);
      const config = {
        heartbeat_interval_sec: settings.heartbeat_interval_sec,
        unreachable_missed_beats: settings.unreachable_missed_beats,
        min_mem_start_gib: settings.min_mem_start_gib,
      };

      if (body.pairing_code) {
        const result = await registerWithPairing(prisma, body);
        return reply.status(201).send({
          agent_id: result.agent.id,
          agent_token: result.agentToken,
          session_id: result.session.id,
          session_no: result.session.sessionNo,
          config,
        });
      }

      // Re-attach: Bearer token + agent_id in body.
      const agentId = body.agent_id as string;
      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (!agent) throw httpError(404, 'AGENT_NOT_FOUND');
      const token = bearerToken(request);
      if (!token || agent.revokedAt || !verifyAgentToken(token, agent.tokenHash)) {
        throw httpError(401, 'AGENT_UNAUTHORIZED');
      }
      const result = await reattachAgent(prisma, agent, body);
      return reply.send({
        agent_id: result.agent.id,
        session_id: result.session.id,
        session_no: result.session.sessionNo,
        config,
      });
    },
  );

  // --- Heartbeat ---
  app.post<{ Params: { id: string }; Body: HeartbeatBody }>(
    '/api/agents/:id/heartbeat',
    { schema: { body: heartbeatBodySchema } },
    async (request, reply) => {
      const agent = await authenticateAgent(prisma, request, request.params.id);
      if (!agent.currentSessionId || request.body.session_id !== agent.currentSessionId) {
        return reply.status(409).send({ error: 'SESSION_SUPERSEDED' });
      }
      const settings = await getSettings(prisma);
      const result = await processHeartbeat(prisma, agent, request.body, deps.poolMonitor.isConfigured());
      return {
        ack: true,
        queued_commands: result.queuedCommands,
        heartbeat_interval_sec: settings.heartbeat_interval_sec,
        min_mem_start_gib: settings.min_mem_start_gib,
      };
    },
  );

  // --- Command polling (atomic claim) ---
  app.get<{ Params: { id: string }; Querystring: { status?: string; session_id?: string } }>(
    '/api/agents/:id/commands',
    async (request) => {
      const agent = await authenticateAgent(prisma, request, request.params.id);
      assertSessionCurrent(agent.currentSessionId, request.query.session_id);
      if (request.query.status && request.query.status !== 'queued') {
        return { commands: [] };
      }
      const claimed = await claimCommands(prisma, agent.id);
      return {
        commands: claimed.map((c) => ({
          id: c.id,
          type: c.type,
          payload: c.payload,
          created_at: c.createdAt.toISOString(),
          expires_at: c.expiresAt.toISOString(),
        })),
      };
    },
  );

  // --- Command ack ---
  app.post<{ Params: { id: string; cmdId: string }; Body: { session_id?: string } }>(
    '/api/agents/:id/commands/:cmdId/ack',
    { schema: { body: ackBodySchema } },
    async (request) => {
      const agent = await authenticateAgent(prisma, request, request.params.id);
      assertSessionCurrent(agent.currentSessionId, request.body?.session_id);
      const updated = await ackCommand(prisma, agent, request.params.cmdId);
      return toCommandDto(updated);
    },
  );

  // --- Command result ---
  app.post<{ Params: { id: string; cmdId: string }; Body: CommandResultBody & { session_id?: string } }>(
    '/api/agents/:id/commands/:cmdId/result',
    { schema: { body: resultBodySchema } },
    async (request) => {
      const agent = await authenticateAgent(prisma, request, request.params.id);
      assertSessionCurrent(agent.currentSessionId, request.body?.session_id);
      const { command, verification } = await reportCommandResult(prisma, agent, request.params.cmdId, request.body);
      return { ...toCommandDto(command), verification };
    },
  );

  // --- Ad-hoc bridge events ---
  app.post<{
    Params: { id: string };
    Body: { type: string; description?: string; metadata?: Record<string, unknown>; session_id?: string };
  }>(
    '/api/agents/:id/events',
    { schema: { body: agentEventBodySchema } },
    async (request, reply) => {
      const agent = await authenticateAgent(prisma, request, request.params.id);
      const worker = await prisma.worker.findUnique({ where: { agentId: agent.id } });
      const metadata = { ...(request.body.metadata ?? {}) };
      if (request.body.session_id) metadata.session_id = request.body.session_id;
      const event = await createEvent(prisma, {
        agentId: agent.id,
        workerId: worker?.id ?? null,
        type: request.body.type,
        description: request.body.description ?? request.body.type,
        metadata,
      });
      return reply.status(201).send({
        id: event.id,
        type: event.type,
        created_at: event.createdAt.toISOString(),
      });
    },
  );
}
