import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { runSweep } from '../../src/services/sweeper';
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

describe('worker status from heartbeats + sweeper (integration)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agent: PairedAgent;

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
    agent = await pairAgent(app, jwt);
  });

  it('miner stops while the bridge stays online -> worker MATI with reason', async () => {
    await sendHeartbeat(app, agent, { service_state: 'active' });
    let worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.status).toBe('SEHAT');

    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 });
    worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.status).toBe('MATI');
    expect(worker?.statusReason).toContain('tidak aktif');
    // Agent itself is still online.
    const stored = await prisma.agent.findUnique({ where: { id: agent.agentId } });
    expect(stored?.status).toBe('ONLINE');
  });

  it('low-memory VM reports GAGAL_START with the actual memory figure', async () => {
    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 }, 2.4);
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.status).toBe('GAGAL_START');
    expect(worker?.statusReason).toContain('2.4 GiB');
  });

  it('agent becomes unreachable after three missed heartbeat intervals (sweeper)', async () => {
    await sendHeartbeat(app, agent);
    // Simulate silence far beyond 3 * 30s.
    await prisma.agent.update({
      where: { id: agent.agentId },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) },
    });
    const summary = await runSweep(prisma);
    expect(summary.agentsMarkedUnreachable).toBe(1);

    const stored = await prisma.agent.findUnique({ where: { id: agent.agentId } });
    expect(stored?.status).toBe('UNREACHABLE');
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.status).toBe('TAK_TERJANGKAU');
    expect(await prisma.event.count({ where: { agentId: agent.agentId, type: 'AGENT_UNREACHABLE' } })).toBe(1);

    // A fresh heartbeat brings the agent back (same session still current).
    const hb = await sendHeartbeat(app, agent);
    expect(hb.statusCode).toBe(200);
    const back = await prisma.agent.findUnique({ where: { id: agent.agentId } });
    expect(back?.status).toBe('ONLINE');
    expect(await prisma.event.count({ where: { agentId: agent.agentId, type: 'AGENT_RECONNECTED' } })).toBe(1);
  });

  it('sweeper expires stale QUEUED commands', async () => {
    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 });
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    const created = await app.inject({
      method: 'POST',
      url: `/api/workers/${worker!.id}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type: 'miner.status', idempotency_key: 'will-expire' },
    });
    expect(created.statusCode).toBe(201);
    await prisma.command.update({
      where: { id: created.json().id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const summary = await runSweep(prisma);
    expect(summary.commandsExpired).toBe(1);
    const stored = await prisma.command.findUnique({ where: { id: created.json().id } });
    expect(stored?.status).toBe('EXPIRED');
    // Claiming no longer returns it.
    const claim = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.agentId}/commands?status=queued`,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(claim.json().commands).toHaveLength(0);
  });

  it('unverified command success fails with VERIFICATION_TIMEOUT at the deadline', async () => {
    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 });
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    const created = await app.inject({
      method: 'POST',
      url: `/api/workers/${worker!.id}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type: 'miner.run', idempotency_key: 'verify-timeout', confirm: true },
    });
    const cmdId = created.json().id as string;
    await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.agentId}/commands?status=queued`,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/commands/${cmdId}/ack`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { session_id: agent.sessionId },
    });
    const result = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/commands/${cmdId}/result`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { status: 'succeeded', session_id: agent.sessionId },
    });
    expect(result.json().verification).toBe('pending');

    // Deadline passes without a verifying heartbeat.
    await prisma.command.update({
      where: { id: cmdId },
      data: { verifyDeadline: new Date(Date.now() - 1000) },
    });
    const summary = await runSweep(prisma);
    expect(summary.commandsVerificationFailed).toBe(1);
    const stored = await prisma.command.findUnique({ where: { id: cmdId } });
    expect(stored?.status).toBe('FAILED');
    expect(stored?.errorReason).toBe('VERIFICATION_TIMEOUT');
  });

  it('settings can be read and updated by the dashboard, and are audit-logged', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(before.json().min_mem_start_gib).toBe(5);
    expect(before.json().pool_api_key).toBeUndefined();
    expect(before.json().pool_api_key_set).toBe(false);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { min_mem_start_gib: 4, pool_api_key: 'secret-key' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().min_mem_start_gib).toBe(4);
    expect(put.json().pool_api_key_set).toBe(true);
    expect(put.json().pool_api_key).toBeUndefined();
    expect(await prisma.auditLog.count({ where: { action: 'settings.update' } })).toBe(1);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { not_a_setting: 1 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
