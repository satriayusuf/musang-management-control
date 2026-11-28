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

describe('command templates (integration, Phase 2)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agent: PairedAgent;
  let workerId: string;

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
    agent = await pairAgent(app, jwt);
    await sendHeartbeat(app, agent, { service_state: 'inactive', hashrate_hs: 0, job_height: 0 });
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    workerId = worker!.id;
  });

  it('seeds the default templates at boot', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/command-templates', headers: { authorization: `Bearer ${jwt}` } });
    expect(res.statusCode).toBe(200);
    const names = res.json().items.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Cek Status Miner',
        'Jalankan Miner',
        'Restart Miner',
        'Tahan Auto-Recovery',
        'Lepas Tahan Auto-Recovery',
        'Reinstall Miner',
        'Perbarui Bridge',
      ]),
    );
    const run = res.json().items.find((t: { name: string }) => t.name === 'Jalankan Miner');
    expect(run.type).toBe('miner.run');
    expect(run.sensitive).toBe(true);
    const upd = res.json().items.find((t: { name: string }) => t.name === 'Perbarui Bridge');
    expect(upd.type).toBe('bridge.update');
    expect(upd.sensitive).toBe(true);
  });

  it('CRUD: create -> duplicate name 409 -> patch -> delete 204', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/command-templates',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'Hold 30 Menit', type: 'miner.hold', payload: { duration_minutes: 30 }, description: 'Tahan setengah jam' },
    });
    expect(created.statusCode).toBe(201);
    const tpl = created.json();
    expect(tpl.id).toMatch(/^tpl_/);
    expect(tpl.payload).toEqual({ duration_minutes: 30 });

    const dup = await app.inject({
      method: 'POST',
      url: '/api/command-templates',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'Hold 30 Menit', type: 'miner.hold' },
    });
    expect(dup.statusCode).toBe(409);

    const badType = await app.inject({
      method: 'POST',
      url: '/api/command-templates',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'Ngawur', type: 'miner.explode' },
    });
    expect(badType.statusCode).toBe(400);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/command-templates/${tpl.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { payload: { duration_minutes: 45 }, description: 'Diubah' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().payload).toEqual({ duration_minutes: 45 });
    expect(patched.json().description).toBe('Diubah');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/command-templates/${tpl.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(removed.statusCode).toBe(204);
    expect(await prisma.commandTemplate.findUnique({ where: { id: tpl.id } })).toBeNull();

    const removeAgain = await app.inject({
      method: 'DELETE',
      url: `/api/command-templates/${tpl.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(removeAgain.statusCode).toBe(404);
  });

  it('using a template in a single command records template_id and merges payloads', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/command-templates',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'Hold Panjang', type: 'miner.hold', payload: { duration_minutes: 30, note: 'dari template' } },
    });
    const tpl = created.json();

    const res = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { template_id: tpl.id, payload: { duration_minutes: 90 }, idempotency_key: 'tpl-use-1', confirm: true },
    });
    expect(res.statusCode).toBe(201);
    const cmd = res.json();
    expect(cmd.type).toBe('miner.hold');
    expect(cmd.template_id).toBe(tpl.id);
    // Explicit payload wins over template defaults; other template keys kept.
    expect(cmd.payload).toEqual({ duration_minutes: 90, note: 'dari template' });
    // It is a normal command: audit row exists.
    expect(await prisma.auditLog.count({ where: { action: 'command.create', target: cmd.id } })).toBe(1);
  });

  it('a mismatched explicit type next to template_id is rejected', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/command-templates', headers: { authorization: `Bearer ${jwt}` } });
    const tpl = list.json().items.find((t: { name: string }) => t.name === 'Cek Status Miner');
    const res = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { template_id: tpl.id, type: 'miner.run', idempotency_key: 'tpl-mismatch', confirm: true },
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.command.count()).toBe(0);
  });
});
