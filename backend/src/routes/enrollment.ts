// Zero-touch self-enrollment endpoints (Phase 3, CONTRACT-3 §8) — PUBLIC.
//
//   GET  /agent.md                     the enrollment document, rendered live
//                                      with the CURRENT key + public server URL
//   POST /api/bridge/self-register     register a new agent with the key
//                                      (same response shape as pairing
//                                      registration, plus server_time)

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { selfRegisterBodySchema } from '../schemas';
import {
  ensureEnrollmentKey,
  publicBaseUrl,
  renderAgentDocument,
  selfRegister,
  type SelfRegisterBody,
} from '../services/enrollment';
import { getSettings } from '../services/settings';

export async function enrollmentRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.get('/agent.md', async (_request, reply) => {
    const key = await ensureEnrollmentKey(prisma);
    const document = renderAgentDocument(key, publicBaseUrl());
    return reply.type('text/markdown; charset=utf-8').send(document);
  });

  app.post<{ Body: SelfRegisterBody }>(
    '/api/bridge/self-register',
    { schema: { body: selfRegisterBodySchema } },
    async (request, reply) => {
      const result = await selfRegister(prisma, request.body, request.ip);
      const settings = await getSettings(prisma);
      return reply.status(201).send({
        agent_id: result.agent.id,
        agent_token: result.agentToken,
        session_id: result.session.id,
        session_no: result.session.sessionNo,
        server_time: new Date().toISOString(),
        config: {
          heartbeat_interval_sec: settings.heartbeat_interval_sec,
          unreachable_missed_beats: settings.unreachable_missed_beats,
          min_mem_start_gib: settings.min_mem_start_gib,
        },
      });
    },
  );
}
