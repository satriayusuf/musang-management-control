// Pool provider abstraction (CONTRACT.md P§7).
// The real bntpool.com HTTP API format is undocumented, so Phase 1 ships only
// the interface plus a disabled-by-default placeholder. Never fabricate pool data.

export interface PoolWorkerData {
  worker_name: string;
  present: boolean;
  accepted: number;
  rejected: number;
  last_share_at: Date | null;
}

export interface PoolProvider {
  readonly name: string;
  /** False means "not configured" — the monitor stays idle and worker status
   *  is computed from bridge data alone. */
  isConfigured(): boolean;
  fetchWorkers(): Promise<PoolWorkerData[]>;
}
