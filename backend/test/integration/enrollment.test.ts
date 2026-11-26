// Zero-touch self-enrollment (integration, Phase 3 CONTRACT-3 §8):
// /agent.md rendering, self-register success/wrong-key/rate-limit, key
// rotation invalidating old copies.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, createTestPrisma, loginAsAdmin, migrateTestDb, resetDb } from './helpers';

describe('self-enrollment (integration, Phase 3 §8)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let adminJwt: string;
  let currentKey: string;

  async function fetchSettingsKey(): Promise<string> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().enrollment_key as string;
  }

  async function selfRegister(ip: string, body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/bridge/self-register', remoteAddress: ip, payload: body });
  }

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    adminJwt = await loginAsAdmin(app);
    currentKey = await fetchSettingsKey();
    expect(currentKey).toMatch(/^[0-9a-f]{64}$/);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('GET /agent.md is public and renders the current key + register endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent.md' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.payload).toContain(currentKey);
    expect(res.payload).toContain('/api/bridge/self-register');
    expect(res.payload).toContain('MUSE_ENROLLMENT_KEY');
    expect(res.payload).not.toContain('{{ENROLLMENT_KEY}}');
    expect(res.payload).not.toContain('{{SERVER_URL}}');
  });

  it('self-register with the correct key creates a self-enrolled agent', async () => {
    const res = await selfRegister('10.1.1.1', {
      enrollment_key: currentKey,
      agent_name: 'rig-self-1',
      worker_name: 'worker-self-1',
      boot_id: 'boot-self-1',
      capabilities: ['miner.status'],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.agent_id).toMatch(/^agt_/);
    expect(typeof body.agent_token).toBe('string');
    expect(body.session_no).toBe(1);
    expect(body.server_time).toBeTruthy();
    expect(body.config.heartbeat_interval_sec).toBeGreaterThan(0);

    const agent = await prisma.agent.findUnique({ where: { id: body.agent_id } });
    expect(agent?.enrolledVia).toBe('self');
    const worker = await prisma.worker.findUnique({ where: { agentId: body.agent_id } });
    expect(worker?.name).toBe('worker-self-1');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'agent.self_register', target: body.agent_id } });
    expect(audit?.actor).toBe('self-enroll');
  });

  it('a wrong key is rejected with 401', async () => {
    const res = await selfRegister('10.2.2.2', {
      enrollment_key: 'deadbeef'.repeat(8),
      agent_name: 'rig-intruder',
      boot_id: 'boot-x',
    });
    expect(res.statusCode).toBe(401);
    expect(await prisma.agent.count({ where: { name: 'rig-intruder' } })).toBe(0);
  });

  it('after 10 failed key attempts from one IP, further attempts get 429', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 10; i++) {
      const res = await selfRegister(ip, {
        enrollment_key: 'wrong-key',
        agent_name: 'rig-ratelimit',
        boot_id: 'boot-rl',
      });
      expect(res.statusCode, `attempt ${i + 1}`).toBe(401);
    }
    const eleventh = await selfRegister(ip, {
      enrollment_key: 'wrong-key',
      agent_name: 'rig-ratelimit',
      boot_id: 'boot-rl',
    });
    expect(eleventh.statusCode).toBe(429);
    // Even the CORRECT key is refused while the IP is limited.
    const correct = await selfRegister(ip, {
      enrollment_key: currentKey,
      agent_name: 'rig-ratelimit',
      boot_id: 'boot-rl',
    });
    expect(correct.statusCode).toBe(429);
    // A different IP is unaffected.
    const other = await selfRegister('10.8.8.8', {
      enrollment_key: currentKey,
      agent_name: 'rig-other-ip',
      boot_id: 'boot-other',
    });
    expect(other.statusCode).toBe(201);
  });

  it('rotation changes the rendered document and invalidates the old key', async () => {
    const rotate = await app.inject({
      method: 'POST',
      url: '/api/settings/enrollment-key/rotate',
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(rotate.statusCode).toBe(200);
    const newKey = rotate.json().enrollment_key as string;
    expect(newKey).toMatch(/^[0-9a-f]{64}$/);
    expect(newKey).not.toBe(currentKey);

    const doc = await app.inject({ method: 'GET', url: '/agent.md' });
    expect(doc.payload).toContain(newKey);
    expect(doc.payload).not.toContain(currentKey);

    const oldAttempt = await selfRegister('10.3.3.3', {
      enrollment_key: currentKey,
      agent_name: 'rig-old-key',
      boot_id: 'boot-old',
    });
    expect(oldAttempt.statusCode).toBe(401);

    const newAttempt = await selfRegister('10.4.4.4', {
      enrollment_key: newKey,
      agent_name: 'rig-new-key',
      boot_id: 'boot-new',
    });
    expect(newAttempt.statusCode).toBe(201);
    currentKey = newKey;
  });
});
