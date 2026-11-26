// Periodic sweeper (single function, called by server.ts every 15s and
// directly from tests):
//  1. Agents whose heartbeat is older than interval * missed_beats become
//     UNREACHABLE; their workers become TAK_TERJANGKAU.
//  2. QUEUED commands past expires_at become EXPIRED.
//  3. RUNNING commands past verify_deadline become FAILED
//     (VERIFICATION_TIMEOUT) — the reported success was never proven.

import type { PrismaClient } from '@prisma/client';
import { ALERT_CONDITIONS, createAlertNotification, evaluateWorkerAlerts } from './alerts';
import { evaluateAutomationRules } from './automation';
import { createEvent } from './events';
import { runRetentionIfDue, type RetentionCounts } from './retention';
import { evaluateSchedules } from './schedules';
import { getSettings } from './settings';
import { broadcast } from './ws';

export interface SweepSummary {
  agentsMarkedUnreachable: number;
  commandsExpired: number;
  commandsVerificationFailed: number;
  alertsCreated: number;
  /** Phase 3: automation rules that created at least one command. */
  rulesFired: number;
  /** Phase 3: automation targets skipped by eligibility gates. */
  ruleSkips: number;
  /** Phase 3: schedules that fired this tick. */
  schedulesFired: number;
  /** Phase 3: retention counts when the hourly cleanup ran, else null. */
  retention: RetentionCounts | null;
}

export interface SweepOptions {
  /** True when a pool provider is configured (gates POOL_STALL alerts). */
  poolConfigured?: boolean;
}

