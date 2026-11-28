// Combined dashboard status (CONTRACT-7 §4) — pure-function tests over
// the spec's status table and thresholds.

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SILENT_SEC,
  RUNTIME_SILENT_SEC,
  computeCombinedStatus,
  type CombinedStatusInput,
} from '../../src/services/combined-status';

const NOW = new Date('2026-11-28T04:00:00.000Z');
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000);

function input(overrides: Partial<CombinedStatusInput> = {}): CombinedStatusInput {
  return {
    now: NOW,
    lastTransitionType: null,
    transitionReason: null,
    lastRuntimeContactAt: null,
    lastBridgeHeartbeatAt: null,
    bridgeServiceState: null,
    bridgeStartBlockedReason: null,
    ...overrides,
  };
}

describe('computeCombinedStatus (CONTRACT-7 §4)', () => {
  it('exposes the spec constants under their spec names', () => {
    expect(BRIDGE_SILENT_SEC).toBe(300);
    expect(RUNTIME_SILENT_SEC).toBe(1800);
  });

  it('VM_REPLACED without an outcome -> PULIH, even with a silent bridge', () => {
    const r = computeCombinedStatus(
      input({ lastTransitionType: 'VM_REPLACED', lastRuntimeContactAt: ago(60), lastBridgeHeartbeatAt: ago(3600) }),
    );
    expect(r.status).toBe('PULIH');
  });

  it('RECOVERY_FAILED -> MATI with the event reason in the status reason', () => {
    const r = computeCombinedStatus(
      input({
        lastTransitionType: 'RECOVERY_FAILED',
        transitionReason: 'memori tidak cukup',
        lastRuntimeContactAt: ago(30),
        lastBridgeHeartbeatAt: ago(30),
        bridgeServiceState: 'active',
      }),
    );
    expect(r.status).toBe('MATI');
    expect(r.reason).toContain('memori tidak cukup');
  });

  it('fresh bridge heartbeat + active service -> JALAN (after RECOVERY_OK)', () => {
    const r = computeCombinedStatus(
      input({
        lastTransitionType: 'RECOVERY_OK',
        lastRuntimeContactAt: ago(120),
        lastBridgeHeartbeatAt: ago(20),
        bridgeServiceState: 'active',
      }),
    );
    expect(r.status).toBe('JALAN');
  });

  it('fresh bridge heartbeat + inactive service -> MATI (bridge-reported)', () => {
    const r = computeCombinedStatus(
      input({ lastBridgeHeartbeatAt: ago(20), bridgeServiceState: 'inactive', bridgeStartBlockedReason: 'LOW_MEMORY' }),
    );
    expect(r.status).toBe('MATI');
    expect(r.reason).toContain('LOW_MEMORY');
  });

  it('both sources silent past thresholds -> TAK_TERJANGKAU, blaming the runtime (A14)', () => {
    const r = computeCombinedStatus(
      input({ lastRuntimeContactAt: ago(RUNTIME_SILENT_SEC + 1), lastBridgeHeartbeatAt: ago(BRIDGE_SILENT_SEC + 1) }),
    );
    expect(r.status).toBe('TAK_TERJANGKAU');
    expect(r.reason).toContain('runtime');
    expect(r.reason).toContain('bukan VM');
  });

  it('no contact ever from either source -> TAK_TERJANGKAU', () => {
    expect(computeCombinedStatus(input()).status).toBe('TAK_TERJANGKAU');
  });

  it('bridge silent but runtime still reporting snapshots -> TAK_TERJANGKAU (waiting), not MATI', () => {
    const r = computeCombinedStatus(
      input({ lastRuntimeContactAt: ago(600), lastBridgeHeartbeatAt: ago(3600), bridgeServiceState: 'active' }),
    );
    expect(r.status).toBe('TAK_TERJANGKAU');
    expect(r.reason).toContain('runtime masih melapor');
  });

  it('bridge heartbeat exactly at the silent threshold still counts as fresh', () => {
    const r = computeCombinedStatus(
      input({ lastBridgeHeartbeatAt: ago(BRIDGE_SILENT_SEC), bridgeServiceState: 'active' }),
    );
    expect(r.status).toBe('JALAN');
  });

  it('a later RECOVERY_OK supersedes VM_REPLACED (no longer PULIH)', () => {
    const r = computeCombinedStatus(
      input({
        lastTransitionType: 'RECOVERY_OK',
        lastRuntimeContactAt: ago(60),
        lastBridgeHeartbeatAt: ago(10),
        bridgeServiceState: 'active',
      }),
    );
    expect(r.status).toBe('JALAN');
  });
});
