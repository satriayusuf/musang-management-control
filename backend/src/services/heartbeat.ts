// Heartbeat processing (CONTRACT.md — agent heartbeat endpoint):
// validate session (route) -> persist heartbeat -> upsert worker + recompute
// status -> resolve pending command verifications -> report queue depth.

import type { Agent, PrismaClient, Worker } from '@prisma/client';
import { newId } from '../lib/crypto';
import { countQueuedCommands, resolveVerifications } from './commands';
import { createEvent } from './events';
import { applyPoolStatus } from './pool-status';
import { getSettings, type Settings } from './settings';
import { computeWorkerStatus } from './status';
import { broadcast } from './ws';

export interface MinerSnapshot {
  service_state: string;
  pid?: number | null;
  session_no?: number | null;
  hashrate_hs: number;
  shares_local: number;
  /**
   * CONTRACT-6 addendum: accepted/rejected shares reported by the miner
   * process on the VM itself (via the bridge's stats source). When present
   * they are the authoritative VM-side counters and overwrite the worker's
   * stored values; when absent the stored values are left unchanged.
   */
  accepted_shares?: number | null;
  rejected_shares?: number | null;
  last_share_at?: string | null;
  start_blocked_reason?: string | null;
  job_height: number;
  difficulty: number;
  /**
   * Phase 2 (CONTRACT-2 §5): hold state reported by the bridge. The bridge
   * tracks hold as a flag file next to its identity; snapshots carry it as
   * `hold_active` (boolean). `hold` is accepted as an alias. When the field
   * is absent the stored workers.hold_active is left unchanged.
   */
  hold_active?: boolean | null;
  hold?: boolean | null;
}

export interface HeartbeatBody {
  session_id: string;
  sent_at?: string;
  host: { boot_id: string; mem_available_gib: number };
  miner: MinerSnapshot;
}

export interface HeartbeatResult {
  queuedCommands: number;
  worker: Worker | null;
}

const DOWN_STATES = new Set(['MATI', 'GAGAL_START', 'POOL_STALL', 'TAK_TERJANGKAU']);

