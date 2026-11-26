// BNTPool adapter unit tests (Phase 5, CONTRACT-5 B2/B7): the three
// last_share_at forms (spec A8), defensive payload parsing, and the HTTP
// behavior against a local mock server — including A11 (no credentials are
// ever sent) at the adapter level.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fetchAddressWorkers,
  parseMinerPayload,
  parsePoolLastShareAt,
  poolUserAgent,
  workerResultFromFetch,
} from '../../src/services/pool/bntpool';
import { minerPayload, poolWorkerEntry, startMockPool, type MockPool } from '../mock-pool';

describe('parsePoolLastShareAt (A8 forms)', () => {
  it('accepts integer epoch seconds', () => {
    expect(parsePoolLastShareAt(1795702439)?.getTime()).toBe(1795702439000);
  });

  it('accepts the {secs_since_epoch, nanos_since_epoch} object form', () => {
    const d = parsePoolLastShareAt({ secs_since_epoch: 1795702439, nanos_since_epoch: 500_000_000 });
    expect(d?.getTime()).toBe(1795702439500);
    const d2 = parsePoolLastShareAt({ secs_since_epoch: 1795702439 });
    expect(d2?.getTime()).toBe(1795702439000);
  });

  it('accepts ISO 8601 strings, producing the same instant as the epoch form', () => {
    const iso = new Date(1795702439000).toISOString();
    expect(parsePoolLastShareAt(iso)?.getTime()).toBe(1795702439000);
  });

  it('returns null (unknown, not an error) for anything else', () => {
    expect(parsePoolLastShareAt(null)).toBeNull();
    expect(parsePoolLastShareAt(undefined)).toBeNull();
    expect(parsePoolLastShareAt('not-a-date')).toBeNull();
    expect(parsePoolLastShareAt('')).toBeNull();
    expect(parsePoolLastShareAt(-100)).toBeNull();
    expect(parsePoolLastShareAt(0)).toBeNull();
    expect(parsePoolLastShareAt({})).toBeNull();
    expect(parsePoolLastShareAt({ secs_since_epoch: 'soon' })).toBeNull();
    expect(parsePoolLastShareAt([1795702439])).toBeNull();
    expect(parsePoolLastShareAt(true)).toBeNull();
  });
});

describe('parseMinerPayload (defensive, spec §3.1/§9)', () => {
  it('parses the spec example shape and indexes workers by exact name', () => {
    const map = parseMinerPayload(
      minerPayload([
        poolWorkerEntry('czx-utama-7d66', { hashrate: 1.91, accepted: 147, rejected: 0, last_share_at: 1795702439 }),
        poolWorkerEntry('other-rig', { hashrate: 3.5 }),
      ]),
    );
    expect(map).not.toBeNull();
    expect(map!.size).toBe(2);
    const w = map!.get('czx-utama-7d66')!;
    expect(w.hashrate).toBe(1.91);
    expect(w.accepted).toBe(147);
    expect(w.rejected).toBe(0);
    expect(w.lastShareAt?.getTime()).toBe(1795702439000);
    // Case-sensitive: a differently-cased name is a different worker.
    expect(map!.get('CZX-UTAMA-7D66')).toBeUndefined();
  });

  it('nulls mistyped fields per-field but keeps the entry', () => {
    const map = parseMinerPayload(
      minerPayload([{ worker: 'w1', hashrate: 'fast', accepted: null, rejected: undefined, last_share_at: 'junk' }]),
    );
    const w = map!.get('w1')!;
    expect(w.hashrate).toBeNull();
    expect(w.accepted).toBeNull();
    expect(w.rejected).toBeNull();
    expect(w.lastShareAt).toBeNull();
  });

  it('skips entries without a string worker name', () => {
    const map = parseMinerPayload(minerPayload([{ hashrate: 1 }, { worker: 42 }, null, 'x']));
    expect(map!.size).toBe(0);
  });

  it('returns null for non §3.1 shapes', () => {
    expect(parseMinerPayload(null)).toBeNull();
    expect(parseMinerPayload([])).toBeNull();
    expect(parseMinerPayload('json')).toBeNull();
    expect(parseMinerPayload({})).toBeNull();
    expect(parseMinerPayload({ workers: {} })).toBeNull();
  });
});

