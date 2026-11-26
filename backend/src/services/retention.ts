// Retention cleanup (Phase 3, CONTRACT-3 §4; Phase 4, CONTRACT-4 §4;
// Phase 5, CONTRACT-5 B1).
//
// Deletes ONLY: alert notifications (their deliveries cascade) and
// TERMINAL commands (SUCCEEDED / FAILED / TIMED_OUT / EXPIRED) older than
// the configured windows. Agents, users, audit logs, events, sessions, and
// non-terminal commands are NEVER touched.
// Heartbeats are NEVER deleted: since Phase 4 each agent keeps exactly one
// latest heartbeat row, and an agent silent longer than any window must not
// lose its last known state. The retention_heartbeats_days setting remains
// readable/writable as a legacy no-op; counts.heartbeats is always 0.
// Pool snapshots are NEVER deleted either: since Phase 5 each agent keeps
// exactly one snapshot row (the last successful pool state + confirmation
// counters); retention_pool_snapshots_days is likewise a legacy no-op and
// counts.pool_snapshots is always 0.
// A window of 0 days disables that set. Every run — hourly from the sweeper
// or on demand via POST /api/settings/retention/run — writes an audit row.

import type { PrismaClient } from '@prisma/client';
import { createAuditLog } from './audit';
import { getSettings } from './settings';

export const TERMINAL_COMMAND_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'EXPIRED'] as const;

export interface RetentionCounts {
  heartbeats: number;
  pool_snapshots: number;
  alert_notifications: number;
  alert_deliveries: number;
  commands: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runRetentionCleanup(
  prisma: PrismaClient,
  now: Date,
  actor: string,
): Promise<RetentionCounts> {
  const settings = await getSettings(prisma);
  const counts: RetentionCounts = {
    heartbeats: 0,
    pool_snapshots: 0,
    alert_notifications: 0,
    alert_deliveries: 0,
    commands: 0,
  };

  if (settings.retention_alerts_days > 0) {
    const cutoff = new Date(now.getTime() - settings.retention_alerts_days * DAY_MS);
    // Count deliveries first: they are removed by the FK cascade.
    counts.alert_deliveries = await prisma.alertDelivery.count({
      where: { notification: { createdAt: { lt: cutoff } } },
    });
    const res = await prisma.alertNotification.deleteMany({ where: { createdAt: { lt: cutoff } } });
    counts.alert_notifications = res.count;
  }

  if (settings.retention_terminal_commands_days > 0) {
    const cutoff = new Date(now.getTime() - settings.retention_terminal_commands_days * DAY_MS);
    // Terminal rows normally carry finished_at; EXPIRED rows may not, so
    // fall back to created_at for those.
    const res = await prisma.command.deleteMany({
      where: {
        status: { in: [...TERMINAL_COMMAND_STATUSES] },
        OR: [{ finishedAt: { lt: cutoff } }, { finishedAt: null, createdAt: { lt: cutoff } }],
      },
    });
    counts.commands = res.count;
  }

  await createAuditLog(prisma, {
    actor,
    action: 'retention.cleanup',
    target: 'retention',
    metadata: { ...counts },
  });
  return counts;
}

// Hourly gate for the sweeper-driven cleanup (module state is fine: the
// backend is a single process by design).
let lastRetentionRunAt: Date | null = null;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** Run the cleanup when at least an hour passed since the last run. */
export async function runRetentionIfDue(
  prisma: PrismaClient,
  now: Date,
): Promise<RetentionCounts | null> {
  if (lastRetentionRunAt && now.getTime() - lastRetentionRunAt.getTime() < RETENTION_INTERVAL_MS) {
    return null;
  }
  lastRetentionRunAt = now;
  return runRetentionCleanup(prisma, now, 'system');
}

/** Test hook: reset the hourly gate. */
export function resetRetentionGate(): void {
  lastRetentionRunAt = null;
}
