// Runtime event payload validation (CONTRACT-7 §3) — pure tests.
// Every violation must be a 400; ingest never runs for invalid payloads.

import { describe, expect, it } from 'vitest';
import { validateRuntimeEvent } from '../../src/services/runtime';

const BASE = {
  occurred_at: '2026-11-28T02:12:12+07:00',
  boot_time: '2026-11-28T02:12:12+07:00',
};

function expect400(body: Record<string, unknown>): void {
  try {
    validateRuntimeEvent(body);
    throw new Error('expected validation to throw');
  } catch (err) {
    expect((err as { statusCode?: number }).statusCode).toBe(400);
  }
}

describe('validateRuntimeEvent (CONTRACT-7 §3)', () => {
  it('accepts a full VM_REPLACED payload', () => {
    const v = validateRuntimeEvent({ type: 'VM_REPLACED', ...BASE });
    expect(v.type).toBe('VM_REPLACED');
    expect(v.occurredAt.toISOString()).toBe('2026-11-27T19:12:12.000Z');
    expect(v.bootTime?.toISOString()).toBe('2026-11-27T19:12:12.000Z');
  });

  it('accepts RECOVERY_OK with pid, primer_gib and mem_available_gib', () => {
    const v = validateRuntimeEvent({
      type: 'RECOVERY_OK',
      ...BASE,
      pid: 2028,
      primer_gib: 6.66,
      mem_available_gib: 1.27,
    });
    expect(v.pid).toBe(2028);
    expect(v.primerGib).toBe(6.66);
  });

  it('accepts RECOVERY_FAILED with reason and mem_available_gib', () => {
    const v = validateRuntimeEvent({
      type: 'RECOVERY_FAILED',
      ...BASE,
      reason: 'memori tidak cukup',
      mem_available_gib: 0.4,
    });
    expect(v.reason).toBe('memori tidak cukup');
  });

  it('accepts SNAPSHOT with hashrate_local + shares_local and no boot_time', () => {
    const v = validateRuntimeEvent({
      type: 'SNAPSHOT',
      occurred_at: BASE.occurred_at,
      hashrate_local: 1.91,
      shares_local: 3,
      pool_accepted: 185,
      pool_last_share_at: '2026-11-28T02:21:19+07:00',
    });
    expect(v.hashrateLocal).toBe(1.91);
    expect(v.sharesLocal).toBe(3);
    expect(v.poolAccepted).toBe(185);
    expect(v.poolLastShareAt?.toISOString()).toBe('2026-11-27T19:21:19.000Z');
  });

  it('rejects an unknown type (A11)', () => {
    expect400({ type: 'SOMETHING_ELSE', ...BASE });
  });

  it('rejects a missing occurred_at (A11)', () => {
    expect400({ type: 'VM_REPLACED', boot_time: BASE.boot_time });
  });

  it('rejects an unparseable occurred_at', () => {
    expect400({ type: 'VM_REPLACED', occurred_at: 'bukan-waktu', boot_time: BASE.boot_time });
  });

  it('rejects VM_REPLACED without boot_time', () => {
    expect400({ type: 'VM_REPLACED', occurred_at: BASE.occurred_at });
  });

  it('rejects RECOVERY_OK without pid / primer_gib / mem_available_gib', () => {
    expect400({ type: 'RECOVERY_OK', ...BASE, primer_gib: 6.66, mem_available_gib: 1.27 });
    expect400({ type: 'RECOVERY_OK', ...BASE, pid: 2028, mem_available_gib: 1.27 });
    expect400({ type: 'RECOVERY_OK', ...BASE, pid: 2028, primer_gib: 6.66 });
  });

  it('rejects RECOVERY_FAILED without a reason', () => {
    expect400({ type: 'RECOVERY_FAILED', ...BASE, mem_available_gib: 0.4 });
    expect400({ type: 'RECOVERY_FAILED', ...BASE, reason: '  ', mem_available_gib: 0.4 });
  });

  it('rejects SNAPSHOT without hashrate_local or shares_local', () => {
    expect400({ type: 'SNAPSHOT', occurred_at: BASE.occurred_at, shares_local: 1 });
    expect400({ type: 'SNAPSHOT', occurred_at: BASE.occurred_at, hashrate_local: 1.9 });
  });

  it('tolerates null optional fields and ignores unknown extras', () => {
    const v = validateRuntimeEvent({
      type: 'SNAPSHOT',
      occurred_at: BASE.occurred_at,
      hashrate_local: 1.5,
      shares_local: 2,
      pool_accepted: null,
      pool_last_share_at: null,
      something_extra: 'diabaikan',
    });
    expect(v.poolAccepted).toBeNull();
    expect(v.poolLastShareAt).toBeNull();
  });
});
