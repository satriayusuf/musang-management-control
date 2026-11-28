// Broadcast question endpoints (CONTRACT-8).
//   POST /api/broadcasts                                  (JWT, OPERATOR/ADMIN)
//   GET  /api/broadcasts                                  (JWT)
//   GET  /api/broadcasts/:broadcastId                     (JWT)
//   GET  /api/agents/:id/questions?status=queued          (runtime token ONLY)
//   POST /api/agents/:id/questions/:questionId/answer     (runtime token ONLY)
//
// The runtime endpoints deliberately accept ONLY the runtime token: a
// question is not a command, and the bridge must never see it.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toQuestionDto } from '../lib/serialize';
import { authenticateRuntime, httpError, requireRole, requireUser } from '../plugins/auth';
import { questionAnswerBodySchema, questionBroadcastBodySchema } from '../schemas';
import {
  answerQuestion,
  createQuestionBroadcast,
  deleteBroadcast,
  getBroadcast,
  listBroadcasts,
  listQueuedQuestionsForRuntime,
  summarize,
} from '../services/questions';

export async function questionRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  // --- Dashboard: create a broadcast ---
  app.post<{ Body: { question: string; agent_ids: string[]; kind?: string } }>(
    '/api/broadcasts',
    {
      preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')],
      schema: { body: questionBroadcastBodySchema },
    },
    async (request, reply) => {
      const user = request.user as { sub: string; email: string };
      const result = await createQuestionBroadcast(prisma, {
        question: request.body.question,
        agentIds: request.body.agent_ids,
        askedBy: user.email,
        kind: request.body.kind,
      });
      return reply.status(201).send({
        broadcast_id: result.broadcastId,
        question_count: result.questionCount,
        kind: result.kind,
      });
    },
  );

  // --- Dashboard: recent broadcasts ---
  app.get<{ Querystring: { page?: string; page_size?: string } }>(
    '/api/broadcasts',
    { preHandler: requireUser },
    async (request) => {
      const page = Math.max(1, Number(request.query.page ?? 1) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(request.query.page_size ?? 20) || 20));
      const { items, total } = await listBroadcasts(prisma, page, pageSize);
      return {
        items: items.map(({ broadcastId, rows }) => ({
          broadcast_id: broadcastId,
          kind: rows[0].kind,
          question: rows[0].question,
          asked_by: rows[0].askedBy,
          asked_at: rows[0].askedAt.toISOString(),
          summary: summarize(rows),
        })),
        total,
        page,
        page_size: pageSize,
      };
    },
  );

  // --- Dashboard: one broadcast with every agent's answer ---
  app.get<{ Params: { broadcastId: string } }>(
    '/api/broadcasts/:broadcastId',
    { preHandler: requireUser },
    async (request) => {
      const rows = await getBroadcast(prisma, request.params.broadcastId);
      if (!rows) throw httpError(404, 'BROADCAST_NOT_FOUND');
      const first = rows[0];
      return {
        broadcast_id: first.broadcastId,
        kind: first.kind,
        question: first.question,
        asked_by: first.askedBy,
        asked_at: first.askedAt.toISOString(),
        summary: summarize(rows),
        items: rows.map((r) => ({
          ...toQuestionDto(r),
          agent_name: r.agent.name,
        })),
      };
    },
  );

  // --- Dashboard: delete a whole broadcast (with its answers) ---
  app.delete<{ Params: { broadcastId: string } }>(
    '/api/broadcasts/:broadcastId',
    { preHandler: [requireUser, requireRole('OPERATOR', 'ADMIN')] },
    async (request) => {
      const user = request.user as { sub: string; email: string };
      const result = await deleteBroadcast(prisma, request.params.broadcastId, user.email);
      return { broadcast_id: request.params.broadcastId, deleted: result.deleted };
    },
  );

  // --- Runtime: poll queued questions (runtime token ONLY) ---
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/agents/:id/questions',
    async (request) => {
      const agent = await authenticateRuntime(prisma, request, request.params.id);
      if (request.query.status && request.query.status !== 'queued') {
        return { questions: [] };
      }
      const rows = await listQueuedQuestionsForRuntime(prisma, agent.id);
      return {
        questions: rows.map((q) => ({
          question_id: q.id,
          broadcast_id: q.broadcastId,
          kind: q.kind,
          question: q.question,
          asked_at: q.askedAt.toISOString(),
          asked_by: q.askedBy,
        })),
      };
    },
  );

  // --- Runtime: post the answer (runtime token ONLY) ---
  app.post<{
    Params: { id: string; questionId: string };
    Body: { answer: string; answered_at?: string };
  }>(
    '/api/agents/:id/questions/:questionId/answer',
    { schema: { body: questionAnswerBodySchema } },
    async (request) => {
      const agent = await authenticateRuntime(prisma, request, request.params.id);
      const updated = await answerQuestion(prisma, agent.id, request.params.questionId, {
        answer: request.body.answer,
        answeredAt: request.body.answered_at,
      });
      return toQuestionDto(updated);
    },
  );
}
