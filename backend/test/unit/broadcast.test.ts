import { describe, expect, it } from 'vitest';
import type { Agent, Worker } from '@prisma/client';
import { evaluateBroadcastTarget } from '../../src/services/broadcast';

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_x',
    capabilities: ['miner.status', 'miner.run', 'miner.restart', 'miner.reinstall', 'miner.hold', 'miner.unhold'],
    revokedAt: null,
    ...overrides,
  } as Agent;
}

function fakeWorker(overrides: Partial<Worker> = {}): Worker {
  return { id: 'wrk_x', status: 'SEHAT', holdActive: false, ...overrides } as Worker;
}

describe('broadcast target eligibility (unit)', () => {
  it('eligible target returns null', () => {
    expect(evaluateBroadcastTarget(fakeAgent(), fakeWorker(), 'miner.run')).toBeNull();
    expect(evaluateBroadcastTarget(fakeAgent(), fakeWorker(), 'miner.status')).toBeNull();
  });

  it('missing agent / revoked agent / missing worker are skipped', () => {
    expect(evaluateBroadcastTarget(null, null, 'miner.run')).toContain('tidak ditemukan');
    expect(evaluateBroadcastTarget(fakeAgent({ revokedAt: new Date() }), fakeWorker(), 'miner.run')).toContain('dicabut');
    expect(evaluateBroadcastTarget(fakeAgent(), null, 'miner.run')).toContain('worker');
  });

  it('capability gate mirrors single create', () => {
    const agent = fakeAgent({ capabilities: ['miner.status'] });
    expect(evaluateBroadcastTarget(agent, fakeWorker(), 'miner.run')).toContain('kemampuan');
    expect(evaluateBroadcastTarget(agent, fakeWorker(), 'miner.status')).toBeNull();
  });

  it('miner.run on GAGAL_START is skipped with the single-create reason', () => {
    const reason = evaluateBroadcastTarget(fakeAgent(), fakeWorker({ status: 'GAGAL_START' }), 'miner.run');
    expect(reason).toContain('gagal start');
  });

  it('recovery commands skip TAK_TERJANGKAU and held workers, other types do not', () => {
    const unreachable = fakeWorker({ status: 'TAK_TERJANGKAU' });
    expect(evaluateBroadcastTarget(fakeAgent(), unreachable, 'miner.run')).toContain('tidak terjangkau');
    expect(evaluateBroadcastTarget(fakeAgent(), unreachable, 'miner.restart')).toContain('tidak terjangkau');
    expect(evaluateBroadcastTarget(fakeAgent(), unreachable, 'miner.status')).toBeNull();

    const held = fakeWorker({ holdActive: true });
    expect(evaluateBroadcastTarget(fakeAgent(), held, 'miner.restart')).toContain('ditahan');
    expect(evaluateBroadcastTarget(fakeAgent(), held, 'miner.status')).toBeNull();
  });

  it('hold on an already-held worker and unhold on a non-held worker are skipped', () => {
    expect(evaluateBroadcastTarget(fakeAgent(), fakeWorker({ holdActive: true }), 'miner.hold')).toContain('sudah aktif');
    expect(evaluateBroadcastTarget(fakeAgent(), fakeWorker({ holdActive: false }), 'miner.unhold')).toContain('tidak aktif');
    expect(evaluateBroadcastTarget(fakeAgent(), fakeWorker({ holdActive: true }), 'miner.unhold')).toBeNull();
    expect(evaluateBroadcastTarget(fakeAgent(), fakeWorker({ holdActive: false }), 'miner.hold')).toBeNull();
  });
});
