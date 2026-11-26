// Local mock pool HTTP server for adapter/poller tests: binds 127.0.0.1 on
// a random port, records every request, and lets each test swap behavior.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
}

export type MockHandler = (req: RecordedRequest) => MockResponse;

export interface MockPool {
  port: number;
  /** e.g. http://127.0.0.1:PORT/api — shaped like a pool base URL. */
  baseUrl: string;
  requests: RecordedRequest[];
  setHandler(handler: MockHandler): void;
  setJson(payload: unknown, status?: number): void;
  close(): Promise<void>;
}

export async function startMockPool(): Promise<MockPool> {
  const requests: RecordedRequest[] = [];
  let handler: MockHandler = () => ({ status: 200, body: JSON.stringify({ hashrate: 0, workers: [] }) });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const recorded: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers };
    requests.push(recorded);
    let out: MockResponse;
    try {
      out = handler(recorded);
    } catch {
      out = { status: 500, body: 'handler error' };
    }
    const send = () => {
      if (res.destroyed) return; // client may have aborted (timeout tests)
      try {
        res.writeHead(out.status ?? 200, out.headers ?? { 'content-type': 'application/json' });
        res.end(out.body ?? '');
      } catch {
        /* socket already gone */
      }
    };
    if (out.delayMs && out.delayMs > 0) setTimeout(send, out.delayMs);
    else send();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/api`,
    requests,
    setHandler(fn: MockHandler) {
      handler = fn;
    },
    setJson(payload: unknown, status = 200) {
      handler = () => ({ status, body: JSON.stringify(payload) });
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A BNTPool-shaped worker entry (owner spec §3.1). */
export function poolWorkerEntry(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worker: name,
    hashrate: 1.91,
    accepted: 147,
    rejected: 0,
    last_share_at: Math.floor(Date.now() / 1000),
    miner_version: '0.3.1',
    backend: 'cpu#1',
    version_status: 'current',
    solo: false,
    ...overrides,
  };
}

export function minerPayload(workers: unknown[]): Record<string, unknown> {
  return { hashrate: 77.39, workers, shares: [], payouts: [] };
}
