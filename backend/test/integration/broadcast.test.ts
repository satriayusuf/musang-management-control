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

describe('broadcast fan-out (integration, Phase 2)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agents: Record<'a' | 'b' | 'c' | 'd' | 'e', PairedAgent>;

  async function broadcast(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/commands/broadcast',
      headers: { authorization: `Bearer ${jwt}` },
      payload: body,
    });
  }

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    // Pair once for the whole file: the register endpoint is rate-limited
    // (30/min), so per-test state is reset with targeted deletes instead.
    await resetDb(prisma);
    jwt = await loginAsAdmin(app);
    agents = {
      a: await pairAgent(app, jwt, { name: 'rig-a', workerName: 'worker-a', bootId: 'boot-a' }),
      b: await pairAgent(app, jwt, { name: 'rig-b', workerName: 'worker-b', bootId: 'boot-b' }),
      c: await pairAgent(app, jwt, {
        name: 'rig-c',
        workerName: 'worker-c',
        bootId: 'boot-c',
        capabilities: ['miner.status'],
      }),
      d: await pairAgent(app, jwt, { name: 'rig-d', workerName: 'worker-d', bootId: 'boot-d' }),
      e: await pairAgent(app, jwt, { name: 'rig-e', workerName: 'worker-e', bootId: 'boot-e' }),
    };
    for (const agent of Object.values(agents)) {
      const hb = await sendHeartbeat(app, agent, { service_state: 'active' });
      expect(hb.statusCode).toBe(200);
    }
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.command.deleteMany();
    await prisma.broadcastBatch.deleteMany();
    await prisma.event.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.worker.updateMany({
      data: { status: 'SEHAT', statusReason: 'Miner berjalan normal', holdActive: false },
    });
  });

  /** Drive the five workers into distinct eligibility states. */
  async function arrangeMixedStates() {
    // B: GAGAL_START (service down + low memory).
    await sendHeartbeat(app, agents.b, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 }, 2.0);
    // D: TAK_TERJANGKAU (as the sweeper would leave it).
    await prisma.worker.update({ where: { agentId: agents.d.agentId }, data: { status: 'TAK_TERJANGKAU' } });
    // E: hold active.
    await prisma.worker.update({ where: { agentId: agents.e.agentId }, data: { holdActive: true } });
  }

  it('fan-out creates for eligible targets and skips the rest with reasons', async () => {
    await arrangeMixedStates();
    const res = await broadcast({
      type: 'miner.run',
      confirm: true,
      idempotency_key: 'bc-mixed-1',
      agent_ids: [agents.a.agentId, agents.b.agentId, agents.c.agentId, agents.d.agentId, agents.e.agentId, 'agt_missing'],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.batch_id).toMatch(/^bct_/);
    expect(body.created).toEqual([{ agent_id: agents.a.agentId, command_id: expect.any(String) }]);

    const skipped = new Map(body.skipped.map((s: { agent_id: string; reason: string }) => [s.agent_id, s.reason]));
    expect(skipped.get(agents.b.agentId)).toContain('gagal start');
    expect(skipped.get(agents.c.agentId)).toContain('kemampuan');
    expect(skipped.get(agents.d.agentId)).toContain('tidak terjangkau');
    expect(skipped.get(agents.e.agentId)).toContain('ditahan');
    expect(skipped.get('agt_missing')).toContain('tidak ditemukan');

    const batch = await prisma.broadcastBatch.findUnique({ where: { id: body.batch_id } });
    expect(batch?.totalCount).toBe(6);
    expect(batch?.createdCount).toBe(1);
    expect(batch?.skippedCount).toBe(5);

    // The created command is a normal queued command with the derived key.
    const command = await prisma.command.findUnique({ where: { id: body.created[0].command_id } });
    expect(command?.status).toBe('QUEUED');
    expect(command?.batchId).toBe(body.batch_id);
    expect(command?.idempotencyKey).toBe(`bc-mixed-1:${agents.a.agentId}`);
    expect(await prisma.command.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'command.broadcast', target: body.batch_id } })).toBe(1);
  });

  it('state-changing broadcast without confirm is 422 and creates nothing', async () => {
    const res = await broadcast({
      type: 'miner.restart',
      idempotency_key: 'bc-noconfirm',
      agent_ids: [agents.a.agentId],
    });
    expect(res.statusCode).toBe(422);
    expect(await prisma.broadcastBatch.count()).toBe(0);
    expect(await prisma.command.count()).toBe(0);
  });

  it('non-sensitive broadcast needs no confirm and ignores recovery-only gates', async () => {
    await arrangeMixedStates();
    const res = await broadcast({
      type: 'miner.status',
      idempotency_key: 'bc-status-1',
      agent_ids: [agents.a.agentId, agents.b.agentId, agents.d.agentId],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // GAGAL_START and TAK_TERJANGKAU workers still receive miner.status.
    expect(body.created.map((c: { agent_id: string }) => c.agent_id).sort()).toEqual(
      [agents.a.agentId, agents.b.agentId, agents.d.agentId].sort(),
    );
    expect(body.skipped).toEqual([]);
  });

  it('idempotent retry returns the same batch and creates no duplicates', async () => {
    const payload = {
      type: 'miner.status',
      idempotency_key: 'bc-retry-1',
      agent_ids: [agents.a.agentId, agents.b.agentId],
    };
    const first = await broadcast(payload);
    expect(first.statusCode).toBe(201);
    const second = await broadcast(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json().batch_id).toBe(first.json().batch_id);
    expect(second.json().created).toEqual(first.json().created);
    expect(await prisma.broadcastBatch.count()).toBe(1);
    expect(await prisma.command.count()).toBe(2);
  });

  it('broadcast via template resolves type + payload and records template_id', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/command-templates',
      headers: { authorization: `Bearer ${jwt}` },
    });
    const tpl = list.json().items.find((t: { name: string }) => t.name === 'Jalankan Miner');
    const res = await broadcast({
      template_id: tpl.id,
      confirm: true,
      idempotency_key: 'bc-tpl-1',
      agent_ids: [agents.a.agentId],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.batch.type).toBe('miner.run');
    expect(body.batch.template_id).toBe(tpl.id);
    const command = await prisma.command.findUnique({ where: { id: body.created[0].command_id } });
    expect(command?.type).toBe('miner.run');
    expect(command?.templateId).toBe(tpl.id);
  });

  it('exactly one of type/template_id is required', async () => {
    const both = await broadcast({
      type: 'miner.status',
      template_id: 'tpl_whatever',
      idempotency_key: 'bc-both',
      agent_ids: [agents.a.agentId],
    });
    expect(both.statusCode).toBe(400);
    const neither = await broadcast({ idempotency_key: 'bc-neither', agent_ids: [agents.a.agentId] });
    expect(neither.statusCode).toBe(400);
    expect(await prisma.broadcastBatch.count()).toBe(0);
  });

  it('batch list and detail expose per-status progress counts', async () => {
    const res = await broadcast({
      type: 'miner.status',
      idempotency_key: 'bc-progress',
      agent_ids: [agents.a.agentId, agents.b.agentId],
    });
    const batchId = res.json().batch_id as string;

    const list = await app.inject({
      method: 'GET',
      url: '/api/commands/batches',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(list.statusCode).toBe(200);
    const item = list.json().items.find((b: { id: string }) => b.id === batchId);
    expect(item).toBeTruthy();
    expect(item.command_status_counts).toEqual({ QUEUED: 2 });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/commands/batches/${batchId}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().commands).toHaveLength(2);
    expect(detail.json().command_status_counts).toEqual({ QUEUED: 2 });

    const missing = await app.inject({
      method: 'GET',
      url: '/api/commands/batches/bct_nope',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});
