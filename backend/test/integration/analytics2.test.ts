import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, createTestPrisma, loginAsAdmin, migrateTestDb, resetDb } from './helpers';

const MIN = 60_000;

describe('full analytics (integration, Phase 2)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    jwt = await loginAsAdmin(app);
  });

  async function seedRichAgent() {
    const now = Date.now();
    await prisma.agent.create({
      data: { id: 'agt_an', name: 'rig-analytics', capabilities: ['miner.run'], status: 'ONLINE' },
    });
    await prisma.worker.create({
      data: { id: 'wrk_an', agentId: 'agt_an', name: 'worker-analytics', status: 'SEHAT', statusReason: '' },
    });
    // Two finished sessions: 60 and 30 minutes.
    await prisma.session.createMany({
      data: [
        { id: 'ses_an1', agentId: 'agt_an', bootId: 'boot-1', startedAt: new Date(now - 120 * MIN), endedAt: new Date(now - 60 * MIN), endReason: 'TAKEOVER', sessionNo: 1 },
        { id: 'ses_an2', agentId: 'agt_an', bootId: 'boot-2', startedAt: new Date(now - 50 * MIN), endedAt: new Date(now - 20 * MIN), endReason: 'SHUTDOWN', sessionNo: 2 },
      ],
    });
    // Phase 4 (CONTRACT-4): exactly ONE heartbeat row per agent — the latest.
    // It belongs to session 2 (miner session_no 2, 20 shares, mem 5.5).
    const t0 = now - 119 * MIN;
    await prisma.heartbeat.create({
      data: {
        id: 'hbt_latest',
        agentId: 'agt_an',
        sessionId: 'ses_an2',
        receivedAt: new Date(t0 + 400_000),
        memAvailableGib: 5.5,
        minerSnapshot: {
          service_state: 'active', session_no: 2, shares_local: 20, hashrate_hs: 1.9,
          last_share_at: new Date(t0 + 400_000).toISOString(), job_height: 12, difficulty: 2,
        } as never,
        agentStatus: 'ONLINE',
      },
    });
    const cmd = (id: string, type: string, status: string, errorReason: string | null, key: string) =>
      prisma.command.create({
        data: {
          id, agentId: 'agt_an', workerId: 'wrk_an', type, status, errorReason,
          idempotencyKey: key, requestedBy: 'admin@mikasu.lol',
          createdAt: new Date(now - 30 * MIN), expiresAt: new Date(now + 60 * MIN),
        },
      });
    await cmd('cmd_an1', 'miner.run', 'FAILED', 'LOW_MEMORY', 'an-1');
    await cmd('cmd_an2', 'miner.run', 'SUCCEEDED', null, 'an-2');
    await cmd('cmd_an3', 'miner.status', 'FAILED', 'VERIFICATION_TIMEOUT', 'an-3');
    await prisma.event.createMany({
      data: [
        { id: 'evt_an1', agentId: 'agt_an', type: 'VM_REPLACED', description: 'diganti', createdAt: new Date(now - 50 * MIN) },
        { id: 'evt_an2', agentId: 'agt_an', workerId: 'wrk_an', type: 'RECOVERY', description: 'pulih', createdAt: new Date(now - 25 * MIN) },
      ],
    });
  }

  it('computes the Phase 2 per-agent and per-worker aggregates from real rows', async () => {
    await seedRichAgent();
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?range=24h',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const agent = body.agents.find((a: { agent_id: string }) => a.agent_id === 'agt_an');
    expect(agent.sessions).toBe(2);
    expect(agent.session_count).toBe(2);
    expect(agent.replacements).toBe(1);
    expect(agent.replacement_count).toBe(1);
    expect(agent.commands_count).toBe(3);
    expect(agent.commands.total).toBe(3);
    expect(agent.success_rate).toBeCloseTo(33.3, 1);
    expect(agent.top_errors).toEqual(
      expect.arrayContaining([
        { reason: 'LOW_MEMORY', count: 1 },
        { reason: 'VERIFICATION_TIMEOUT', count: 1 },
      ]),
    );
    expect(agent.top_errors.length).toBeLessThanOrEqual(3);

    const worker = body.workers.find((w: { worker_id: string }) => w.worker_id === 'wrk_an');
    expect(worker.session_duration_distribution).toEqual({
      min_minutes: 30,
      median_minutes: 45,
      max_minutes: 60,
    });
    // Phase 4 (CONTRACT-4 §3): worker analytics derive from the single
    // latest heartbeat only — shares/session from its snapshot alone, no
    // share-gap series, mem trend holds only its session's point,
    // downtime reports 0.
    expect(worker.shares_per_session).toBe(20);
    expect(worker.longest_share_gap_sec).toBeNull();
    expect(worker.last_share_intervals).toEqual([]);
    expect(worker.downtime_sec).toBe(0);
    expect(worker.recoveries).toEqual({ succeeded: 1, failed: 0, failed_low_memory: 1 });
    expect(worker.mem_at_session_start_trend).toEqual([
      { at: expect.any(String), mem_available_gib: 5.5 },
    ]);
    // Phase 1 fields still present: the series is exactly the latest point.
    expect(worker.hashrate_series).toHaveLength(1);
    expect(worker.hashrate_series[0].v).toBe(1.9);
    expect(worker.mem_at_session_start).toHaveLength(1);
  });

  it('defaults to a 7d range when no range is given', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const { from, to } = res.json().range as { from: string; to: string };
    const spanHours = (new Date(to).getTime() - new Date(from).getTime()) / 3600_000;
    expect(spanHours).toBeGreaterThan(167.9);
    expect(spanHours).toBeLessThan(168.1);
  });

  it('empty data yields zeros and nulls, never fabricated numbers', async () => {
    await prisma.agent.create({
      data: { id: 'agt_empty', name: 'rig-empty', capabilities: [], status: 'ONLINE' },
    });
    await prisma.worker.create({
      data: { id: 'wrk_empty', agentId: 'agt_empty', name: 'worker-empty', status: 'SEHAT', statusReason: '' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?range=24h&agent_id=agt_empty',
      headers: { authorization: `Bearer ${jwt}` },
    });
    const agent = res.json().agents[0];
    expect(agent.commands_count).toBe(0);
    expect(agent.success_rate).toBeNull();
    expect(agent.top_errors).toEqual([]);
    const worker = res.json().workers[0];
    expect(worker.shares_per_session).toBeNull();
    expect(worker.longest_share_gap_sec).toBeNull();
    expect(worker.session_duration_distribution).toEqual({
      min_minutes: null,
      median_minutes: null,
      max_minutes: null,
    });
    expect(worker.recoveries).toEqual({ succeeded: 0, failed: 0, failed_low_memory: 0 });
  });
});
