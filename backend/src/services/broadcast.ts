// Broadcast fan-out (Phase 2, CONTRACT-2 §2): one command type (or one
// template) sent to many agents in a single transaction. Eligibility is
// evaluated per target with the SAME rules as single command creation;
// ineligible targets are skipped with a reason — a skip never fails the
// whole batch.

import type { Agent, BroadcastBatch, Command, PrismaClient, Worker } from '@prisma/client';
import { newId } from '../lib/crypto';
import { COMMAND_TYPES, SENSITIVE_COMMAND_TYPES } from './commands';
import { getSettings } from './settings';
import { getTemplateOrThrow, mergePayload } from './templates';
import { broadcast } from './ws';

/** Command types that change miner state (recovery actions). */
const RECOVERY_TYPES = new Set(['miner.run', 'miner.restart', 'miner.reinstall']);

export interface BroadcastSkip {
  agent_id: string;
  reason: string;
}

export interface BroadcastResult {
  batch: BroadcastBatch;
  created: Array<{ agent_id: string; command_id: string }>;
  skipped: BroadcastSkip[];
  replayed: boolean;
}

/**
 * Pure eligibility check for one broadcast target. Returns a skip reason in
 * Bahasa Indonesia, or null when a command may be created. Mirrors the
 * single-create gates in services/commands.ts, plus the broadcast-only
 * gates from CONTRACT-2 §2 (TAK_TERJANGKAU / held workers are skipped for
 * recovery commands instead of being queued into the void).
 */
export function evaluateBroadcastTarget(
  agent: Agent | null,
  worker: Worker | null,
  type: string,
): string | null {
  if (!agent) return 'Agent tidak ditemukan';
  if (agent.revokedAt) return 'Token agent sudah dicabut';
  if (!agent.capabilities.includes(type)) return `Agent tidak memiliki kemampuan ${type}`;
  if (!worker) return 'Agent belum memiliki worker';
  if (type === 'miner.run' && worker.status === 'GAGAL_START') {
    return 'Run Lagi tidak tersedia: miner gagal start karena memori di bawah ambang';
  }
  if (RECOVERY_TYPES.has(type)) {
    if (worker.status === 'TAK_TERJANGKAU') return 'Worker tidak terjangkau';
    if (worker.holdActive) return 'Worker sedang ditahan (hold aktif) — lepas tahan dulu';
  }
  if (type === 'miner.hold' && worker.holdActive) return 'Hold sudah aktif pada worker ini';
  if (type === 'miner.unhold' && !worker.holdActive) return 'Hold tidak aktif pada worker ini';
  return null;
}

export interface CreateBroadcastInput {
  type?: string;
  templateId?: string;
  payload?: Record<string, unknown>;
  agentIds: string[];
  confirm?: boolean;
  idempotencyKey: string;
  /** Stored on the batch row (CONTRACT-2: requested_by = user id). */
  requestedById: string;
  /** Stored on each command row + audit actor (Phase 1 convention: email). */
  requestedByEmail: string;
  /** Phase 3: origin recorded on each created command (default "manual"). */
  source?: string;
  /** Phase 3: schedule that triggered this broadcast, when source=schedule. */
  scheduleId?: string | null;
}

