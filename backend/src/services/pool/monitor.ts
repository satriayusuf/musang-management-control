// Pool poller (Phase 5 rework, CONTRACT-5 B3; owner spec §7).
//
// Settings-driven: every cycle re-reads the pool_* settings from the DB.
// Unless provider = 'bntpool' the poller is fully idle — zero requests —
// and the Phase 1 env placeholder stays inactive exactly as before.
// One request per cycle per unique (provider, baseUrl, lookupParam) combo,
// shared by every agent on that address and split per registered worker
// name. Failures back off 60 -> 120 -> 300 -> 600s; HTTP 429 honors
// Retry-After (else >= 300s) with zero requests during the wait. A failed
// cycle NEVER overwrites the last successful snapshot (spec §6.1).

import type { PrismaClient } from '@prisma/client';
import { newId } from '../../lib/crypto';
import {
  assembleBridgeContext,
  applyPoolStatus,
  POOL_CONFIRM_GAP_SEC,
  SHARE_STALL_SEC,
} from '../pool-status';
import { getSettings, type Settings } from '../settings';
import { fetchAddressWorkers, workerResultFromFetch, type PoolWorkerResult } from './bntpool';
import { PlaceholderPoolProvider } from './placeholder';
import type { PoolProvider } from './types';

/** Select the pool provider from the environment. Phase 1: placeholder only. */
export function createPoolProvider(env: NodeJS.ProcessEnv = process.env): PoolProvider {
  const name = (env.POOL_PROVIDER ?? 'none').toLowerCase();
  if (name === 'none' || name === '' || name === 'placeholder') {
    return new PlaceholderPoolProvider();
  }
  // Unknown provider name: fall back to the placeholder rather than inventing
  // an undocumented API integration.
  return new PlaceholderPoolProvider();
}

export interface PoolMonitorDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}

interface ComboState {
  failures: number;
  nextAllowedAtMs: number;
}

const BASE_CYCLE_SEC = 60;
const BACKOFF_STEPS_SEC = [60, 120, 300, 600];

function backoffDelaySec(consecutiveFailures: number): number {
  const idx = Math.min(Math.max(consecutiveFailures, 1), BACKOFF_STEPS_SEC.length) - 1;
  return BACKOFF_STEPS_SEC[idx];
}

export interface PoolCycleSummary {
  /** True when a pool HTTP request actually went out this cycle. */
  fetched: boolean;
  error?: string;
}

/**
 * Address-wide pool totals from the latest SUCCESSFUL fetch (addendum:
 * dashboard "Total Hashrate Pool"). Deliberately NOT a sum over connected
 * agents: `hashrate` is the pool's own address-level total (falling back to
 * the sum of every worker the pool returned for the address), and
 * `workerCount` counts every worker on the address, enrolled or not.
 * Errors never overwrite the last success.
 */
export interface PoolTotals {
  hashrate: number;
  workerCount: number;
  fetchedAt: Date;
}

