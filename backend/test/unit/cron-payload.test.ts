// Payload validation for the generic cron.* command types (CONTRACT-7).

import { describe, expect, it } from 'vitest';
import { isValidCronSchedule, validateCronPayload } from '../../src/services/cron-payload';

describe('isValidCronSchedule', () => {
  it('accepts standard 5-field schedules and rejects broken ones', () => {
    expect(isValidCronSchedule('*/10 * * * *')).toBe(true);
    expect(isValidCronSchedule('0 7 * * *')).toBe(true);
    expect(isValidCronSchedule('15,45 0-23/2 1 * 0')).toBe(true);
    expect(isValidCronSchedule('*/10 * * *')).toBe(false);
    expect(isValidCronSchedule('61 * * * *')).toBe(false);
    expect(isValidCronSchedule('* * * * MON')).toBe(false);
    expect(isValidCronSchedule('*/0 * * * *')).toBe(false);
    expect(isValidCronSchedule(42)).toBe(false);
  });
});

describe('validateCronPayload', () => {
  it('enforces the cron.install shape { name, schedule, command }', () => {
    expect(validateCronPayload('cron.install', { name: 'ok-1', schedule: '*/5 * * * *', command: '/bin/true' })).toBeNull();
    expect(validateCronPayload('cron.install', { name: 'ada spasi', schedule: '*/5 * * * *', command: '/bin/true' })).not.toBeNull();
    expect(validateCronPayload('cron.install', { name: 'ok', schedule: 'bukan cron', command: '/bin/true' })).not.toBeNull();
    expect(validateCronPayload('cron.install', { name: 'ok', schedule: '*/5 * * * *', command: 'dua\nbaris' })).not.toBeNull();
    expect(validateCronPayload('cron.install', { name: 'ok', schedule: '*/5 * * * *' })).not.toBeNull();
    expect(validateCronPayload('cron.install', undefined)).not.toBeNull();
  });

  it('rejects shell metacharacters in command (jobs run without a shell)', () => {
    for (const command of ['/bin/a; /bin/b', '/bin/a | /bin/b', '/bin/a && /bin/b', '/bin/echo `id`', '/bin/echo $(id)', '/bin/a > /tmp/x', '/bin/echo $HOME']) {
      expect(validateCronPayload('cron.install', { name: 'ok', schedule: '*/5 * * * *', command })).not.toBeNull();
    }
    expect(validateCronPayload('cron.install', { name: 'ok', schedule: '*/5 * * * *', command: '/home/user/scripts/laporan.sh --harian' })).toBeNull();
  });

  it('enforces the cron.remove shape { name } and leaves cron.list free', () => {
    expect(validateCronPayload('cron.remove', { name: 'ok-1' })).toBeNull();
    expect(validateCronPayload('cron.remove', {})).not.toBeNull();
    expect(validateCronPayload('cron.list', {})).toBeNull();
    expect(validateCronPayload('cron.list', undefined)).toBeNull();
  });
});