export async function runSweep(
  prisma: PrismaClient,
  now: Date = new Date(),
  options: SweepOptions = {},
): Promise<SweepSummary> {
  const settings = await getSettings(prisma);
  const summary: SweepSummary = {
    agentsMarkedUnreachable: 0,
    commandsExpired: 0,
    commandsVerificationFailed: 0,
    alertsCreated: 0,
    rulesFired: 0,
    ruleSkips: 0,
    schedulesFired: 0,
    retention: null,
  };

  // 1. Unreachable agents.
  const thresholdMs = settings.heartbeat_interval_sec * settings.unreachable_missed_beats * 1000;
  const cutoff = new Date(now.getTime() - thresholdMs);
  const staleAgents = await prisma.agent.findMany({
    where: { status: 'ONLINE', lastSeenAt: { lt: cutoff } },
  });
  for (const agent of staleAgents) {
    await prisma.agent.update({ where: { id: agent.id }, data: { status: 'UNREACHABLE' } });
    summary.agentsMarkedUnreachable += 1;
    await createEvent(prisma, {
      agentId: agent.id,
      type: 'AGENT_UNREACHABLE',
      description: `Agent ${agent.name} tidak terjangkau (heartbeat berhenti)`,
      metadata: { last_seen_at: agent.lastSeenAt?.toISOString() ?? null },
    });
    broadcast('agent.unreachable', { agent_id: agent.id, last_seen_at: agent.lastSeenAt });
    broadcast('agent.status_changed', { agent_id: agent.id, status: 'UNREACHABLE' });

    // Phase 2 alert: the unreachable transition itself is the occurrence.
    const workerForAlert = await prisma.worker.findUnique({ where: { agentId: agent.id } });
    const alertNotification = await createAlertNotification(prisma, {
      condition: ALERT_CONDITIONS.AGENT_UNREACHABLE,
      agentId: agent.id,
      workerId: workerForAlert?.id ?? null,
      entityId: agent.id,
      occurrenceStartedAt: now,
      title: `Agent tidak terjangkau: ${agent.name}`,
      body: `Agent ${agent.name} berhenti mengirim heartbeat; terakhir terlihat ${agent.lastSeenAt?.toISOString() ?? '-'}`,
    });
    if (alertNotification) summary.alertsCreated += 1;

    const worker = await prisma.worker.findUnique({ where: { agentId: agent.id } });
    if (worker && worker.status !== 'TAK_TERJANGKAU') {
      await prisma.worker.update({
        where: { id: worker.id },
        data: {
          status: 'TAK_TERJANGKAU',
          statusReason: 'Heartbeat agent berhenti; status terakhir yang diketahui ditampilkan',
          statusSince: now,
        },
      });
      broadcast('worker.status_changed', {
        agent_id: agent.id,
        worker_id: worker.id,
        status: 'TAK_TERJANGKAU',
        previous_status: worker.status,
      });
      broadcast('alert.created', { agent_id: agent.id, worker_id: worker.id, type: 'TAK_TERJANGKAU' });
    }

    // Close the dangling session as LOST if it never ended.
    if (agent.currentSessionId) {
      const session = await prisma.session.findUnique({ where: { id: agent.currentSessionId } });
      if (session && !session.endedAt) {
        await prisma.session.update({
          where: { id: session.id },
          data: { endedAt: now, endReason: 'LOST' },
        });
        broadcast('session.ended', { agent_id: agent.id, session_id: session.id, end_reason: 'LOST' });
      }
    }
  }

  // 2. Expired queued commands.
  const expired = await prisma.command.updateMany({
    where: { status: 'QUEUED', expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });
  summary.commandsExpired = expired.count;

  // 3. Verification timeouts.
  const overdue = await prisma.command.findMany({
    where: { status: 'RUNNING', verifyDeadline: { not: null, lt: now } },
  });
  for (const command of overdue) {
    const updated = await prisma.command.update({
      where: { id: command.id },
      data: {
        status: 'FAILED',
        errorReason: 'VERIFICATION_TIMEOUT',
        finishedAt: now,
        verifyDeadline: null,
      },
    });
    summary.commandsVerificationFailed += 1;
    await createEvent(prisma, {
      agentId: command.agentId,
      workerId: command.workerId,
      type: 'COMMAND_FAILED',
      description: `Perintah ${command.type} gagal: hasil tidak terverifikasi sebelum batas waktu`,
      metadata: { command_id: command.id, outcome: 'failure', error_reason: 'VERIFICATION_TIMEOUT' },
    });
    await createEvent(prisma, {
      agentId: command.agentId,
      workerId: command.workerId,
      type: 'RECOVERY_FAILED',
      description: `Pemulihan worker gagal: verifikasi perintah ${command.type} melewati batas waktu`,
      metadata: { command_id: command.id, outcome: 'failure', error_reason: 'VERIFICATION_TIMEOUT' },
    });
    broadcast('command.failed', updated);
    broadcast('worker.recovery_failed', {
      agent_id: command.agentId,
      command_id: command.id,
      reason: 'VERIFICATION_TIMEOUT',
    });
  }

  // 4. Phase 2 alert conditions on workers (MATI / GAGAL_START past the
  // threshold, POOL_STALL when the pool is configured). Deduped per
  // occurrence inside the alerts service; failures never break the sweep.
  summary.alertsCreated += await evaluateWorkerAlerts(prisma, now, options.poolConfigured ?? false);

  // 5. Phase 3 automation rules + schedules, gated by the master switch
  // (CONTRACT-3 §2). Runs AFTER unreachable marking so agent_unreachable
  // rules see this tick's transitions. Failures never break the sweep.
  if (settings.automation_enabled) {
    try {
      const automation = await evaluateAutomationRules(prisma, now);
      summary.rulesFired = automation.rulesFired;
      summary.ruleSkips = automation.ruleSkips;
    } catch {
      /* rules are best-effort per tick */
    }
    try {
      const schedules = await evaluateSchedules(prisma, now);
      summary.schedulesFired = schedules.schedulesFired;
    } catch {
      /* schedules are best-effort per tick */
    }
  }

  // 6. Phase 3 retention cleanup (hourly; CONTRACT-3 §4).
  try {
    summary.retention = await runRetentionIfDue(prisma, now);
  } catch {
    summary.retention = null;
  }

  return summary;
}
