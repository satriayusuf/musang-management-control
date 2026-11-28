import { describe, expect, it } from 'vitest';
import {
  COMMAND_TYPES,
  SENSITIVE_COMMAND_TYPES,
  isVerificationSatisfied,
  requiresVerification,
} from '../../src/services/commands';

describe('command lifecycle helpers', () => {
  it('state-changing miner commands require verification', () => {
    expect(requiresVerification('miner.run')).toBe(true);
    expect(requiresVerification('miner.restart')).toBe(true);
    expect(requiresVerification('miner.reinstall')).toBe(true);
  });

  it('non-state-changing commands finish on result without verification', () => {
    expect(requiresVerification('miner.status')).toBe(false);
    expect(requiresVerification('miner.hold')).toBe(false);
    expect(requiresVerification('miner.unhold')).toBe(false);
    // bridge.update verifies itself (hash compare on the bridge), so the
    // heartbeat-snapshot verification does not apply (CONTRACT-10).
    expect(requiresVerification('bridge.update')).toBe(false);
  });

  it('sensitive types require dashboard confirmation', () => {
    for (const t of ['miner.run', 'miner.restart', 'miner.reinstall', 'miner.hold', 'miner.unhold', 'bridge.update']) {
      expect(SENSITIVE_COMMAND_TYPES.has(t)).toBe(true);
    }
    expect(SENSITIVE_COMMAND_TYPES.has('miner.status')).toBe(false);
  });

  it('allowlist contains exactly the six miner types plus bridge.update', () => {
    expect([...COMMAND_TYPES].sort()).toEqual(
      ['bridge.update', 'miner.hold', 'miner.reinstall', 'miner.restart', 'miner.run', 'miner.status', 'miner.unhold'].sort(),
    );
  });

  it('verification is satisfied only by an active miner with a job', () => {
    expect(isVerificationSatisfied({ service_state: 'active', job_height: 804 })).toBe(true);
    expect(isVerificationSatisfied({ service_state: 'active', job_height: 0 })).toBe(false);
    expect(isVerificationSatisfied({ service_state: 'inactive', job_height: 804 })).toBe(false);
    expect(isVerificationSatisfied({ service_state: 'failed', job_height: 804 })).toBe(false);
    expect(isVerificationSatisfied(null)).toBe(false);
    expect(isVerificationSatisfied(undefined)).toBe(false);
    expect(isVerificationSatisfied({})).toBe(false);
  });
});
