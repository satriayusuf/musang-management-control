// Append-only audit log writer. There are deliberately no update/delete paths.

import type { PrismaClient } from '@prisma/client';
import { newId } from '../lib/crypto';

export interface AuditEntry {
  actor: string;
  action: string;
  target: string;
  metadata?: Record<string, unknown>;
}

export async function createAuditLog(prisma: PrismaClient, entry: AuditEntry) {
  return prisma.auditLog.create({
    data: {
      id: newId('aud'),
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      metadata: (entry.metadata ?? {}) as never,
    },
  });
}
