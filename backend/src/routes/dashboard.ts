// Dashboard endpoints (JWT): overview, agent list/detail, pairing, revoke.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { generatePairingCode, newId, sha256Hex } from '../lib/crypto';
import { toAgentDto, toCommandDto, toEventDto, toSessionDto, toWorkerDto } from '../lib/serialize';
import { httpError, requireRole, requireUser } from '../plugins/auth';
import { pairingBodySchema } from '../schemas';
import { createAuditLog } from '../services/audit';
import { poolFieldsForAgents } from '../services/pool-status';
import { getSettings } from '../services/settings';
import { broadcast } from '../services/ws';
import type { PoolMonitorService } from '../services/pool';

interface Deps {
  poolMonitor: PoolMonitorService;
}

const WORKER_STATUSES = ['SEHAT', 'WASPADA', 'MATI', 'GAGAL_START', 'TAK_TERJANGKAU', 'POOL_STALL'];

export async function dashboardRoutes(app: FastifyInstance, prisma: PrismaClient, deps: Deps): Promise<void> {
  // --- Overview ---
  app.get('/api/dashboard/overview', { preHandler: requireUser }, async () => {
    const [agents, workers, activeCommands, recentEvents] = await Promise.all([
      prisma.agent.findMany({ include: { worker: true } }),
      prisma.worker.findMany(),
      prisma.command.count({ where: { status: { in: ['QUEUED', 'SENT', 'RUNNING'] } } }),
      prisma.event.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);

    const distribution: Record<string, number> = Object.fromEntries(WORKER_STATUSES.map((s) => [s, 0]));
    for (const w of workers) distribution[w.status] = (distribution[w.status] ?? 0) + 1;

    let online = 0;
    let unreachable = 0;
    let working = 0;
    let warning = 0;
    let idle = 0;
    for (const agent of agents) {
      if (agent.status === 'UNREACHABLE') {
        unreachable += 1;
        continue;
      }
      online += 1;
      const ws = agent.worker?.status;
      if (ws === 'SEHAT') working += 1;
      else if (ws === 'WASPADA' || ws === 'POOL_STALL') warning += 1;
      else if (ws === 'MATI' || ws === 'GAGAL_START') {
        // counted under miners.dead, not idle
      } else idle += 1;
    }

    const alerts: Array<Record<string, unknown>> = [];
    for (const w of workers) {
      if (w.status === 'MATI' || w.status === 'GAGAL_START' || w.status === 'POOL_STALL') {
        const agent = agents.find((a) => a.id === w.agentId);
        alerts.push({
          agent_name: agent?.name ?? null,
          worker_name: w.name,
          type: w.status,
          reason: w.statusReason,
          at: w.statusSince.toISOString(),
          action: w.status === 'GAGAL_START' ? 'check_memory' : w.status === 'POOL_STALL' ? 'check_pool' : 'run_again',
        });
      }
    }
    for (const agent of agents) {
      if (agent.status === 'UNREACHABLE') {
        alerts.push({
          agent_name: agent.name,
          worker_name: agent.worker?.name ?? null,
          type: 'TAK_TERJANGKAU',
          reason: 'Heartbeat agent berhenti',
          at: agent.lastSeenAt?.toISOString() ?? agent.updatedAt.toISOString(),
          action: 'check_agent',
        });
      }
    }

    return {
      agents: { total: agents.length, online, working, idle, warning, unreachable },
      miners: {
        total: workers.length,
        healthy: distribution.SEHAT ?? 0,
        dead: (distribution.MATI ?? 0) + (distribution.GAGAL_START ?? 0),
      },
      active_commands: activeCommands,
      worker_status_distribution: distribution,
      recent_events: recentEvents.map(toEventDto),
      active_alerts: alerts.slice(0, 20),
      pool_configured: deps.poolMonitor.isConfigured(),
    };
  });

  // --- Agent list ---
  app.get<{
    Querystring: { search?: string; status?: string; page?: string; page_size?: string; sort?: string };
  }>('/api/agents', { preHandler: requireUser }, async (request) => {
    const page = Math.max(1, Number(request.query.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(request.query.page_size ?? 20) || 20));
    const search = request.query.search?.trim();
    const status = request.query.status?.trim();

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { id: { contains: search } },
        { workerName: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) {
      if (status === 'ONLINE' || status === 'UNREACHABLE') where.status = status;
      else if (WORKER_STATUSES.includes(status)) where.worker = { status };
    }

    const orderBy =
      request.query.sort === 'name'
        ? { name: 'asc' as const }
        : request.query.sort === 'replacement_count'
          ? { replacementCount: 'desc' as const }
          : { lastSeenAt: 'desc' as const };

    const [total, rows] = await Promise.all([
      prisma.agent.count({ where: where as never }),
      prisma.agent.findMany({
        where: where as never,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { worker: true },
      }),
    ]);

    const sessionIds = rows.map((a) => a.currentSessionId).filter(Boolean) as string[];
    const sessions = sessionIds.length
      ? await prisma.session.findMany({ where: { id: { in: sessionIds } } })
      : [];
    const sessionById = new Map(sessions.map((s) => [s.id, s]));

    // Phase 5 (CONTRACT-5 B6): embedded worker objects carry the pool block.
    const poolFields = await poolFieldsForAgents(
      prisma,
      rows.map((a) => a.id),
      new Date(),
    );

    return {
      items: rows.map((a) => {
        const dto = toAgentDto(a, {
          current_session: a.currentSessionId ? (sessionById.get(a.currentSessionId) ?? null) : null,
          worker: a.worker ?? null,
        });
        if (dto.worker) dto.worker = { ...dto.worker, pool: poolFields.get(a.id) ?? null };
        return dto;
      }),
      total,
      page,
      page_size: pageSize,
    };
  });

  // --- Agent detail ---
  app.get<{ Params: { id: string }; Querystring: { page?: string; page_size?: string } }>(
    '/api/agents/:id',
    { preHandler: requireUser },
    async (request) => {
      const agent = await prisma.agent.findUnique({
        where: { id: request.params.id },
        include: { worker: true },
      });
      if (!agent) throw httpError(404, 'AGENT_NOT_FOUND');

      const page = Math.max(1, Number(request.query.page ?? 1) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(request.query.page_size ?? 20) || 20));

      const [sessionTotal, sessionRows, recentEvents, recentCommands, currentSession] = await Promise.all([
        prisma.session.count({ where: { agentId: agent.id } }),
        prisma.session.findMany({
          where: { agentId: agent.id },
          orderBy: { startedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.event.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
        prisma.command.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
        agent.currentSessionId
          ? prisma.session.findUnique({ where: { id: agent.currentSessionId } })
          : Promise.resolve(null),
      ]);

      const now = Date.now();
      // Phase 5 (CONTRACT-5 B6): pool block on the worker payloads.
      const poolFields = await poolFieldsForAgents(prisma, [agent.id], new Date());
      const poolField = agent.worker ? (poolFields.get(agent.id) ?? null) : null;
      const agentDto = toAgentDto(agent, { current_session: currentSession, worker: agent.worker ?? null });
      if (agentDto.worker) agentDto.worker = { ...agentDto.worker, pool: poolField };
      return {
        ...agentDto,
        health: {
          status: agent.status,
          last_seen_at: agent.lastSeenAt?.toISOString() ?? null,
          current_session_uptime_sec: currentSession
            ? Math.max(0, Math.floor((now - currentSession.startedAt.getTime()) / 1000))
            : null,
        },
        worker_metrics: agent.worker ? { ...toWorkerDto(agent.worker), pool: poolField } : null,
        sessions: {
          items: sessionRows.map(toSessionDto),
          total: sessionTotal,
          page,
          page_size: pageSize,
        },
        recent_events: recentEvents.map(toEventDto),
        recent_commands: recentCommands.map(toCommandDto),
      };
    },
  );

  // --- Pairing code creation ---
  app.post<{ Body: { planned_name: string } }>(
    '/api/agents/pairing',
    { preHandler: [requireUser, requireRole('ADMIN')], schema: { body: pairingBodySchema } },
    async (request, reply) => {
      const user = request.user as { email: string };
      const settings = await getSettings(prisma);
      const rawCode = generatePairingCode();
      const expiresAt = new Date(Date.now() + settings.pairing_ttl_sec * 1000);
      await prisma.pairingCode.create({
        data: {
          id: newId('pair'),
          codeHash: sha256Hex(rawCode),
          plannedName: request.body.planned_name,
          createdBy: user.email,
          expiresAt,
        },
      });
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'agent.pairing.create',
        target: request.body.planned_name,
        metadata: { expires_at: expiresAt.toISOString() },
      });
      return reply.status(201).send({ pairing_code: rawCode, expires_at: expiresAt.toISOString() });
    },
  );

  // --- Revoke agent token ---
  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/revoke',
    { preHandler: [requireUser, requireRole('ADMIN')] },
    async (request) => {
      const user = request.user as { email: string };
      const agent = await prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!agent) throw httpError(404, 'AGENT_NOT_FOUND');
      const updated = await prisma.agent.update({
        where: { id: agent.id },
        data: { tokenHash: null, revokedAt: new Date() },
      });
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'agent.revoke',
        target: agent.id,
        metadata: { agent_name: agent.name },
      });
      broadcast('agent.status_changed', { agent_id: agent.id, status: agent.status, revoked: true });
      return toAgentDto(updated);
    },
  );

  // --- Delete agent permanently (ADMIN) ---
  // Removes the agent and, via ON DELETE CASCADE, all of its operational
  // data (sessions, heartbeats, worker, pool snapshot, commands, events).
  // The audit log entry for the deletion itself is kept (audit rows are
  // not tied to the agent by a foreign key).
  app.delete<{ Params: { id: string } }>(
    '/api/agents/:id',
    { preHandler: [requireUser, requireRole('ADMIN')] },
    async (request) => {
      const user = request.user as { email: string };
      const agent = await prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!agent) throw httpError(404, 'AGENT_NOT_FOUND');
      await prisma.agent.delete({ where: { id: agent.id } });
      await createAuditLog(prisma, {
        actor: user.email,
        action: 'agent.delete',
        target: agent.id,
        metadata: { agent_name: agent.name, worker_name: agent.workerName },
      });
      broadcast('agent.deleted', { agent_id: agent.id });
      return { deleted: true, id: agent.id, name: agent.name };
    },
  );
}
