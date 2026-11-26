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

describe('worker hold state (integration, Phase 2)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agent: PairedAgent;
  let workerId: string;

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
    await sendHeartbeat(app, agent, { service_state: 'active' });
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    workerId = worker!.id;
  });

  async function runCommandToSuccess(type: string, key: string) {
    const created = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type, idempotency_key: key, confirm: true },
    });
    expect(created.statusCode).toBe(201);
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
    expect(result.json().status).toBe('SUCCEEDED');
    return cmdId;
  }

  it('hold_active follows the heartbeat snapshot field and is left alone when absent', async () => {
    let worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.holdActive).toBe(false);

    await sendHeartbeat(app, agent, { hold_active: true });
    worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.holdActive).toBe(true);

    // A snapshot without the field must not clear the known hold state.
    await sendHeartbeat(app, agent, {});
    worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.holdActive).toBe(true);

    await sendHeartbeat(app, agent, { hold_active: false });
    worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.holdActive).toBe(false);
  });

  it('a successful miner.hold flips hold_active on; miner.unhold flips it off', async () => {
    await runCommandToSuccess('miner.hold', 'hold-1');
    let worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.holdActive).toBe(true);
    expect(worker?.holdUntil).not.toBeNull();

    // The dashboard list exposes the flag.
    const list = await app.inject({ method: 'GET', url: '/api/workers', headers: { authorization: `Bearer ${jwt}` } });
    expect(list.json().items[0].hold_active).toBe(true);

    await runCommandToSuccess('miner.unhold', 'unhold-1');
    worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.holdActive).toBe(false);
    expect(worker?.holdUntil).toBeNull();
  });

  it('a failed miner.hold result does not change hold_active', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type: 'miner.hold', idempotency_key: 'hold-fail', confirm: true },
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
    await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/commands/${cmdId}/result`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { status: 'failed', error_reason: 'EXEC_ERROR', session_id: agent.sessionId },
    });
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    expect(worker?.holdActive).toBe(false);
  });
});