describe('fetchAddressWorkers against a mock pool', () => {
  let mock: MockPool;

  beforeAll(async () => {
    mock = await startMockPool();
  });

  afterAll(async () => {
    await mock.close();
  });

  it('fetches, URL-encodes the lookup param as one segment, sends UA and NO Authorization (A11)', async () => {
    mock.setJson(minerPayload([poolWorkerEntry('w1')]));
    mock.requests.length = 0;
    const res = await fetchAddressWorkers({ baseUrl: mock.baseUrl, lookupParam: 'a/b c?d' });
    expect(res.kind).toBe('ok');
    expect(mock.requests.length).toBe(1);
    const req = mock.requests[0];
    expect(req.url).toBe('/api/miner/a%2Fb%20c%3Fd');
    expect(req.headers['user-agent']).toBe(poolUserAgent());
    expect(req.headers['user-agent']).toMatch(/^muse-management-control\//);
    expect(req.headers.authorization).toBeUndefined();
  });

  it('maps HTTP 500 to an error result', async () => {
    mock.setHandler(() => ({ status: 500, body: 'boom' }));
    const res = await fetchAddressWorkers({ baseUrl: mock.baseUrl, lookupParam: 'W' });
    expect(res).toEqual({ kind: 'error', reason: 'http_500' });
  });

  it('maps HTTP 429 with Retry-After to retryAfterSec (A10, adapter level)', async () => {
    mock.setHandler(() => ({ status: 429, headers: { 'retry-after': '120' }, body: 'slow down' }));
    const res = await fetchAddressWorkers({ baseUrl: mock.baseUrl, lookupParam: 'W' });
    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.reason).toBe('http_429');
      expect(res.retryAfterSec).toBe(120);
    }
  });

  it('maps a non-JSON body to invalid_json and a wrong shape to invalid_shape', async () => {
    mock.setHandler(() => ({ status: 200, body: '<html>nope</html>' }));
    expect(await fetchAddressWorkers({ baseUrl: mock.baseUrl, lookupParam: 'W' })).toEqual({
      kind: 'error',
      reason: 'invalid_json',
    });
    mock.setJson({ hello: 'world' });
    expect(await fetchAddressWorkers({ baseUrl: mock.baseUrl, lookupParam: 'W' })).toEqual({
      kind: 'error',
      reason: 'invalid_shape',
    });
  });

  it('rejects oversized responses', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 16);
    mock.setHandler(() => ({ status: 200, body: big }));
    const res = await fetchAddressWorkers({ baseUrl: mock.baseUrl, lookupParam: 'W' });
    expect(res).toEqual({ kind: 'error', reason: 'response_too_large' });
  });

  it('times out via the abort signal', async () => {
    mock.setHandler(() => ({ status: 200, body: '{}', delayMs: 1500 }));
    const res = await fetchAddressWorkers({ baseUrl: mock.baseUrl, lookupParam: 'W', timeoutMs: 200 });
    expect(res).toEqual({ kind: 'error', reason: 'timeout' });
  });

  it('workerResultFromFetch: found / not_found / error passthrough', () => {
    const ok = { kind: 'ok' as const, workers: parseMinerPayload(minerPayload([poolWorkerEntry('w1')]))!, totalHashrate: 77.39 };
    expect(workerResultFromFetch(ok, 'w1').kind).toBe('found');
    expect(workerResultFromFetch(ok, 'nope')).toEqual({ kind: 'not_found' });
    expect(workerResultFromFetch({ kind: 'error', reason: 'http_500' }, 'w1')).toEqual({
      kind: 'error',
      reason: 'http_500',
    });
  });
});
