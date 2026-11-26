// BNTPool adapter (Phase 5, CONTRACT-5 B2; owner spec §3/§8.3/§9).
//
// The BNTPool API is public: GET {base}/miner/{address}, no authorization
// header, no API key — pool_api_key is never read and never sent. Responses
// are external, untrusted data: parsing is defensive, the body size is
// capped, and nothing from the payload is ever executed or rendered as HTML.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PoolWorkerEntry {
  hashrate: number | null;
  accepted: number | null;
  rejected: number | null;
  lastShareAt: Date | null;
}

/** Per-agent result, exactly the owner spec §8.3 contract. */
export type PoolWorkerResult =
  | { kind: 'found'; hashrate: number | null; accepted: number | null; rejected: number | null; lastShareAt: Date | null }
  | { kind: 'not_found' }
  | { kind: 'error'; reason: string };

export type AddressFetchResult =
  | {
      kind: 'ok';
      workers: Map<string, PoolWorkerEntry>;
      /** The pool's own address-level total hashrate (top-level `hashrate`), null when absent. */
      totalHashrate: number | null;
    }
  | { kind: 'error'; reason: string; retryAfterSec?: number };

export const POOL_FETCH_TIMEOUT_MS = 8_000;
export const POOL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

let cachedUserAgent: string | null = null;

/** `muse-management-control/<package version>` — identifies this server (§7). */
export function poolUserAgent(): string {
  if (cachedUserAgent) return cachedUserAgent;
  let version = '0.0.0';
  try {
    // Works from both src/ (tsx) and dist/ (tsc): ../../package.json is the
    // backend package root in both layouts.
    const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) version = parsed.version;
  } catch {
    /* keep fallback version */
  }
  cachedUserAgent = `muse-management-control/${version}`;
  return cachedUserAgent;
}

/**
 * Parse a pool `last_share_at` value (owner spec §3.1): integer epoch
 * seconds, `{ secs_since_epoch, nanos_since_epoch? }`, or an ISO 8601
 * string. Anything else (or unparseable) → null = "share time unknown",
 * never an error and never a stall signal.
 */
export function parsePoolLastShareAt(value: unknown): Date | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(Math.floor(value) * 1000);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const secs = (value as { secs_since_epoch?: unknown }).secs_since_epoch;
    if (typeof secs !== 'number' || !Number.isFinite(secs) || secs <= 0) return null;
    const nanosRaw = (value as { nanos_since_epoch?: unknown }).nanos_since_epoch;
    const nanos = typeof nanosRaw === 'number' && Number.isFinite(nanosRaw) ? nanosRaw : 0;
    return new Date(Math.floor(secs) * 1000 + Math.floor(nanos / 1_000_000));
  }
  return null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function intOrNull(value: unknown): number | null {
  const n = finiteNumberOrNull(value);
  return n === null ? null : Math.trunc(n);
}

/**
 * Defensively parse the GET /miner/{address} payload into a worker map.
 * Returns null when the shape is not the §3.1 shape at all (→ error
 * 'invalid_shape'). Per-worker fields may be missing or mistyped: they
 * become null per-field, and the entry is still used when `worker` is a
 * string (exact, case-sensitive name match downstream).
 */
export function parseMinerPayload(json: unknown): Map<string, PoolWorkerEntry> | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const workers = (json as { workers?: unknown }).workers;
  if (!Array.isArray(workers)) return null;
  const map = new Map<string, PoolWorkerEntry>();
  for (const entry of workers) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const name = (entry as { worker?: unknown }).worker;
    if (typeof name !== 'string' || name.length === 0) continue;
    const e = entry as Record<string, unknown>;
    map.set(name, {
      hashrate: finiteNumberOrNull(e.hashrate),
      accepted: intOrNull(e.accepted),
      rejected: intOrNull(e.rejected),
      lastShareAt: parsePoolLastShareAt(e.last_share_at),
    });
  }
  return map;
}

/** Derive the per-agent §8.3 result from an address-level fetch. */
export function workerResultFromFetch(fetch: AddressFetchResult, workerName: string): PoolWorkerResult {
  if (fetch.kind === 'error') return { kind: 'error', reason: fetch.reason };
  const entry = fetch.workers.get(workerName);
  if (!entry) return { kind: 'not_found' };
  return {
    kind: 'found',
    hashrate: entry.hashrate,
    accepted: entry.accepted,
    rejected: entry.rejected,
    lastShareAt: entry.lastShareAt,
  };
}

export interface FetchAddressOptions {
  baseUrl: string;
  lookupParam: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, Math.round((at - nowMs) / 1000));
  return undefined;
}

/**
 * One GET of the address payload. No retry. Timeout 8s via abort signal,
 * response body capped at 2 MB. Never sends an Authorization header.
 */
export async function fetchAddressWorkers(opts: FetchAddressOptions): Promise<AddressFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? POOL_FETCH_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const url = `${base}/miner/${encodeURIComponent(opts.lookupParam)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': poolUserAgent(), Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return { kind: 'error', reason: 'timeout' };
      return { kind: 'error', reason: `network: ${(err as Error).message || 'fetch failed'}` };
    }

    if (res.status === 429) {
      return {
        kind: 'error',
        reason: 'http_429',
        retryAfterSec: parseRetryAfter(res.headers.get('retry-after'), Date.now()),
      };
    }
    if (!res.ok) {
      return { kind: 'error', reason: `http_${res.status}` };
    }

    const contentLength = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(contentLength) && contentLength > POOL_MAX_RESPONSE_BYTES) {
      return { kind: 'error', reason: 'response_too_large' };
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      if (controller.signal.aborted) return { kind: 'error', reason: 'timeout' };
      return { kind: 'error', reason: 'network: failed reading response body' };
    }
    if (Buffer.byteLength(text, 'utf8') > POOL_MAX_RESPONSE_BYTES) {
      return { kind: 'error', reason: 'response_too_large' };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'error', reason: 'invalid_json' };
    }
    const workers = parseMinerPayload(json);
    if (!workers) return { kind: 'error', reason: 'invalid_shape' };
    const totalHashrate = finiteNumberOrNull((json as { hashrate?: unknown }).hashrate);
    return { kind: 'ok', workers, totalHashrate };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
  }
}
