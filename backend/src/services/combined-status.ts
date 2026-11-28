// Combined dashboard status (CONTRACT-7 §4) — pure, no I/O.
//
// Trust order: (1) runtime events, (2) bridge heartbeat, (3) pool data —
// pool data is NEVER an input here. WebSocket presence is never an input.
// The legacy worker status (services/status.ts) is unchanged and still
// drives alerts/automation; this status is the dashboard headline.

export const BRIDGE_SILENT_SEC = 300; // 5 min; bridge heartbeats every ~30s
export const RUNTIME_SILENT_SEC = 1800; // 30 min; one missed SNAPSHOT cycle

export type CombinedStatus = 'JALAN' | 'PULIH' | 'MATI' | 'TAK_TERJANGKAU';

export interface CombinedStatusInput {
  now: Date;
  /** Latest runtime TRANSITION type (VM_REPLACED | RECOVERY_OK | RECOVERY_FAILED), null when none. */
  lastTransitionType: string | null;
  /** The transition event's `reason` (RECOVERY_FAILED), when present. */
  transitionReason?: string | null;
  /** Server receive time of the latest runtime event of any kind. */
  lastRuntimeContactAt: Date | null;
  /** Receive time of the latest bridge heartbeat (null = never). */
  lastBridgeHeartbeatAt: Date | null;
  /** Miner service_state from the latest bridge heartbeat snapshot. */
  bridgeServiceState: string | null;
  /** Bridge-reported start block reason, e.g. LOW_MEMORY. */
  bridgeStartBlockedReason?: string | null;
}

export interface CombinedStatusResult {
  status: CombinedStatus;
  reason: string;
}

function ageSec(now: Date, at: Date | null): number | null {
  if (!at) return null;
  return Math.max(0, (now.getTime() - at.getTime()) / 1000);
}

export function computeCombinedStatus(input: CombinedStatusInput): CombinedStatusResult {
  const bridgeAge = ageSec(input.now, input.lastBridgeHeartbeatAt);
  const runtimeAge = ageSec(input.now, input.lastRuntimeContactAt);
  const bridgeFresh = bridgeAge !== null && bridgeAge <= BRIDGE_SILENT_SEC;
  const bridgeSilent = bridgeAge === null || bridgeAge > BRIDGE_SILENT_SEC;
  const runtimeSilent = runtimeAge === null || runtimeAge > RUNTIME_SILENT_SEC;

  // 1. Runtime says the VM was replaced and no outcome has arrived yet:
  //    recovering — even while the bridge is silent.
  if (input.lastTransitionType === 'VM_REPLACED') {
    return {
      status: 'PULIH',
      reason: 'VM diganti; pemulihan oleh runtime sedang berjalan',
    };
  }

  // 2. Runtime reported a failed recovery.
  if (input.lastTransitionType === 'RECOVERY_FAILED') {
    const detail = input.transitionReason ? `: ${input.transitionReason}` : '';
    return { status: 'MATI', reason: `Pemulihan oleh runtime gagal${detail}` };
  }

  // 3/4. Bridge heartbeat fresh: the bridge's own report decides.
  if (bridgeFresh) {
    if (input.bridgeServiceState === 'active') {
      return { status: 'JALAN', reason: 'Program berjalan; heartbeat bridge segar' };
    }
    if (input.bridgeServiceState) {
      const blocked = input.bridgeStartBlockedReason
        ? ` (diblokir: ${input.bridgeStartBlockedReason})`
        : '';
      return {
        status: 'MATI',
        reason: `Bridge melapor service tidak aktif (${input.bridgeServiceState})${blocked}`,
      };
    }
    return { status: 'JALAN', reason: 'Heartbeat bridge segar' };
  }

  // 5. Both sources silent past their thresholds: the runtime is the
  //    problem, not necessarily the VM.
  if (bridgeSilent && runtimeSilent) {
    return {
      status: 'TAK_TERJANGKAU',
      reason:
        'Tidak ada kabar dari runtime maupun bridge; kemungkinan runtime Muse yang bermasalah, bukan VM',
    };
  }

  // 6. Bridge silent but the runtime is still reporting (and no pending
  //    transition): unproven either way.
  return {
    status: 'TAK_TERJANGKAU',
    reason: 'Bridge diam tetapi runtime masih melapor; menunggu kabar berikutnya',
  };
}
