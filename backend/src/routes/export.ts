// CSV exports (Phase 3, CONTRACT-3 §5) — ADMIN only, streamed.
//
//   GET /api/export/agents.csv    all agents + current worker status
//   GET /api/export/commands.csv  ?range=24h|7d|30d|all (default 30d)
//   GET /api/export/events.csv    ?range=...
//   GET /api/export/audit.csv     ?range=...
//
// Header row first, comma-separated, ISO timestamps, values quoted when
// they contain a comma, quote, or newline. Rows stream in pages of 500 so
// memory stays flat on the small production VPS.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { requireRole, requireUser } from '../plugins/auth';

const PAGE_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

type ExportRange = '24h' | '7d' | '30d' | 'all';

function parseRange(raw: string | undefined): ExportRange {
  if (raw === '24h' || raw === '7d' || raw === '30d' || raw === 'all') return raw;
  return '30d';
}

function rangeCutoff(range: ExportRange, now: Date): Date | null {
  switch (range) {
    case '24h':
      return new Date(now.getTime() - DAY_MS);
    case '7d':
      return new Date(now.getTime() - 7 * DAY_MS);
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS);
    case 'all':
      return null;
  }
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\n';
}

function beginCsv(reply: FastifyReply, filename: string): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

export async function exportRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  const adminOnly = { preHandler: [requireUser, requireRole('ADMIN')] };

  app.get<{ Querystring: { range?: string } }>('/api/export/agents.csv', adminOnly, async (request, reply) => {
    beginCsv(reply, 'agents.csv');
    reply.raw.write(csvRow(['id', 'name', 'worker_name', 'enrolled_via', 'status', 'worker_status', 'last_seen_at', 'replacement_count', 'created_at']));
    let skip = 0;
    for (;;) {
      const agents = await prisma.agent.findMany({
        orderBy: { createdAt: 'asc' },
        skip,
        take: PAGE_SIZE,
        include: { worker: true },
      });
      if (agents.length === 0) break;
      for (const a of agents) {
        reply.raw.write(
          csvRow([
            a.id,
            a.name,
            a.workerName,
            a.enrolledVia,
            a.status,
            a.worker?.status ?? '',
            a.lastSeenAt,
            a.replacementCount,
            a.createdAt,
          ]),
        );
      }
      skip += agents.length;
    }
    reply.raw.end();
  });

  app.get<{ Querystring: { range?: string } }>('/api/export/commands.csv', adminOnly, async (request, reply) => {
    const cutoff = rangeCutoff(parseRange(request.query.range), new Date());
    beginCsv(reply, 'commands.csv');
    reply.raw.write(csvRow(['id', 'agent', 'worker', 'type', 'source', 'status', 'created_at', 'finished_at', 'error_reason']));
    let skip = 0;
    for (;;) {
      const commands = await prisma.command.findMany({
        where: cutoff ? { createdAt: { gte: cutoff } } : {},
        orderBy: { createdAt: 'asc' },
        skip,
        take: PAGE_SIZE,
        include: { agent: true, worker: true },
      });
      if (commands.length === 0) break;
      for (const c of commands) {
        reply.raw.write(
          csvRow([
            c.id,
            c.agent?.name ?? c.agentId,
            c.worker?.name ?? c.workerId ?? '',
            c.type,
            c.source,
            c.status,
            c.createdAt,
            c.finishedAt,
            c.errorReason,
          ]),
        );
      }
      skip += commands.length;
    }
    reply.raw.end();
  });

  app.get<{ Querystring: { range?: string } }>('/api/export/events.csv', adminOnly, async (request, reply) => {
    const cutoff = rangeCutoff(parseRange(request.query.range), new Date());
    beginCsv(reply, 'events.csv');
    reply.raw.write(csvRow(['id', 'agent', 'worker', 'type', 'description', 'created_at']));
    let skip = 0;
    for (;;) {
      const events = await prisma.event.findMany({
        where: cutoff ? { createdAt: { gte: cutoff } } : {},
        orderBy: { createdAt: 'asc' },
        skip,
        take: PAGE_SIZE,
        include: { agent: true, worker: true },
      });
      if (events.length === 0) break;
      for (const e of events) {
        reply.raw.write(
          csvRow([e.id, e.agent?.name ?? e.agentId ?? '', e.worker?.name ?? e.workerId ?? '', e.type, e.description, e.createdAt]),
        );
      }
      skip += events.length;
    }
    reply.raw.end();
  });

  app.get<{ Querystring: { range?: string } }>('/api/export/audit.csv', adminOnly, async (request, reply) => {
    const cutoff = rangeCutoff(parseRange(request.query.range), new Date());
    beginCsv(reply, 'audit.csv');
    reply.raw.write(csvRow(['id', 'actor', 'action', 'target', 'created_at']));
    let skip = 0;
    for (;;) {
      const rows = await prisma.auditLog.findMany({
        where: cutoff ? { createdAt: { gte: cutoff } } : {},
        orderBy: { createdAt: 'asc' },
        skip,
        take: PAGE_SIZE,
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        reply.raw.write(csvRow([r.id, r.actor, r.action, r.target, r.createdAt]));
      }
      skip += rows.length;
    }
    reply.raw.end();
  });
}
