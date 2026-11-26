// Retention cleanup (integration, Phase 3 CONTRACT-3 §4; Phase 4
// CONTRACT-4 §4): only the prunable sets are deleted — heartbeats are no
// longer one of them — protected tables are never touched, a 0-day
// window disables a set, the run-now endpoint reports counts and audits.

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
import { runRetentionCleanup } from '../../src/services/retention';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

describe('retention (integration, Phase 3)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agent: PairedAgent;
  let workerId: string;
  let latestHbId: string;

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    jwt = await loginAsAdmin(app);
    agent = await pairAgent(app, jwt, { name: 'rig-ret', workerName: 'worker-ret', bootId: 'boot-ret' });
    const hb = await sendHeartbeat(app, agent, { service_state: 'active' });
    expect(hb.statusCode).toBe(200);
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    workerId = worker!.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function seedOldAndNew() {
    // Heartbeats (Phase 4): exactly one latest row per agent — age the row
    // created by the pairing heartbeat to 40 days. Retention must NOT delete
    // it however old it gets (CONTRACT-4 §4).
    const latest = await prisma.heartbeat.findUnique({ where: { agentId: agent.agentId } });
    latestHbId = latest!.id;
    await prisma.heartbeat.update({
      where: { agentId: agent.agentId },
      data: { receivedAt: daysAgo(40) },
    });
    // Pool snapshots (Phase 5): exactly one per-agent row — age it to
    // 40 days. Retention must NOT delete it (CONTRACT-5 B1), so the
    // deleted.pool_snapshots count stays 0 and the row survives.
    await prisma.poolSnapshot.create({
      data: {
        id: 'ps_agent',
        agentId: agent.agentId,
        provider: 'bntpool',
        lookupParam: 'WALLET-RET',
        workerName: 'worker-ret',
        found: true,
        fetchedAt: daysAgo(40),
        lastAttemptAt: daysAgo(40),
        fetchOk: true,
      },
    });
    // Alert notification + delivery: old (100d).
    await prisma.alertNotification.create({
      data: {
        id: 'an_old',
        dedupeKey: 'ret-test:1',
        condition: 'worker_dead',
        agentId: agent.agentId,
        workerId,
        title: 'lama',
        body: 'lama',
        createdAt: daysAgo(100),
      },
    });
    await prisma.alertDelivery.create({
      data: { id: 'ad_old', notificationId: 'an_old', channel: 'webhook', status: 'sent', at: daysAgo(100) },
    });
    // Commands: terminal old (100d), terminal recent, non-terminal old.
    const base = { agentId: agent.agentId, workerId, type: 'miner.status', payload: {} as never, requestedBy: 'test' };
    await prisma.command.create({
      data: { ...base, id: 'cmd_old_done', idempotencyKey: 'ret-1', status: 'SUCCEEDED', createdAt: daysAgo(100), finishedAt: daysAgo(100), expiresAt: daysAgo(99) },
    });
    await prisma.command.create({
      data: { ...base, id: 'cmd_new_done', idempotencyKey: 'ret-2', status: 'FAILED', createdAt: daysAgo(1), finishedAt: daysAgo(1), expiresAt: daysAgo(1) },
    });
    await prisma.command.create({
      data: { ...base, id: 'cmd_old_queued', idempotencyKey: 'ret-3', status: 'QUEUED', createdAt: daysAgo(100), expiresAt: daysAgo(99) },
    });
    // An old event (protected table).
    await prisma.event.create({
      data: { id: 'evt_old', agentId: agent.agentId, workerId, type: 'TEST', description: 'peristiwa lama', metadata: {} as never, createdAt: daysAgo(365) },
    });
  }

  it('run-now prunes only the configured sets and reports counts', async () => {
    await seedOldAndNew();
    const auditsBefore = await prisma.auditLog.count();

    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/retention/run',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const deleted = res.json().deleted;
    // Phase 4: heartbeats are never pruned — the count stays 0 and the
    // 40-day-old latest row survives.
    expect(deleted.heartbeats).toBe(0);
    // Phase 5: pool snapshots are per-agent state, never pruned.
    expect(deleted.pool_snapshots).toBe(0);
    expect(deleted.alert_notifications).toBe(1);
    expect(deleted.alert_deliveries).toBe(1);
    expect(deleted.commands).toBe(1);

    // Survivors.
    expect(await prisma.heartbeat.findUnique({ where: { id: latestHbId } })).not.toBeNull();
    expect(await prisma.poolSnapshot.findUnique({ where: { id: 'ps_agent' } })).not.toBeNull();
    expect(await prisma.command.findUnique({ where: { id: 'cmd_new_done' } })).not.toBeNull();
    // Protected: non-terminal command, old event, agent, user, session.
    expect(await prisma.command.findUnique({ where: { id: 'cmd_old_queued' } })).not.toBeNull();
    expect(await prisma.event.findUnique({ where: { id: 'evt_old' } })).not.toBeNull();
    expect(await prisma.agent.findUnique({ where: { id: agent.agentId } })).not.toBeNull();
    expect(await prisma.session.count({ where: { agentId: agent.agentId } })).toBeGreaterThan(0);
    expect(await prisma.user.count()).toBeGreaterThan(0);
    // Audit: the cleanup itself appended a row (audit logs are never pruned).
    const auditsAfter = await prisma.auditLog.count();
    expect(auditsAfter).toBeGreaterThan(auditsBefore);
    const cleanupRows = await prisma.auditLog.findMany({ where: { action: 'retention.cleanup' } });
    expect(cleanupRows.length).toBeGreaterThan(0);
  });

  it('a 0-day window disables that set', async () => {
    // The latest heartbeat row (already aged 40d by the previous test's
    // seed; retention would never delete it anyway — Phase 4) must survive
    // a cleanup run with retention_heartbeats_days=0 as well.
    await prisma.systemSetting.update({
      where: { key: 'retention_heartbeats_days' },
      data: { value: 0 as never },
    });
    try {
      const counts = await runRetentionCleanup(prisma, new Date(), 'test');
      expect(counts.heartbeats).toBe(0);
      expect(await prisma.heartbeat.findUnique({ where: { id: latestHbId } })).not.toBeNull();
    } finally {
      await prisma.systemSetting.update({
        where: { key: 'retention_heartbeats_days' },
        data: { value: 30 as never },
      });
    }
  });
});
