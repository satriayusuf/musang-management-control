// Pure analytics helpers (Phase 2, CONTRACT-2 §3) — kept separate from the
// route so they can be unit-tested without a database.

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface DurationDistribution {
  min_minutes: number | null;
  median_minutes: number | null;
  max_minutes: number | null;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Min/median/max of session durations, in minutes (nulls when no data). */
export function sessionDurationDistribution(durationsSec: number[]): DurationDistribution {
  if (durationsSec.length === 0) return { min_minutes: null, median_minutes: null, max_minutes: null };
  const minutes = durationsSec.map((s) => s / 60);
  return {
    min_minutes: round1(Math.min(...minutes)),
    median_minutes: round1(median(minutes) ?? 0),
    max_minutes: round1(Math.max(...minutes)),
  };
}

export interface ShareSnapshotPoint {
  session_no?: number | null;
  shares_local?: number | null;
}

/**
 * Average shares per miner session: for each distinct snapshot session_no,
 * the session's share total is the maximum cumulative shares_local seen;
 * the result is the mean across sessions. Null when no snapshot carries
 * both a session number and a share counter (e.g. real-mode bridges).
 */
export function sharesPerSession(points: ShareSnapshotPoint[]): number | null {
  const perSession = new Map<number, number>();
  for (const p of points) {
    if (typeof p.session_no !== 'number' || typeof p.shares_local !== 'number') continue;
    const current = perSession.get(p.session_no);
    if (current === undefined || p.shares_local > current) perSession.set(p.session_no, p.shares_local);
  }
  if (perSession.size === 0) return null;
  const totals = [...perSession.values()];
  return Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100;
}

/** Longest gap (seconds) between successive distinct timestamps; null < 2. */
export function longestGapSec(timesMs: number[]): number | null {
  const unique = [...new Set(timesMs)].sort((a, b) => a - b);
  if (unique.length < 2) return null;
  let longest = 0;
  for (let i = 1; i < unique.length; i += 1) {
    longest = Math.max(longest, (unique[i] - unique[i - 1]) / 1000);
  }
  return longest;
}
