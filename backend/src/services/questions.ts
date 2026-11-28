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

/** Shared CONTRACT-8 validation for any broadcast/follow-up text. */
function normalizeQuestionText(raw: string): string {
  const question = raw.trim();
  if (question.length === 0) throw httpError(400, 'QUESTION_EMPTY');
  if (question.length > QUESTION_MAX_LENGTH) throw httpError(400, 'QUESTION_TOO_LONG');
  return question;
}

/** Route schemas already restrict kind to the enum; anything that is
 *  not 'instruction' behaves as 'question' (CONTRACT-9 default). */
function normalizeKind(raw: string | undefined, fallback: BroadcastKind): BroadcastKind {
  if (raw === undefined) return fallback;
  return raw === 'instruction' ? 'instruction' : 'question';
}

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
  const question = normalizeQuestionText(input.question);
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

export interface CreateFollowupInput {
  question: string;
  askedBy: string;
  /** Optional; defaults to the parent/original kind (CONTRACT-11). */
  kind?: string;
}

/**
 * CONTRACT-11: reply to ONE agent's message. Creates a single new row
 * for the SAME agent under a NEW broadcast id, linked to the parent
 * row (parent = the row being answered, root = the thread's first
 * row). The parent may be in any status — a follow-up is a new
 * message, not a state change on the parent. Unknown parent → 404.
 */
export async function createQuestionFollowup(
  prisma: PrismaClient,
  parentQuestionId: string,
  input: CreateFollowupInput,
): Promise<{ broadcastId: string; questionId: string; parentQuestionId: string; kind: BroadcastKind }> {
  const question = normalizeQuestionText(input.question);
  const parent = await prisma.agentQuestion.findUnique({ where: { id: parentQuestionId } });
  if (!parent) throw httpError(404, 'QUESTION_NOT_FOUND');
  const kind = normalizeKind(input.kind, parent.kind as BroadcastKind);

  const broadcastId = randomUUID();
  const row = await prisma.agentQuestion.create({
    data: {
      id: randomUUID(),
      agentId: parent.agentId,
      broadcastId,
      kind,
      question,
      askedBy: input.askedBy,
      askedAt: new Date(),
      status: 'queued',
      parentQuestionId: parent.id,
      rootQuestionId: parent.rootQuestionId ?? parent.id,
    },
  });
  await createAuditLog(prisma, {
    actor: input.askedBy,
    action: kind === 'instruction' ? 'instruction.followup' : 'question.followup',
    target: row.id,
    metadata: { parent_question_id: parent.id, broadcast_id: broadcastId, kind },
  });
  broadcast('broadcast.question_created', { broadcast_id: broadcastId, question_count: 1, kind });
  return { broadcastId, questionId: row.id, parentQuestionId: parent.id, kind };
}

/**
 * CONTRACT-11: broadcast a follow-up to the agents of an existing
 * broadcast. Each new row's parent is THAT agent's latest row in the
 * thread rooted at its row in the source broadcast, so per-agent
 * threads stay linear even across several follow-up rounds. Targets
 * default to every agent of the source broadcast; `agentIds` narrows
 * to a subset (ids without a row in the source broadcast are skipped;
 * zero valid targets → 400). Unknown broadcast → 404.
 */
