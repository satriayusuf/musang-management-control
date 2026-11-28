// Broadcast questions (CONTRACT-8) — pure-helper unit tests.

import { describe, expect, it } from 'vitest';
import { QUESTION_TTL_SEC, isQuestionStale, summarize } from '../../src/services/questions';

describe('isQuestionStale', () => {
  const askedAt = new Date('2026-11-28T09:00:00Z');

  it('is fresh inside the TTL', () => {
    const now = new Date(askedAt.getTime() + (QUESTION_TTL_SEC - 1) * 1000);
    expect(isQuestionStale(askedAt, now)).toBe(false);
  });

  it('is fresh exactly at the TTL boundary', () => {
    const now = new Date(askedAt.getTime() + QUESTION_TTL_SEC * 1000);
    expect(isQuestionStale(askedAt, now)).toBe(false);
  });

  it('is stale past the TTL', () => {
    const now = new Date(askedAt.getTime() + (QUESTION_TTL_SEC + 1) * 1000);
    expect(isQuestionStale(askedAt, now)).toBe(true);
  });
});

describe('summarize', () => {
  it('counts statuses and treats unknown as queued', () => {
    const s = summarize([
      { status: 'answered' },
      { status: 'answered' },
      { status: 'queued' },
      { status: 'expired' },
    ]);
    expect(s).toEqual({ total: 4, answered: 2, queued: 1, expired: 1 });
  });

  it('handles an empty broadcast', () => {
    expect(summarize([])).toEqual({ total: 0, answered: 0, queued: 0, expired: 0 });
  });
});
