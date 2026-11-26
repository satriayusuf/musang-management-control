// Pure cron matcher tests (Phase 3, CONTRACT-3 §3).
// Dates are built with the LOCAL-time Date constructor on purpose: cron is
// evaluated in the server's local timezone.

import { describe, expect, it } from 'vitest';
import { computeNextRun, cronMatches, parseCron } from '../../src/services/cron';

const d = (y: number, mo: number, day: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, day, h, mi, s);

describe('parseCron + cronMatches', () => {
  it('wildcard matches everything', () => {
    const s = parseCron('* * * * *');
    expect(cronMatches(s, d(2026, 11, 26, 13, 37))).toBe(true);
    expect(cronMatches(s, d(2027, 1, 1, 0, 0))).toBe(true);
  });

  it('step on minutes: */15', () => {
    const s = parseCron('*/15 * * * *');
    expect(cronMatches(s, d(2026, 11, 26, 10, 0))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 26, 10, 15))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 26, 10, 30))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 26, 10, 45))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 26, 10, 7))).toBe(false);
  });

  it('weekday range: 0 9 * * 1-5', () => {
    const s = parseCron('0 9 * * 1-5');
    // 2026-11-23 is a Monday; 2026-11-28 is a Saturday.
    expect(cronMatches(s, d(2026, 11, 23, 9, 0))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 28, 9, 0))).toBe(false);
    expect(cronMatches(s, d(2026, 11, 23, 10, 0))).toBe(false);
  });

  it('lists: 0 0 1,15 * *', () => {
    const s = parseCron('0 0 1,15 * *');
    expect(cronMatches(s, d(2026, 11, 1, 0, 0))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 15, 0, 0))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 16, 0, 0))).toBe(false);
  });

  it('range with step: 0 9-17/2 * * *', () => {
    const s = parseCron('0 9-17/2 * * *');
    expect(cronMatches(s, d(2026, 11, 26, 9, 0))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 26, 11, 0))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 26, 17, 0))).toBe(true);
    expect(cronMatches(s, d(2026, 11, 26, 10, 0))).toBe(false);
    expect(cronMatches(s, d(2026, 11, 26, 18, 0))).toBe(false);
  });

  it('day-of-month OR day-of-week when both restricted (Vixie rule)', () => {
    const s = parseCron('0 0 13 * 5'); // the 13th, OR any Friday
    // 2026-11-13 is a Friday the 13th.
    expect(cronMatches(s, d(2026, 11, 13, 0, 0))).toBe(true);
    // 2026-12-13 is a Sunday the 13th -> matches via day-of-month.
    expect(cronMatches(s, d(2026, 12, 13, 0, 0))).toBe(true);
    // 2026-11-20 is a Friday, not the 13th -> matches via day-of-week.
    expect(cronMatches(s, d(2026, 11, 20, 0, 0))).toBe(true);
    // 2026-11-21 is a Saturday, not the 13th -> no match.
    expect(cronMatches(s, d(2026, 11, 21, 0, 0))).toBe(false);
  });

  it('day-of-week 7 means Sunday, same as 0', () => {
    // 2026-11-29 is a Sunday.
    expect(cronMatches(parseCron('0 0 * * 7'), d(2026, 11, 29, 0, 0))).toBe(true);
    expect(cronMatches(parseCron('0 0 * * 0'), d(2026, 11, 29, 0, 0))).toBe(true);
    expect(cronMatches(parseCron('0 0 * * 7'), d(2026, 11, 30, 0, 0))).toBe(false);
  });

  it('rejects invalid expressions', () => {
    for (const bad of ['', 'bukan cron', '* * * *', '* * * * * *', '61 * * * *', '0 0 32 * *', '0 24 * * *', '*/0 * * * *', '5-1 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });
});

describe('computeNextRun', () => {
  it('later the same day', () => {
    const next = computeNextRun('30 10 * * *', d(2026, 11, 26, 10, 0, 30));
    expect(next).toEqual(d(2026, 11, 26, 10, 30, 0));
  });

  it('rolls to the next day when the time has passed', () => {
    const next = computeNextRun('0 9 * * *', d(2026, 11, 26, 10, 0, 0));
    expect(next).toEqual(d(2026, 11, 27, 9, 0, 0));
  });

  it('is strictly after `from` at minute resolution', () => {
    const next = computeNextRun('* * * * *', d(2026, 11, 26, 10, 0, 0));
    expect(next).toEqual(d(2026, 11, 26, 10, 1, 0));
  });

  it('finds Feb 29 across a non-leap year', () => {
    const next = computeNextRun('0 0 29 2 *', d(2027, 3, 1, 0, 0, 0));
    expect(next).toEqual(d(2028, 2, 29, 0, 0, 0));
  });

  it('throws on an invalid expression', () => {
    expect(() => computeNextRun('99 * * * *', new Date())).toThrow();
  });
});
