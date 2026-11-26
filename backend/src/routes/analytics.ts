// Analytics (JWT): real database aggregates only — per-agent and per-worker
// metrics over a selectable range (24h | 7d | 30d | custom).

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { requireUser } from '../plugins/auth';
import {
  longestGapSec,
  sessionDurationDistribution,
  sharesPerSession,
} from '../services/analytics-helpers';

interface Range {
  from: Date;
  to: Date;
}

function parseRange(query: { range?: string; from?: string; to?: string }): Range {
  const now = new Date();
  if (query.range === 'custom' && query.from) {
    return { from: new Date(query.from), to: query.to ? new Date(query.to) : now };
  }
  // Phase 2 default is 7d (CONTRACT-2 §3); 24h and 30d stay explicit.
  const hours = query.range === '24h' ? 24 : query.range === '30d' ? 30 * 24 : 7 * 24;
  return { from: new Date(now.getTime() - hours * 3600_000), to: now };
}

function overlapSec(start: Date, end: Date, range: Range): number {
  const s = Math.max(start.getTime(), range.from.getTime());
  const e = Math.min(end.getTime(), range.to.getTime());
  return Math.max(0, (e - s) / 1000);
}

export async function analyticsRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.get<{
    Querystring: { range?: string; from?: string; to?: string; agent_id?: string; worker_id?: string };
  }>('/api/analytics', { preHandler: requireUser }, async (request) => {
    const range = parseRange(request.query);
    const rangeSec = Math.max(1, (range.to.getTime() - range.from.getTime()) / 1000);

    const agents = await prisma.agent.findMany({
      where: request.query.agent_id ? { id: request.query.agent_id } : {},
      orderBy: { name: 'asc' },
    });
    const workers = await prisma.worker.findMany({
      where: {
        ...(request.query.worker_id ? { id: request.query.worker_id } : {}),
        ...(request.query.agent_id ? { agentId: request.query.agent_id } : {}),
      },
      orderBy: { name: 'asc' },
    });

    const agentAnalytics = [] as Array<Record<string, unknown>>;
    for (const agent of agents) {
      const sessions = await prisma.session.findMany({
        where: { agentId: agent.id, startedAt: { lte: range.to }, OR: [{ endedAt: null }, { endedAt: { gte: range.from } }] },
      });
      const uptimeSec = sessions.reduce(
        (acc, s) => acc + overlapSec(s.startedAt, s.endedAt ?? range.to, range),
        0,
      );
      const sessionsInRange = await prisma.session.count({
        where: { agentId: agent.id, startedAt: { gte: range.from, lte: range.to } },
      });
      const replacements = await prisma.event.count({
        where: { agentId: agent.id, type: 'VM_REPLACED', createdAt: { gte: range.from, lte: range.to } },
      });
      const commands = await prisma.command.findMany({
        where: { agentId: agent.id, createdAt: { gte: range.from, lte: range.to } },
      });
      const succeeded = commands.filter((c) => c.status === 'SUCCEEDED').length;
      const failed = commands.filter((c) => c.status === 'FAILED' || c.status === 'TIMED_OUT').length;
      const errorCounts = new Map<string, number>();
      for (const c of commands) {
        if ((c.status === 'FAILED' || c.status === 'TIMED_OUT') && c.errorReason) {
          errorCounts.set(c.errorReason, (errorCounts.get(c.errorReason) ?? 0) + 1);
        }
      }
      const endedSessions = sessions.filter((s) => s.endedAt);
      const avgLifetime = endedSessions.length
        ? endedSessions.reduce((acc, s) => acc + ((s.endedAt as Date).getTime() - s.startedAt.getTime()) / 1000, 0) /
          endedSessions.length
        : null;

      const successRate = commands.length ? Math.round((succeeded / commands.length) * 1000) / 10 : null;
      agentAnalytics.push({
        agent_id: agent.id,
        agent_name: agent.name,
        uptime_pct: Math.min(100, Math.round((uptimeSec / rangeSec) * 1000) / 10),
        session_count: sessionsInRange,
        replacement_count: replacements,
        // Phase 2 flat aliases (CONTRACT-2 §3) alongside the Phase 1 shape.
        sessions: sessionsInRange,
        replacements,
        commands_count: commands.length,
        success_rate: successRate,
        commands: {
          total: commands.length,
          succeeded,
          failed,
          success_rate: successRate,
        },
        top_errors: [...errorCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([reason, count]) => ({ reason, count })),
        avg_session_lifetime_sec: avgLifetime,
      });
    }

    const workerAnalytics = [] as Array<Record<string, unknown>>;
    for (const worker of workers) {
      // Phase 4 (CONTRACT-4 §3): pure replace-latest — worker analytics
      // derive from the agent's single latest heartbeat row only. Fields
      // that need a series (share intervals, downtime) report their honest
      // empty values rather than estimates.
      const latest = await prisma.heartbeat.findUnique({ where: { agentId: worker.agentId } });
      const latestSnap = (latest?.minerSnapshot ?? {}) as {
        hashrate_hs?: number;
        session_no?: number | null;
        shares_local?: number | null;
      };
      const hashrateSeries = latest
        ? [
            {
              t: latest.receivedAt.toISOString(),
              v: typeof latestSnap.hashrate_hs === 'number' ? latestSnap.hashrate_hs : 0,
            },
          ]
        : [];
      const intervals: number[] = [];
      const uniqueShareTimes: number[] = [];
      const [recoveriesOk, recoveriesFailed, poolStalls, sessions] = await Promise.all([
        prisma.event.count({
          where: { workerId: worker.id, type: 'RECOVERY', createdAt: { gte: range.from, lte: range.to } },
        }),
        prisma.event.count({
          where: { workerId: worker.id, type: 'RECOVERY_FAILED', createdAt: { gte: range.from, lte: range.to } },
        }),
        prisma.event.count({
          where: { workerId: worker.id, type: 'POOL_STALL', createdAt: { gte: range.from, lte: range.to } },
        }),
        prisma.session.findMany({
          where: { agentId: worker.agentId, startedAt: { gte: range.from, lte: range.to } },
          orderBy: { startedAt: 'asc' },
        }),
      ]);
      // The latest heartbeat's memory stands in for its session's start
      // memory — only when that session started within the range (the
      // sessions list above is already range-filtered by startedAt).
      const memAtSessionStart: Array<{ t: string; v: number }> = [];
      if (latest) {
        const s = sessions.find((x) => x.id === latest.sessionId);
        if (s) memAtSessionStart.push({ t: s.startedAt.toISOString(), v: latest.memAvailableGib });
      }
      // Phase 2 worker aggregates (CONTRACT-2 §3), all from real rows.
      const durationDist = sessionDurationDistribution(
        sessions.map((s) => Math.max(0, ((s.endedAt ?? range.to).getTime() - s.startedAt.getTime()) / 1000)),
      );
      const sharesAvg = sharesPerSession(
        latest
          ? [{ session_no: latestSnap.session_no ?? null, shares_local: latestSnap.shares_local ?? null }]
          : [],
      );
      const failedLowMemory = await prisma.command.count({
        where: {
          workerId: worker.id,
          type: { in: ['miner.run', 'miner.restart', 'miner.reinstall'] },
          status: 'FAILED',
          errorReason: 'LOW_MEMORY',
          createdAt: { gte: range.from, lte: range.to },
        },
      });
      // Downtime is not derivable from a single latest snapshot (Phase 4):
      // report 0, never an estimate dressed as data.
      const downtimeSec = 0;

      workerAnalytics.push({
        worker_id: worker.id,
        worker_name: worker.name,
        agent_id: worker.agentId,
        hashrate_series: hashrateSeries,
        shares: { accepted: worker.acceptedShares, rejected: worker.rejectedShares },
        last_share_intervals: intervals.slice(-50),
        recoveries: { succeeded: recoveriesOk, failed: recoveriesFailed, failed_low_memory: failedLowMemory },
        downtime_sec: Math.round(downtimeSec),
        mem_at_session_start: memAtSessionStart,
        pool_stall_count: poolStalls,
        // Phase 2 additions (CONTRACT-2 §3).
        session_duration_distribution: durationDist,
        shares_per_session: sharesAvg,
        longest_share_gap_sec: longestGapSec(uniqueShareTimes),
        mem_at_session_start_trend: memAtSessionStart.map((p) => ({
          at: p.t,
          mem_available_gib: p.v,
        })),
      });
    }

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      agents: agentAnalytics,
      workers: workerAnalytics,
    };
  });
}
