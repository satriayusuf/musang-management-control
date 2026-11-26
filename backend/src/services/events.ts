// Event writer: persists a timeline event and broadcasts `event.created`.

import type { PrismaClient } from '@prisma/client';
import { newId } from '../lib/crypto';
import { broadcast } from './ws';

export interface EventEntry {
  agentId?: string | null;
  workerId?: string | null;
  type: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export async function createEvent(prisma: PrismaClient, entry: EventEntry) {
  const event = await prisma.event.create({
    data: {
      id: newId('evt'),
      agentId: entry.agentId ?? null,
      workerId: entry.workerId ?? null,
      type: entry.type,
      description: entry.description,
      metadata: (entry.metadata ?? {}) as never,
    },
  });
  broadcast('event.created', event);
  return event;
}
