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

describe('command queue & Run Again verification (integration)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agent: PairedAgent;
  let workerId: string;

  async function createCommand(type: string, key: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type, idempotency_key: key, confirm: true, ...extra },
    });
  }

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
    // Miner is down (service inactive, memory fine) -> worker MATI.
    const hb = await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, shares_local: 0, job_height: 0 });
    expect(hb.statusCode).toBe(200);
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.status).toBe('MATI');
    workerId = worker!.id;
  });

  it('full Run Again flow: create -> claim -> ack -> result -> verified by heartbeat', async () => {
    const created = await createCommand('miner.run', 'run-1');
    expect(created.statusCode).toBe(201);
    const cmd = created.json();
    expect(cmd.status).toBe('QUEUED');

    // Audit log + event rows exist for the manual command.
    expect(await prisma.auditLog.count({ where: { action: 'command.create', target: cmd.id } })).toBe(1);
    expect(await prisma.event.count({ where: { type: 'COMMAND_CREATED' } })).toBe(1);

    // Bridge claims it (QUEUED -> SENT).
    const claim = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.agentId}/commands?status=queued`,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().commands).toHaveLength(1);
    expect(claim.json().commands[0].id).toBe(cmd.id);
    // A second poll finds nothing (already claimed — SKIP LOCKED claim).
    const claim2 = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.agentId}/commands?status=queued`,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(claim2.json().commands).toHaveLength(0);

    // Ack (SENT -> RUNNING).
    const ack = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/commands/${cmd.id}/ack`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { session_id: agent.sessionId },
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().status).toBe('RUNNING');

    // Bridge reports success — NOT sufficient on its own.
    const result = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/commands/${cmd.id}/result`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { status: 'succeeded', output: 'service started', exit_code: 0, session_id: agent.sessionId },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().verification).toBe('pending');
    expect(result.json().status).toBe('RUNNING');

    // A heartbeat that still shows the miner down does not verify it.
    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 });
    let stored = await prisma.command.findUnique({ where: { id: cmd.id } });
    expect(stored?.status).toBe('RUNNING');

    // A heartbeat proving the miner is active with a job verifies success.
    await sendHeartbeat(app, agent, { service_state: 'active', hashrate_hs: 1.7, shares_local: 3, job_height: 900 });
    stored = await prisma.command.findUnique({ where: { id: cmd.id } });
    expect(stored?.status).toBe('SUCCEEDED');
    expect(stored?.finishedAt).not.toBeNull();
    expect(await prisma.event.count({ where: { type: 'COMMAND_SUCCEEDED' } })).toBe(1);
    expect(await prisma.event.count({ where: { type: 'RECOVERY' } })).toBe(1);
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.status).toBe('SEHAT');
    expect(worker?.lastRecoveryAt).not.toBeNull();
  });

  it('duplicate idempotency key returns the same command instead of a duplicate execution', async () => {
    const first = await createCommand('miner.run', 'dup-key');
    const second = await createCommand('miner.run', 'dup-key');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(await prisma.command.count()).toBe(1);
  });

  it('sensitive commands require explicit confirmation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type: 'miner.restart', idempotency_key: 'no-confirm' },
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.command.count()).toBe(0);
  });

  it('commands outside the agent capabilities are rejected', async () => {
    const limited = await pairAgent(app, jwt, {
      name: 'rig-limited',
      workerName: 'worker-limited',
      bootId: 'boot-limited',
      capabilities: ['miner.status'],
    });
    await sendHeartbeat(app, limited, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 });
    const w = await prisma.worker.findUnique({ where: { agentId: limited.agentId } });
    const res = await app.inject({
      method: 'POST',
      url: `/api/workers/${w!.id}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type: 'miner.run', idempotency_key: 'cap-1', confirm: true },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a queued command stays visible while the agent is offline', async () => {
    const created = await createCommand('miner.status', 'offline-visible');
    expect(created.statusCode).toBe(201);
    // Agent never polls; the command remains QUEUED and listed.
    const list = await app.inject({
      method: 'GET',
      url: '/api/commands?status=QUEUED',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(list.json().total).toBe(1);
    expect(list.json().items[0].id).toBe(created.json().id);
    expect(list.json().items[0].expires_at).toBeTruthy();
  });

  it('bridge-reported failure finishes the command with its reason', async () => {
    const created = await createCommand('miner.run', 'fail-1');
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
      payload: { status: 'failed', error_reason: 'UNIT_START_FAILED', session_id: agent.sessionId },
    });
    expect(result.json().status).toBe('FAILED');
    expect(result.json().error_reason).toBe('UNIT_START_FAILED');
    expect(await prisma.event.count({ where: { type: 'COMMAND_FAILED' } })).toBe(1);
    expect(await prisma.event.count({ where: { type: 'RECOVERY_FAILED' } })).toBe(1);
  });

  it('non-state-changing commands succeed immediately on result', async () => {
    const created = await createCommand('miner.status', 'status-1');
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
      payload: { status: 'succeeded', output: 'active', session_id: agent.sessionId },
    });
    expect(result.json().status).toBe('SUCCEEDED');
    expect(result.json().verification).toBe('none');
  });

  it('Run Again is refused with 422 while the worker is GAGAL_START (low memory)', async () => {
    // Drive the worker into GAGAL_START: service down + memory below threshold.
    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 }, 2.0);
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.status).toBe('GAGAL_START');
    expect(worker?.statusReason).toContain('2 GiB');

    const res = await createCommand('miner.run', 'run-blocked');
    expect(res.statusCode).toBe(422);
    expect(await prisma.command.count({ where: { idempotencyKey: 'run-blocked' } })).toBe(0);
  });
});
