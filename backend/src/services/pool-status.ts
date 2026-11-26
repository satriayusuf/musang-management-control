// Combined bridge+pool worker status (Phase 5, CONTRACT-5 B4; owner spec
// §5/§6). The bridge verdict (computeWorkerStatus, unchanged) is the base;
// a fresh, successful pool snapshot may rebut the SHARE-BASED parts of it.
// Pool errors never raise an alarm: an unreachable pool means "unknown",
// and the final status then follows the bridge alone (spec §6.1).

import type { Agent, PrismaClient, Worker } from '@prisma/client';
import { createEvent } from './events';
import { getSettings, type Settings } from './settings';
import { computeWorkerStatus, type WorkerStatus, type WorkerStatusResult } from './status';
import { broadcast } from './ws';

// --- Owner spec §5.1 thresholds (named constants, single home) ---
export const SHARE_FRESH_SEC = 1800; // 30 min: pool share still fresh
export const SHARE_STALL_SEC = 9000; // 2.5 h: + confirmations => pool-side stall
export const POOL_CONFIRM_POLLS = 2; // consecutive successful polls to escalate
export const POOL_CONFIRM_GAP_SEC = 300; // min gap between confirming polls
export const POOL_SNAPSHOT_MAX_AGE_SEC = 900; // older success snapshot => unknown

const DOWN_STATES = new Set(['MATI', 'GAGAL_START', 'POOL_STALL', 'TAK_TERJANGKAU']);
const SERVICE_DEAD_STATES = new Set(['MATI', 'GAGAL_START']);

/** The subset of a pool_snapshots row the status logic reads. */
export interface PoolSnapshotView {
  found: boolean;
  fetchOk: boolean;
  fetchedAt: Date | null;
  poolLastShareAt: Date | null;
  lastKnownShareAt: Date | null;
  confirmKind: string | null;
  confirmCount: number;
}

/** Pool is "unknown" when there is no usable successful snapshot (B4). */
export function isPoolUnknown(snapshot: PoolSnapshotView | null, now: Date): boolean {
  if (!snapshot || !snapshot.fetchedAt) return true;
  return now.getTime() - snapshot.fetchedAt.getTime() > POOL_SNAPSHOT_MAX_AGE_SEC * 1000;
}

