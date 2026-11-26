// Combined bridge+pool status — decision-table unit tests (Phase 5,
// CONTRACT-5 B4/B7; owner spec §5.2/§6). computeCombinedStatus is pure:
// every row of the spec table is exercised with injected time.

import { describe, expect, it } from 'vitest';
import {
  computeCombinedStatus,
  humanAgeId,
  type CombinedStatusInput,
  type PoolSnapshotView,
} from '../../src/services/pool-status';
import type { WorkerStatus } from '../../src/services/status';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000);

function snapshot(over: Partial<PoolSnapshotView> = {}): PoolSnapshotView {
  return {
    found: true,
    fetchOk: true,
    fetchedAt: ago(30),
    poolLastShareAt: ago(120),
    lastKnownShareAt: ago(120),
    confirmKind: null,
    confirmCount: 0,
    ...over,
  };
}

function input(over: Partial<CombinedStatusInput> = {}): CombinedStatusInput {
  return {
    bridgeStatus: 'SEHAT',
    bridgeReason: 'Miner berjalan normal',
    bridgeHashing: true,
    bridgeShareBased: false,
    agentOnline: true,
    snapshot: snapshot(),
    now: NOW,
    ...over,
  };
}

const asBridge = (status: WorkerStatus, reason = 'alasan bridge') => ({
  bridgeStatus: status,
  bridgeReason: reason,
});

describe('computeCombinedStatus — pool unknown (spec §6.1)', () => {
  it('no snapshot -> bridge verdict, poolState unknown', () => {
    const r = computeCombinedStatus(input({ snapshot: null, ...asBridge('WASPADA') }));
    expect(r.status).toBe('WASPADA');
    expect(r.reason).toBe('alasan bridge');
    expect(r.poolState).toBe('unknown');
  });

  it('snapshot older than POOL_SNAPSHOT_MAX_AGE_SEC -> unknown, bridge verdict', () => {
    const r = computeCombinedStatus(
      input({ snapshot: snapshot({ fetchedAt: ago(901), poolLastShareAt: ago(60) }), ...asBridge('SEHAT') }),
    );
    expect(r.poolState).toBe('unknown');
    expect(r.status).toBe('SEHAT');
  });

  it('failed fetch with a still-fresh success snapshot -> snapshot still used (B4 AND rule)', () => {
    const r = computeCombinedStatus(
      input({
        snapshot: snapshot({ fetchOk: false, fetchedAt: ago(120), poolLastShareAt: ago(60) }),
        ...asBridge('WASPADA'),
        bridgeShareBased: true,
      }),
    );
    expect(r.poolState).toBe('ok');
    expect(r.status).toBe('SEHAT');
  });
});

describe('computeCombinedStatus — fresh share band (<= 30 min)', () => {
  it('rebuts a share-based WASPADA -> SEHAT', () => {
    const r = computeCombinedStatus(input({ ...asBridge('WASPADA'), bridgeShareBased: true }));
    expect(r.status).toBe('SEHAT');
    expect(r.poolState).toBe('ok');
  });

  it('rebuts TAK_TERJANGKAU for an offline agent -> miner SEHAT (A12 separation)', () => {
    const r = computeCombinedStatus(
      input({ ...asBridge('TAK_TERJANGKAU'), agentOnline: false, bridgeHashing: false }),
    );
    expect(r.status).toBe('SEHAT');
  });

  it('never rebuts a service-dead verdict (MATI / GAGAL_START)', () => {
    expect(computeCombinedStatus(input({ ...asBridge('MATI') })).status).toBe('MATI');
    expect(computeCombinedStatus(input({ ...asBridge('GAGAL_START') })).status).toBe('GAGAL_START');
  });

  it('does not rebut a non-share WASPADA (hashrate/memory warnings stand)', () => {
    const r = computeCombinedStatus(input({ ...asBridge('WASPADA', 'Hashrate rendah'), bridgeShareBased: false }));
    expect(r.status).toBe('WASPADA');
    expect(r.reason).toBe('Hashrate rendah');
  });

  it('future share time clamps age to 0 and flags the skew (A8)', () => {
    const r = computeCombinedStatus(
      input({
        snapshot: snapshot({ poolLastShareAt: new Date(NOW.getTime() + 600_000) }),
        ...asBridge('WASPADA'),
        bridgeShareBased: true,
      }),
    );
    expect(r.status).toBe('SEHAT');
    expect(r.shareInFuture).toBe(true);
  });
});

