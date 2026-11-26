// Heartbeat replace-latest (integration, Phase 4 CONTRACT-4): every report
// overwrites the agent's single heartbeat row, and retention never deletes
// that row however old it gets.

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
import { runRetentionCleanup } from '../../src/services/retention';

const DAY = 24 * 60 * 60 * 1000;

describe('heartbeat replace-latest (integration, Phase 4)', () => {
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
    agent = await pairAgent(app, jwt, { name: 'rig-hb4', workerName: 'worker-hb4', bootId: 'boot-hb4' });
  });

  it('two heartbeats leave exactly one row carrying the latest values', async () => {
    const first = await sendHeartbeat(app, agent, { hashrate_hs: 1.85, shares_local: 10 }, 6.8);
    expect(first.statusCode).toBe(200);
    const afterFirst = await prisma.heartbeat.findUnique({ where: { agentId: agent.agentId } });
    expect(afterFirst).not.toBeNull();

    const second = await sendHeartbeat(app, agent, { hashrate_hs: 2.2, shares_local: 42 }, 5.1);
    expect(second.statusCode).toBe(200);

    const rows = await prisma.heartbeat.findMany({ where: { agentId: agent.agentId } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(afterFirst!.id);
    expect(row.memAvailableGib).toBe(5.1);
    const snap = row.minerSnapshot as { hashrate_hs?: number; shares_local?: number };
    expect(snap.hashrate_hs).toBe(2.2);
    expect(snap.shares_local).toBe(42);
    expect(row.receivedAt.getTime()).toBeGreaterThanOrEqual(afterFirst!.receivedAt.getTime());
    expect(row.sessionId).toBe(agent.sessionId);
    expect(row.agentStatus).toBe('ONLINE');
  });

  it('VM-reported accepted/rejected shares land on the worker and persist when later heartbeats omit them', async () => {
    const hb1 = await sendHeartbeat(app, agent, { accepted_shares: 42, rejected_shares: 3 });
    expect(hb1.statusCode).toBe(200);
    let worker = await prisma.worker.findFirst({ where: { agentId: agent.agentId } });
    expect(worker?.acceptedShares).toBe(42);
    expect(worker?.rejectedShares).toBe(3);

    const hb2 = await sendHeartbeat(app, agent, { shares_local: 50 });
    expect(hb2.statusCode).toBe(200);
    worker = await prisma.worker.findFirst({ where: { agentId: agent.agentId } });
    expect(worker?.acceptedShares).toBe(42);
    expect(worker?.rejectedShares).toBe(3);
  });

  it('retention never deletes the latest heartbeat row, however old', async () => {
    const hb = await sendHeartbeat(app, agent, { service_state: 'active' });
    expect(hb.statusCode).toBe(200);
    // Age the single row far beyond the 30-day retention window.
    await prisma.heartbeat.update({
      where: { agentId: agent.agentId },
      data: { receivedAt: new Date(Date.now() - 90 * DAY) },
    });

    const counts = await runRetentionCleanup(prisma, new Date(), 'test');
    expect(counts.heartbeats).toBe(0);
    const row = await prisma.heartbeat.findUnique({ where: { agentId: agent.agentId } });
    expect(row).not.toBeNull();
  });
});