export async function processHeartbeat(
  prisma: PrismaClient,
  agent: Agent,
  body: HeartbeatBody,
  poolConfigured: boolean,
): Promise<HeartbeatResult> {
  const now = new Date();
  const settings: Settings = await getSettings(prisma);
  const wasUnreachable = agent.status !== 'ONLINE';

  await prisma.agent.update({
    where: { id: agent.id },
    data: { lastSeenAt: now, status: 'ONLINE' },
  });
  if (wasUnreachable) {
    await createEvent(prisma, {
      agentId: agent.id,
      type: 'AGENT_RECONNECTED',
      description: `Agent ${agent.name} terhubung kembali`,
      metadata: { session_id: body.session_id },
    });
    broadcast('agent.reconnected', { agent_id: agent.id, session_id: body.session_id });
    broadcast('agent.status_changed', { agent_id: agent.id, status: 'ONLINE' });
  }

  // Phase 4 (CONTRACT-4 §2): pure replace-latest — exactly one heartbeat row
  // per agent, overwritten by every report. receivedAt is set explicitly on
  // update because @default(now()) only fires on insert.
  await prisma.heartbeat.upsert({
    where: { agentId: agent.id },
    create: {
      id: newId('hbt'),
      agentId: agent.id,
      sessionId: body.session_id,
      receivedAt: now,
      memAvailableGib: body.host.mem_available_gib,
      minerSnapshot: body.miner as never,
      agentStatus: 'ONLINE',
    },
    update: {
      sessionId: body.session_id,
      receivedAt: now,
      memAvailableGib: body.host.mem_available_gib,
      minerSnapshot: body.miner as never,
      agentStatus: 'ONLINE',
    },
  });

  // Resolve pending command verifications against this fresh snapshot first,
  // so the generic recovery event below does not double-report.
  const resolved = await resolveVerifications(prisma, agent, body.miner);
  const resolvedWorkerIds = new Set(resolved.map((c) => c.workerId).filter(Boolean));

  // --- Worker upsert + status recomputation ---
  let worker: Worker | null = null;
  if (agent.workerName) {
    worker = await prisma.worker.findUnique({ where: { agentId: agent.id } });
    if (!worker) {
      worker = await prisma.worker.create({
        data: { id: newId('wrk'), agentId: agent.id, name: agent.workerName },
      });
    }
  }

  if (worker) {
    const prevStatus = worker.status;
    const miner = body.miner;

    // Local last-share tracking: an explicit timestamp wins; otherwise a
    // growing shares_local counter while active means a share just landed.
    let lastLocalShareAt = worker.lastLocalShareAt;
    if (miner.last_share_at) {
      lastLocalShareAt = new Date(miner.last_share_at);
    } else if (miner.service_state === 'active' && miner.shares_local > worker.sharesLocal) {
      lastLocalShareAt = now;
    }
    const lastLocalShareAgeSec = lastLocalShareAt
      ? Math.max(0, (now.getTime() - lastLocalShareAt.getTime()) / 1000)
      : null;

    // Pool cross-check data (legacy path only). Phase 5 (CONTRACT-5 B4):
    // with provider 'bntpool' the heartbeat writes the PURE bridge verdict
    // and applyPoolStatus() below decides the final status from the
    // per-agent pool snapshot, so this read is skipped entirely.
    const isBntpool = settings.pool_provider === 'bntpool';
    let poolPresent: boolean | null = null;
    let poolLastShareAt: Date | null = null;
    let accepted = worker.acceptedShares;
    let rejected = worker.rejectedShares;
    if (poolConfigured && !isBntpool) {
      const snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.id } });
      if (snap) {
        poolPresent = snap.found;
        poolLastShareAt = snap.poolLastShareAt;
        accepted = snap.poolAccepted ?? accepted;
        rejected = snap.poolRejected ?? rejected;
      }
    }

    // CONTRACT-6 addendum: VM-reported accepted/rejected (from the miner
    // process via the bridge stats source) win over the legacy pool copy —
    // under bntpool they are the only writer of these worker fields.
    if (typeof miner.accepted_shares === 'number') accepted = miner.accepted_shares;
    if (typeof miner.rejected_shares === 'number') rejected = miner.rejected_shares;

    const { status, reason } = computeWorkerStatus(
      {
        agentOnline: true,
        serviceState: miner.service_state,
        startBlockedReason: miner.start_blocked_reason ?? null,
        hashrateHs: miner.hashrate_hs,
        memAvailableGib: body.host.mem_available_gib,
        lastPoolShareAt: poolLastShareAt,
        lastLocalShareAgeSec,
        poolPresent,
        now,
      },
      {
        minMemStartGib: settings.min_mem_start_gib,
        minHashrateHs: settings.min_hashrate_hs,
        memWarnMarginGib: settings.mem_warn_margin_gib,
        noShareWarnSec: settings.no_share_warn_sec,
        poolStallSec: settings.pool_stall_sec,
      },
      poolConfigured && !isBntpool,
    );

    const statusChanged = status !== prevStatus;
    // Phase 2 hold state: only overwrite when the snapshot actually reports
    // it, so older bridges without the field don't clear a known hold.
    const reportedHold =
      typeof miner.hold_active === 'boolean'
        ? miner.hold_active
        : typeof miner.hold === 'boolean'
          ? miner.hold
          : undefined;
    worker = await prisma.worker.update({
      where: { id: worker.id },
      data: {
        status,
        statusReason: reason,
        statusSince: statusChanged ? now : worker.statusSince,
        minerServiceState: miner.service_state,
        hashrateHs: miner.hashrate_hs,
        sharesLocal: miner.shares_local,
        jobHeight: miner.job_height,
        difficulty: miner.difficulty,
        lastLocalShareAt,
        lastShareAt: poolLastShareAt ?? lastLocalShareAt ?? worker.lastShareAt,
        acceptedShares: accepted,
        rejectedShares: rejected,
        ...(reportedHold !== undefined ? { holdActive: reportedHold } : {}),
      },
    });

    // Phase 5 (CONTRACT-5 B4): with provider 'bntpool', the transition side
    // effects below are owned by applyPoolStatus (it compares the FINAL
    // combined status against prevStatus, so events fire exactly once).
    if (statusChanged && !isBntpool) {
      broadcast('worker.status_changed', {
        agent_id: agent.id,
        worker_id: worker.id,
        status,
        reason,
        previous_status: prevStatus,
      });
      if (status === 'POOL_STALL') {
        await createEvent(prisma, {
          agentId: agent.id,
          workerId: worker.id,
          type: 'POOL_STALL',
          description: `Worker ${worker.name} terindikasi pool-stall: ${reason}`,
          metadata: { outcome: 'failure' },
        });
        broadcast('alert.created', { agent_id: agent.id, worker_id: worker.id, type: 'POOL_STALL', reason });
      }
      // Generic recovery: worker returned to SEHAT from a down state without
      // a command verification (e.g. its local watchdog fixed it on its own).
      if (status === 'SEHAT' && DOWN_STATES.has(prevStatus) && !resolvedWorkerIds.has(worker.id)) {
        await prisma.worker.update({ where: { id: worker.id }, data: { lastRecoveryAt: now } });
        await createEvent(prisma, {
          agentId: agent.id,
          workerId: worker.id,
          type: 'RECOVERY',
          description: `Worker ${worker.name} pulih (status kembali SEHAT)`,
          metadata: { outcome: 'success', source: 'heartbeat' },
        });
        broadcast('worker.recovered', { agent_id: agent.id, worker_id: worker.id });
      }
    }

    if (isBntpool) {
      // The final status is the bridge+pool combination; applyPoolStatus
      // persists it and emits the transition events/broadcasts.
      await applyPoolStatus(prisma, agent.id, {
        previousStatus: prevStatus,
        skipRecoveryEvent: resolvedWorkerIds.has(worker.id),
      });
      worker = (await prisma.worker.findUnique({ where: { id: worker.id } })) ?? worker;
    }
  }

  const queuedCommands = await countQueuedCommands(prisma, agent.id);
  return { queuedCommands, worker };
}
