import { describe, expect, it } from 'vitest';
import {
  longestGapSec,
  median,
  sessionDurationDistribution,
  sharesPerSession,
} from '../../src/services/analytics-helpers';

describe('analytics helpers (unit)', () => {
  it('median handles empty, odd and even inputs', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('session duration distribution reports min/median/max minutes or nulls', () => {
    expect(sessionDurationDistribution([])).toEqual({
      min_minutes: null,
      median_minutes: null,
      max_minutes: null,
    });
    expect(sessionDurationDistribution([1800, 3600, 900])).toEqual({
      min_minutes: 15,
      median_minutes: 30,
      max_minutes: 60,
    });
  });

  it('shares per session averages the per-session maxima of the cumulative counter', () => {
    const points = [
      { session_no: 1, shares_local: 3 },
      { session_no: 1, shares_local: 10 },
      { session_no: 1, shares_local: 7 }, // counter noise: max wins
      { session_no: 2, shares_local: 20 },
      { session_no: 2, shares_local: 20 },
    ];
    expect(sharesPerSession(points)).toBe(15);
  });

  it('shares per session is null when snapshots carry no session/share data', () => {
    expect(sharesPerSession([])).toBeNull();
    expect(sharesPerSession([{ session_no: null, shares_local: null }])).toBeNull();
    expect(sharesPerSession([{ session_no: 1, shares_local: null }])).toBeNull();
  });

  it('longest share gap uses distinct sorted timestamps', () => {
    expect(longestGapSec([])).toBeNull();
    expect(longestGapSec([1000])).toBeNull();
    const t0 = 1_700_000_000_000;
    expect(longestGapSec([t0 + 400_000, t0, t0 + 100_000, t0 + 100_000])).toBe(300);
  });
});
