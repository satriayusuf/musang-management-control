// Pure automation target-eligibility tests (Phase 3, CONTRACT-3 §2).

import { describe, expect, it } from 'vitest';
import { evaluateAutomationTarget } from '../../src/services/automation';

const agent = (over: Record<string, unknown> = {}) =>
  ({
    id: 'agt_1',
    revokedAt: null,
    capabilities: ['miner.status', 'miner.run'],
    ...over,
  }) as never;

const worker = (over: Record<string, unknown> = {}) =>
  ({
    id: 'wrk_1',
    status: 'MATI',
    ...over,
  }) as never;

describe('evaluateAutomationTarget', () => {
  it('allows an eligible target', () => {
    expect(
      evaluateAutomationTarget({ agent: agent(), worker: worker(), type: 'miner.status', hasActiveDuplicate: false }),
    ).toBeNull();
  });

  it('skips a missing agent / worker', () => {
    expect(evaluateAutomationTarget({ agent: null, worker: worker(), type: 'miner.status', hasActiveDuplicate: false })).toMatch(/tidak ditemukan/);
    expect(evaluateAutomationTarget({ agent: agent(), worker: null, type: 'miner.status', hasActiveDuplicate: false })).toMatch(/belum memiliki worker/);
  });

  it('skips a revoked agent', () => {
    expect(
      evaluateAutomationTarget({ agent: agent({ revokedAt: new Date() }), worker: worker(), type: 'miner.status', hasActiveDuplicate: false }),
    ).toMatch(/dicabut/);
  });

  it('skips when the capability is missing', () => {
    expect(
      evaluateAutomationTarget({ agent: agent(), worker: worker(), type: 'miner.restart', hasActiveDuplicate: false }),
    ).toMatch(/kemampuan/);
  });

  it('skips miner.run for a GAGAL_START worker (Run Again refusal)', () => {
    expect(
      evaluateAutomationTarget({ agent: agent(), worker: worker({ status: 'GAGAL_START' }), type: 'miner.run', hasActiveDuplicate: false }),
    ).toMatch(/gagal start/);
  });

  it('skips when an active duplicate command exists', () => {
    expect(
      evaluateAutomationTarget({ agent: agent(), worker: worker(), type: 'miner.status', hasActiveDuplicate: true }),
    ).toMatch(/perintah aktif/);
  });
});
