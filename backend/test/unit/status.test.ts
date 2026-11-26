import { describe, expect, it } from 'vitest';
import { computeWorkerStatus, type WorkerStatusSettings } from '../../src/services/status';

const settings: WorkerStatusSettings = {
  minMemStartGib: 5,
  minHashrateHs: 0.5,
  memWarnMarginGib: 1,
  noShareWarnSec: 1800,
  poolStallSec: 7200,
};

const now = new Date('2026-11-26T10:00:00Z');

function base(overrides: Record<string, unknown> = {}) {
  return {
    agentOnline: true,
    serviceState: 'active',
    startBlockedReason: null,
    hashrateHs: 1.8,
    memAvailableGib: 6.8,
    lastPoolShareAt: now,
    lastLocalShareAgeSec: 60,
    poolPresent: true,
    now,
    ...overrides,
  };
}

describe('computeWorkerStatus', () => {
  it('TAK TERJANGKAU when the agent is offline, regardless of miner state', () => {
    const r = computeWorkerStatus(base({ agentOnline: false, serviceState: 'active' }), settings, false);
    expect(r.status).toBe('TAK_TERJANGKAU');
  });

  it('SEHAT when active, hashing, sharing, memory comfortable, pool not configured', () => {
    const r = computeWorkerStatus(base({ poolPresent: null, lastPoolShareAt: null }), settings, false);
    expect(r.status).toBe('SEHAT');
  });

  it('SEHAT at exact boundaries (share age == threshold, hashrate == min, mem == min+margin)', () => {
    const r = computeWorkerStatus(
      base({ lastLocalShareAgeSec: 1800, hashrateHs: 0.5, memAvailableGib: 6 }),
      settings,
      false,
    );
    expect(r.status).toBe('SEHAT');
  });

  it('MATI when service inactive and memory is sufficient', () => {
    expect(computeWorkerStatus(base({ serviceState: 'inactive' }), settings, false).status).toBe('MATI');
    expect(computeWorkerStatus(base({ serviceState: 'failed' }), settings, false).status).toBe('MATI');
    expect(computeWorkerStatus(base({ serviceState: 'unit-missing' }), settings, false).status).toBe('MATI');
  });

  it('GAGAL_START when service is down and memory is below the start threshold', () => {
    const r = computeWorkerStatus(base({ serviceState: 'inactive', memAvailableGib: 2.4 }), settings, false);
    expect(r.status).toBe('GAGAL_START');
    expect(r.reason).toContain('2.4 GiB');
    expect(r.reason).toContain('5 GiB');
  });

  it('GAGAL_START when the bridge reports LOW_MEMORY even if mem reads high', () => {
    const r = computeWorkerStatus(
      base({ serviceState: 'inactive', memAvailableGib: 6.8, startBlockedReason: 'LOW_MEMORY' }),
      settings,
      false,
    );
    expect(r.status).toBe('GAGAL_START');
  });

  it('memory boundary: mem exactly at threshold with service down is MATI, just below is GAGAL_START', () => {
    expect(computeWorkerStatus(base({ serviceState: 'inactive', memAvailableGib: 5 }), settings, false).status).toBe('MATI');
    expect(computeWorkerStatus(base({ serviceState: 'inactive', memAvailableGib: 4.99 }), settings, false).status).toBe('GAGAL_START');
  });

  it('POOL_STALL when hashing locally but absent from pool beyond the stall threshold', () => {
    const r = computeWorkerStatus(
      base({ poolPresent: false, lastPoolShareAt: new Date(now.getTime() - 3 * 3600_000) }),
      settings,
      true,
    );
    expect(r.status).toBe('POOL_STALL');
  });

  it('POOL_STALL when the worker was never seen in the pool at all', () => {
    const r = computeWorkerStatus(base({ poolPresent: false, lastPoolShareAt: null }), settings, true);
    expect(r.status).toBe('POOL_STALL');
  });

  it('never POOL_STALL when pool is not configured', () => {
    const r = computeWorkerStatus(base({ poolPresent: false, lastPoolShareAt: null }), settings, false);
    expect(r.status).toBe('SEHAT');
  });

  it('not POOL_STALL when local hashrate is also dead (falls through to WASPADA)', () => {
    const r = computeWorkerStatus(
      base({ poolPresent: false, lastPoolShareAt: new Date(now.getTime() - 3 * 3600_000), hashrateHs: 0 }),
      settings,
      true,
    );
    expect(r.status).toBe('WASPADA');
  });

  it('WASPADA when no local share for longer than the no-share threshold', () => {
    expect(computeWorkerStatus(base({ lastLocalShareAgeSec: 1801 }), settings, false).status).toBe('WASPADA');
  });

  it('WASPADA when there has never been a local share', () => {
    expect(computeWorkerStatus(base({ lastLocalShareAgeSec: null }), settings, false).status).toBe('WASPADA');
  });

  it('WASPADA when hashrate is below the minimum', () => {
    expect(computeWorkerStatus(base({ hashrateHs: 0.3 }), settings, false).status).toBe('WASPADA');
  });

  it('WASPADA when memory approaches the start threshold', () => {
    expect(computeWorkerStatus(base({ memAvailableGib: 5.5 }), settings, false).status).toBe('WASPADA');
  });
});
