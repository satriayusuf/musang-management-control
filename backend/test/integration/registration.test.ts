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
} from './helpers';

describe('registration, pairing & sessions (integration)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    await resetDb(prisma);
    app = await buildTestApp(prisma);
    jwt = await loginAsAdmin(app);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    jwt = await loginAsAdmin(app);
  });

  it('paired agent appears in the dashboard after its first heartbeat', async () => {
    const agent = await pairAgent(app, jwt);
    const hb = await sendHeartbeat(app, agent);
    expect(hb.statusCode).toBe(200);
    expect(hb.json()).toMatchObject({ ack: true, queued_commands: 0 });

    const overview = await app.inject({
      method: 'GET',
      url: '/api/dashboard/overview',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(overview.statusCode).toBe(200);
    const body = overview.json();
    expect(body.agents.total).toBe(1);
    expect(body.agents.online).toBe(1);
    expect(body.agents.working).toBe(1);
    expect(body.miners.healthy).toBe(1);
    expect(body.pool_configured).toBe(false);
    expect(body.worker_status_distribution.SEHAT).toBe(1);
  });

  it('dashboard endpoints reject unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
    expect(res.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@mikasu.lol', password: 'wrong-password' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('pairing code cannot be reused', async () => {
    const pairRes = await app.inject({
      method: 'POST',
      url: '/api/agents/pairing',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { planned_name: 'rig-once' },
    });
    const { pairing_code } = pairRes.json() as { pairing_code: string };
    const payload = {
      pairing_code,
      name: 'rig-once',
      boot_id: 'boot-x',
      bridge_version: '1.0.0',
      capabilities: [],
    };
    const first = await app.inject({ method: 'POST', url: '/api/agents/register', payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/agents/register', payload });
    expect(second.statusCode).toBe(401);
    expect(await prisma.agent.count()).toBe(1);
  });

  it('re-attach with the same boot id reuses the session and creates no duplicate agent', async () => {
    const agent = await pairAgent(app, jwt);
    await sendHeartbeat(app, agent);

    const re = await app.inject({
      method: 'POST',
      url: '/api/agents/register',
      headers: { authorization: `Bearer ${agent.token}` },
      payload: {
        agent_id: agent.agentId,
        boot_id: 'boot-0001',
        boot_time: new Date().toISOString(),
        bridge_version: '1.0.0',
        capabilities: ['miner.status'],
      },
    });
    expect(re.statusCode).toBe(200);
    expect(re.json().session_id).toBe(agent.sessionId);
    expect(await prisma.agent.count()).toBe(1);
    expect(await prisma.session.count({ where: { agentId: agent.agentId } })).toBe(1);
    const stored = await prisma.agent.findUnique({ where: { id: agent.agentId } });
    expect(stored?.replacementCount).toBe(0);
    expect(await prisma.event.count({ where: { agentId: agent.agentId, type: 'VM_REPLACED' } })).toBe(0);
  });

  it('new boot id creates a new session under the same agent with a VM_REPLACED event', async () => {
    const agent = await pairAgent(app, jwt);
    await sendHeartbeat(app, agent);

    const re = await app.inject({
      method: 'POST',
      url: '/api/agents/register',
      headers: { authorization: `Bearer ${agent.token}` },
      payload: {
        agent_id: agent.agentId,
        boot_id: 'boot-0002',
        boot_time: new Date().toISOString(),
        bridge_version: '1.0.0',
        capabilities: ['miner.status'],
      },
    });
    expect(re.statusCode).toBe(200);
    const newSessionId = re.json().session_id as string;
    expect(newSessionId).not.toBe(agent.sessionId);
    expect(re.json().session_no).toBe(2);

    expect(await prisma.agent.count()).toBe(1);
    const stored = await prisma.agent.findUnique({ where: { id: agent.agentId } });
    expect(stored?.replacementCount).toBe(1);
    expect(stored?.currentSessionId).toBe(newSessionId);

    const sessions = await prisma.session.findMany({
      where: { agentId: agent.agentId },
      orderBy: { sessionNo: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].endedAt).not.toBeNull();
    expect(sessions[0].endReason).toBe('TAKEOVER');
    // Session end is the takeover time, never before the new session started.
    expect(sessions[0].endedAt!.getTime()).toBeGreaterThanOrEqual(sessions[0].startedAt.getTime());

    const events = await prisma.event.findMany({ where: { agentId: agent.agentId, type: 'VM_REPLACED' } });
    expect(events).toHaveLength(1);

    // The old session can no longer heartbeat.
    const stale = await sendHeartbeat(app, agent, {}, 6.8, agent.sessionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('SESSION_SUPERSEDED');
  });

  it('clean shutdown followed by a new boot records REBOOT, not VM_REPLACED', async () => {
    const agent = await pairAgent(app, jwt);
    await sendHeartbeat(app, agent);
    const ev = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/events`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { type: 'AGENT_SHUTDOWN', description: 'bridge stopping', session_id: agent.sessionId },
    });
    expect(ev.statusCode).toBe(201);

    const re = await app.inject({
      method: 'POST',
      url: '/api/agents/register',
      headers: { authorization: `Bearer ${agent.token}` },
      payload: {
        agent_id: agent.agentId,
        boot_id: 'boot-0002',
        boot_time: new Date().toISOString(),
        bridge_version: '1.0.0',
        capabilities: ['miner.status'],
      },
    });
    expect(re.statusCode).toBe(200);
    expect(await prisma.event.count({ where: { agentId: agent.agentId, type: 'REBOOT' } })).toBe(1);
    expect(await prisma.event.count({ where: { agentId: agent.agentId, type: 'VM_REPLACED' } })).toBe(0);
    const stored = await prisma.agent.findUnique({ where: { id: agent.agentId } });
    expect(stored?.replacementCount).toBe(0);
    const oldSession = await prisma.session.findUnique({ where: { id: agent.sessionId } });
    expect(oldSession?.endReason).toBe('SHUTDOWN');
  });

  it('revoked agent token can no longer authenticate', async () => {
    const agent = await pairAgent(app, jwt);
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/revoke`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(revoke.statusCode).toBe(200);
    const hb = await sendHeartbeat(app, agent);
    expect(hb.statusCode).toBe(401);

    // Regression: the dashboard client sends Content-Type: application/json
    // with an empty body on action-only POSTs — that must not 400.
    const agent2 = await pairAgent(app, jwt, { name: 'rig-test-2', workerName: 'czx-utama-lain', bootId: 'boot-0002' });
    const revoke2 = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent2.agentId}/revoke`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(revoke2.statusCode).toBe(200);
    const stored2 = await prisma.agent.findUnique({ where: { id: agent2.agentId } });
    expect(stored2?.revokedAt).not.toBeNull();
  });

  it('agent list is searchable and includes the current session + worker summary', async () => {
    const agent = await pairAgent(app, jwt, { name: 'rig-alpha' });
    await sendHeartbeat(app, agent);
    const list = await app.inject({
      method: 'GET',
      url: '/api/agents?search=alpha',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.total).toBe(1);
    expect(body.items[0].current_session.id).toBe(agent.sessionId);
    expect(body.items[0].worker.status).toBe('SEHAT');
  });
});
