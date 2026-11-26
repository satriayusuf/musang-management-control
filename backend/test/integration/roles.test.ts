// Multi-user roles (integration, Phase 3 CONTRACT-3 §1): role matrix,
// user management API, disabled-login, self-protection, enrollment key
// visibility in settings.
//
// Login budget: the login endpoint allows 10/min per app instance; this
// file performs exactly 8 logins.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { ADMIN_EMAIL, buildTestApp, createTestPrisma, loginAsAdmin, migrateTestDb, resetDb } from './helpers';

describe('multi-user roles (integration, Phase 3)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let adminJwt: string;
  let operatorJwt: string;
  let viewerJwt: string;
  let operatorId: string;
  let viewerId: string;
  let adminId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function login(email: string, password: string) {
    return app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  }

  async function createUser(token: string, body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/users', headers: auth(token), payload: body });
  }

  beforeAll(async () => {
    migrateTestDb();
    prisma = createTestPrisma();
    app = await buildTestApp(prisma);
    await resetDb(prisma);
    adminJwt = await loginAsAdmin(app); // login #1
    const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    adminId = admin!.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('ADMIN creates OPERATOR and VIEWER users; duplicates and bad roles rejected', async () => {
    const op = await createUser(adminJwt, { email: 'operator@mikasu.lol', password: 'operator-pass-1', role: 'OPERATOR' });
    expect(op.statusCode).toBe(201);
    const opBody = op.json();
    expect(opBody.role).toBe('OPERATOR');
    expect(opBody.disabled).toBe(false);
    expect(opBody.password_hash).toBeUndefined();
    expect(opBody.passwordHash).toBeUndefined();
    operatorId = opBody.id;

    const vw = await createUser(adminJwt, { email: 'viewer@mikasu.lol', password: 'viewer-pass-1', role: 'VIEWER' });
    expect(vw.statusCode).toBe(201);
    viewerId = vw.json().id;

    const dup = await createUser(adminJwt, { email: 'operator@mikasu.lol', password: 'whatever-pass', role: 'VIEWER' });
    expect(dup.statusCode).toBe(409);

    const badRole = await createUser(adminJwt, { email: 'x@mikasu.lol', password: 'whatever-pass', role: 'SUPERUSER' });
    expect(badRole.statusCode).toBe(400);

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: auth(adminJwt) });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(3);

    const audits = await prisma.auditLog.count({ where: { action: 'user.create' } });
    expect(audits).toBe(2);
  });

  it('login responses and /me carry the role', async () => {
    const op = await login('operator@mikasu.lol', 'operator-pass-1'); // login #2
    expect(op.statusCode).toBe(200);
    expect(op.json().user.role).toBe('OPERATOR');
    operatorJwt = op.json().token;

    const vw = await login('viewer@mikasu.lol', 'viewer-pass-1'); // login #3
    expect(vw.statusCode).toBe(200);
    expect(vw.json().user.role).toBe('VIEWER');
    viewerJwt = vw.json().token;

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(operatorJwt) });
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe('OPERATOR');
  });

  it('VIEWER is read-only: every write route returns 403', async () => {
    const reads = await app.inject({ method: 'GET', url: '/api/workers', headers: auth(viewerJwt) });
    expect(reads.statusCode).toBe(200);

    const attempts: Array<{ method: 'POST' | 'PUT'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'POST', url: '/api/workers/wrk_anything/commands', payload: { type: 'miner.status', idempotency_key: 'viewer-1' } },
      { method: 'POST', url: '/api/commands/broadcast', payload: { type: 'miner.status', agent_ids: ['agt_x'], idempotency_key: 'viewer-2' } },
      { method: 'POST', url: '/api/command-templates', payload: { name: 'X', type: 'miner.status' } },
      { method: 'PUT', url: '/api/settings', payload: { command_ttl_sec: 120 } },
      { method: 'POST', url: '/api/agents/pairing', payload: { planned_name: 'nope' } },
      { method: 'POST', url: '/api/users', payload: { email: 'z@mikasu.lol', password: 'z-pass-12345', role: 'VIEWER' } },
      { method: 'POST', url: '/api/settings/alerts/test', payload: { channel: 'webhook' } },
      { method: 'POST', url: '/api/settings/retention/run' },
    ];
    for (const attempt of attempts) {
      const res = await app.inject({ ...attempt, headers: auth(viewerJwt) });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
    }

    const users = await app.inject({ method: 'GET', url: '/api/users', headers: auth(viewerJwt) });
    expect(users.statusCode).toBe(403);
    const rules = await app.inject({ method: 'GET', url: '/api/automation/rules', headers: auth(viewerJwt) });
    expect(rules.statusCode).toBe(403);
    const schedules = await app.inject({ method: 'GET', url: '/api/schedules', headers: auth(viewerJwt) });
    expect(schedules.statusCode).toBe(403);
    const csv = await app.inject({ method: 'GET', url: '/api/export/agents.csv', headers: auth(viewerJwt) });
    expect(csv.statusCode).toBe(403);
  });

  it('OPERATOR can command and automate but not administer', async () => {
    const tpl = await app.inject({
      method: 'POST',
      url: '/api/command-templates',
      headers: auth(operatorJwt),
      payload: { name: 'Template Operator', type: 'miner.status' },
    });
    expect(tpl.statusCode).toBe(201);

    const rules = await app.inject({ method: 'GET', url: '/api/automation/rules', headers: auth(operatorJwt) });
    expect(rules.statusCode).toBe(200);

    const schedule = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: auth(operatorJwt),
      payload: {
        name: 'Jadwal Operator',
        cron: '0 9 * * *',
        action: { type: 'miner.status' },
        target: { agent_ids: 'all' },
      },
    });
    expect(schedule.statusCode).toBe(201);

    const denied: Array<{ method: 'GET' | 'POST' | 'PUT'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'GET', url: '/api/users' },
      { method: 'PUT', url: '/api/settings', payload: { command_ttl_sec: 120 } },
      { method: 'GET', url: '/api/export/commands.csv' },
      { method: 'POST', url: '/api/agents/pairing', payload: { planned_name: 'nope' } },
      { method: 'POST', url: '/api/settings/alerts/test', payload: { channel: 'webhook' } },
      { method: 'POST', url: '/api/settings/retention/run' },
      { method: 'POST', url: '/api/settings/enrollment-key/rotate' },
    ];
    for (const attempt of denied) {
      const res = await app.inject({ ...attempt, headers: auth(operatorJwt) });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
    }
  });

  it('enrollment_key is exposed in settings to ADMIN only', async () => {
    const adminSettings = await app.inject({ method: 'GET', url: '/api/settings', headers: auth(adminJwt) });
    expect(adminSettings.statusCode).toBe(200);
    expect(adminSettings.json().enrollment_key).toMatch(/^[0-9a-f]{64}$/);

    const operatorSettings = await app.inject({ method: 'GET', url: '/api/settings', headers: auth(operatorJwt) });
    expect(operatorSettings.statusCode).toBe(200);
    expect(operatorSettings.json().enrollment_key).toBeNull();

    const viewerSettings = await app.inject({ method: 'GET', url: '/api/settings', headers: auth(viewerJwt) });
    expect(viewerSettings.json().enrollment_key).toBeNull();
  });

  it('an admin cannot disable or demote themselves', async () => {
    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: auth(adminJwt),
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(400);

    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: auth(adminJwt),
      payload: { role: 'VIEWER' },
    });
    expect(demote.statusCode).toBe(400);

    const me = await prisma.user.findUnique({ where: { id: adminId } });
    expect(me?.disabledAt).toBeNull();
    expect(me?.role).toBe('ADMIN');
  });

  it('disabled users cannot log in until re-enabled', async () => {
    const created = await createUser(adminJwt, { email: 'disableme@mikasu.lol', password: 'disable-pass-1', role: 'VIEWER' });
    expect(created.statusCode).toBe(201);
    const targetId = created.json().id;

    const ok = await login('disableme@mikasu.lol', 'disable-pass-1'); // login #4
    expect(ok.statusCode).toBe(200);

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${targetId}`,
      headers: auth(adminJwt),
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().disabled).toBe(true);

    const blocked = await login('disableme@mikasu.lol', 'disable-pass-1'); // login #5
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toBe('ACCOUNT_DISABLED');
    expect(blocked.json().message).toMatch(/dinonaktifkan/);

    const enable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${targetId}`,
      headers: auth(adminJwt),
      payload: { disabled: false },
    });
    expect(enable.statusCode).toBe(200);

    const okAgain = await login('disableme@mikasu.lol', 'disable-pass-1'); // login #6
    expect(okAgain.statusCode).toBe(200);
  });

  it('password reset by ADMIN replaces the credential', async () => {
    const reset = await app.inject({
      method: 'POST',
      url: `/api/users/${viewerId}/reset-password`,
      headers: auth(adminJwt),
      payload: { password: 'viewer-pass-2' },
    });
    expect(reset.statusCode).toBe(200);

    const oldLogin = await login('viewer@mikasu.lol', 'viewer-pass-1'); // login #7
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await login('viewer@mikasu.lol', 'viewer-pass-2'); // login #8
    expect(newLogin.statusCode).toBe(200);

    const audits = await prisma.auditLog.count({ where: { action: 'user.reset_password', target: viewerId } });
    expect(audits).toBe(1);
    expect(operatorId).toBeTruthy();
  });
});
