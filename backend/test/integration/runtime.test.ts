// Runtime monitoring (CONTRACT-7) — integration acceptance tests.
// Covers: token issuance on every registration path + rotation, the
// runtime event contract (A11 400 / A12 401 with NO state change), the
// combined-status transitions driven by runtime events, SNAPSHOT state,
// and the runtime command-queue path (read without claiming, result
// from QUEUED, exactly-once, rejection as Ditolak).

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

const BOOT = '2026-11-28T02:12:12+07:00';
const iso = (d: Date) => d.toISOString();

function vmReplaced(at: Date) {
  return { type: 'VM_REPLACED', occurred_at: iso(at), boot_time: BOOT };
}
function recoveryOk(at: Date) {
  return {
    type: 'RECOVERY_OK',
    occurred_at: iso(at),
    boot_time: BOOT,
    pid: 2028,
    primer_gib: 6.66,
    mem_available_gib: 1.27,
  };
}
function recoveryFailed(at: Date, reason = 'memori tidak cukup') {
  return {
    type: 'RECOVERY_FAILED',
    occurred_at: iso(at),
    boot_time: BOOT,
    reason,
    mem_available_gib: 0.4,
  };
}
function snapshot(at: Date) {
  return {
    type: 'SNAPSHOT',
    occurred_at: iso(at),
    hashrate_local: 1.91,
    shares_local: 7,
    pool_accepted: 185,
    pool_last_share_at: iso(at),
    mem_available_gib: 2.5,
  };
}

