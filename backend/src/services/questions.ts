// Broadcast questions (CONTRACT-8). A question is NOT a command: the
// server fans one dashboard question out to one AgentQuestion row per
// selected agent; each agent's Muse RUNTIME polls for it (runtime
// token only — the bridge never sees questions), investigates read-only,
// and posts a short text answer. Queued questions older than
// QUESTION_TTL_SEC expire lazily on every read path.
//
// CONTRACT-9 adds kind='instruction': the same fan-out, but each runtime
// EXECUTES the text on its VM and posts an execution report through the
// same answer path. The server still executes nothing itself.

import { randomUUID } from 'node:crypto';
import type { AgentQuestion, PrismaClient } from '@prisma/client';
import { httpError } from '../plugins/auth';
import { createAuditLog } from './audit';
import { broadcast } from './ws';

export const QUESTION_TTL_SEC = 1800; // 30 minutes (spec)
export const QUESTION_MAX_LENGTH = 2000;

/** Pure staleness check (unit-tested): queued + askedAt older than TTL. */
export function isQuestionStale(askedAt: Date, now: Date): boolean {
  return now.getTime() - askedAt.getTime() > QUESTION_TTL_SEC * 1000;
}

/**
 * Lazy expiry sweep: flip stale QUEUED rows to `expired`. Runs at the
 * start of every read path (runtime poll, broadcast detail/list) — no
 * background job. Optionally scoped to one agent or one broadcast.
 */
export async function expireStaleQuestions(
  prisma: PrismaClient,
  scope: { agentId?: string; broadcastId?: string } = {},
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - QUESTION_TTL_SEC * 1000);
  const result = await prisma.agentQuestion.updateMany({
    where: {
      status: 'queued',
      askedAt: { lt: cutoff },
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.broadcastId ? { broadcastId: scope.broadcastId } : {}),
    },
    data: { status: 'expired' },
  });
  return result.count;
}

export type BroadcastKind = 'question' | 'instruction';

export interface CreateBroadcastInput {
  question: string;
  agentIds: string[];
  askedBy: string;
  /** CONTRACT-9: 'question' (default) or 'instruction' (executed by runtimes). */
  kind?: string;
}

/**
 * Fan one question out to one row per EXISTING agent (unknown ids are
 * skipped). Throws 400 when the question is empty/too long or no valid
 * agent remains.
 */
export async function createQuestionBroadcast(
  prisma: PrismaClient,
  input: CreateBroadcastInput,
): Promise<{ broadcastId: string; questionCount: number; kind: BroadcastKind }> {
  const question = input.question.trim();
  if (question.length === 0) throw httpError(400, 'QUESTION_EMPTY');
  if (question.length > QUESTION_MAX_LENGTH) throw httpError(400, 'QUESTION_TOO_LONG');
  const kind: BroadcastKind = input.kind === 'instruction' ? 'instruction' : 'question';

  const uniqueIds = [...new Set(input.agentIds)];
  const agents = await prisma.agent.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true },
  });
  if (agents.length === 0) throw httpError(400, 'NO_VALID_AGENTS');

  const broadcastId = randomUUID();
  const askedAt = new Date();
  await prisma.agentQuestion.createMany({
    data: agents.map((a) => ({
      id: randomUUID(),
      agentId: a.id,
      broadcastId,
      kind,
      question,
      askedBy: input.askedBy,
      askedAt,
      status: 'queued',
    })),
  });
  await createAuditLog(prisma, {
    actor: input.askedBy,
    action: kind === 'instruction' ? 'instruction.broadcast' : 'question.broadcast',
    target: broadcastId,
    metadata: { question_count: agents.length, kind },
  });
  broadcast('broadcast.question_created', { broadcast_id: broadcastId, question_count: agents.length, kind });
  return { broadcastId, questionCount: agents.length, kind };
}

/**
 * The runtime's poll: the agent's queued questions still within the TTL.
 * Stale rows are expired by this read and never returned.
 */
export async function listQueuedQuestionsForRuntime(
  prisma: PrismaClient,
  agentId: string,
): Promise<AgentQuestion[]> {
  await expireStaleQuestions(prisma, { agentId });
  return prisma.agentQuestion.findMany({
    where: { agentId, status: 'queued' },
    orderBy: { askedAt: 'asc' },
  });
}

