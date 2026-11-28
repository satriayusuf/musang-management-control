// Shared helpers for integration tests: real Fastify app (inject) against the
// dedicated muse_control_test database.

import 'dotenv/config';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { seedAdmin } from '../../src/services/auth';
import { seedSettings } from '../../src/services/settings';
import { seedCommandTemplates } from '../../src/services/templates';
import { ensureEnrollmentKey } from '../../src/services/enrollment';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgresql://postgres:muse@127.0.0.1:5432/muse_control_test';

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@mikasu.lol';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin12345';

let migrated = false;

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
}

/** Run `prisma migrate deploy` against the test DB exactly once per process. */
export function migrateTestDb(): void {
  if (migrated) return;
  const enginesDir = `${process.cwd()}/node_modules/@prisma/engines`;
  execSync('npx prisma migrate deploy', {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      // Point the CLI at the locally installed engines (this VM's Node fetch
      // cannot download them through the egress proxy).
      PRISMA_QUERY_ENGINE_LIBRARY: `${enginesDir}/libquery_engine-debian-openssl-3.0.x.so.node`,
      PRISMA_SCHEMA_ENGINE_BINARY: `${enginesDir}/schema-engine-debian-openssl-3.0.x`,
      PRISMA_CLI_QUERY_ENGINE_TYPE: 'library',
    },
    stdio: 'pipe',
  });
  migrated = true;
}

const TABLES = [
  'alert_deliveries',
  'alert_notifications',
  'automation_rules',
  'schedules',
  'heartbeats',
  'agent_questions',
  'commands',
  'broadcast_batches',
  'command_templates',
  'events',
  'sessions',
  'workers',
  'agent_runtime_states',
  'agents',
  'pairing_codes',
  'audit_logs',
  'pool_snapshots',
  'system_settings',
  'users',
];

/** Wipe all rows and re-seed settings + admin (mirrors a fresh boot). */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await seedSettings(prisma);
  await seedAdmin(prisma);
  await seedCommandTemplates(prisma);
  await ensureEnrollmentKey(prisma);
}

export async function buildTestApp(prisma: PrismaClient): Promise<FastifyInstance> {
  const { app } = await buildApp({ prisma, logger: false });
  await app.ready();
  return app;
}

export async function loginAsAdmin(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`admin login failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { token: string }).token;
}

export interface PairedAgent {
  agentId: string;
  token: string;
  /** CONTRACT-7: raw runtime token from the register response. */
  runtimeToken: string;
  sessionId: string;
  workerId: string | null;
}

/** Full pairing flow through the public API: create code -> register bridge. */
export async function pairAgent(
  app: FastifyInstance,
  jwt: string,
  opts: { name?: string; workerName?: string; bootId?: string; capabilities?: string[] } = {},
): Promise<PairedAgent> {
  const name = opts.name ?? 'rig-test-1';
  const pairRes = await app.inject({
    method: 'POST',
    url: '/api/agents/pairing',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { planned_name: name },
  });
  if (pairRes.statusCode !== 201) throw new Error(`pairing failed: ${pairRes.statusCode} ${pairRes.body}`);
  const { pairing_code } = pairRes.json() as { pairing_code: string };

  const regRes = await app.inject({
    method: 'POST',
    url: '/api/agents/register',
    payload: {
      pairing_code,
      name,
      worker_name: opts.workerName ?? 'czx-utama-7d66',
      boot_id: opts.bootId ?? 'boot-0001',
      boot_time: new Date().toISOString(),
      bridge_version: '1.0.0',
      capabilities: opts.capabilities ?? [
        'miner.status',
        'miner.run',
        'miner.restart',
        'miner.reinstall',
        'miner.hold',
        'miner.unhold',
      ],
    },
  });
  if (regRes.statusCode !== 201) throw new Error(`register failed: ${regRes.statusCode} ${regRes.body}`);
  const reg = regRes.json() as {
    agent_id: string;
    agent_token: string;
    runtime_token: string;
    session_id: string;
  };
  return {
    agentId: reg.agent_id,
    token: reg.agent_token,
    runtimeToken: reg.runtime_token,
    sessionId: reg.session_id,
    workerId: null,
  };
}

export function heartbeatBody(sessionId: string, minerOverrides: Record<string, unknown> = {}, mem = 6.8) {
  return {
    session_id: sessionId,
    sent_at: new Date().toISOString(),
    host: { boot_id: 'boot-0001', mem_available_gib: mem },
    miner: {
      service_state: 'active',
      pid: 1757,
      session_no: 1,
      hashrate_hs: 1.85,
      shares_local: 10,
      last_share_at: new Date().toISOString(),
      job_height: 804,
      difficulty: 2,
      ...minerOverrides,
    },
  };
}

export async function sendHeartbeat(
  app: FastifyInstance,
  agent: PairedAgent,
  minerOverrides: Record<string, unknown> = {},
  mem = 6.8,
  sessionId?: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/agents/${agent.agentId}/heartbeat`,
    headers: { authorization: `Bearer ${agent.token}` },
    payload: heartbeatBody(sessionId ?? agent.sessionId, minerOverrides, mem),
  });
}
