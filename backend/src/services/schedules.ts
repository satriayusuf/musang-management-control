// Schedules (Phase 3, CONTRACT-3 §3): cron-timed command creation.
//
// Cron expressions are validated at save time by the dependency-free matcher
// in services/cron.ts (invalid → 400). The sweeper evaluates due schedules:
// broadcast=true goes through the Phase 2 broadcast fan-out (one batch);
// otherwise one normal command per target through the Phase 1 creation path.
// Either way the commands carry source="schedule" and schedule_id, and
// idempotency keys are derived from the scheduled occurrence so a repeated
// tick can never double-fire. Cron is evaluated in the SERVER'S LOCAL
// timezone (documented in the README).

import type { PrismaClient, Schedule } from '@prisma/client';
import { newId } from '../lib/crypto';
import { createBroadcast } from './broadcast';
import { createCommand } from './commands';
import { createEvent } from './events';
import { computeNextRun, parseCron } from './cron';
import { resolveAction, validateActionShape, validateTarget, type RuleAction, type RuleTarget } from './automation';

function httpErr(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export interface ScheduleInput {
  name: string;
  enabled?: boolean;
  cron: string;
  action: unknown;
  target: unknown;
  broadcast?: boolean;
}

interface ValidatedSchedule {
  name: string;
  cron: string;
  action: RuleAction;
  target: RuleTarget;
  broadcast: boolean;
}

async function validateScheduleInput(prisma: PrismaClient, input: ScheduleInput): Promise<ValidatedSchedule> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw httpErr(400, 'Nama jadwal wajib diisi');
  if (typeof input.cron !== 'string' || input.cron.trim().length === 0) {
    throw httpErr(400, 'Ekspresi cron wajib diisi');
  }
  try {
    parseCron(input.cron);
  } catch (err) {
    throw httpErr(400, err instanceof Error ? err.message : 'Ekspresi cron tidak valid');
  }
  const action = validateActionShape(input.action);
  await resolveAction(prisma, action); // template must exist at save time
  const target = validateTarget(input.target);
  return { name, cron: input.cron.trim(), action, target, broadcast: input.broadcast ?? false };
}

export async function createSchedule(prisma: PrismaClient, input: ScheduleInput): Promise<Schedule> {
  const v = await validateScheduleInput(prisma, input);
  const enabled = input.enabled ?? false;
  const now = new Date();
  return prisma.schedule.create({
    data: {
      id: newId('sch'),
      name: v.name,
      enabled,
      cron: v.cron,
      action: v.action as never,
      target: v.target as never,
      broadcast: v.broadcast,
      nextRunAt: enabled ? computeNextRun(v.cron, now) : null,
    },
  });
}

export async function updateSchedule(
  prisma: PrismaClient,
  id: string,
  patch: Partial<ScheduleInput>,
): Promise<Schedule> {
  const existing = await prisma.schedule.findUnique({ where: { id } });
  if (!existing) throw httpErr(404, 'SCHEDULE_NOT_FOUND');
  const merged: ScheduleInput = {
    name: patch.name ?? existing.name,
    enabled: patch.enabled ?? existing.enabled,
    cron: patch.cron ?? existing.cron,
    action: patch.action ?? existing.action,
    target: patch.target ?? existing.target,
    broadcast: patch.broadcast ?? existing.broadcast,
  };
  const v = await validateScheduleInput(prisma, merged);
  const enabled = merged.enabled ?? false;
  const cronChanged = v.cron !== existing.cron;
  return prisma.schedule.update({
    where: { id },
    data: {
      name: v.name,
      enabled,
      cron: v.cron,
      action: v.action as never,
      target: v.target as never,
      broadcast: v.broadcast,
      // Recompute the next run when the schedule is (re)enabled or its cron
      // expression changed; otherwise keep the stored value.
      nextRunAt: enabled ? (cronChanged || !existing.nextRunAt ? computeNextRun(v.cron, new Date()) : existing.nextRunAt) : existing.nextRunAt,
    },
  });
}