export interface AnswerInput {
  answer: string;
  answeredAt?: string;
}

/**
 * Record the runtime's answer. Only a `queued` row may be answered: a
 * stale queued row is expired first and then rejected (409), as are
 * already answered/expired rows. A question of another agent → 404.
 */
export async function answerQuestion(
  prisma: PrismaClient,
  agentId: string,
  questionId: string,
  input: AnswerInput,
): Promise<AgentQuestion> {
  const answer = input.answer.trim();
  if (answer.length === 0) throw httpError(400, 'ANSWER_EMPTY');

  const row = await prisma.agentQuestion.findUnique({ where: { id: questionId } });
  if (!row || row.agentId !== agentId) throw httpError(404, 'QUESTION_NOT_FOUND');
  if (row.status !== 'queued') throw httpError(409, 'QUESTION_NOT_QUEUED');
  if (isQuestionStale(row.askedAt, new Date())) {
    await prisma.agentQuestion.update({ where: { id: row.id }, data: { status: 'expired' } });
    throw httpError(409, 'QUESTION_EXPIRED');
  }

  const parsed = input.answeredAt ? new Date(input.answeredAt) : null;
  const answeredAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  const updated = await prisma.agentQuestion.update({
    where: { id: row.id },
    data: { status: 'answered', answer, answeredAt },
  });
  broadcast('agent.question_answered', {
    broadcast_id: row.broadcastId,
    agent_id: agentId,
    question_id: row.id,
  });
  return updated;
}

/**
 * Delete a whole broadcast (all its question rows, answered or not).
 * Throws 404 when the broadcast does not exist. Audited.
 */
export async function deleteBroadcast(
  prisma: PrismaClient,
  broadcastId: string,
  actor: string,
): Promise<{ deleted: number }> {
  const result = await prisma.agentQuestion.deleteMany({ where: { broadcastId } });
  if (result.count === 0) throw httpError(404, 'BROADCAST_NOT_FOUND');
  await createAuditLog(prisma, {
    actor,
    action: 'question.broadcast_delete',
    target: broadcastId,
    metadata: { deleted: result.count },
  });
  broadcast('broadcast.question_deleted', { broadcast_id: broadcastId, deleted: result.count });
  return { deleted: result.count };
}

export interface BroadcastSummary {
  total: number;
  answered: number;
  queued: number;
  expired: number;
}

export function summarize(rows: Array<{ status: string }>): BroadcastSummary {
  const summary: BroadcastSummary = { total: rows.length, answered: 0, queued: 0, expired: 0 };
  for (const r of rows) {
    if (r.status === 'answered') summary.answered += 1;
    else if (r.status === 'expired') summary.expired += 1;
    else summary.queued += 1;
  }
  return summary;
}

/** One broadcast's rows with agent names, after lazy expiry. Null when unknown. */
export async function getBroadcast(prisma: PrismaClient, broadcastId: string) {
  await expireStaleQuestions(prisma, { broadcastId });
  const rows = await prisma.agentQuestion.findMany({
    where: { broadcastId },
    include: { agent: { select: { name: true } } },
    orderBy: { agent: { name: 'asc' } },
  });
  if (rows.length === 0) return null;
  return rows;
}

/** Recent broadcasts (grouped in memory from the latest rows) for the dashboard list. */
export async function listBroadcasts(
  prisma: PrismaClient,
  page: number,
  pageSize: number,
): Promise<{ items: Array<{ broadcastId: string; rows: AgentQuestion[] }>; total: number }> {
  await expireStaleQuestions(prisma);
  // Fetch the newest rows (enough to fill the page of broadcasts), then
  // group. Broadcasts are human-created and infrequent; a bounded scan
  // of recent rows is proportionate here.
  const recent = await prisma.agentQuestion.findMany({
    orderBy: { askedAt: 'desc' },
    take: 2000,
  });
  const byBroadcast = new Map<string, AgentQuestion[]>();
  for (const row of recent) {
    const list = byBroadcast.get(row.broadcastId) ?? [];
    list.push(row);
    byBroadcast.set(row.broadcastId, list);
  }
  const all = [...byBroadcast.entries()].map(([broadcastId, rows]) => ({ broadcastId, rows }));
  const total = all.length;
  const items = all.slice((page - 1) * pageSize, page * pageSize);
  return { items, total };
}