describe('runtime monitoring (integration, CONTRACT-7)', () => {
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
    await resetDb(prisma);
  });

  function postEvent(agent: PairedAgent, payload: unknown, token: string | null = agent.runtimeToken) {
    return app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/events`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: payload as Record<string, unknown>,
    });
  }

  async function agentDetail(agent: PairedAgent) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.agentId}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, never>;
  }

  async function workerOf(agent: PairedAgent) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/workers',
      headers: { authorization: `Bearer ${jwt}` },
    });
    const items = (res.json() as { items: Array<Record<string, never>> }).items;
    return items.find((w) => w.agent_id === agent.agentId);
  }

  async function createCommand(agent: PairedAgent, type: string): Promise<string> {
    const worker = await workerOf(agent);
    expect(worker).toBeTruthy();
    const res = await app.inject({
      method: 'POST',
      url: `/api/workers/${worker!.id}/commands`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { type, idempotency_key: `rt-${type}-${Math.random()}`, confirm: true },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it('pairing registration returns a runtime_token and the state row exists', async () => {
    const agent = await pairAgent(app, jwt);
    expect(typeof agent.runtimeToken).toBe('string');
    expect(agent.runtimeToken.length).toBeGreaterThan(10);
    const state = await prisma.agentRuntimeState.findUnique({ where: { agentId: agent.agentId } });
    expect(state?.runtimeTokenHash).toBeTruthy();
    expect(state?.runtimeTokenHash).not.toBe(agent.runtimeToken);
    const detail = await agentDetail(agent);
    expect((detail.runtime as { token_issued: boolean }).token_issued).toBe(true);
    // The raw value must never leak through the dashboard API.
    expect(JSON.stringify(detail)).not.toContain(agent.runtimeToken);
  });

  it('self-register also returns a runtime_token that can post events', async () => {
    const keyRow = await prisma.systemSetting.findUnique({ where: { key: 'enrollment_key' } });
    const key = keyRow?.value as unknown as string;
    const res = await app.inject({
      method: 'POST',
      url: '/api/bridge/self-register',
      payload: {
        enrollment_key: key,
        agent_name: 'rig-self-rt',
        worker_name: 'czx-utama-selfrt',
        boot_id: 'boot-self-1',
        capabilities: ['miner.run'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { agent_id: string; runtime_token: string };
    expect(body.runtime_token).toBeTruthy();
    const ev = await app.inject({
      method: 'POST',
      url: `/api/agents/${body.agent_id}/events`,
      headers: { authorization: `Bearer ${body.runtime_token}` },
      payload: vmReplaced(new Date()),
    });
    expect(ev.statusCode).toBe(201);
  });

  it('VM_REPLACED -> combined PULIH (bridge silent), timeline event written', async () => {
    const agent = await pairAgent(app, jwt);
    const res = await postEvent(agent, vmReplaced(new Date()));
    expect(res.statusCode).toBe(201);

    const detail = await agentDetail(agent);
    expect(detail.combined_status).toBe('PULIH');
    const runtime = detail.runtime as { last_transition_type: string; boot_time: string };
    expect(runtime.last_transition_type).toBe('VM_REPLACED');
    expect(runtime.boot_time).toBeTruthy();

    const events = await prisma.event.findMany({
      where: { agentId: agent.agentId, type: 'VM_REPLACED' },
    });
    expect(events.length).toBe(1);
    expect((events[0].metadata as { source?: string }).source).toBe('runtime');
  });

  it('RECOVERY_OK + fresh active heartbeat -> combined JALAN', async () => {
    const agent = await pairAgent(app, jwt);
    await postEvent(agent, vmReplaced(new Date()));
    const ok = await postEvent(agent, recoveryOk(new Date()));
    expect(ok.statusCode).toBe(201);
    const hb = await sendHeartbeat(app, agent);
    expect(hb.statusCode).toBe(200);
    const worker = await workerOf(agent);
    expect(worker?.combined_status).toBe('JALAN');
  });

  it('RECOVERY_OK mirrors into worker.lastRecoveryAt (forward only)', async () => {
    const agent = await pairAgent(app, jwt);
    await sendHeartbeat(app, agent);
    // The first heartbeat may itself stamp lastRecoveryAt via the legacy
    // path (initial status -> SEHAT). Clear it so the assertions below
    // isolate the runtime mirror.
    await prisma.worker.updateMany({ where: { agentId: agent.agentId }, data: { lastRecoveryAt: null } });
    const t1 = new Date(Date.now() - 60_000);
    const res = await postEvent(agent, recoveryOk(t1));
    expect(res.statusCode).toBe(201);
    let worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.lastRecoveryAt?.getTime()).toBe(t1.getTime());

    // An older out-of-order RECOVERY_OK must not move the column back.
    const t0 = new Date(t1.getTime() - 30_000);
    await postEvent(agent, recoveryOk(t0));
    worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.lastRecoveryAt?.getTime()).toBe(t1.getTime());

    // VM_REPLACED is not a recovery: the column stays.
    await postEvent(agent, vmReplaced(new Date()));
    worker = await prisma.worker.findUnique({ where: { agentId: agent.agentId } });
    expect(worker?.lastRecoveryAt?.getTime()).toBe(t1.getTime());
  });

  it('RECOVERY_FAILED -> combined MATI with the reason, beating a fresh heartbeat', async () => {
    const agent = await pairAgent(app, jwt);
    await sendHeartbeat(app, agent);
    const res = await postEvent(agent, recoveryFailed(new Date(), 'memori tidak cukup'));
    expect(res.statusCode).toBe(201);
    const detail = await agentDetail(agent);
    expect(detail.combined_status).toBe('MATI');
    expect(String(detail.combined_status_reason)).toContain('memori tidak cukup');
  });

  it('SNAPSHOT stores snapshot fields and does not overwrite the transition', async () => {
    const agent = await pairAgent(app, jwt);
    await postEvent(agent, vmReplaced(new Date()));
    const res = await postEvent(agent, snapshot(new Date()));
    expect(res.statusCode).toBe(201);
    const detail = await agentDetail(agent);
    expect(detail.combined_status).toBe('PULIH');
    const runtime = detail.runtime as {
      last_transition_type: string;
      snapshot: { hashrate_hs: number; shares_local: number; pool_accepted: number };
    };
    expect(runtime.last_transition_type).toBe('VM_REPLACED');
    expect(runtime.snapshot.hashrate_hs).toBe(1.91);
    expect(runtime.snapshot.shares_local).toBe(7);
    expect(runtime.snapshot.pool_accepted).toBe(185);
    // SNAPSHOT writes no timeline event.
    const snapEvents = await prisma.event.count({ where: { agentId: agent.agentId, type: 'SNAPSHOT' } });
    expect(snapEvents).toBe(0);
  });

  it('A11: invalid payloads -> 400 and NO state change', async () => {
    const agent = await pairAgent(app, jwt);
    const unknown = await postEvent(agent, { type: 'NOPE', occurred_at: iso(new Date()), boot_time: BOOT });
    expect(unknown.statusCode).toBe(400);
    const missing = await postEvent(agent, { type: 'VM_REPLACED', boot_time: BOOT });
    expect(missing.statusCode).toBe(400);
    const noReason = await postEvent(agent, {
      type: 'RECOVERY_FAILED',
      occurred_at: iso(new Date()),
      boot_time: BOOT,
      mem_available_gib: 0.4,
    });
    expect(noReason.statusCode).toBe(400);

    const state = await prisma.agentRuntimeState.findUnique({ where: { agentId: agent.agentId } });
    expect(state?.lastEventType).toBeNull();
    expect(state?.lastContactAt).toBeNull();
    const detail = await agentDetail(agent);
    expect((detail.runtime as { last_event_type: unknown }).last_event_type).toBeNull();
  });

  it('A12: wrong or missing token -> 401 and NO state change', async () => {
    const agent = await pairAgent(app, jwt);
    const wrong = await postEvent(agent, vmReplaced(new Date()), 'token-ngawur');
    expect(wrong.statusCode).toBe(401);
    const none = await postEvent(agent, vmReplaced(new Date()), null);
    expect(none.statusCode).toBe(401);
    const state = await prisma.agentRuntimeState.findUnique({ where: { agentId: agent.agentId } });
    expect(state?.lastEventType).toBeNull();
  });

  it('runtime queue read does NOT claim; runtime result from QUEUED verifies via heartbeat; second result 409', async () => {
    const agent = await pairAgent(app, jwt);
    const cmdId = await createCommand(agent, 'miner.run');

    const list = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.agentId}/commands?status=queued`,
      headers: { authorization: `Bearer ${agent.runtimeToken}` },
    });
    expect(list.statusCode).toBe(200);
    const commands = (list.json() as { commands: Array<{ id: string }> }).commands;
    expect(commands.map((c) => c.id)).toContain(cmdId);
    // Still QUEUED — the read must not claim.
    let row = await prisma.command.findUnique({ where: { id: cmdId } });
    expect(row?.status).toBe('QUEUED');

    const result = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/commands/${cmdId}/result`,
      headers: { authorization: `Bearer ${agent.runtimeToken}` },
      payload: { status: 'succeeded', output: 'started by runtime' },
    });
    expect(result.statusCode).toBe(200);
    expect((result.json() as { verification: string }).verification).toBe('pending');

    // Heartbeat verification completes it (state-changing type).
    await sendHeartbeat(app, agent);
    row = await prisma.command.findUnique({ where: { id: cmdId } });
    expect(row?.status).toBe('SUCCEEDED');

    // Exactly-once: a second result is refused.
    const again = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/commands/${cmdId}/result`,
      headers: { authorization: `Bearer ${agent.runtimeToken}` },
      payload: { status: 'succeeded' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('runtime rejection is stored as Ditolak (reported_status rejected + reason)', async () => {
    const agent = await pairAgent(app, jwt);
    const cmdId = await createCommand(agent, 'miner.restart');
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/commands/${cmdId}/result`,
      headers: { authorization: `Bearer ${agent.runtimeToken}` },
      payload: { status: 'rejected', error_reason: 'LOW_MEMORY' },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.command.findUnique({ where: { id: cmdId } });
    expect(row?.status).toBe('FAILED');
    expect(row?.errorReason).toBe('LOW_MEMORY');
    expect((row?.result as { reported_status?: string }).reported_status).toBe('rejected');
    const events = await prisma.event.findMany({ where: { agentId: agent.agentId, type: 'COMMAND_REJECTED' } });
    expect(events.length).toBe(1);
  });

  it('re-attach rotates the runtime token: old token 401, new token works', async () => {
    const agent = await pairAgent(app, jwt);
    const re = await app.inject({
      method: 'POST',
      url: '/api/agents/register',
      headers: { authorization: `Bearer ${agent.token}` },
      payload: {
        agent_id: agent.agentId,
        boot_id: 'boot-0002',
        boot_time: iso(new Date()),
        bridge_version: '1.0.0',
        capabilities: ['miner.run'],
      },
    });
    expect(re.statusCode).toBe(200);
    const newToken = (re.json() as { runtime_token: string }).runtime_token;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(agent.runtimeToken);

    const oldUse = await postEvent(agent, vmReplaced(new Date()), agent.runtimeToken);
    expect(oldUse.statusCode).toBe(401);
    const newUse = await postEvent(agent, vmReplaced(new Date()), newToken);
    expect(newUse.statusCode).toBe(201);
  });

  it('bridge agent token still uses the legacy ad-hoc event path (unchanged)', async () => {
    const agent = await pairAgent(app, jwt);
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/events`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { type: 'AGENT_SHUTDOWN', description: 'bridge shutdown', session_id: agent.sessionId },
    });
    expect(res.statusCode).toBe(201);
    const state = await prisma.agentRuntimeState.findUnique({ where: { agentId: agent.agentId } });
    expect(state?.lastEventType).toBeNull();
  });
});