export async function createBroadcastFollowup(
  prisma: PrismaClient,
  sourceBroadcastId: string,
  input: CreateFollowupInput & { agentIds?: string[] },
): Promise<{ broadcastId: string; questionCount: number; kind: BroadcastKind }> {
  const question = normalizeQuestionText(input.question);
  const sourceRows = await prisma.agentQuestion.findMany({
    where: { broadcastId: sourceBroadcastId },
  });
  if (sourceRows.length === 0) throw httpError(404, 'BROADCAST_NOT_FOUND');
  const kind = normalizeKind(input.kind, sourceRows[0].kind as BroadcastKind);

  let targets = sourceRows;
  if (input.agentIds && input.agentIds.length > 0) {
    const wanted = new Set(input.agentIds);
    targets = sourceRows.filter((r) => wanted.has(r.agentId));
  }
  if (targets.length === 0) throw httpError(400, 'NO_VALID_AGENTS');

  const broadcastId = randomUUID();
  const askedAt = new Date();
  const data = [];
  for (const src of targets) {
    const rootId = src.rootQuestionId ?? src.id;
    const latest = await prisma.agentQuestion.findFirst({
      where: { agentId: src.agentId, OR: [{ id: rootId }, { rootQuestionId: rootId }] },
      orderBy: { askedAt: 'desc' },
    });
    const parent = latest ?? src;
    data.push({
      id: randomUUID(),
      agentId: src.agentId,
      broadcastId,
      kind,
      question,
      askedBy: input.askedBy,
      askedAt,
      status: 'queued',
      parentQuestionId: parent.id,
      rootQuestionId: rootId,
    });
  }
  await prisma.agentQuestion.createMany({ data });
  await createAuditLog(prisma, {
    actor: input.askedBy,
    action: kind === 'instruction' ? 'instruction.followup_broadcast' : 'question.followup_broadcast',
    target: broadcastId,
    metadata: { source_broadcast_id: sourceBroadcastId, question_count: data.length, kind },
  });
  broadcast('broadcast.question_created', { broadcast_id: broadcastId, question_count: data.length, kind });
  return { broadcastId, questionCount: data.length, kind };
}

/** Batch-load parent rows for the runtime poll's context payload. */
export async function loadQuestionParents(
  prisma: PrismaClient,
  rows: AgentQuestion[],
): Promise<Map<string, AgentQuestion>> {
  const ids = [...new Set(rows.map((r) => r.parentQuestionId).filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const parents = await prisma.agentQuestion.findMany({ where: { id: { in: ids } } });
  return new Map(parents.map((p) => [p.id, p]));
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

export type BroadcastRow = AgentQuestion & {
  agent: { name: string };
  /** CONTRACT-11: later rows of this agent's thread (other broadcasts), oldest first. */
  followups: AgentQuestion[];
  /** CONTRACT-11: the parent row's text when this row is itself a follow-up. */
  parentQuestion: string | null;
};

/** One broadcast's rows with agent names, after lazy expiry. Null when unknown. */
export async function getBroadcast(prisma: PrismaClient, broadcastId: string): Promise<BroadcastRow[] | null> {
  // Global sweep (not just this broadcast) so nested follow-up statuses
  // shown in the detail are expired consistently too.
  await expireStaleQuestions(prisma);
  const rows = await prisma.agentQuestion.findMany({
    where: { broadcastId },
    include: { agent: { select: { name: true } } },
    orderBy: { agent: { name: 'asc' } },
  });
  if (rows.length === 0) return null;

  const rootIds = [...new Set(rows.map((r) => r.rootQuestionId ?? r.id))];
  const descendants = await prisma.agentQuestion.findMany({
    where: { rootQuestionId: { in: rootIds } },
    orderBy: { askedAt: 'asc' },
  });
  const itemIds = new Set(rows.map((r) => r.id));
  const byRoot = new Map<string, AgentQuestion[]>();
  for (const d of descendants) {
    if (itemIds.has(d.id) || d.broadcastId === broadcastId || !d.rootQuestionId) continue;
    const list = byRoot.get(d.rootQuestionId) ?? [];
    list.push(d);
    byRoot.set(d.rootQuestionId, list);
  }

  const parentIds = [...new Set(rows.map((r) => r.parentQuestionId).filter((x): x is string => !!x))];
  const parents =
    parentIds.length > 0
      ? await prisma.agentQuestion.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, question: true },
        })
      : [];
  const parentText = new Map(parents.map((p) => [p.id, p.question]));

  return rows.map((r) => ({
    ...r,
    followups: byRoot.get(r.rootQuestionId ?? r.id) ?? [],
    parentQuestion: r.parentQuestionId ? (parentText.get(r.parentQuestionId) ?? null) : null,
  }));
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
