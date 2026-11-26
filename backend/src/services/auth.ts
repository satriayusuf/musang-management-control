// Dashboard admin account: a single administrator seeded from the
// environment on first boot (Phase 1 scope — multi-user is Phase 3).

import type { PrismaClient } from '@prisma/client';
import { hashPassword, newId } from '../lib/crypto';

export async function seedAdmin(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const email = env.ADMIN_EMAIL;
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;
  await prisma.user.create({
    data: { id: newId('usr'), email, passwordHash: await hashPassword(password) },
  });
}
