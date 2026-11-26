import { describe, expect, it } from 'vitest';
import { alertDedupeKey } from '../../src/services/alerts';

describe('alert dedupe keys (unit)', () => {
  it('follow the <condition>:<entity>:<occurrence start> format', () => {
    const at = new Date('2026-11-26T10:00:00.000Z');
    expect(alertDedupeKey('WORKER_MATI', 'wrk_123', at)).toBe('WORKER_MATI:wrk_123:2026-11-26T10:00:00.000Z');
  });

  it('a recurrence after clearing (new occurrence start) yields a new key', () => {
    const first = alertDedupeKey('WORKER_MATI', 'wrk_123', new Date('2026-11-26T10:00:00.000Z'));
    const second = alertDedupeKey('WORKER_MATI', 'wrk_123', new Date('2026-11-26T12:30:00.000Z'));
    expect(first).not.toBe(second);
  });

  it('different conditions or entities never collide', () => {
    const at = new Date('2026-11-26T10:00:00.000Z');
    expect(alertDedupeKey('WORKER_MATI', 'wrk_1', at)).not.toBe(alertDedupeKey('WORKER_GAGAL_START', 'wrk_1', at));
    expect(alertDedupeKey('WORKER_MATI', 'wrk_1', at)).not.toBe(alertDedupeKey('WORKER_MATI', 'wrk_2', at));
  });
});
