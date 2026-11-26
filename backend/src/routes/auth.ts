// Dashboard authentication: POST /api/auth/login, GET /api/auth/me.
// Phase 3 (CONTRACT-3 §1): the JWT carries the user's role, login responses
// include it, and disabled users cannot log in.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { verifyPassword } from '../lib/crypto';
import { httpError, requireUser } from '../plugins/auth';
import { loginBodySchema } from '../schemas';

export async function authRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  app.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    {
      schema: { body: loginBodySchema },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        throw httpError(401, 'INVALID_CREDENTIALS');
      }
      if (user.disabledAt) {
        return reply.status(401).send({
          error: 'ACCOUNT_DISABLED',
          message: 'Akun Anda dinonaktifkan. Hubungi administrator.',
        });
      }
      const token = app.jwt.sign(
        { sub: user.id, email: user.email, role: user.role },
        { expiresIn: '12h' },
      );
      return { token, user: { id: user.id, email: user.email, role: user.role } };
    },
  );

  app.get('/api/auth/me', { preHandler: requireUser }, async (request) => {
    const payload = request.user as { sub: string; email: string };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw httpError(404, 'USER_NOT_FOUND');
    return { id: user.id, email: user.email, role: user.role };
  });
}
