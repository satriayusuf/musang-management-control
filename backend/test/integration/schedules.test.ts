// Schedules (integration, Phase 3 CONTRACT-3 §3): cron validation at save,
// next_run_at computation, due evaluation in the sweeper (single + broadcast
// fan-out), disabled schedules and the master switch.

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
import { runSweep } from '../../src/services/sweeper';

describe('schedules (integration, Phase 3)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agent: PairedAgent;

  const auth = () => ({ authorization: `Bearer ${jwt}` });

  async function createSchedule(body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/schedules', headers: auth(), payload: body });
  }

  const baseSchedule = (over: Record<string, unknown> = {}) => ({
    name: 'Cek status harian',
    enabled: true,
    cron: '0 9 * * *',
    action: { type: 'miner.status' },
    target: { agent_ids: [agent.agentId] },
    ...over,
  });

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    jwt = await loginAsAdmin(app);
    agent = await pairAgent(app, jwt, { name: 'rig-sched', workerName: 'worker-sched', bootId: 'boot-sched' });
    const hb = await sendHeartbeat(app, agent, { service_state: 'active' });
    expect(hb.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.command.deleteMany({});
    await prisma.broadcastBatch.deleteMany({});
    await prisma.schedule.deleteMany({});
    await prisma.agent.update({
      where: { id: agent.agentId },
      data: { status: 'ONLINE', lastSeenAt: new Date() },
    });
  });

  it('rejects an invalid cron expression at save time', async () => {
    for (const cron of ['61 * * * *', 'bukan cron', '0 9 * *']) {
      const res = await createSchedule(baseSchedule({ cron }));
      expect(res.statusCode, cron).toBe(400);
    }
    expect(await prisma.schedule.count()).toBe(0);
  });

  it('computes next_run_at for an enabled schedule (next 09:00 local)', async () => {
    const res = await createSchedule(baseSchedule());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.next_run_at).not.toBeNull();
    const next = new Date(body.next_run_at);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());

    const disabled = await createSchedule(baseSchedule({ name: 'Nonaktif', enabled: false }));
    expect(disabled.statusCode).toBe(201);
    expect(disabled.json().next_run_at).toBeNull();

    const toggled = await app.inject({
      method: 'POST',
      url: `/api/schedules/${disabled.json().id}/toggle`,
      headers: auth(),
      payload: { enabled: true },
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().next_run_at).not.toBeNull();
  });

  it('a due schedule creates commands with source=schedule', async () => {
    const res = await createSchedule(baseSchedule());
    const id = res.json().id;
    await prisma.schedule.update({
      where: { id },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });

    const summary = await runSweep(prisma, new Date());
    expect(summary.schedulesFired).toBe(1);

    const commands = await prisma.command.findMany({ where: { source: 'schedule' } });
    expect(commands).toHaveLength(1);
    expect(commands[0].scheduleId).toBe(id);
    expect(commands[0].requestedBy).toBe('schedule');

    const after = await prisma.schedule.findUnique({ where: { id } });
    expect(after?.lastRunAt).not.toBeNull();
    expect(after?.nextRunAt).not.toBeNull();
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    // Not due anymore: a second sweep creates nothing new.
    const again = await runSweep(prisma, new Date());
    expect(again.schedulesFired).toBe(0);
    expect(await prisma.command.count({ where: { source: 'schedule' } })).toBe(1);
  });

  it('a due broadcast schedule fans out through the Phase 2 broadcast service', async () => {
    const res = await createSchedule(baseSchedule({ name: 'Broadcast pagi', broadcast: true }));
    const id = res.json().id;
    await prisma.schedule.update({
      where: { id },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });

    await runSweep(prisma, new Date());
    const batches = await prisma.broadcastBatch.findMany({});
    expect(batches).toHaveLength(1);
    const commands = await prisma.command.findMany({ where: { source: 'schedule' } });
    expect(commands).toHaveLength(1);
    expect(commands[0].batchId).toBe(batches[0].id);
    expect(commands[0].scheduleId).toBe(id);
  });

  it('a disabled schedule never fires, even when overdue', async () => {
    const res = await createSchedule(baseSchedule({ name: 'Mati', enabled: false }));
    const id = res.json().id;
    await prisma.schedule.update({
      where: { id },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });
    const summary = await runSweep(prisma, new Date());
    expect(summary.schedulesFired).toBe(0);
    expect(await prisma.command.count({ where: { source: 'schedule' } })).toBe(0);
  });

  it('master switch off: due schedules do not fire', async () => {
    const res = await createSchedule(baseSchedule());
    const id = res.json().id;
    await prisma.schedule.update({
      where: { id },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });
    await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload: { automation_enabled: false } });
    try {
      const summary = await runSweep(prisma, new Date());
      expect(summary.schedulesFired).toBe(0);
      expect(await prisma.command.count({ where: { source: 'schedule' } })).toBe(0);
    } finally {
      await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload: { automation_enabled: true } });
    }
  });
});
