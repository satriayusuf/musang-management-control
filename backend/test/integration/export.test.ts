// CSV exports (integration, Phase 3 CONTRACT-3 §5): headers + rows, ADMIN
// gate, ?range= filtering, CSV quoting.

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
  type PairedAgent,
} from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

describe('CSV exports (integration, Phase 3)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let adminJwt: string;
  let operatorJwt: string;
  let agent: PairedAgent;

  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    adminJwt = await loginAsAdmin(app);
    agent = await pairAgent(app, adminJwt, { name: 'rig-export', workerName: 'worker-export', bootId: 'boot-export' });
    const hb = await sendHeartbeat(app, agent, { service_state: 'active' });
    expect(hb.statusCode).toBe(200);

    // An OPERATOR for the role-gate checks.
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: { email: 'export-op@mikasu.lol', password: 'export-op-pass', role: 'OPERATOR' },
    });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'export-op@mikasu.lol', password: 'export-op-pass' },
    });
    operatorJwt = login.json().token;

    // Commands at two ages for the range filter.
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    const base = { agentId: agent.agentId, workerId: worker!.id, type: 'miner.status', payload: {} as never, requestedBy: 'test', status: 'SUCCEEDED' };
    await prisma.command.create({
      data: { ...base, id: 'cmd_export_recent', idempotencyKey: 'exp-1', source: 'automation', createdAt: daysAgo(2), finishedAt: daysAgo(2), expiresAt: daysAgo(2) },
    });
    await prisma.command.create({
      data: { ...base, id: 'cmd_export_old', idempotencyKey: 'exp-2', source: 'manual', createdAt: daysAgo(40), finishedAt: daysAgo(40), expiresAt: daysAgo(40) },
    });
    // An agent whose name needs CSV quoting.
    await prisma.agent.create({
      data: { id: 'agt_csv_comma', name: 'Rig, Satu', capabilities: [], enrolledVia: 'self' },
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('agents.csv streams a header + one row per agent with worker status', async () => {
    const res = await get('/api/export/agents.csv', adminJwt);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.payload.split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('id,name,worker_name,enrolled_via,status,worker_status,last_seen_at,replacement_count,created_at');
    expect(res.payload).toContain('rig-export');
    expect(res.payload).toContain('pairing');
    // CSV quoting for a name containing a comma.
    expect(res.payload).toContain('"Rig, Satu"');
    expect(res.payload).toContain('self');
  });

  it('commands.csv honors the range filter (default 30d)', async () => {
    const def = await get('/api/export/commands.csv', adminJwt);
    expect(def.statusCode).toBe(200);
    expect(def.payload.split('\n')[0]).toBe('id,agent,worker,type,source,status,created_at,finished_at,error_reason');
    expect(def.payload).toContain('cmd_export_recent');
    expect(def.payload).toContain('automation');
    expect(def.payload).not.toContain('cmd_export_old');

    const all = await get('/api/export/commands.csv?range=all', adminJwt);
    expect(all.payload).toContain('cmd_export_recent');
    expect(all.payload).toContain('cmd_export_old');

    const day = await get('/api/export/commands.csv?range=24h', adminJwt);
    expect(day.payload).not.toContain('cmd_export_recent');
    expect(day.payload).not.toContain('cmd_export_old');
  });

  it('events.csv and audit.csv stream with headers', async () => {
    const events = await get('/api/export/events.csv', adminJwt);
    expect(events.statusCode).toBe(200);
    expect(events.payload.split('\n')[0]).toBe('id,agent,worker,type,description,created_at');
    expect(events.payload).toContain('AGENT_REGISTERED');

    const audit = await get('/api/export/audit.csv?range=all', adminJwt);
    expect(audit.statusCode).toBe(200);
    expect(audit.payload.split('\n')[0]).toBe('id,actor,action,target,created_at');
    expect(audit.payload).toContain('user.create');
  });

  it('exports are ADMIN-only', async () => {
    for (const url of ['/api/export/agents.csv', '/api/export/commands.csv', '/api/export/events.csv', '/api/export/audit.csv']) {
      const res = await get(url, operatorJwt);
      expect(res.statusCode, url).toBe(403);
    }
    const anon = await app.inject({ method: 'GET', url: '/api/export/agents.csv' });
    expect(anon.statusCode).toBe(401);
  });
});
