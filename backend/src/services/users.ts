// Multi-user management (Phase 3, CONTRACT-3 §1).
//
// Users are created by an ADMIN with a role (ADMIN | OPERATOR | VIEWER).
// Passwords use the same scrypt format as the seeded admin. A user cannot
// disable or demote THEMSELVES (self-protection); disabled users cannot log
// in (enforced in routes/auth.ts). Every management action writes an audit
// row (actor = the acting admin's email).

import type { PrismaClient, User } from '@prisma/client';
import { hashPassword, newId } from '../lib/crypto';
import { USER_ROLES, type UserRole } from '../plugins/auth';
import { createAuditLog } from './audit';

export interface Actor {
  id: string;
  email: string;
}

function httpErr(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

export function isValidRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export async function listUsers(prisma: PrismaClient): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function createUser(
  prisma: PrismaClient,
  actor: Actor,
  input: { email: string; password: string; role: string },
): Promise<User> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) {
    throw httpErr(400, 'INVALID_EMAIL', 'Email tidak valid');
  }
  if (typeof input.password !== 'string' || input.password.length < 8) {
    throw httpErr(400, 'WEAK_PASSWORD', 'Kata sandi minimal 8 karakter');
  }
  if (!isValidRole(input.role)) {
    throw httpErr(400, 'INVALID_ROLE', 'Peran harus salah satu dari ADMIN, OPERATOR, VIEWER');
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw httpErr(409, 'EMAIL_TAKEN', 'Email sudah terdaftar');
  }
  const user = await prisma.user.create({
    data: {
      id: newId('usr'),
      email,
      passwordHash: await hashPassword(input.password),
      role: input.role,
    },
  });
  await createAuditLog(prisma, {
    actor: actor.email,
    action: 'user.create',
    target: user.id,
    metadata: { email: user.email, role: user.role },
  });
  return user;
}

export async function updateUser(
  prisma: PrismaClient,
  actor: Actor,
  userId: string,
  patch: { role?: string; disabled?: boolean },
): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw httpErr(404, 'USER_NOT_FOUND', 'Pengguna tidak ditemukan');
  }
  const data: { role?: string; disabledAt?: Date | null } = {};
  const changes: Record<string, unknown> = {};

  if (patch.role !== undefined) {
    if (!isValidRole(patch.role)) {
      throw httpErr(400, 'INVALID_ROLE', 'Peran harus salah satu dari ADMIN, OPERATOR, VIEWER');
    }
    if (userId === actor.id && patch.role !== user.role) {
      throw httpErr(400, 'SELF_DEMOTE_FORBIDDEN', 'Anda tidak dapat menurunkan peran Anda sendiri');
    }
    data.role = patch.role;
    changes.role = patch.role;
  }
  if (patch.disabled !== undefined) {
    if (typeof patch.disabled !== 'boolean') {
      throw httpErr(400, 'INVALID_DISABLED', 'Nilai disabled harus boolean');
    }
    if (userId === actor.id && patch.disabled) {
      throw httpErr(400, 'SELF_DISABLE_FORBIDDEN', 'Anda tidak dapat menonaktifkan akun Anda sendiri');
    }
    data.disabledAt = patch.disabled ? new Date() : null;
    changes.disabled = patch.disabled;
  }
  if (Object.keys(data).length === 0) {
    throw httpErr(400, 'EMPTY_PATCH', 'Tidak ada perubahan yang diberikan');
  }
  const updated = await prisma.user.update({ where: { id: userId }, data });
  await createAuditLog(prisma, {
    actor: actor.email,
    action: 'user.update',
    target: userId,
    metadata: { email: user.email, changes },
  });
  return updated;
}

export async function resetUserPassword(
  prisma: PrismaClient,
  actor: Actor,
  userId: string,
  newPassword: string,
): Promise<User> {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw httpErr(400, 'WEAK_PASSWORD', 'Kata sandi minimal 8 karakter');
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw httpErr(404, 'USER_NOT_FOUND', 'Pengguna tidak ditemukan');
  }
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  await createAuditLog(prisma, {
    actor: actor.email,
    action: 'user.reset_password',
    target: userId,
    metadata: { email: user.email },
  });
  return updated;
}