export async function createBroadcast(
  prisma: PrismaClient,
  input: CreateBroadcastInput,
): Promise<BroadcastResult> {
  // Idempotent retry: the batch key already exists -> return its outcome.
  const existingBatch = await prisma.broadcastBatch.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existingBatch) {
    const commands = await prisma.command.findMany({
      where: { batchId: existingBatch.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      batch: existingBatch,
      created: commands.map((c) => ({ agent_id: c.agentId, command_id: c.id })),
      skipped: (existingBatch.skipped as unknown as BroadcastSkip[]) ?? [],
      replayed: true,
    };
  }

  const hasType = typeof input.type === 'string' && input.type.length > 0;
  const hasTemplate = typeof input.templateId === 'string' && input.templateId.length > 0;
  if (hasType === hasTemplate) {
    throw Object.assign(new Error('Isi tepat satu dari type atau template_id'), { statusCode: 400 });
  }
  if (!Array.isArray(input.agentIds) || input.agentIds.length === 0) {
    throw Object.assign(new Error('agent_ids wajib berisi minimal satu agent'), { statusCode: 400 });
  }

  let type: string;
  let payload: Record<string, unknown>;
  let templateId: string | null = null;
  if (hasTemplate) {
    const template = await getTemplateOrThrow(prisma, input.templateId as string);
    type = template.type;
    payload = mergePayload(template.payload, input.payload);
    templateId = template.id;
  } else {
    type = input.type as string;
    payload = input.payload ?? {};
  }
  if (!COMMAND_TYPES.includes(type as (typeof COMMAND_TYPES)[number])) {
    throw Object.assign(new Error(`Tipe perintah tidak dikenal: ${type}`), { statusCode: 400 });
  }
  if (SENSITIVE_COMMAND_TYPES.has(type) && input.confirm !== true) {
    throw Object.assign(new Error('CONFIRMATION_REQUIRED'), { statusCode: 422 });
  }

  const agentIds = [...new Set(input.agentIds)];
  const settings = await getSettings(prisma);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.command_ttl_sec * 1000);

  const outcome = await prisma.$transaction(async (tx) => {
    const batch = await tx.broadcastBatch.create({
      data: {
        id: newId('bct'),
        type,
        templateId,
        payload: payload as never,
        requestedBy: input.requestedById,
        idempotencyKey: input.idempotencyKey,
        totalCount: agentIds.length,
        createdCount: 0,
        skippedCount: 0,
        skipped: [] as never,
      },
    });

    const created: Array<{ agent_id: string; command_id: string }> = [];
    const skipped: BroadcastSkip[] = [];
    const createdCommands: Command[] = [];

    for (const agentId of agentIds) {
      const agent = await tx.agent.findUnique({ where: { id: agentId } });
      const worker = agent ? await tx.worker.findUnique({ where: { agentId: agent.id } }) : null;
      const reason = evaluateBroadcastTarget(agent, worker, type);
      if (reason !== null || !agent || !worker) {
        skipped.push({ agent_id: agentId, reason: reason ?? 'Agent tidak ditemukan' });
        continue;
      }
      const derivedKey = `${input.idempotencyKey}:${agentId}`;
      const already = await tx.command.findUnique({ where: { idempotencyKey: derivedKey } });
      if (already) {
        created.push({ agent_id: agentId, command_id: already.id });
        continue;
      }
      const command = await tx.command.create({
        data: {
          id: newId('cmd'),
          agentId: agent.id,
          workerId: worker.id,
          templateId,
          batchId: batch.id,
          source: input.source ?? 'manual',
          scheduleId: input.scheduleId ?? null,
          type,
          payload: payload as never,
          idempotencyKey: derivedKey,
          status: 'QUEUED',
          requestedBy: input.requestedByEmail,
          expiresAt,
        },
      });
      createdCommands.push(command);
      created.push({ agent_id: agentId, command_id: command.id });
      await tx.auditLog.create({
        data: {
          id: newId('aud'),
          actor: input.requestedByEmail,
          action: 'command.create',
          target: command.id,
          metadata: {
            agent_id: agent.id,
            worker_id: worker.id,
            type,
            batch_id: batch.id,
            broadcast: true,
          } as never,
        },
      });
      await tx.event.create({
        data: {
          id: newId('evt'),
          agentId: agent.id,
          workerId: worker.id,
          type: 'COMMAND_CREATED',
          description: `Perintah ${type} dibuat untuk worker ${worker.name} (broadcast)`,
          metadata: { command_id: command.id, requested_by: input.requestedByEmail, batch_id: batch.id } as never,
        },
      });
    }

    const updatedBatch = await tx.broadcastBatch.update({
      where: { id: batch.id },
      data: { createdCount: created.length, skippedCount: skipped.length, skipped: skipped as never },
    });
    await tx.auditLog.create({
      data: {
        id: newId('aud'),
        actor: input.requestedByEmail,
        action: 'command.broadcast',
        target: batch.id,
        metadata: {
          type,
          template_id: templateId,
          total: agentIds.length,
          created: created.length,
          skipped: skipped.length,
        } as never,
      },
    });
    return { batch: updatedBatch, created, skipped, createdCommands };
  });

  for (const command of outcome.createdCommands) broadcast('command.created', command);
  broadcast('broadcast.created', {
    batch_id: outcome.batch.id,
    type,
    created: outcome.created.length,
    skipped: outcome.skipped.length,
  });

  return { batch: outcome.batch, created: outcome.created, skipped: outcome.skipped, replayed: false };
}
