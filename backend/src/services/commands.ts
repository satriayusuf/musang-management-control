// Command queue on the `commands` table (CONTRACT.md — "Command Center").
// No Redis/BullMQ: claiming is transactional with SELECT … FOR UPDATE SKIP
// LOCKED so two pollers can never claim the same row. State-changing miner
// commands are only SUCCEEDED after a verifying heartbeat snapshot.

import type { Agent, Command, PrismaClient, Worker } from '@prisma/client';
import { newId } from '../lib/crypto';
import { createAuditLog } from './audit';
import { createEvent } from './events';
import { getSettings } from './settings';
import { broadcast } from './ws';

export const COMMAND_TYPES = [
  'miner.status',
  'miner.run',
  'miner.restart',
  'miner.reinstall',
  'miner.hold',
  'miner.unhold',
  'bridge.update',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

/** Types that need explicit confirmation in the dashboard. */
export const SENSITIVE_COMMAND_TYPES = new Set<string>([
  'miner.run',
  'miner.restart',
  'miner.reinstall',
  'miner.hold',
  'miner.unhold',
  'bridge.update',
]);

/** Types whose success must be verified by a later heartbeat snapshot. */
export const STATE_CHANGING_TYPES = new Set<string>(['miner.run', 'miner.restart', 'miner.reinstall']);

/** Pure: does a command of this type require post-result verification? */
export function requiresVerification(type: string): boolean {
  return STATE_CHANGING_TYPES.has(type);
}

/** Pure: does this miner snapshot prove a state-changing command worked? */
export function isVerificationSatisfied(snapshot: { service_state?: string; job_height?: number } | null | undefined): boolean {
  if (!snapshot) return false;
  return snapshot.service_state === 'active' && typeof snapshot.job_height === 'number' && snapshot.job_height > 0;
}

export interface CreateCommandInput {
  worker: Worker;
  agent: Agent;
  type: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  requestedBy: string;
  confirm?: boolean;
  /** Phase 2: set when the command was created from a command template. */
  templateId?: string | null;
  /** Phase 2: set when the command belongs to a broadcast batch. */
  batchId?: string | null;
  /** Phase 3: origin of the command (default "manual"). */
  source?: string;
  /** Phase 3: automation rule that created this command, when source=automation. */
  ruleId?: string | null;
  /** Phase 3: schedule that created this command, when source=schedule. */
  scheduleId?: string | null;
}

/**
 * Create a queued command for a worker's agent (dashboard path).
 * Idempotent: an existing command with the same key is returned as-is.
 */
export async function createCommand(
  prisma: PrismaClient,
  input: CreateCommandInput,
): Promise<{ command: Command; created: boolean }> {
  const { worker, agent, type } = input;

  const existing = await prisma.command.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { command: existing, created: false };

  if (!COMMAND_TYPES.includes(type as CommandType)) {
    throw Object.assign(new Error(`Tipe perintah tidak dikenal: ${type}`), { statusCode: 400 });
  }
  if (!agent.capabilities.includes(type)) {
    throw Object.assign(new Error(`Agent tidak memiliki kemampuan ${type}`), { statusCode: 422 });
  }
  if (SENSITIVE_COMMAND_TYPES.has(type) && input.confirm !== true) {
    throw Object.assign(new Error('CONFIRMATION_REQUIRED'), { statusCode: 400 });
  }
  if (type === 'miner.run' && worker.status === 'GAGAL_START') {
    throw Object.assign(
      new Error('Run Lagi tidak tersedia: miner gagal start karena memori di bawah ambang'),
      { statusCode: 422 },
    );
  }

  const settings = await getSettings(prisma);
  const now = new Date();
  const command = await prisma.command.create({
    data: {
      id: newId('cmd'),
      agentId: agent.id,
      workerId: worker.id,
      templateId: input.templateId ?? null,
      batchId: input.batchId ?? null,
      source: input.source ?? 'manual',
      ruleId: input.ruleId ?? null,
      scheduleId: input.scheduleId ?? null,
      type,
      payload: (input.payload ?? {}) as never,
      idempotencyKey: input.idempotencyKey,
      status: 'QUEUED',
      requestedBy: input.requestedBy,
      expiresAt: new Date(now.getTime() + settings.command_ttl_sec * 1000),
    },
  });

  await createAuditLog(prisma, {
    actor: input.requestedBy,
    action: 'command.create',
    target: command.id,
    metadata: { agent_id: agent.id, worker_id: worker.id, type },
  });
  await createEvent(prisma, {
    agentId: agent.id,
    workerId: worker.id,
    type: 'COMMAND_CREATED',
    description: `Perintah ${type} dibuat untuk worker ${worker.name}`,
    metadata: { command_id: command.id, requested_by: input.requestedBy },
  });
  broadcast('command.created', command);
  return { command, created: true };
}

/**
 * Atomically claim up to 10 queued, unexpired commands for an agent.
 * Expired QUEUED rows are flipped to EXPIRED first (lazy expiry).
 */
export async function claimCommands(prisma: PrismaClient, agentId: string): Promise<Command[]> {
  // NOTE: compare against a UTC wall-clock string cast to ::timestamp, never
  // SQL now() or a timestamptz parameter — Prisma stores DateTime as UTC
  // wall-clock in timestamp(3) columns, while the DB server's timezone
  // (e.g. Asia/Bangkok) would shift any timestamptz comparison by hours.
  const nowWall = new Date().toISOString().slice(0, 23).replace('T', ' ');
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE commands SET status = 'EXPIRED'
      WHERE agent_id = ${agentId} AND status = 'QUEUED' AND expires_at < ${nowWall}::timestamp`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM commands
      WHERE agent_id = ${agentId} AND status = 'QUEUED' AND expires_at >= ${nowWall}::timestamp
      ORDER BY created_at ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return [] as Command[];
    const ids = rows.map((r) => r.id);
    await tx.command.updateMany({
      where: { id: { in: ids } },
      data: { status: 'SENT', sentAt: new Date() },
    });
    return tx.command.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' } });
  });
  for (const cmd of claimed) broadcast('command.sent', cmd);
  return claimed;
}

/** Count of QUEUED, unexpired commands waiting for an agent. */
export async function countQueuedCommands(prisma: PrismaClient, agentId: string): Promise<number> {
  return prisma.command.count({
    where: { agentId, status: 'QUEUED', expiresAt: { gte: new Date() } },
  });
}

/** SENT -> RUNNING. */
export async function ackCommand(
  prisma: PrismaClient,
  agent: Agent,
  commandId: string,
): Promise<Command> {
  const command = await prisma.command.findUnique({ where: { id: commandId } });
  if (!command || command.agentId !== agent.id) {
    throw Object.assign(new Error('COMMAND_NOT_FOUND'), { statusCode: 404 });
  }
  if (command.status !== 'SENT') {
    throw Object.assign(new Error(`COMMAND_NOT_SENT (status=${command.status})`), { statusCode: 409 });
  }
  const updated = await prisma.command.update({
    where: { id: commandId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  await createEvent(prisma, {
    agentId: agent.id,
    workerId: command.workerId,
    type: 'COMMAND_STARTED',
    description: `Perintah ${command.type} mulai dijalankan`,
    metadata: { command_id: command.id },
  });
  broadcast('command.started', updated);
  return updated;
}

export interface CommandResultBody {
  status: 'succeeded' | 'failed' | 'rejected';
  output?: string;
  exit_code?: number;
  error_reason?: string;
}

/**
 * Record a bridge-reported result. State-changing commands stay RUNNING with
 * a verify_deadline; they finish in resolveVerifications() once a heartbeat
 * snapshot proves the miner is active, or in the sweeper on timeout.
 */
export async function reportCommandResult(
  prisma: PrismaClient,
  agent: Agent,
  commandId: string,
  body: CommandResultBody,
): Promise<{ command: Command; verification: 'none' | 'pending' | 'failed' }> {
  const command = await prisma.command.findUnique({ where: { id: commandId } });
  if (!command || command.agentId !== agent.id) {
    throw Object.assign(new Error('COMMAND_NOT_FOUND'), { statusCode: 404 });
  }
  if (command.status !== 'RUNNING' && command.status !== 'SENT') {
    throw Object.assign(new Error(`COMMAND_NOT_RUNNING (status=${command.status})`), { statusCode: 409 });
  }

  const resultJson = {
    output: body.output ?? null,
    exit_code: body.exit_code ?? null,
    reported_status: body.status,
  } as never;

  if (body.status === 'failed' || body.status === 'rejected') {
    const rejected = body.status === 'rejected';
    const updated = await prisma.command.update({
      where: { id: commandId },
      data: {
        status: 'FAILED',
        result: resultJson,
        errorReason: body.error_reason ?? (rejected ? 'REJECTED' : 'EXECUTION_FAILED'),
        finishedAt: new Date(),
        verifyDeadline: null,
      },
    });
    await createEvent(prisma, {
      agentId: agent.id,
      workerId: command.workerId,
      type: rejected ? 'COMMAND_REJECTED' : 'COMMAND_FAILED',
      description: rejected
        ? `Perintah ${command.type} ditolak: ${updated.errorReason}`
        : `Perintah ${command.type} gagal: ${updated.errorReason}`,
      metadata: {
        command_id: command.id,
        outcome: 'failure',
        error_reason: updated.errorReason,
        ...(rejected ? { rejected: true } : {}),
      },
    });
    if (STATE_CHANGING_TYPES.has(command.type)) {
      await createEvent(prisma, {
        agentId: agent.id,
        workerId: command.workerId,
        type: 'RECOVERY_FAILED',
        description: `Pemulihan worker gagal: ${updated.errorReason}`,
        metadata: { command_id: command.id, outcome: 'failure', error_reason: updated.errorReason },
      });
      broadcast('worker.recovery_failed', { agent_id: agent.id, command_id: command.id, reason: updated.errorReason });
    }
    broadcast('command.failed', updated);
    return { command: updated, verification: 'failed' };
  }

  // Reported success.
  if (requiresVerification(command.type)) {
    const settings = await getSettings(prisma);
    const updated = await prisma.command.update({
      where: { id: commandId },
      data: {
        result: resultJson,
        verifyDeadline: new Date(Date.now() + settings.verify_window_sec * 1000),
        startedAt: command.startedAt ?? new Date(),
      },
    });
    return { command: updated, verification: 'pending' };
  }

  const updated = await prisma.command.update({
    where: { id: commandId },
    data: { status: 'SUCCEEDED', result: resultJson, finishedAt: new Date(), verifyDeadline: null },
  });
  await createEvent(prisma, {
    agentId: agent.id,
    workerId: command.workerId,
    type: 'COMMAND_SUCCEEDED',
    description: `Perintah ${command.type} berhasil`,
    metadata: { command_id: command.id, outcome: 'success' },
  });
  // Hold/unhold bookkeeping on the worker row. hold/unhold finish immediately
  // on a successful result (they are not verification-gated), so the hold
  // state flips here — CONTRACT-2 §5's "optimistic after verify" point.
  if (command.type === 'miner.hold' && command.workerId) {
    const payload = (command.payload ?? {}) as Record<string, unknown>;
    const minutes = typeof payload.duration_minutes === 'number' ? payload.duration_minutes : 60;
    await prisma.worker.update({
      where: { id: command.workerId },
      data: { holdUntil: new Date(Date.now() + minutes * 60_000), holdActive: true },
    });
  }
  if (command.type === 'miner.unhold' && command.workerId) {
    await prisma.worker.update({ where: { id: command.workerId }, data: { holdUntil: null, holdActive: false } });
  }
  broadcast('command.succeeded', updated);
  return { command: updated, verification: 'none' };
}

/**
 * CONTRACT-7 §5: the runtime's view of the queue. Returns QUEUED,
 * unexpired commands WITHOUT claiming them — the row stays QUEUED (the
 * dashboard keeps showing "Menunggu VM") until the runtime posts a
 * result. Exactly-once on the runtime side is the runtime's own
 * executed-id tracking; the server additionally rejects a second result
 * for a terminal command with 409.
 */
export async function listQueuedForRuntime(prisma: PrismaClient, agentId: string): Promise<Command[]> {
  return prisma.command.findMany({
    where: { agentId, status: 'QUEUED', expiresAt: { gte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
}

/**
 * CONTRACT-7 §5: record a runtime-reported result. Unlike the bridge
 * path, the command may still be QUEUED (the runtime never claimed it):
 * it is first moved to RUNNING, then the shared terminal handling runs.
 * A result for a terminal command is a 409 — never applied twice.
 */
export async function reportRuntimeCommandResult(
  prisma: PrismaClient,
  agent: Agent,
  commandId: string,
  body: CommandResultBody,
): Promise<{ command: Command; verification: 'none' | 'pending' | 'failed' }> {
  const command = await prisma.command.findUnique({ where: { id: commandId } });
  if (!command || command.agentId !== agent.id) {
    throw Object.assign(new Error('COMMAND_NOT_FOUND'), { statusCode: 404 });
  }
  if (command.status === 'QUEUED') {
    await prisma.command.update({
      where: { id: commandId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await createEvent(prisma, {
      agentId: agent.id,
      workerId: command.workerId,
      type: 'COMMAND_STARTED',
      description: `Perintah ${command.type} mulai dijalankan oleh runtime`,
      metadata: { command_id: command.id, source: 'runtime' },
    });
  }
  return reportCommandResult(prisma, agent, commandId, body);
}

/**
 * Called from the heartbeat path: any RUNNING state-changing command with a
 * reported success becomes SUCCEEDED when the fresh snapshot proves the miner
 * is active with a job. Returns the commands resolved by this snapshot.
 */
export async function resolveVerifications(
  prisma: PrismaClient,
  agent: Agent,
  snapshot: { service_state?: string; job_height?: number } | null | undefined,
): Promise<Command[]> {
  if (!isVerificationSatisfied(snapshot)) return [];
  const pending = await prisma.command.findMany({
    where: { agentId: agent.id, status: 'RUNNING', verifyDeadline: { not: null } },
  });
  const resolved: Command[] = [];
  for (const command of pending) {
    const updated = await prisma.command.update({
      where: { id: command.id },
      data: { status: 'SUCCEEDED', finishedAt: new Date(), verifyDeadline: null },
    });
    await createEvent(prisma, {
      agentId: agent.id,
      workerId: command.workerId,
      type: 'COMMAND_SUCCEEDED',
      description: `Perintah ${command.type} berhasil (terverifikasi dari snapshot heartbeat)`,
      metadata: { command_id: command.id, outcome: 'success', verified: true },
    });
    if (command.workerId) {
      await prisma.worker.update({
        where: { id: command.workerId },
        data: { lastRecoveryAt: new Date() },
      });
      await createEvent(prisma, {
        agentId: agent.id,
        workerId: command.workerId,
        type: 'RECOVERY',
        description: `Worker pulih melalui perintah ${command.type}`,
        metadata: { command_id: command.id, outcome: 'success' },
      });
      broadcast('worker.recovered', { agent_id: agent.id, worker_id: command.workerId, command_id: command.id });
    }
    broadcast('command.succeeded', updated);
    resolved.push(updated);
  }
  return resolved;
}
