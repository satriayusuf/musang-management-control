// Pure worker status calculation (CONTRACT.md — "Worker status calculation").
// No I/O, no Prisma: fully unit-testable. Reason strings are Bahasa Indonesia.

export type WorkerStatus =
  | 'SEHAT'
  | 'WASPADA'
  | 'MATI'
  | 'GAGAL_START'
  | 'TAK_TERJANGKAU'
  | 'POOL_STALL';

export interface WorkerStatusInput {
  /** False when the agent's heartbeat has stopped (agent marked unreachable). */
  agentOnline: boolean;
  /** Miner service state as reported by the bridge: active | inactive | failed | unit-missing | … */
  serviceState: string;
  /** Bridge-reported reason the miner cannot start, e.g. "LOW_MEMORY" (nullable). */
  startBlockedReason?: string | null;
  hashrateHs: number;
  memAvailableGib: number;
  /** Last share time known from the pool (or null when never seen / not configured). */
  lastPoolShareAt?: Date | null;
  /** Age in seconds of the last local share reported by the bridge (null = never). */
  lastLocalShareAgeSec: number | null;
  /** Whether the worker is currently present in the pool API (null = unknown / not configured). */
  poolPresent: boolean | null;
  now: Date;
}

export interface WorkerStatusSettings {
  minMemStartGib: number;
  minHashrateHs: number;
  memWarnMarginGib: number;
  noShareWarnSec: number;
  poolStallSec: number;
}

export interface WorkerStatusResult {
  status: WorkerStatus;
  reason: string;
}

function fmtGib(v: number): string {
  return `${Math.round(v * 10) / 10} GiB`;
}

export function computeWorkerStatus(
  input: WorkerStatusInput,
  settings: WorkerStatusSettings,
  poolConfigured: boolean,
): WorkerStatusResult {
  // 1. Agent unreachable beats everything else.
  if (!input.agentOnline) {
    return { status: 'TAK_TERJANGKAU', reason: 'Heartbeat agent berhenti; status terakhir yang diketahui ditampilkan' };
  }

  // 2. Miner service not active.
  if (input.serviceState !== 'active') {
    if (input.startBlockedReason === 'LOW_MEMORY' || input.memAvailableGib < settings.minMemStartGib) {
      return {
        status: 'GAGAL_START',
        reason: `Memori tersedia ${fmtGib(input.memAvailableGib)} di bawah ambang start ${fmtGib(settings.minMemStartGib)}`,
      };
    }
    if (input.serviceState === 'failed') {
      return { status: 'MATI', reason: 'Service miner gagal berjalan (failed)' };
    }
    if (input.serviceState === 'unit-missing') {
      return { status: 'MATI', reason: 'Unit service miner tidak ditemukan' };
    }
    return { status: 'MATI', reason: 'Service miner tidak aktif' };
  }

  // 3. Service active.
  // 3a. Pool stall: hashing locally, but the pool has not seen the worker / a
  // share for longer than the anomaly threshold. Only when a pool is configured.
  if (poolConfigured && input.poolPresent === false) {
    const poolShareAgeSec =
      input.lastPoolShareAt == null
        ? Number.POSITIVE_INFINITY
        : (input.now.getTime() - input.lastPoolShareAt.getTime()) / 1000;
    if (poolShareAgeSec > settings.poolStallSec && input.hashrateHs >= settings.minHashrateHs) {
      return {
        status: 'POOL_STALL',
        reason: 'Miner hashing normal secara lokal tetapi worker tidak terlihat di pool / share berhenti terlalu lama',
      };
    }
  }

  // 3b. No local share for too long.
  if (input.lastLocalShareAgeSec == null || input.lastLocalShareAgeSec > settings.noShareWarnSec) {
    return {
      status: 'WASPADA',
      reason: `Tidak ada share selama lebih dari ${Math.round(settings.noShareWarnSec / 60)} menit`,
    };
  }

  // 3c. Hashrate below the configured minimum.
  if (input.hashrateHs < settings.minHashrateHs) {
    return {
      status: 'WASPADA',
      reason: `Hashrate ${input.hashrateHs} H/s di bawah ambang minimum ${settings.minHashrateHs} H/s`,
    };
  }

  // 3d. Available memory approaching the start threshold.
  if (input.memAvailableGib < settings.minMemStartGib + settings.memWarnMarginGib) {
    return {
      status: 'WASPADA',
      reason: `Memori tersedia ${fmtGib(input.memAvailableGib)} mendekati ambang start ${fmtGib(settings.minMemStartGib)}`,
    };
  }

  return { status: 'SEHAT', reason: 'Miner berjalan normal' };
}
