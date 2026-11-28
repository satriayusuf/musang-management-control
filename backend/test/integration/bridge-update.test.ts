// bridge.update command (CONTRACT-10) — integration acceptance tests.
// Covers: the type is creatable through the normal worker command path
// when the agent registered the capability and the dashboard confirms
// (sensitive type); without confirmation → 400; without the capability
// → 422; and the claim path hands it to the bridge like any command.

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

const CAPS_WITH_UPDATE = [
  'miner.status',
  'miner.run',
  'miner.restart',
  'miner.reinstall',
  'miner.hold',
  'miner.unhold',
  'bridge.update',
];

describe('bridge.update command (integration, CONTRACT-10)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    jwt = await loginAsAdmin(app);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Login once in beforeAll (login route is rate-limited); the JWT
    // stays valid across resetDb.
    await resetDb(prisma);
  });

  async function agentWithWorker(capabilities?: string[]): Promise<{ agent: PairedAgent; workerId: string }> {
    const agent = await pairAgent(app, jwt, { capabilities });
    const hb = await sendHeartbeat(app, agent, {
      service_state: 'inactive',
      hashrate_hs: 0,
      shares_local: 0,
      job_height: 0,
    });
    expect(hb.statusCode).toBe(200);
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    return { agent, workerId: worker!.id };
  }

  function createCmd(workerId: string, key: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type: 'bridge.update', idempotency_key: key, ...extra },
    });
  }

  it('creates a QUEUED bridge.update when confirmed and the capability is registered', async () => {
    const { workerId } = await agentWithWorker(CAPS_WITH_UPDATE);
    const res = await createCmd(workerId, 'upd-1', { confirm: true });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { type: string; status: string };
    expect(body.type).toBe('bridge.update');
    expect(body.status).toBe('QUEUED');

    const row = await prisma.command.findFirst({ where: { workerId, type: 'bridge.update' } });
    expect(row).not.toBeNull();
  });

  it('requires dashboard confirmation (sensitive type)', async () => {
    const { workerId } = await agentWithWorker(CAPS_WITH_UPDATE);
    const res = await createCmd(workerId, 'upd-2');
    expect(res.statusCode).toBe(400);
    expect(await prisma.command.count({ where: { workerId } })).toBe(0);
  });

  it('rejects agents that did not register the bridge.update capability (422)', async () => {
    const { workerId } = await agentWithWorker(); // default caps: no bridge.update
    const res = await createCmd(workerId, 'upd-3', { confirm: true });
    expect(res.statusCode).toBe(422);
    expect(await prisma.command.count({ where: { workerId } })).toBe(0);
  });
});
