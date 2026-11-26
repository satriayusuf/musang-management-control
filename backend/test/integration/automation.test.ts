// Rule automation engine (integration, Phase 3 CONTRACT-3 §2): the engine
// runs inside runSweep — condition duration, cooldown, daily cap, duplicate
// guard, GAGAL_START skip events, master switch, agent_unreachable rules.

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
import { localDayStart } from '../../src/services/automation';

const MIN = 60_000;

describe('rule automation (integration, Phase 3)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let jwt: string;
  let agent: PairedAgent;
  let workerId: string;

  async function primeAgent() {
    await prisma.agent.update({
      where: { id: agent.agentId },
      data: { status: 'ONLINE', lastSeenAt: new Date() },
    });
  }

  async function setWorkerStatus(status: string, sinceMinutesAgo: number) {
    await prisma.worker.update({
      where: { id: workerId },
      data: { status, statusSince: new Date(Date.now() - sinceMinutesAgo * MIN), holdActive: false },
    });
  }

  async function createRule(body: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/automation/rules',
      headers: { authorization: `Bearer ${jwt}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  const matiRule = (over: Record<string, unknown> = {}) => ({
    name: 'Auto status saat MATI',
    enabled: true,
    condition: { kind: 'worker_status', status: 'MATI', for_sec: 300 },
    action: { type: 'miner.status' },
    target: { agent_ids: [agent.agentId] },
    cooldown_sec: 3600,
    max_per_day: 5,
    ...over,
  });

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    jwt = await loginAsAdmin(app);
    agent = await pairAgent(app, jwt, { name: 'rig-auto', workerName: 'worker-auto', bootId: 'boot-auto' });
    const hb = await sendHeartbeat(app, agent, { service_state: 'active' });
    expect(hb.statusCode).toBe(200);
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    workerId = worker!.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.command.deleteMany({});
    await prisma.automationRule.deleteMany({});
    await prisma.event.deleteMany({ where: { type: { in: ['RULE_FIRED', 'RULE_SKIPPED'] } } });
    await primeAgent();
    await setWorkerStatus('SEHAT', 1);
  });

  it('rule CRUD: defaults, validation, toggle, delete', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/automation/rules',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'Buruk', condition: { kind: 'worker_status', status: 'SEHAT', for_sec: 10 }, action: { type: 'miner.status' }, target: { agent_ids: 'all' } },
    });
    expect(bad.statusCode).toBe(400);

    const created = await createRule(matiRule({ enabled: false }));
    expect(created.enabled).toBe(false);
    expect(created.cooldown_sec).toBe(3600);
    expect(created.max_per_day).toBe(5);
    expect(created.fire_count_today).toBe(0);

    const toggled = await app.inject({
      method: 'POST',
      url: `/api/automation/rules/${created.id}/toggle`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { enabled: true },
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().enabled).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/automation/rules', headers: { authorization: `Bearer ${jwt}` } });
    expect(list.json().total).toBe(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/automation/rules/${created.id}`, headers: { authorization: `Bearer ${jwt}` } });
    expect(del.statusCode).toBe(204);
  });

  it('fires once when the condition has held for for_sec', async () => {
    const rule = await createRule(matiRule());
    await setWorkerStatus('MATI', 10);

    const summary = await runSweep(prisma, new Date());
    expect(summary.rulesFired).toBe(1);

    const commands = await prisma.command.findMany({ where: { source: 'automation' } });
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe('miner.status');
    expect(commands[0].ruleId).toBe(rule.id);
    expect(commands[0].requestedBy).toBe('automation');

    const fired = await prisma.event.findFirst({ where: { type: 'RULE_FIRED' } });
    expect(fired).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'automation.rule_fired', actor: 'automation' } });
    expect(audit).not.toBeNull();

    const updated = await prisma.automationRule.findUnique({ where: { id: rule.id } });
    expect(updated?.fireCountToday).toBe(1);
    expect(updated?.lastFiredAt).not.toBeNull();

    // Second sweep: cooldown (and the still-active command) block a re-fire.
    const again = await runSweep(prisma, new Date());
    expect(again.rulesFired).toBe(0);
    expect(await prisma.command.count({ where: { source: 'automation' } })).toBe(1);
  });

  it('does not fire before the duration is met', async () => {
    await createRule(matiRule());
    await setWorkerStatus('MATI', 1); // 1 min < for_sec 300s
    const summary = await runSweep(prisma, new Date());
    expect(summary.rulesFired).toBe(0);
    expect(await prisma.command.count({ where: { source: 'automation' } })).toBe(0);
  });

  it('cooldown alone blocks a re-fire after the first command is gone', async () => {
    const rule = await createRule(matiRule());
    await setWorkerStatus('MATI', 10);
    await runSweep(prisma, new Date());
    expect(await prisma.command.count({ where: { source: 'automation' } })).toBe(1);

    await prisma.command.deleteMany({}); // remove the active command
    const summary = await runSweep(prisma, new Date());
    expect(summary.rulesFired).toBe(0);
    expect(await prisma.command.count({ where: { source: 'automation' } })).toBe(0);
    const updated = await prisma.automationRule.findUnique({ where: { id: rule.id } });
    expect(updated?.fireCountToday).toBe(1);
  });

  it('daily cap blocks firing', async () => {
    const rule = await createRule(matiRule());
    await prisma.automationRule.update({
      where: { id: rule.id },
      data: { fireCountToday: 5, fireCountDate: localDayStart(new Date()), lastFiredAt: null },
    });
    await setWorkerStatus('MATI', 10);
    const summary = await runSweep(prisma, new Date());
    expect(summary.rulesFired).toBe(0);
    expect(await prisma.command.count({ where: { source: 'automation' } })).toBe(0);
  });

  it('duplicate active command guard blocks silently', async () => {
    await createRule(matiRule({ cooldown_sec: 0 }));
    await setWorkerStatus('MATI', 10);
    await prisma.command.create({
      data: {
        id: 'cmd_existing_active',
        agentId: agent.agentId,
        workerId,
        type: 'miner.status',
        payload: {} as never,
        idempotencyKey: 'manual-existing',
        status: 'QUEUED',
        requestedBy: 'admin@mikasu.lol',
        expiresAt: new Date(Date.now() + 10 * MIN),
      },
    });
    const summary = await runSweep(prisma, new Date());
    expect(summary.rulesFired).toBe(0);
    expect(await prisma.command.count({})).toBe(1);
    expect(await prisma.event.count({ where: { type: 'RULE_SKIPPED' } })).toBe(0);
  });

  it('GAGAL_START eligibility refusal is recorded as RULE_SKIPPED', async () => {
    const rule = await createRule(
      matiRule({
        name: 'Run lagi saat gagal start',
        condition: { kind: 'worker_status', status: 'GAGAL_START', for_sec: 60 },
        action: { type: 'miner.run' },
      }),
    );
    await setWorkerStatus('GAGAL_START', 10);
    const summary = await runSweep(prisma, new Date());
    expect(summary.rulesFired).toBe(0);
    expect(summary.ruleSkips).toBe(1);
    expect(await prisma.command.count({ where: { source: 'automation' } })).toBe(0);
    const skipped = await prisma.event.findFirst({ where: { type: 'RULE_SKIPPED' } });
    expect(skipped).not.toBeNull();
    expect((skipped!.metadata as Record<string, unknown>).rule_id).toBe(rule.id);
  });

  it('template-based rule action resolves the template type', async () => {
    const tpl = await prisma.commandTemplate.findFirst({ where: { type: 'miner.status' } });
    await createRule(matiRule({ action: { template_id: tpl!.id } }));
    await setWorkerStatus('MATI', 10);
    await runSweep(prisma, new Date());
    const commands = await prisma.command.findMany({ where: { source: 'automation' } });
    expect(commands).toHaveLength(1);
    expect(commands[0].templateId).toBe(tpl!.id);
  });

  it('master switch off: no rule fires', async () => {
    await createRule(matiRule());
    await setWorkerStatus('MATI', 10);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { automation_enabled: false },
    });
    expect(put.statusCode).toBe(200);
    try {
      const summary = await runSweep(prisma, new Date());
      expect(summary.rulesFired).toBe(0);
      expect(await prisma.command.count({ where: { source: 'automation' } })).toBe(0);
    } finally {
      await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { automation_enabled: true },
      });
    }
  });

  it('agent_unreachable rule fires in the same sweep that marks the agent unreachable', async () => {
    await createRule(
      matiRule({
        name: 'Status saat agent hilang',
        condition: { kind: 'agent_unreachable', for_sec: 60 },
        cooldown_sec: 0,
      }),
    );
    // Heartbeat stopped 10 minutes ago: the sweep marks the agent
    // UNREACHABLE (threshold 90s) and the rule's 60s duration is long met.
    await prisma.agent.update({
      where: { id: agent.agentId },
      data: { status: 'ONLINE', lastSeenAt: new Date(Date.now() - 10 * MIN) },
    });
    const summary = await runSweep(prisma, new Date());
    expect(summary.agentsMarkedUnreachable).toBe(1);
    expect(summary.rulesFired).toBe(1);
    const commands = await prisma.command.findMany({ where: { source: 'automation' } });
    expect(commands).toHaveLength(1);
    await primeAgent();
  });
});
