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
    expect(requiresVerification('cron.install')).toBe(false);
    expect(requiresVerification('cron.list')).toBe(false);
    expect(requiresVerification('cron.remove')).toBe(false);
    expect(requiresVerification('miner.hold')).toBe(false);
    expect(requiresVerification('miner.unhold')).toBe(false);
  });

  it('sensitive types require dashboard confirmation', () => {
    for (const t of ['miner.run', 'miner.restart', 'miner.reinstall', 'miner.hold', 'miner.unhold', 'cron.install', 'cron.remove']) {
      expect(SENSITIVE_COMMAND_TYPES.has(t)).toBe(true);
    }
    expect(SENSITIVE_COMMAND_TYPES.has('miner.status')).toBe(false);
    expect(SENSITIVE_COMMAND_TYPES.has('cron.list')).toBe(false);
  });

  it('allowlist contains the six miner types plus the three generic cron types (CONTRACT-7)', () => {
    expect([...COMMAND_TYPES].sort()).toEqual(
      [
        'miner.hold', 'miner.reinstall', 'miner.restart', 'miner.run', 'miner.status', 'miner.unhold',
        'cron.install', 'cron.list', 'cron.remove',
      ].sort(),
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
