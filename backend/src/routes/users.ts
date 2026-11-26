// User management endpoints (JWT, ADMIN only) — Phase 3, CONTRACT-3 §1.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { toUserDto } from '../lib/serialize';
import { requireRole, requireUser, type JwtUserPayload } from '../plugins/auth';
import {
  userCreateBodySchema,
  userPatchBodySchema,
  userResetPasswordBodySchema,
} from '../schemas';
import { createUser, listUsers, resetUserPassword, updateUser } from '../services/users';

export async function userRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  const adminOnly = { preHandler: [requireUser, requireRole('ADMIN')] };

  app.get('/api/users', adminOnly, async () => {
    const rows = await listUsers(prisma);
    return { items: rows.map(toUserDto), total: rows.length };
  });

  app.post<{ Body: { email: string; password: string; role: string } }>(
    '/api/users',
    { ...adminOnly, schema: { body: userCreateBodySchema } },
    async (request, reply) => {
      const actor = request.user as JwtUserPayload;
      const user = await createUser(
        prisma,
        { id: actor.sub, email: actor.email },
        request.body,
      );
      return reply.status(201).send(toUserDto(user));
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; disabled?: boolean } }>(
    '/api/users/:id',
    { ...adminOnly, schema: { body: userPatchBodySchema } },
    async (request) => {
      const actor = request.user as JwtUserPayload;
      const user = await updateUser(
        prisma,
        { id: actor.sub, email: actor.email },
        request.params.id,
        request.body,
      );
      return toUserDto(user);
    },
  );

  app.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/users/:id/reset-password',
    { ...adminOnly, schema: { body: userResetPasswordBodySchema } },
    async (request, reply) => {
      const actor = request.user as JwtUserPayload;
      await resetUserPassword(
        prisma,
        { id: actor.sub, email: actor.email },
        request.params.id,
        request.body.password,
      );
      return reply.status(200).send({ ok: true });
    },
  );
}