describe('computeCombinedStatus — mid band (30 min – 2.5 h)', () => {
  it('hashing -> WASPADA with the exact spec text', () => {
    const r = computeCombinedStatus(input({ snapshot: snapshot({ poolLastShareAt: ago(45 * 60) }) }));
    expect(r.status).toBe('WASPADA');
    expect(r.reason).toBe('Tidak ada share selama 45 menit — miner masih hashing; share bersifat acak');
  });

  it('not hashing -> bridge verdict (pool is not blamed)', () => {
    const r = computeCombinedStatus(
      input({ snapshot: snapshot({ poolLastShareAt: ago(45 * 60) }), bridgeHashing: false, ...asBridge('MATI') }),
    );
    expect(r.status).toBe('MATI');
  });
});

describe('computeCombinedStatus — stall band (>= 2.5 h)', () => {
  const stallSnap = (confirmCount: number) =>
    snapshot({ poolLastShareAt: ago(3 * 3600), confirmKind: 'stall', confirmCount });

  it('one confirming poll is not enough: stays WASPADA (A6)', () => {
    const r = computeCombinedStatus(input({ snapshot: stallSnap(1) }));
    expect(r.status).toBe('WASPADA');
  });

  it('two confirming polls -> POOL_STALL with the exact spec text (A6)', () => {
    const r = computeCombinedStatus(input({ snapshot: stallSnap(2) }));
    expect(r.status).toBe('POOL_STALL');
    expect(r.reason).toBe('Tidak ada share ≥2,5 jam padahal miner hashing — kemungkinan stall di sisi pool');
  });

  it('not hashing -> bridge verdict even when confirmed', () => {
    const r = computeCombinedStatus(input({ snapshot: stallSnap(2), bridgeHashing: false, ...asBridge('MATI') }));
    expect(r.status).toBe('MATI');
  });
});

describe('computeCombinedStatus — not_found', () => {
  const nfSnap = (confirmCount: number, over: Partial<PoolSnapshotView> = {}) =>
    snapshot({ found: false, poolLastShareAt: null, confirmKind: 'not_found', confirmCount, ...over });

  it('a single not_found fetch changes nothing (A7)', () => {
    const r = computeCombinedStatus(input({ snapshot: nfSnap(1) }));
    expect(r.status).toBe('SEHAT');
    expect(r.reason).toBe('Miner berjalan normal');
  });

  it('confirmed not_found + online + hashing -> WASPADA "Worker tidak terlihat di pool" (A7)', () => {
    const r = computeCombinedStatus(input({ snapshot: nfSnap(2, { lastKnownShareAt: ago(600) }) }));
    expect(r.status).toBe('WASPADA');
    expect(r.reason).toBe('Worker tidak terlihat di pool');
  });

  it('confirmed not_found + last known share >= 2.5 h + hashing -> POOL_STALL', () => {
    const r = computeCombinedStatus(input({ snapshot: nfSnap(2, { lastKnownShareAt: ago(3 * 3600) }) }));
    expect(r.status).toBe('POOL_STALL');
    expect(r.reason).toBe('Tidak ada share ≥2,5 jam padahal miner hashing — kemungkinan stall di sisi pool');
  });

  it('confirmed not_found while agent offline -> bridge verdict', () => {
    const r = computeCombinedStatus(
      input({ snapshot: nfSnap(2, { lastKnownShareAt: ago(600) }), agentOnline: false, ...asBridge('TAK_TERJANGKAU') }),
    );
    expect(r.status).toBe('TAK_TERJANGKAU');
  });
});

describe('computeCombinedStatus — found but share time unknown', () => {
  it('bridge verdict stands (not an error, not a stall)', () => {
    const r = computeCombinedStatus(
      input({ snapshot: snapshot({ poolLastShareAt: null }), ...asBridge('WASPADA'), bridgeShareBased: true }),
    );
    expect(r.status).toBe('WASPADA');
    expect(r.poolState).toBe('ok');
  });
});

describe('humanAgeId', () => {
  it('formats minutes and hours in Indonesian', () => {
    expect(humanAgeId(45 * 60)).toBe('45 menit');
    expect(humanAgeId(2 * 3600)).toBe('2 jam');
    expect(humanAgeId(2 * 3600 + 5 * 60)).toBe('2 jam 5 menit');
    expect(humanAgeId(90 * 60)).toBe('1 jam 30 menit');
  });
});
