/** Shared types for the Muse Bridge (see ../CONTRACT.md). */

export type BridgeMode = "demo" | "real";

export type MinerServiceState = "active" | "inactive" | "failed" | "unit-missing";

/** Miner snapshot sent with every heartbeat (contract: API contract / heartbeat). */
export interface MinerSnapshot {
  service_state: MinerServiceState;
  pid: number | null;
  session_no: number | null;
  /** H/s. Null when unknown (real mode cannot read the miner's own stats). */
  hashrate_hs: number | null;
  shares_local: number | null;
  /** Accepted/rejected shares as reported by the miner process itself (stats source, CONTRACT-6). */
  accepted_shares?: number | null;
  rejected_shares?: number | null;
  last_share_at: string | null;
  job_height: number | null;
  difficulty: number | null;
  /** Set when the miner is not running because memory is below the start threshold. */
  start_blocked_reason?: string;
  /** True while the local hold flag is set (auto-recovery held from the dashboard). */
  hold_active?: boolean;
}

export interface HostSnapshot {
  boot_id: string;
  mem_available_gib: number;
}

/** Persistent agent identity (identity.json). The raw token lives in its own file. */
export interface Identity {
  agent_id: string;
  name: string;
  worker_name?: string;
}

/** Server-provided configuration, learned from register / heartbeat responses. */
export interface ServerConfig {
  heartbeat_interval_sec: number;
  min_mem_start_gib: number;
  unreachable_missed_beats?: number;
}

export interface RegisterResponse {
  agent_id: string;
  session_id: string;
  session_no?: number;
  /** Raw agent token — returned only on first (pairing) registration, as `agent_token`. */
  agent_token?: string;
  /** Legacy alias some servers use for the same value. */
  token?: string;
  config?: Partial<ServerConfig>;
}

export interface HeartbeatResponse {
  ack: boolean;
  queued_commands?: number;
  config?: Partial<ServerConfig>;
  min_mem_start_gib?: number;
}

export interface ClaimedCommand {
  id: string;
  type: string;
  payload?: Record<string, unknown> | null;
  created_at?: string;
  expires_at?: string;
}

export interface CommandResult {
  status: "succeeded" | "failed";
  output?: string;
  exit_code?: number;
  error_reason?: string;
}

/** Outcome of a miner control operation inside a MinerProvider. */
export interface ExecOutcome {
  ok: boolean;
  message: string;
  exit_code?: number;
  /** Structured failure reason, e.g. "NOT_CONFIGURED". */
  error_reason?: string;
}

/**
 * Abstraction over the local miner (simulated in demo mode, systemctl in real
 * mode) so the command executor and heartbeat loop stay mode-agnostic.
 */
export interface MinerProvider {
  snapshot(): Promise<MinerSnapshot>;
  memAvailableGib(): Promise<number>;
  run(): Promise<ExecOutcome>;
  restart(): Promise<ExecOutcome>;
  reinstall(): Promise<ExecOutcome>;
  /** Advance simulated time (demo mode only; no-op in real mode). */
  tick?(): void;
}