export class PoolMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private readonly comboStates = new Map<string, ComboState>();
  private totals: PoolTotals | null = null;
  private configuredFlag: boolean;
  private readonly log: (line: string) => void;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: PoolProvider,
    private readonly deps: PoolMonitorDeps = {},
  ) {
    this.configuredFlag = provider.isConfigured();
    this.log = deps.log ?? ((line: string) => console.warn(line));
  }

  /**
   * True when a pool integration is active: the legacy env provider, or —
   * after the first cycle has read the DB settings — provider 'bntpool'.
   */
  isConfigured(): boolean {
    return this.configuredFlag;
  }

  /** Latest successful address-wide pool totals; null before the first success. */
  getPoolTotals(): PoolTotals | null {
    return this.totals;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCycle().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Legacy Phase 1 entry point. The placeholder provider is never
   * configured, so this stays a no-op returning 0 — the Phase 5 poller
   * (runCycle) owns all real fetching now, and the per-agent snapshot
   * table no longer supports the old append-per-poll writes.
   */
  async pollOnce(): Promise<number> {
    if (!this.provider.isConfigured()) return 0;
    return 0;
  }

  /** One polling cycle. `now` is injectable for tests. */
  async runCycle(now: Date = new Date()): Promise<PoolCycleSummary> {
    const settings = await getSettings(this.prisma);
    if (settings.pool_provider !== 'bntpool') {
      this.configuredFlag = this.provider.isConfigured();
      return { fetched: false };
    }
    this.configuredFlag = true;

    const baseUrl = settings.pool_api_base_url.replace(/\/+$/, '');
    const lookupParam = settings.pool_lookup_param;
    const comboKey = `bntpool|${baseUrl}|${lookupParam}`;
    let combo = this.comboStates.get(comboKey);
    if (!combo) {
      combo = { failures: 0, nextAllowedAtMs: 0 };
      this.comboStates.set(comboKey, combo);
    }
    if (now.getTime() < combo.nextAllowedAtMs) {
      return { fetched: false }; // backoff / 429 wait: zero requests
    }

    const agents = await this.prisma.agent.findMany({
      where: { workerName: { not: null } },
      orderBy: { createdAt: 'asc' },
    });

    const fetchResult = await fetchAddressWorkers({
      baseUrl,
      lookupParam,
      fetchImpl: this.deps.fetchImpl,
      timeoutMs: this.deps.timeoutMs,
    });

    if (fetchResult.kind === 'error') {
      combo.failures += 1;
      let delaySec = backoffDelaySec(combo.failures);
      if (fetchResult.reason === 'http_429') {
        delaySec = fetchResult.retryAfterSec ?? Math.max(300, delaySec);
      }
      combo.nextAllowedAtMs = now.getTime() + delaySec * 1000;
      this.log(`[pool] ${now.toISOString()} provider=bntpool error=${fetchResult.reason}`);
      for (const agent of agents) {
        await this.recordAttemptError(agent.id, agent.workerName as string, lookupParam, fetchResult.reason, now);
      }
      // As the last success ages past POOL_SNAPSHOT_MAX_AGE_SEC the combined
      // status falls back to the bridge verdict; recompute so that happens
      // on the poller's cadence, not only on the next heartbeat.
      for (const agent of agents) {
        await applyPoolStatus(this.prisma, agent.id, { now, log: this.log });
      }
      return { fetched: true, error: fetchResult.reason };
    }

    combo.failures = 0;
    combo.nextAllowedAtMs = now.getTime() + BASE_CYCLE_SEC * 1000;
    // Address-wide totals: prefer the pool's own total; fall back to the
    // sum over EVERY worker the pool returned for the address.
    let summed = 0;
    for (const entry of fetchResult.workers.values()) summed += entry.hashrate ?? 0;
    this.totals = {
      hashrate: fetchResult.totalHashrate ?? summed,
      workerCount: fetchResult.workers.size,
      fetchedAt: now,
    };
    for (const agent of agents) {
      const result = workerResultFromFetch(fetchResult, agent.workerName as string);
      await this.recordSuccess(agent.id, agent.workerName as string, lookupParam, result, settings, now);
      await applyPoolStatus(this.prisma, agent.id, { now, log: this.log });
    }
    return { fetched: true };
  }

  /** Error cycle: mark the attempt only — success fields stay untouched. */
  private async recordAttemptError(
    agentId: string,
    workerName: string,
    lookupParam: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.poolSnapshot.upsert({
      where: { agentId },
      create: {
        id: newId('pls'),
        agentId,
        provider: 'bntpool',
        lookupParam,
        workerName,
        found: false,
        fetchOk: false,
        fetchError: reason,
        lastAttemptAt: now,
        fetchedAt: null,
      },
      update: {
        provider: 'bntpool',
        lookupParam,
        workerName,
        fetchOk: false,
        fetchError: reason,
        lastAttemptAt: now,
      },
    });
  }

  /** Successful fetch: refresh the snapshot + confirmation counters. */
  private async recordSuccess(
    agentId: string,
    workerName: string,
    lookupParam: string,
    result: PoolWorkerResult,
    settings: Settings,
    now: Date,
  ): Promise<void> {
    const existing = await this.prisma.poolSnapshot.findUnique({ where: { agentId } });

    // --- Escalation confirmation (spec §5.1/§5.2, CONTRACT-5 B3) ---
    let escalation: 'stall' | 'not_found' | null = null;
    if (result.kind === 'not_found') {
      escalation = 'not_found';
    } else if (result.kind === 'found' && result.lastShareAt) {
      const worker = await this.prisma.worker.findUnique({ where: { agentId } });
      const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
      let hashing = false;
      if (worker && agent) {
        const ctx = await assembleBridgeContext(this.prisma, agent, worker, settings, now);
        hashing = ctx.bridgeHashing;
      }
      const ageSec = Math.max(0, (now.getTime() - result.lastShareAt.getTime()) / 1000);
      if (hashing && ageSec >= SHARE_STALL_SEC) escalation = 'stall';
    }

    let confirmKind: string | null = null;
    let confirmCount = 0;
    let confirmLastAt: Date | null = null;
    if (escalation) {
      const prevKind = existing?.confirmKind ?? null;
      const prevCount = existing?.confirmCount ?? 0;
      const prevLastAt = existing?.confirmLastAt ?? null;
      if (prevKind === escalation && prevLastAt && now.getTime() - prevLastAt.getTime() >= POOL_CONFIRM_GAP_SEC * 1000) {
        confirmKind = escalation;
        confirmCount = prevCount + 1;
        confirmLastAt = now;
      } else if (prevKind === escalation && prevLastAt) {
        // Same condition, but the confirming polls are too close together
        // (< POOL_CONFIRM_GAP_SEC): not a new confirmation.
        confirmKind = prevKind;
        confirmCount = prevCount;
        confirmLastAt = prevLastAt;
      } else {
        confirmKind = escalation;
        confirmCount = 1;
        confirmLastAt = now;
      }
    }

    const snapshotFields =
      result.kind === 'found'
        ? {
            found: true,
            poolHashrate: result.hashrate,
            poolAccepted: result.accepted,
            poolRejected: result.rejected,
            poolLastShareAt: result.lastShareAt,
            lastKnownShareAt: result.lastShareAt ?? existing?.lastKnownShareAt ?? null,
          }
        : {
            // Successful fetch, worker absent: current fields clear, but
            // lastKnownShareAt is preserved (B1).
            found: false,
            poolHashrate: null,
            poolAccepted: null,
            poolRejected: null,
            poolLastShareAt: null,
            lastKnownShareAt: existing?.lastKnownShareAt ?? null,
          };

    await this.prisma.poolSnapshot.upsert({
      where: { agentId },
      create: {
        id: newId('pls'),
        agentId,
        provider: 'bntpool',
        lookupParam,
        workerName,
        ...snapshotFields,
        fetchedAt: now,
        lastAttemptAt: now,
        fetchOk: true,
        fetchError: null,
        confirmKind,
        confirmCount,
        confirmLastAt,
      },
      update: {
        provider: 'bntpool',
        lookupParam,
        workerName,
        ...snapshotFields,
        fetchedAt: now,
        lastAttemptAt: now,
        fetchOk: true,
        fetchError: null,
        confirmKind,
        confirmCount,
        confirmLastAt,
      },
    });
  }
}