/** Human-readable duration for the spec's WASPADA text ("45 menit", "2 jam 5 menit"). */
export function humanAgeId(ageSec: number): string {
  const totalMin = Math.max(1, Math.floor(ageSec / 60));
  if (totalMin < 60) return `${totalMin} menit`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours} jam ${mins} menit` : `${hours} jam`;
}

export interface CombinedStatusInput {
  bridgeStatus: WorkerStatus;
  bridgeReason: string;
  /** Last bridge report says service active and hashrate > 0 (B4). */
  bridgeHashing: boolean;
  /** The bridge verdict is the share-staleness WASPADA (status.ts step 3b). */
  bridgeShareBased: boolean;
  agentOnline: boolean;
  snapshot: PoolSnapshotView | null;
  now: Date;
}

export interface CombinedStatusResult {
  status: WorkerStatus;
  reason: string;
  poolState: 'ok' | 'unknown';
  /** pool_last_share_at was in the future (clock skew); age was clamped to 0. */
  shareInFuture: boolean;
}

const STALL_REASON = 'Tidak ada share ≥2,5 jam padahal miner hashing — kemungkinan stall di sisi pool';

export function computeCombinedStatus(input: CombinedStatusInput): CombinedStatusResult {
  const bridge: CombinedStatusResult = {
    status: input.bridgeStatus,
    reason: input.bridgeReason,
    poolState: 'ok',
    shareInFuture: false,
  };
  if (isPoolUnknown(input.snapshot, input.now)) {
    return { ...bridge, poolState: 'unknown' };
  }
  const snapshot = input.snapshot as PoolSnapshotView;
  const nowMs = input.now.getTime();

  if (snapshot.found && snapshot.poolLastShareAt) {
    const rawAgeSec = (nowMs - snapshot.poolLastShareAt.getTime()) / 1000;
    const shareInFuture = rawAgeSec < 0;
    const ageSec = Math.max(0, rawAgeSec); // §6.3: negative age clamps to 0
    const withSkew = (r: CombinedStatusResult): CombinedStatusResult => ({ ...r, shareInFuture });

    if (ageSec <= SHARE_FRESH_SEC) {
      // Fresh pool share. The pool rebuts only share/stall-based verdicts
      // and the unreachable verdict — never a service-dead verdict (B4).
      if (SERVICE_DEAD_STATES.has(input.bridgeStatus)) return withSkew(bridge);
      if (input.bridgeStatus === 'WASPADA' && !input.bridgeShareBased) return withSkew(bridge);
      if (input.bridgeStatus === 'SEHAT') return withSkew(bridge);
      return withSkew({
        status: 'SEHAT',
        reason: 'Share pool segar — miner sehat menurut pool',
        poolState: 'ok',
        shareInFuture,
      });
    }

    if (ageSec < SHARE_STALL_SEC) {
      if (input.bridgeHashing) {
        return withSkew({
          status: 'WASPADA',
          reason: `Tidak ada share selama ${humanAgeId(ageSec)} — miner masih hashing; share bersifat acak`,
          poolState: 'ok',
          shareInFuture,
        });
      }
      return withSkew(bridge); // miner itself is the problem; don't blame the pool
    }

    // ageSec >= SHARE_STALL_SEC
    if (input.bridgeHashing) {
      if (snapshot.confirmKind === 'stall' && snapshot.confirmCount >= POOL_CONFIRM_POLLS) {
        return withSkew({ status: 'POOL_STALL', reason: STALL_REASON, poolState: 'ok', shareInFuture });
      }
      // Not yet confirmed by a second spaced successful poll: stays a
      // warning — escalation always requires a fresh successful fetch,
      // never an old snapshot aging in place (spec §5.2).
      return withSkew({
        status: 'WASPADA',
        reason: `Tidak ada share selama ${humanAgeId(ageSec)} — miner masih hashing; share bersifat acak`,
        poolState: 'ok',
        shareInFuture,
      });
    }
    return withSkew(bridge);
  }

  if (snapshot.found) {
    // Worker found but its share time is unknown: not an error, not a
    // stall (spec §3.1) — the bridge verdict stands.
    return bridge;
  }

  // not_found (from the last successful fetch)
  const confirmedNotFound =
    snapshot.confirmKind === 'not_found' && snapshot.confirmCount >= POOL_CONFIRM_POLLS;
  if (confirmedNotFound && input.bridgeHashing) {
    if (snapshot.lastKnownShareAt) {
      const knownAgeSec = Math.max(0, (nowMs - snapshot.lastKnownShareAt.getTime()) / 1000);
      if (knownAgeSec >= SHARE_STALL_SEC) {
        return { status: 'POOL_STALL', reason: STALL_REASON, poolState: 'ok', shareInFuture: false };
      }
    }
    if (input.agentOnline) {
      return {
        status: 'WASPADA',
        reason: 'Worker tidak terlihat di pool',
        poolState: 'ok',
        shareInFuture: false,
      };
    }
  }
  return bridge;
}

// ---------------------------------------------------------------------------
// DB assembly + persistence
// ---------------------------------------------------------------------------

export interface BridgeContext {
  verdict: WorkerStatusResult;
  bridgeHashing: boolean;
  bridgeShareBased: boolean;
  agentOnline: boolean;
}

/**
 * Rebuild the pure bridge verdict for an agent from stored state: the
 * latest heartbeat's miner snapshot + worker row, computeWorkerStatus with
 * poolConfigured=false (no pool influence).
 */
export async function assembleBridgeContext(
  prisma: PrismaClient,
  agent: Agent,
  worker: Worker,
  settings: Settings,
  now: Date,
): Promise<BridgeContext> {
  const heartbeat = await prisma.heartbeat.findUnique({ where: { agentId: agent.id } });
  const miner = (heartbeat?.minerSnapshot ?? null) as {
    service_state?: string;
    hashrate_hs?: number;
    start_blocked_reason?: string | null;
  } | null;
  const agentOnline = agent.status === 'ONLINE';
  const serviceState = miner?.service_state ?? worker.minerServiceState;
  const hashrateHs = typeof miner?.hashrate_hs === 'number' ? miner.hashrate_hs : worker.hashrateHs;
  // A worker row is only ever created by processHeartbeat (after the
  // heartbeat upsert), so a heartbeat normally exists; the fallback keeps
  // memory thresholds from misfiring if one is somehow absent.
  const memAvailableGib =
    heartbeat?.memAvailableGib ?? settings.min_mem_start_gib + settings.mem_warn_margin_gib + 1;
  const lastLocalShareAgeSec = worker.lastLocalShareAt
    ? Math.max(0, (now.getTime() - worker.lastLocalShareAt.getTime()) / 1000)
    : null;

  const verdict = computeWorkerStatus(
    {
      agentOnline,
      serviceState,
      startBlockedReason: miner?.start_blocked_reason ?? null,
      hashrateHs,
      memAvailableGib,
      lastPoolShareAt: null,
      lastLocalShareAgeSec,
      poolPresent: null,
      now,
    },
    {
      minMemStartGib: settings.min_mem_start_gib,
      minHashrateHs: settings.min_hashrate_hs,
      memWarnMarginGib: settings.mem_warn_margin_gib,
      noShareWarnSec: settings.no_share_warn_sec,
      poolStallSec: settings.pool_stall_sec,
    },
    false,
  );

  return {
    verdict,
    bridgeHashing: serviceState === 'active' && hashrateHs > 0,
    bridgeShareBased:
      agentOnline &&
      serviceState === 'active' &&
      (lastLocalShareAgeSec === null || lastLocalShareAgeSec > settings.no_share_warn_sec),
    agentOnline,
  };
}

export interface ApplyPoolStatusOptions {
  now?: Date;
  /** Worker status before the caller's own write (heartbeat path), so
   *  transition events describe the full old -> final change once. */
  previousStatus?: string;
  /** A command verification already reported this worker's recovery. */
  skipRecoveryEvent?: boolean;
  log?: (line: string) => void;
}

export interface ApplyPoolStatusResult {
  status: WorkerStatus;
  reason: string;
  poolState: 'ok' | 'unknown';
}

/**
 * Compute the final (combined) worker status for an agent and persist it,
 * following heartbeat.ts side-effect patterns (status_changed broadcast,
 * POOL_STALL event + alert broadcast, generic RECOVERY). Never touches
 * agent.status — agent reachability stays the heartbeat/sweeper domain
 * (spec §5.2 separation, A12). Returns null when the agent/worker is gone.
 * When the provider is not bntpool this is a pure read: the bridge verdict
 * is returned as-is and nothing is written (legacy path owns the writes).
 */
export async function applyPoolStatus(
  prisma: PrismaClient,
  agentId: string,
  opts: ApplyPoolStatusOptions = {},
): Promise<ApplyPoolStatusResult | null> {
  const now = opts.now ?? new Date();
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return null;
  const worker = await prisma.worker.findUnique({ where: { agentId } });
  if (!worker) return null;

  const settings = await getSettings(prisma);
  const ctx = await assembleBridgeContext(prisma, agent, worker, settings, now);

  if (settings.pool_provider !== 'bntpool') {
    return { status: ctx.verdict.status, reason: ctx.verdict.reason, poolState: 'unknown' };
  }

  const snapshot = await prisma.poolSnapshot.findUnique({ where: { agentId } });
  const combined = computeCombinedStatus({
    bridgeStatus: ctx.verdict.status,
    bridgeReason: ctx.verdict.reason,
    bridgeHashing: ctx.bridgeHashing,
    bridgeShareBased: ctx.bridgeShareBased,
    agentOnline: ctx.agentOnline,
    snapshot: snapshot
      ? {
          found: snapshot.found,
          fetchOk: snapshot.fetchOk,
          fetchedAt: snapshot.fetchedAt,
          poolLastShareAt: snapshot.poolLastShareAt,
          lastKnownShareAt: snapshot.lastKnownShareAt,
          confirmKind: snapshot.confirmKind,
          confirmCount: snapshot.confirmCount,
        }
      : null,
    now,
  });

  if (combined.shareInFuture) {
    (opts.log ?? ((line: string) => console.warn(line)))(
      `[pool] clock skew: pool_last_share_at in the future for worker ${worker.name}; age clamped to 0`,
    );
  }

  const prevStatus = opts.previousStatus ?? worker.status;
  const statusChanged = combined.status !== worker.status;
  if (statusChanged || combined.reason !== worker.statusReason) {
    await prisma.worker.update({
      where: { id: worker.id },
      data: {
        status: combined.status,
        statusReason: combined.reason,
        statusSince: statusChanged ? now : worker.statusSince,
      },
    });
  }

  if (combined.status !== prevStatus) {
    broadcast('worker.status_changed', {
      agent_id: agent.id,
      worker_id: worker.id,
      status: combined.status,
      reason: combined.reason,
      previous_status: prevStatus,
    });
    if (combined.status === 'POOL_STALL') {
      await createEvent(prisma, {
        agentId: agent.id,
        workerId: worker.id,
        type: 'POOL_STALL',
        description: `Worker ${worker.name} terindikasi pool-stall: ${combined.reason}`,
        metadata: { outcome: 'failure', source: 'pool' },
      });
      broadcast('alert.created', { agent_id: agent.id, worker_id: worker.id, type: 'POOL_STALL', reason: combined.reason });
    }
    if (combined.status === 'SEHAT' && DOWN_STATES.has(prevStatus) && !opts.skipRecoveryEvent) {
      await prisma.worker.update({ where: { id: worker.id }, data: { lastRecoveryAt: now } });
      await createEvent(prisma, {
        agentId: agent.id,
        workerId: worker.id,
        type: 'RECOVERY',
        description: `Worker ${worker.name} pulih (status kembali SEHAT)`,
        metadata: { outcome: 'success', source: 'pool' },
      });
      broadcast('worker.recovered', { agent_id: agent.id, worker_id: worker.id });
    }
  }

  return { status: combined.status, reason: combined.reason, poolState: combined.poolState };
}

/**
 * Batch-build the B6 `pool` field for a set of agents. The field is null
 * for every agent when the provider is not bntpool (callers additionally
 * null it for agents without a worker).
 */
export async function poolFieldsForAgents(
  prisma: PrismaClient,
  agentIds: string[],
  now: Date,
): Promise<Map<string, PoolField | null>> {
  const out = new Map<string, PoolField | null>();
  const settings = await getSettings(prisma);
  if (settings.pool_provider !== 'bntpool' || agentIds.length === 0) {
    for (const id of agentIds) out.set(id, null);
    return out;
  }
  const snapshots = await prisma.poolSnapshot.findMany({ where: { agentId: { in: agentIds } } });
  const byAgent = new Map(snapshots.map((s) => [s.agentId, s]));
  for (const id of agentIds) {
    out.set(id, toPoolField(byAgent.get(id) ?? null, now));
  }
  return out;
}

// ---------------------------------------------------------------------------
// API exposure (CONTRACT-5 B6)
// ---------------------------------------------------------------------------

export interface PoolField {
  state: 'ok' | 'unknown';
  found: boolean;
  hashrate: number | null;
  accepted: number | null;
  rejected: number | null;
  last_share_at: string | null;
  fetched_at: string | null;
  fetch_error: string | null;
}

/**
 * The B6 `pool` object for one agent's snapshot row. Data from the last
 * successful fetch stays visible even when state is 'unknown' (spec §8.2);
 * only the complete absence of a row yields all-null data.
 */
export function toPoolField(
  snapshot: {
    found: boolean;
    fetchOk: boolean;
    fetchedAt: Date | null;
    poolHashrate: number | null;
    poolAccepted: number | null;
    poolRejected: number | null;
    poolLastShareAt: Date | null;
    lastKnownShareAt: Date | null;
    fetchError: string | null;
    confirmKind: string | null;
    confirmCount: number;
  } | null,
  now: Date,
): PoolField {
  if (!snapshot) {
    return {
      state: 'unknown',
      found: false,
      hashrate: null,
      accepted: null,
      rejected: null,
      last_share_at: null,
      fetched_at: null,
      fetch_error: null,
    };
  }
  return {
    state: isPoolUnknown(snapshot, now) ? 'unknown' : 'ok',
    found: snapshot.found,
    hashrate: snapshot.poolHashrate,
    accepted: snapshot.poolAccepted,
    rejected: snapshot.poolRejected,
    last_share_at: snapshot.poolLastShareAt?.toISOString() ?? null,
    fetched_at: snapshot.fetchedAt?.toISOString() ?? null,
    fetch_error: snapshot.fetchError,
  };
}
