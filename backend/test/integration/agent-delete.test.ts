// Permanent agent deletion (ADMIN): removes the agent and all cascaded
// operational data, keeps the audit entry, rejects non-admins.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('permanent agent deletion (integration)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let adminJwt: string;

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    await resetDb(prisma);
    app = await buildTestApp(prisma);
    adminJwt = await loginAsAdmin(app);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('deletes the agent and all of its operational data, keeping the audit entry', async () => {
    const agent = await pairAgent(app, adminJwt);
    await sendHeartbeat(app, agent);
    expect(await prisma.session.count({ where: { agentId: agent.agentId } })).toBe(1);
    expect(await prisma.worker.count({ where: { agentId: agent.agentId } })).toBe(1);
    expect(await prisma.heartbeat.count({ where: { agentId: agent.agentId } })).toBe(1);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agent.agentId}`,
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true, id: agent.agentId });

    expect(await prisma.agent.findUnique({ where: { id: agent.agentId } })).toBeNull();
    expect(await prisma.session.count({ where: { agentId: agent.agentId } })).toBe(0);
    expect(await prisma.worker.count({ where: { agentId: agent.agentId } })).toBe(0);
    expect(await prisma.heartbeat.count({ where: { agentId: agent.agentId } })).toBe(0);
    expect(await prisma.event.count({ where: { agentId: agent.agentId } })).toBe(0);
    expect(await prisma.command.count({ where: { agentId: agent.agentId } })).toBe(0);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'agent.delete', target: agent.agentId } });
    expect(audit).not.toBeNull();
  });

  it('returns 404 for an unknown agent id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agents/agt_tidakada',
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/agents/agt_tidakada' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-admin users and keeps the agent', async () => {
    const agent = await pairAgent(app, adminJwt, { name: 'rig-keep', workerName: 'worker-keep', bootId: 'boot-keep' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: { email: 'operator@mikasu.lol', password: 'operator-pass-1', role: 'OPERATOR' },
    });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'operator@mikasu.lol', password: 'operator-pass-1' },
    });
    expect(login.statusCode).toBe(200);
    const operatorJwt = (login.json() as { token: string }).token;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agent.agentId}`,
      headers: { authorization: `Bearer ${operatorJwt}` },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.agent.findUnique({ where: { id: agent.agentId } })).not.toBeNull();
  });
});
