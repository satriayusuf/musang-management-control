// BNTPool adapter — integration acceptance tests (Phase 5, CONTRACT-5
// B3/B5/B6/B7; owner spec §10). A local mock pool HTTP server stands in
// for bntpool.com; time is injected into poller cycles so confirmation
// gaps (§5.1) are exercised without real waiting. A1 (live API) is NOT
// covered here by design — it is verified at deploy time.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  createTestPrisma,
  loginAsAdmin,
  migrateTestDb,
  pairAgent,
  resetDb,
  sendHeartbeat,
  type PairedAgent,
} from './helpers';
import { minerPayload, poolWorkerEntry, startMockPool, type MockPool } from '../mock-pool';
import { PoolMonitorService } from '../../src/services/pool/monitor';
import { PlaceholderPoolProvider } from '../../src/services/pool/placeholder';
import { runPoolTestFetch } from '../../src/services/pool/test-fetch';

const WALLET = 'WALLET-TEST-1';
const epochSec = (d: Date) => Math.floor(d.getTime() / 1000);

describe('pool adapter (integration, Phase 5)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let mock: MockPool;

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    jwt = await loginAsAdmin(app);
    mock = await startMockPool();
  });

  afterAll(async () => {
    await mock.close();
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    mock.requests.length = 0;
    mock.setJson(minerPayload([]));
  });

  function makeMonitor(timeoutMs = 400): PoolMonitorService {
    return new PoolMonitorService(prisma, new PlaceholderPoolProvider(), { timeoutMs, log: () => {} });
  }

  async function setSetting(key: string, value: unknown): Promise<void> {
    // Upsert: write-only keys (pool_api_key) have no seeded row.
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value: value as never },
      create: { key, value: value as never },
    });
  }

  async function setPoolSettings(provider = 'bntpool'): Promise<void> {
    await setSetting('pool_provider', provider);
    await setSetting('pool_api_base_url', mock.baseUrl);
    await setSetting('pool_lookup_param', WALLET);
  }

  /** Pair an agent and send one healthy heartbeat so its worker exists. */
  async function setupAgent(name: string, workerName: string): Promise<PairedAgent> {
    const agent = await pairAgent(app, jwt, { name, workerName, bootId: `boot-${name}` });
    const hb = await sendHeartbeat(app, agent);
    expect(hb.statusCode).toBe(200);
    return agent;
  }

  async function workerStatus(agentId: string): Promise<string> {
    const w = await prisma.worker.findUnique({ where: { agentId } });
    return w!.status;
  }

  async function workerRow(agentId: string) {
    return prisma.worker.findUnique({ where: { agentId } });
  }

  // ---------------------------------------------------------------- A2 ---
  it('A2: provider none and placeholder -> zero pool requests, status from bridge alone', async () => {
    const agent = await setupAgent('rig-a2', 'worker-a2');
    await setPoolSettings('none');
    const monitor = makeMonitor();
    await monitor.runCycle();
    await monitor.runCycle();
    expect(mock.requests.length).toBe(0);
    expect(await prisma.poolSnapshot.count()).toBe(0);
    expect(await workerStatus(agent.agentId)).toBe('SEHAT');

    await setPoolSettings('placeholder');
    await monitor.runCycle();
    expect(mock.requests.length).toBe(0);
    expect(await prisma.poolSnapshot.count()).toBe(0);

    // B6: pool field is null when the provider is not bntpool.
    const res = await app.inject({
      method: 'GET',
      url: '/api/workers',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ name: string; pool: unknown }>;
    expect(items.find((i) => i.name === 'worker-a2')!.pool).toBeNull();
  });

  // ------------------------------------------------------------- A9 + B6 ---
  it('A9: one request per cycle shared by all agents on the address; results split per worker name', async () => {
    const a = await setupAgent('rig-a9-a', 'worker-a9-a');
    const b = await setupAgent('rig-a9-b', 'worker-a9-b');
    const c = await setupAgent('rig-a9-c', 'worker-a9-c');
    await setPoolSettings();
    mock.setJson(
      minerPayload([
        poolWorkerEntry('worker-a9-a', { accepted: 10 }),
        poolWorkerEntry('worker-a9-b', { accepted: 20 }),
        poolWorkerEntry('worker-a9-c', { accepted: 30 }),
        poolWorkerEntry('stranger-1', { accepted: 99 }),
        poolWorkerEntry('stranger-2', { accepted: 98 }),
      ]),
    );

    const monitor = makeMonitor();
    const summary = await monitor.runCycle();
    expect(summary.fetched).toBe(true);
    expect(mock.requests.length).toBe(1);
    expect(mock.requests[0].url).toBe(`/api/miner/${WALLET}`);

    for (const [agent, accepted] of [
      [a, 10],
      [b, 20],
      [c, 30],
    ] as const) {
      const snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
      expect(snap).not.toBeNull();
      expect(snap!.found).toBe(true);
      expect(snap!.poolAccepted).toBe(accepted);
      expect(snap!.fetchOk).toBe(true);
      expect(snap!.fetchedAt).not.toBeNull();
    }

    // B6: worker list + agent detail expose the pool block.
    const list = await app.inject({
      method: 'GET',
      url: '/api/workers',
      headers: { authorization: `Bearer ${jwt}` },
    });
    const items = list.json().items as Array<{
      name: string;
      pool: { state: string; found: boolean; accepted: number | null; last_share_at: string | null } | null;
    }>;
    const itemA = items.find((i) => i.name === 'worker-a9-a')!;
    expect(itemA.pool).not.toBeNull();
    expect(itemA.pool!.state).toBe('ok');
    expect(itemA.pool!.found).toBe(true);
    expect(itemA.pool!.accepted).toBe(10);
    expect(itemA.pool!.last_share_at).not.toBeNull();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/agents/${b.agentId}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(detail.json().worker_metrics.pool.accepted).toBe(20);
    expect(detail.json().worker.pool.accepted).toBe(20);
  });

  // ---------------------------------------------------------------- A3 ---
  it('A3: pool API down (HTTP 500, then timeout) -> unknown, bridge verdict stands, last success kept', async () => {
    const agent = await setupAgent('rig-a3', 'worker-a3');
    await setPoolSettings();
    mock.setJson(minerPayload([poolWorkerEntry('worker-a3', { accepted: 147 })]));
    const monitor = makeMonitor();
    const t0 = new Date();
    await monitor.runCycle(t0);
    const before = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(before!.fetchOk).toBe(true);
    expect(before!.poolAccepted).toBe(147);

    mock.setHandler(() => ({ status: 500, body: 'internal error' }));
    const summary = await monitor.runCycle(new Date(t0.getTime() + 61_000));
    expect(summary.error).toBe('http_500');
    const after = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(after!.fetchOk).toBe(false);
    expect(after!.fetchError).toBe('http_500');
    // Last successful snapshot is NOT overwritten by the failure (§6.1).
    expect(after!.fetchedAt?.getTime()).toBe(before!.fetchedAt?.getTime());
    expect(after!.poolAccepted).toBe(147);
    expect(after!.found).toBe(true);
    // Status follows the bridge; no pool-sourced alarm appears.
    expect(await workerStatus(agent.agentId)).toBe('SEHAT');
    const stallEvents = await prisma.event.count({
      where: { workerId: (await workerRow(agent.agentId))!.id, type: 'POOL_STALL' },
    });
    expect(stallEvents).toBe(0);

    // Timeout variant (fresh monitor -> fresh backoff state).
    mock.setHandler(() => ({ status: 200, body: '{}', delayMs: 1500 }));
    const monitor2 = makeMonitor(300);
    const summary2 = await monitor2.runCycle(new Date(t0.getTime() + 122_000));
    expect(summary2.error).toBe('timeout');
    expect(await workerStatus(agent.agentId)).toBe('SEHAT');
  });

  // ---------------------------------------------------------------- A4 ---
  it('A4: pool accepted counter going DOWN is stored as-is, no warning, no status change', async () => {
    const agent = await setupAgent('rig-a4', 'worker-a4');
    await setPoolSettings();
    mock.setJson(minerPayload([poolWorkerEntry('worker-a4', { accepted: 147 })]));
    const monitor = makeMonitor();
    const t0 = new Date();
    await monitor.runCycle(t0);
    expect((await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } }))!.poolAccepted).toBe(147);

    mock.setJson(minerPayload([poolWorkerEntry('worker-a4', { accepted: 120 })]));
    await monitor.runCycle(new Date(t0.getTime() + 61_000));
    const snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(snap!.poolAccepted).toBe(120);
    expect(snap!.fetchOk).toBe(true);
    const worker = await workerRow(agent.agentId);
    expect(worker!.status).toBe('SEHAT');
    const badEvents = await prisma.event.count({
      where: { workerId: worker!.id, type: { in: ['POOL_STALL', 'RECOVERY_FAILED'] } },
    });
    expect(badEvents).toBe(0);
  });

  // ---------------------------------------------------------------- A5 ---
  it('A5: share 45 min old + bridge hashing -> WASPADA with the spec text; never escalates on age alone', async () => {
    const agent = await setupAgent('rig-a5', 'worker-a5');
    await setPoolSettings();
    const shareAt = new Date(Date.now() - 45 * 60_000);
    mock.setJson(minerPayload([poolWorkerEntry('worker-a5', { last_share_at: epochSec(shareAt) })]));
    const monitor = makeMonitor();
    const t0 = new Date();
    await monitor.runCycle(t0);
    let worker = await workerRow(agent.agentId);
    expect(worker!.status).toBe('WASPADA');
    expect(worker!.statusReason).toBe(
      'Tidak ada share selama 45 menit — miner masih hashing; share bersifat acak',
    );

    // 30 more minutes pass (share now 75 min old): still WASPADA, no stall —
    // escalation needs the §5.2 stall conditions from fresh successful polls.
    await monitor.runCycle(new Date(t0.getTime() + 30 * 60_000));
    worker = await workerRow(agent.agentId);
    expect(worker!.status).toBe('WASPADA');
    expect(worker!.statusReason).toContain('miner masih hashing');
  });

  // ---------------------------------------------------------------- A6 ---
  it('A6: share 3h old needs TWO spaced successful polls before POOL_STALL', async () => {
    const agent = await setupAgent('rig-a6', 'worker-a6');
    await setPoolSettings();
    const shareAt = new Date(Date.now() - 3 * 3600_000);
    mock.setJson(minerPayload([poolWorkerEntry('worker-a6', { last_share_at: epochSec(shareAt) })]));
    const monitor = makeMonitor();
    const t0 = new Date();

    await monitor.runCycle(t0);
    let snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(snap!.confirmKind).toBe('stall');
    expect(snap!.confirmCount).toBe(1);
    expect(await workerStatus(agent.agentId)).toBe('WASPADA'); // one fetch is not enough

    // A poll only 60s later does NOT count as the second confirmation.
    await monitor.runCycle(new Date(t0.getTime() + 60_000));
    snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(snap!.confirmCount).toBe(1);
    expect(await workerStatus(agent.agentId)).toBe('WASPADA');

    await monitor.runCycle(new Date(t0.getTime() + 300_000));
    snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(snap!.confirmCount).toBe(2);
    const worker = await workerRow(agent.agentId);
    expect(worker!.status).toBe('POOL_STALL');
    expect(worker!.statusReason).toBe(
      'Tidak ada share ≥2,5 jam padahal miner hashing — kemungkinan stall di sisi pool',
    );
    const stallEvents = await prisma.event.count({ where: { workerId: worker!.id, type: 'POOL_STALL' } });
    expect(stallEvents).toBe(1);
  });

  // ---------------------------------------------------------------- A7 ---
  it('A7: worker not found — first fetch changes nothing, second spaced fetch warns (not stall)', async () => {
    const agent = await setupAgent('rig-a7', 'worker-a7');
    await setPoolSettings();
    mock.setJson(minerPayload([poolWorkerEntry('someone-else')]));
    const monitor = makeMonitor();
    const t0 = new Date();

    await monitor.runCycle(t0);
    let snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(snap!.found).toBe(false);
    expect(snap!.confirmKind).toBe('not_found');
    expect(snap!.confirmCount).toBe(1);
    expect(await workerStatus(agent.agentId)).toBe('SEHAT');

    await monitor.runCycle(new Date(t0.getTime() + 300_000));
    snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(snap!.confirmCount).toBe(2);
    const worker = await workerRow(agent.agentId);
    expect(worker!.status).toBe('WASPADA');
    expect(worker!.statusReason).toBe('Worker tidak terlihat di pool');
  });

  // --------------------------------------------------------------- A10 ---
  it('A10: HTTP 429 honors Retry-After — zero requests during the wait', async () => {
    const agent = await setupAgent('rig-a10', 'worker-a10');
    await setPoolSettings();
    mock.setHandler(() => ({ status: 429, headers: { 'retry-after': '120' }, body: 'rate limited' }));
    const monitor = makeMonitor();
    const t0 = new Date();

    const s1 = await monitor.runCycle(t0);
    expect(s1.error).toBe('http_429');
    expect(mock.requests.length).toBe(1);

    const s2 = await monitor.runCycle(new Date(t0.getTime() + 60_000));
    expect(s2.fetched).toBe(false);
    expect(mock.requests.length).toBe(1);

    const s3 = await monitor.runCycle(new Date(t0.getTime() + 119_000));
    expect(s3.fetched).toBe(false);
    expect(mock.requests.length).toBe(1);

    mock.setJson(minerPayload([poolWorkerEntry('worker-a10')]));
    const s4 = await monitor.runCycle(new Date(t0.getTime() + 121_000));
    expect(s4.fetched).toBe(true);
    expect(mock.requests.length).toBe(2);
    const snap = await prisma.poolSnapshot.findUnique({ where: { agentId: agent.agentId } });
    expect(snap!.fetchOk).toBe(true);
    expect(await workerStatus(agent.agentId)).toBe('SEHAT');
  });

  // --------------------------------------------------------------- A11 ---
  it('A11: with pool_api_key set, requests still carry no Authorization and never leak the key', async () => {
    await setupAgent('rig-a11', 'worker-a11');
    await setPoolSettings();
    await setSetting('pool_api_key', 'SECRET-POOL-KEY-123');
    mock.setJson(minerPayload([poolWorkerEntry('worker-a11')]));
    const monitor = makeMonitor();
    await monitor.runCycle();
    expect(mock.requests.length).toBe(1);
    const req = mock.requests[0];
    expect(req.headers.authorization).toBeUndefined();
    expect(req.url).not.toContain('SECRET-POOL-KEY-123');
    expect(JSON.stringify(req.headers)).not.toContain('SECRET-POOL-KEY-123');
  });

  // --------------------------------------------------------------- A12 ---
  it('A12: bridge heartbeat stopped but pool share fresh -> worker SEHAT, agent stays UNREACHABLE', async () => {
    const agent = await setupAgent('rig-a12', 'worker-a12');
    // Simulate the sweeper after heartbeat loss.
    await prisma.agent.update({ where: { id: agent.agentId }, data: { status: 'UNREACHABLE' } });
    await prisma.worker.update({
      where: { agentId: agent.agentId },
      data: { status: 'TAK_TERJANGKAU', statusReason: 'Heartbeat agent berhenti; status terakhir yang diketahui ditampilkan' },
    });

    await setPoolSettings();
    const shareAt = new Date(Date.now() - 5 * 60_000);
    mock.setJson(minerPayload([poolWorkerEntry('worker-a12', { last_share_at: epochSec(shareAt) })]));
    const monitor = makeMonitor();
    await monitor.runCycle(new Date());

    const worker = await workerRow(agent.agentId);
    expect(worker!.status).toBe('SEHAT');
    const agentRow = await prisma.agent.findUnique({ where: { id: agent.agentId } });
    expect(agentRow!.status).toBe('UNREACHABLE'); // two separate statuses
  });

  // ---------------------------------------------------------------- B5 ---
  it('B5: settings validation for bntpool + pool_test on save (failure never blocks the save)', async () => {
    const put = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${jwt}` },
        payload,
      });

    // http (not https) base URL rejected.
    expect(
      (await put({ pool_provider: 'bntpool', pool_api_base_url: 'http://pool.example.com/api', pool_lookup_param: 'W1' }))
        .statusCode,
    ).toBe(400);
    // Query string rejected.
    expect(
      (await put({ pool_provider: 'bntpool', pool_api_base_url: 'https://pool.example.com/api?x=1', pool_lookup_param: 'W1' }))
        .statusCode,
    ).toBe(400);
    // Missing base URL / lookup rejected.
    expect((await put({ pool_provider: 'bntpool', pool_lookup_param: 'W1' })).statusCode).toBe(400);
    expect(
      (await put({ pool_provider: 'bntpool', pool_api_base_url: 'https://pool.example.com/api' })).statusCode,
    ).toBe(400);
    // Lookup with space or path/query/fragment characters rejected (spec §9).
    for (const bad of ['a b', 'a/b', 'a?b', 'a#b']) {
      expect(
        (
          await put({
            pool_provider: 'bntpool',
            pool_api_base_url: 'https://pool.example.com/api',
            pool_lookup_param: bad,
          })
        ).statusCode,
      ).toBe(400);
    }
    // Non-bntpool providers are not subject to pool validation.
    expect((await put({ pool_provider: 'none', pool_api_base_url: 'not a url' })).statusCode).toBe(200);

    // Valid config: trailing slash normalized, lookup trimmed, save succeeds
    // even though the test fetch fails (127.0.0.1:1 refuses connections).
    const ok = await put({
      pool_provider: 'bntpool',
      pool_api_base_url: 'https://127.0.0.1:1/api/',
      pool_lookup_param: '  WALLET1  ',
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.pool_api_base_url).toBe('https://127.0.0.1:1/api');
    expect(body.pool_lookup_param).toBe('WALLET1');
    expect(body.pool_test).toBeDefined();
    expect(body.pool_test.fetch_ok).toBe(false);
    expect(typeof body.pool_test.error).toBe('string');

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(get.json().pool_api_base_url).toBe('https://127.0.0.1:1/api');
    expect(get.json().pool_test).toBeUndefined();
  });

  it('B5: runPoolTestFetch reports found / not_found per agent', async () => {
    const found = await setupAgent('rig-tf', 'worker-tf-found');
    const missing = await setupAgent('rig-tf2', 'worker-tf-missing');
    await setPoolSettings();
    // Pool share times are epoch SECONDS: build the expectation pre-truncated.
    const shareAt = new Date(Math.floor((Date.now() - 120_000) / 1000) * 1000);
    mock.setJson(
      minerPayload([poolWorkerEntry('worker-tf-found', { hashrate: 2.5, last_share_at: epochSec(shareAt) })]),
    );
    const result = await runPoolTestFetch(prisma);
    expect(result.fetch_ok).toBe(true);
    const byWorker = new Map(result.results.map((r) => [r.worker_name, r]));
    expect(byWorker.get('worker-tf-found')!.outcome).toBe('found');
    expect(byWorker.get('worker-tf-found')!.pool_hashrate).toBe(2.5);
    expect(byWorker.get('worker-tf-found')!.pool_last_share_at).toBe(shareAt.toISOString());
    expect(byWorker.get('worker-tf-missing')!.outcome).toBe('not_found');
    expect(byWorker.get('worker-tf-found')!.agent_id).toBe(found.agentId);
    expect(byWorker.get('worker-tf-missing')!.agent_id).toBe(missing.agentId);
  });

  it('pool totals come from the whole address, not from connected agents', async () => {
    await setupAgent('rig-tot', 'worker-tot');
    await setPoolSettings();
    const monitor = makeMonitor();
    expect(monitor.getPoolTotals()).toBeNull();

    // One connected worker + two strangers on the same address. The payload
    // carries the pool's own address total (77.39), which must win over any
    // per-worker sum (3 x 1.91 = 5.73) and over the connected-only sum (1.91).
    mock.setJson(
      minerPayload([poolWorkerEntry('worker-tot'), poolWorkerEntry('stranger-1'), poolWorkerEntry('stranger-2')]),
    );
    await monitor.runCycle(new Date());
    const totals = monitor.getPoolTotals();
    expect(totals).not.toBeNull();
    expect(totals!.hashrate).toBe(77.39);
    expect(totals!.workerCount).toBe(3);

    // Without the pool's own total field, fall back to the sum over ALL
    // workers on the address (still not just the connected ones).
    mock.setJson({
      workers: [poolWorkerEntry('worker-tot', { hashrate: 2 }), poolWorkerEntry('stranger-1', { hashrate: 3 })],
    });
    await monitor.runCycle(new Date(Date.now() + 61_000));
    const fallback = monitor.getPoolTotals();
    expect(fallback!.hashrate).toBe(5);
    expect(fallback!.workerCount).toBe(2);
  });

  it('agent list sorts by date added and by worker name, both directions', async () => {
    const base = new Date('2026-01-01T00:00:00Z');
    const mk = (id: string, name: string, workerName: string | null, dayOffset: number) =>
      prisma.agent.create({
        data: {
          id,
          name,
          workerName,
          capabilities: [],
          createdAt: new Date(base.getTime() + dayOffset * 86_400_000),
          firstRegisteredAt: new Date(base.getTime() + dayOffset * 86_400_000),
        },
      });
    await mk('agt_sort_1', 'satu', 'worker-zulu', 0);
    await mk('agt_sort_2', 'dua', 'worker-alpha', 2);
    await mk('agt_sort_3', 'tiga', null, 1);

    async function names(sort: string): Promise<string[]> {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents?sort=${sort}&page_size=50`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json().items.map((a: { name: string }) => a.name);
    }

    expect(await names('created_asc')).toEqual(['satu', 'tiga', 'dua']);
    expect(await names('created_desc')).toEqual(['dua', 'tiga', 'satu']);
    // Agents without a worker name stay last in both directions.
    expect(await names('worker_name_asc')).toEqual(['dua', 'satu', 'tiga']);
    expect(await names('worker_name_desc')).toEqual(['satu', 'dua', 'tiga']);
    expect(await names('name')).toEqual(['dua', 'satu', 'tiga']);
    expect(await names('name_desc')).toEqual(['tiga', 'satu', 'dua']);
  });

  it('workers list embeds the agent registration date for date sorting', async () => {
    const agent = await setupAgent('rig-date', 'worker-date');
    const res = await app.inject({
      method: 'GET',
      url: '/api/workers',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ agent_id: string; agent: { created_at?: string } }>;
    const row = items.find((i) => i.agent_id === agent.agentId);
    expect(row).toBeTruthy();
    expect(typeof row!.agent.created_at).toBe('string');
    expect(Number.isNaN(Date.parse(row!.agent.created_at!))).toBe(false);
  });

  it('agent list search honors search_by: agent by default, worker on request', async () => {
    const mk = (id: string, name: string, workerName: string | null) =>
      prisma.agent.create({ data: { id, name, workerName, capabilities: [] } });
    await mk('agt_seek_1', 'alpha-rig', 'worker-one');
    await mk('agt_seek_2', 'beta-rig', 'worker-alpha');

    async function names(qs: string): Promise<string[]> {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents?${qs}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json().items.map((a: { name: string }) => a.name);
    }

    // Default mode = agent: 'alpha' matches the agent NAME alpha-rig only,
    // not beta-rig whose worker happens to contain 'alpha'.
    expect(await names('search=alpha')).toEqual(['alpha-rig']);
    // Worker mode: 'alpha' matches only beta-rig (worker-alpha).
    expect(await names('search=alpha&search_by=worker')).toEqual(['beta-rig']);
    // Worker mode also matches worker-one.
    expect(await names('search=worker-one&search_by=worker')).toEqual(['alpha-rig']);
  });
});