export async function deleteSchedule(prisma: PrismaClient, id: string): Promise<void> {
  const existing = await prisma.schedule.findUnique({ where: { id } });
  if (!existing) throw httpErr(404, 'SCHEDULE_NOT_FOUND');
  await prisma.schedule.delete({ where: { id } });
}

export async function toggleSchedule(prisma: PrismaClient, id: string, enabled: boolean): Promise<Schedule> {
  const existing = await prisma.schedule.findUnique({ where: { id } });
  if (!existing) throw httpErr(404, 'SCHEDULE_NOT_FOUND');
  return prisma.schedule.update({
    where: { id },
    data: {
      enabled,
      nextRunAt: enabled ? computeNextRun(existing.cron, new Date()) : existing.nextRunAt,
    },
  });
}

export interface ScheduleSummary {
  schedulesFired: number;
}

/**
 * One evaluation pass over due schedules. Called from the sweeper tick; the
 * caller gates on the automation_enabled master switch. After firing, the
 * next run is computed FROM NOW (missed occurrences are not caught up).
 */
export async function evaluateSchedules(prisma: PrismaClient, now: Date): Promise<ScheduleSummary> {
  const summary: ScheduleSummary = { schedulesFired: 0 };
  const due = await prisma.schedule.findMany({
    where: { enabled: true, nextRunAt: { not: null, lte: now } },
  });
  for (const schedule of due) {
    try {
      await fireSchedule(prisma, schedule, now);
      summary.schedulesFired += 1;
    } catch {
      // A broken schedule must never break the sweep.
    } finally {
      await prisma.schedule
        .update({
          where: { id: schedule.id },
          data: { lastRunAt: now, nextRunAt: computeNextRun(schedule.cron, now) },
        })
        .catch(() => undefined);
    }
  }
  return summary;
}

async function fireSchedule(prisma: PrismaClient, schedule: Schedule, now: Date): Promise<void> {
  const action = schedule.action as unknown as RuleAction;
  const target = schedule.target as unknown as RuleTarget;
  const { type, payload, templateId } = await resolveAction(prisma, action);
  const occurrence = (schedule.nextRunAt ?? now).toISOString();

  const agents =
    target.agent_ids === 'all'
      ? await prisma.agent.findMany()
      : await prisma.agent.findMany({ where: { id: { in: target.agent_ids } } });
  const agentIds = agents.map((a) => a.id);

  if (schedule.broadcast) {
    await createBroadcast(prisma, {
      ...(templateId ? { templateId } : { type }),
      payload,
      agentIds,
      confirm: true,
      idempotencyKey: `schedule:${schedule.id}:${occurrence}`,
      requestedById: 'schedule',
      requestedByEmail: 'schedule',
      source: 'schedule',
      scheduleId: schedule.id,
    });
    await createEvent(prisma, {
      agentId: null,
      workerId: null,
      type: 'SCHEDULE_FIRED',
      description: `Jadwal "${schedule.name}" dijalankan (broadcast): perintah ${type} ke ${agentIds.length} agent`,
      metadata: { schedule_id: schedule.id, type, broadcast: true, targets: agentIds.length },
    });
    return;
  }

  let created = 0;
  for (const agent of agents) {
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.id } });
    if (!worker || agent.revokedAt) continue;
    try {
      const result = await createCommand(prisma, {
        worker,
        agent,
        type,
        payload,
        templateId,
        idempotencyKey: `schedule:${schedule.id}:${agent.id}:${occurrence}`,
        requestedBy: 'schedule',
        confirm: true,
        source: 'schedule',
        scheduleId: schedule.id,
      });
      if (result.created) created += 1;
    } catch {
      // Per-target eligibility refusals skip that target only.
    }
  }
  await createEvent(prisma, {
    agentId: null,
    workerId: null,
    type: 'SCHEDULE_FIRED',
    description: `Jadwal "${schedule.name}" dijalankan: ${created} perintah ${type} dibuat`,
    metadata: { schedule_id: schedule.id, type, broadcast: false, created },
  });
}
