import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { runSweep } from '../../src/services/sweeper';
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

describe('multi-channel alerts (integration, Phase 2)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agent: PairedAgent;
  let stub: Server;
  let stubUrl: string;
  let received: Array<Record<string, unknown>>;

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    received = [];
    stub = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        try {
          received.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          received.push({ unparsed: raw });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as AddressInfo).port;
    stubUrl = `http://127.0.0.1:${port}/hook`;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  beforeEach(async () => {
    await resetDb(prisma);
    received.length = 0;
    jwt = await loginAsAdmin(app);
    agent = await pairAgent(app, jwt);
  });

  /** Worker MATI whose status began 20 minutes ago (past the 600s default). */
  async function makeAgedDeadWorker() {
    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 });
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.status).toBe('MATI');
    await prisma.worker.update({
      where: { id: worker!.id },
      data: { statusSince: new Date(Date.now() - 20 * 60_000) },
    });
    return worker!;
  }

  async function putSettings(patch: Record<string, unknown>) {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${jwt}` },
      payload: patch,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('notifies once per occurrence; a recurrence after clearing is a new notification', async () => {
    const worker = await makeAgedDeadWorker();
    await runSweep(prisma, new Date());
    expect(await prisma.alertNotification.count({ where: { condition: 'WORKER_MATI' } })).toBe(1);
    // Channels are disabled by default: notification exists, no deliveries.
    expect(await prisma.alertDelivery.count()).toBe(0);

    // Same occurrence, later sweeps: deduped.
    await runSweep(prisma, new Date());
    await runSweep(prisma, new Date());
    expect(await prisma.alertNotification.count({ where: { condition: 'WORKER_MATI' } })).toBe(1);

    // Condition clears, then recurs with a fresh status_since: new occurrence.
    await prisma.worker.update({ where: { id: worker.id }, data: { status: 'SEHAT', statusSince: new Date() } });
    await runSweep(prisma, new Date());
    expect(await prisma.alertNotification.count({ where: { condition: 'WORKER_MATI' } })).toBe(1);
    await prisma.worker.update({
      where: { id: worker.id },
      data: { status: 'MATI', statusSince: new Date(Date.now() - 20 * 60_000) },
    });
    await runSweep(prisma, new Date());
    expect(await prisma.alertNotification.count({ where: { condition: 'WORKER_MATI' } })).toBe(2);
  });

  it('does not notify before the dead-after threshold elapses', async () => {
    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 });
    await runSweep(prisma, new Date());
    expect(await prisma.alertNotification.count()).toBe(0);
  });

  it('records a successful webhook delivery and serves it via GET /api/alerts', async () => {
    await putSettings({ alert_webhook_url: stubUrl, alert_webhook_enabled: true });
    await makeAgedDeadWorker();
    await runSweep(prisma, new Date());

    expect(received).toHaveLength(1);
    expect(received[0].condition).toBe('WORKER_MATI');
    expect(received[0].title).toContain('MATI');

    const deliveries = await prisma.alertDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].channel).toBe('webhook');
    expect(deliveries[0].status).toBe('sent');
    expect(deliveries[0].error).toBeNull();

    const res = await app.inject({ method: 'GET', url: '/api/alerts', headers: { authorization: `Bearer ${jwt}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].condition).toBe('WORKER_MATI');
    expect(res.json().items[0].deliveries[0].status).toBe('sent');
  });

  it('records a failed telegram delivery without breaking the sweep', async () => {
    await putSettings({
      alert_telegram_bot_token: '123456:definitely-not-a-real-token',
      alert_telegram_chat_id: '424242',
      alert_telegram_enabled: true,
    });
    await makeAgedDeadWorker();
    const summary = await runSweep(prisma, new Date());
    expect(summary.alertsCreated).toBe(1);
    const deliveries = await prisma.alertDelivery.findMany({ where: { channel: 'telegram' } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('failed');
    expect(deliveries[0].error).toBeTruthy();
  });

  it('creates an AGENT_UNREACHABLE notification at the transition', async () => {
    await sendHeartbeat(app, agent, { service_state: 'active' });
    await prisma.agent.update({
      where: { id: agent.agentId },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) },
    });
    await runSweep(prisma, new Date());
    const notifications = await prisma.alertNotification.findMany({ where: { condition: 'AGENT_UNREACHABLE' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].agentId).toBe(agent.agentId);
  });

  it('POOL_STALL alerts fire only when the pool is configured', async () => {
    await sendHeartbeat(app, agent, { service_state: 'active' });
    await prisma.worker.update({
      where: { agentId: agent.agentId },
      data: { status: 'POOL_STALL', statusSince: new Date(Date.now() - 5 * 60_000) },
    });
    await runSweep(prisma, new Date());
    expect(await prisma.alertNotification.count({ where: { condition: 'WORKER_POOL_STALL' } })).toBe(0);
    await runSweep(prisma, new Date(), { poolConfigured: true });
    expect(await prisma.alertNotification.count({ where: { condition: 'WORKER_POOL_STALL' } })).toBe(1);
  });

  it('test endpoint sends through the configured channel and rejects unconfigured ones', async () => {
    const unconfigured = await app.inject({
      method: 'POST',
      url: '/api/settings/alerts/test',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { channel: 'telegram' },
    });
    expect(unconfigured.statusCode).toBe(400);

    await putSettings({ alert_webhook_url: stubUrl });
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/alerts/test',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { channel: 'webhook' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.status).toBe('sent');
    expect(received).toHaveLength(1);
    expect(received[0].condition).toBe('TEST');
  });

  it('the telegram bot token is write-only in settings', async () => {
    const secret = '999999:super-secret-token-value';
    await putSettings({ alert_telegram_bot_token: secret, alert_telegram_chat_id: '777' });
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${jwt}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().alert_telegram_configured).toBe(true);
    expect(res.json().alert_telegram_chat_id).toBe('777');
    expect(res.body).not.toContain(secret);
    expect(res.body).not.toContain('alert_telegram_bot_token');
  });
});
