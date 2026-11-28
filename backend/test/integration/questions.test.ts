// Broadcast questions (CONTRACT-8) — integration acceptance tests.
// Covers: fan-out creation (roles, unknown agents skipped, no valid
// agent → 400), runtime-token-ONLY polling (bridge token rejected),
// TTL behaviour (stale never returned, lazily expired), the answer path
// (200 once, 409 on repeat / after expiry / other agent's question),
// and the dashboard broadcast views.

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
  type PairedAgent,
} from './helpers';

describe('broadcast questions (integration, CONTRACT-8)', () => {
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
    // NOTE: no re-login here — the login route is rate-limited
    // (10/minute) and this file's tests run faster than that. The JWT
    // from beforeAll stays valid across resetDb (stateless token, same
    // seeded admin).
    await resetDb(prisma);
  });

  function createBroadcast(agentIds: string[], question = 'Berapa hashrate kamu sekarang?') {
    return app.inject({
      method: 'POST',
      url: '/api/broadcasts',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { question, agent_ids: agentIds },
    });
  }

  function pollQuestions(agent: PairedAgent, token: string | null = agent.runtimeToken) {
    return app.inject({
      method: 'GET',
      url: `/api/agents/${agent.agentId}/questions?status=queued`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  function postAnswer(agent: PairedAgent, questionId: string, answer: string, token: string | null = agent.runtimeToken) {
    return app.inject({
      method: 'POST',
      url: `/api/agents/${agent.agentId}/questions/${questionId}/answer`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { answer, answered_at: new Date().toISOString() },
    });
  }

  it('fans one question out to one queued row per agent', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q1' });
    const b = await pairAgent(app, jwt, { name: 'rig-q2', workerName: 'czx-utama-rw2x' });

    const res = await createBroadcast([a.agentId, b.agentId]);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { broadcast_id: string; question_count: number };
    expect(body.question_count).toBe(2);

    const rows = await prisma.agentQuestion.findMany({ where: { broadcastId: body.broadcast_id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'queued' && r.question.includes('hashrate'))).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/broadcasts/${body.broadcast_id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(detail.statusCode).toBe(200);
    const view = detail.json() as { summary: { total: number; queued: number }; items: Array<{ agent_name: string }> };
    expect(view.summary).toEqual({ total: 2, answered: 0, queued: 2, expired: 0 });
    expect(view.items.map((i) => i.agent_name).sort()).toEqual(['rig-q1', 'rig-q2']);
  });

  it('skips unknown agent ids and rejects a broadcast with no valid agent', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q3' });
    const res = await createBroadcast([a.agentId, 'agt_tidakada']);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { question_count: number }).question_count).toBe(1);

    const bad = await createBroadcast(['agt_tidakada']);
    expect(bad.statusCode).toBe(400);
  });

  it('rejects an empty question and unauthenticated creation', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q4' });
    const empty = await createBroadcast([a.agentId], '   ');
    expect(empty.statusCode).toBe(400);

    const anon = await app.inject({
      method: 'POST',
      url: '/api/broadcasts',
      payload: { question: 'halo', agent_ids: [a.agentId] },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('runtime poll returns queued questions; the BRIDGE token is rejected', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q5' });
    await createBroadcast([a.agentId]);

    const ok = await pollQuestions(a);
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { questions: Array<{ question_id: string; question: string }> };
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].question).toContain('hashrate');

    const bridge = await pollQuestions(a, a.token);
    expect(bridge.statusCode).toBe(401);

    const none = await pollQuestions(a, null);
    expect(none.statusCode).toBe(401);
  });

  it('answer flow: 200 once, then 409; dashboard shows the answer', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q6' });
    const created = await createBroadcast([a.agentId]);
    const { broadcast_id } = created.json() as { broadcast_id: string };
    const polled = await pollQuestions(a);
    const questionId = (polled.json() as { questions: Array<{ question_id: string }> }).questions[0].question_id;

    const answered = await postAnswer(a, questionId, 'Hashrate saya 1,91 H/s, semua normal.');
    expect(answered.statusCode).toBe(200);
    const dto = answered.json() as { status: string; answer: string };
    expect(dto.status).toBe('answered');
    expect(dto.answer).toContain('1,91');

    const again = await postAnswer(a, questionId, 'jawaban kedua');
    expect(again.statusCode).toBe(409);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/broadcasts/${broadcast_id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const view = detail.json() as {
      summary: { answered: number };
      items: Array<{ status: string; answer: string | null }>;
    };
    expect(view.summary.answered).toBe(1);
    expect(view.items[0].answer).toContain('1,91');

    // Nothing left queued for the runtime.
    const after = await pollQuestions(a);
    expect((after.json() as { questions: unknown[] }).questions).toHaveLength(0);
  });

  it("an agent cannot answer another agent's question (404)", async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q7' });
    const b = await pairAgent(app, jwt, { name: 'rig-q8', workerName: 'czx-utama-rw2x' });
    await createBroadcast([a.agentId]);
    const polled = await pollQuestions(a);
    const questionId = (polled.json() as { questions: Array<{ question_id: string }> }).questions[0].question_id;

    const res = await postAnswer(b, questionId, 'bukan pertanyaan saya');
    expect(res.statusCode).toBe(404);
  });

  it('stale questions are never returned and expire lazily; answering one is 409', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q9' });
    const created = await createBroadcast([a.agentId]);
    const { broadcast_id } = created.json() as { broadcast_id: string };
    // Age the row past the 30-minute TTL.
    await prisma.agentQuestion.updateMany({
      where: { broadcastId: broadcast_id },
      data: { askedAt: new Date(Date.now() - 31 * 60 * 1000) },
    });
    const row = await prisma.agentQuestion.findFirst({ where: { broadcastId: broadcast_id } });

    const polled = await pollQuestions(a);
    expect((polled.json() as { questions: unknown[] }).questions).toHaveLength(0);

    const after = await prisma.agentQuestion.findUnique({ where: { id: row!.id } });
    expect(after?.status).toBe('expired');

    const res = await postAnswer(a, row!.id, 'terlambat');
    expect(res.statusCode).toBe(409);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/broadcasts/${broadcast_id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect((detail.json() as { summary: { expired: number } }).summary.expired).toBe(1);
  });

  it('lists recent broadcasts with summaries', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q10' });
    await createBroadcast([a.agentId], 'Pertanyaan pertama?');
    await createBroadcast([a.agentId], 'Pertanyaan kedua?');

    const res = await app.inject({
      method: 'GET',
      url: '/api/broadcasts',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ question: string; summary: { total: number } }>; total: number };
    expect(body.total).toBe(2);
    expect(body.items[0].question).toBe('Pertanyaan kedua?');
    expect(body.items[0].summary.total).toBe(1);
  });

  it('deletes a whole broadcast; afterwards it is 404 and a second delete is 404', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q11' });
    const b = await pairAgent(app, jwt, { name: 'rig-q12', workerName: 'czx-utama-rw2x' });
    const created = await createBroadcast([a.agentId, b.agentId]);
    const { broadcast_id } = created.json() as { broadcast_id: string };

    const anon = await app.inject({ method: 'DELETE', url: `/api/broadcasts/${broadcast_id}` });
    expect(anon.statusCode).toBe(401);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/broadcasts/${broadcast_id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deleted: number }).deleted).toBe(2);
    expect(await prisma.agentQuestion.count({ where: { broadcastId: broadcast_id } })).toBe(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/broadcasts/${broadcast_id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(detail.statusCode).toBe(404);

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/broadcasts/${broadcast_id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(again.statusCode).toBe(404);
  });

  it('unknown broadcast id is 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/broadcasts/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // --- CONTRACT-9: broadcast instructions ---

  function createBroadcastWithKind(agentIds: string[], kind?: string, text = 'Ubah interval poll hook watchdog jadi 60 detik') {
    return app.inject({
      method: 'POST',
      url: '/api/broadcasts',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { question: text, agent_ids: agentIds, ...(kind ? { kind } : {}) },
    });
  }

  it('defaults to kind=question when kind is omitted (CONTRACT-9)', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q13' });
    const res = await createBroadcast([a.agentId]);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { broadcast_id: string; kind: string };
    expect(body.kind).toBe('question');

    const rows = await prisma.agentQuestion.findMany({ where: { broadcastId: body.broadcast_id } });
    expect(rows.every((r) => r.kind === 'question')).toBe(true);

    const polled = await pollQuestions(a);
    const items = (polled.json() as { questions: Array<{ kind: string }> }).questions;
    expect(items[0].kind).toBe('question');
  });

  it('kind=instruction fans out, polls with kind, and is answered with an execution report', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q14' });
    const b = await pairAgent(app, jwt, { name: 'rig-q15', workerName: 'czx-utama-rw2x' });

    const res = await createBroadcastWithKind([a.agentId, b.agentId], 'instruction');
    expect(res.statusCode).toBe(201);
    const body = res.json() as { broadcast_id: string; question_count: number; kind: string };
    expect(body.kind).toBe('instruction');
    expect(body.question_count).toBe(2);

    const rows = await prisma.agentQuestion.findMany({ where: { broadcastId: body.broadcast_id } });
    expect(rows.every((r) => r.kind === 'instruction')).toBe(true);

    // The instruction is audited under its own action.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'instruction.broadcast', target: body.broadcast_id } });
    expect(audit).not.toBeNull();

    // Runtime poll carries the kind so the runtime knows to execute.
    const polled = await pollQuestions(a);
    const items = (polled.json() as { questions: Array<{ question_id: string; kind: string; question: string }> }).questions;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('instruction');
    expect(items[0].question).toContain('watchdog');

    // The execution report comes back through the same answer endpoint.
    const answered = await postAnswer(a, items[0].question_id, 'Selesai: interval poll watchdog diubah ke 60 detik.');
    expect(answered.statusCode).toBe(200);
    const dto = answered.json() as { status: string; kind: string; answer: string };
    expect(dto.status).toBe('answered');
    expect(dto.kind).toBe('instruction');
    expect(dto.answer).toContain('60 detik');

    // Dashboard detail + list expose the kind.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/broadcasts/${body.broadcast_id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect((detail.json() as { kind: string }).kind).toBe('instruction');

    const list = await app.inject({
      method: 'GET',
      url: '/api/broadcasts',
      headers: { authorization: `Bearer ${jwt}` },
    });
    const listBody = list.json() as { items: Array<{ broadcast_id: string; kind: string }> };
    expect(listBody.items.find((i) => i.broadcast_id === body.broadcast_id)?.kind).toBe('instruction');
  });

  it('rejects an unknown kind (400)', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q16' });
    const res = await createBroadcastWithKind([a.agentId], 'perintah');
    expect(res.statusCode).toBe(400);
    expect(await prisma.agentQuestion.count()).toBe(0);
  });

  // --- CONTRACT-11: follow-up replies (threaded updates) ---

  function followupQuestion(questionId: string, payload: { question: string; kind?: string }) {
    return app.inject({
      method: 'POST',
      url: `/api/questions/${questionId}/followup`,
      headers: { authorization: `Bearer ${jwt}` },
      payload,
    });
  }

  function followupBroadcast(
    broadcastId: string,
    payload: { question: string; kind?: string; agent_ids?: string[] },
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/broadcasts/${broadcastId}/followup`,
      headers: { authorization: `Bearer ${jwt}` },
      payload,
    });
  }

  it('per-agent follow-up links parent/root, polls with parent context, and nests in detail', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q17' });
    const created = await createBroadcast([a.agentId]);
    const { broadcast_id } = created.json() as { broadcast_id: string };
    const polled = await pollQuestions(a);
    const root = (
      polled.json() as { questions: Array<{ question_id: string; parent: unknown }> }
    ).questions[0];
    expect(root.parent).toBeNull();
    await postAnswer(a, root.question_id, 'Hashrate 1,91 H/s.');

    const fu = await followupQuestion(root.question_id, { question: 'Sekarang berapa?' });
    expect(fu.statusCode).toBe(201);
    const fuBody = fu.json() as {
      broadcast_id: string;
      question_id: string;
      parent_question_id: string;
      kind: string;
    };
    expect(fuBody.parent_question_id).toBe(root.question_id);
    expect(fuBody.kind).toBe('question'); // defaults to the parent's kind
    expect(fuBody.broadcast_id).not.toBe(broadcast_id);

    const row = await prisma.agentQuestion.findUnique({ where: { id: fuBody.question_id } });
    expect(row?.parentQuestionId).toBe(root.question_id);
    expect(row?.rootQuestionId).toBe(root.question_id);
    expect(row?.agentId).toBe(a.agentId);

    // Runtime poll carries the parent exchange as context.
    const polled2 = await pollQuestions(a);
    const items = (
      polled2.json() as {
        questions: Array<{
          question_id: string;
          parent: { question_id: string; question: string; answer: string | null } | null;
        }>;
      }
    ).questions;
    expect(items).toHaveLength(1);
    expect(items[0].question_id).toBe(fuBody.question_id);
    expect(items[0].parent?.question_id).toBe(root.question_id);
    expect(items[0].parent?.answer).toContain('1,91');

    const answered = await postAnswer(a, fuBody.question_id, 'Sekarang 1,87 H/s.');
    expect(answered.statusCode).toBe(200);
    const dto = answered.json() as { parent_question_id: string | null; root_question_id: string | null };
    expect(dto.parent_question_id).toBe(root.question_id);
    expect(dto.root_question_id).toBe(root.question_id);

    // The original broadcast's detail nests the follow-up under the agent's row.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/broadcasts/${broadcast_id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const view = detail.json() as {
      items: Array<{ followups: Array<{ id: string; answer: string | null }> }>;
    };
    expect(view.items[0].followups).toHaveLength(1);
    expect(view.items[0].followups[0].id).toBe(fuBody.question_id);
    expect(view.items[0].followups[0].answer).toContain('1,87');
  });

  it('broadcast follow-up fans out per agent; a second round chains to the latest thread row', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q18' });
    const b = await pairAgent(app, jwt, { name: 'rig-q19', workerName: 'czx-utama-rw2x' });
    const created = await createBroadcast([a.agentId, b.agentId]);
    const { broadcast_id } = created.json() as { broadcast_id: string };
    const roots = await prisma.agentQuestion.findMany({ where: { broadcastId: broadcast_id } });
    const rootOf = (agentId: string) => roots.find((r) => r.agentId === agentId)!;

    const fu1 = await followupBroadcast(broadcast_id, { question: 'Update: berapa sekarang?' });
    expect(fu1.statusCode).toBe(201);
    const fu1Body = fu1.json() as { broadcast_id: string; question_count: number; kind: string };
    expect(fu1Body.question_count).toBe(2);
    const fu1Rows = await prisma.agentQuestion.findMany({ where: { broadcastId: fu1Body.broadcast_id } });
    for (const r of fu1Rows) {
      expect(r.parentQuestionId).toBe(rootOf(r.agentId).id);
      expect(r.rootQuestionId).toBe(rootOf(r.agentId).id);
    }

    // Second round against the ORIGINAL broadcast: parent = first follow-up row.
    const fu2 = await followupBroadcast(broadcast_id, { question: 'Update lagi?' });
    const fu2Body = fu2.json() as { broadcast_id: string };
    const fu2Rows = await prisma.agentQuestion.findMany({ where: { broadcastId: fu2Body.broadcast_id } });
    expect(fu2Rows).toHaveLength(2);
    for (const r of fu2Rows) {
      const expectedParent = fu1Rows.find((x) => x.agentId === r.agentId)!;
      expect(r.parentQuestionId).toBe(expectedParent.id);
      expect(r.rootQuestionId).toBe(rootOf(r.agentId).id);
    }

    // Subset targets: only agent a; unknown ids are skipped; none valid → 400.
    const fu3 = await followupBroadcast(broadcast_id, {
      question: 'Khusus A',
      agent_ids: [a.agentId, 'agt_tidakada'],
    });
    expect(fu3.statusCode).toBe(201);
    expect((fu3.json() as { question_count: number }).question_count).toBe(1);
    const none = await followupBroadcast(broadcast_id, {
      question: 'Tidak ada target',
      agent_ids: ['agt_tidakada'],
    });
    expect(none.statusCode).toBe(400);

    // The list marks follow-up broadcasts; the original is not one.
    const list = await app.inject({
      method: 'GET',
      url: '/api/broadcasts',
      headers: { authorization: `Bearer ${jwt}` },
    });
    const items = (list.json() as { items: Array<{ broadcast_id: string; is_followup: boolean }> }).items;
    expect(items.find((i) => i.broadcast_id === fu1Body.broadcast_id)?.is_followup).toBe(true);
    expect(items.find((i) => i.broadcast_id === broadcast_id)?.is_followup).toBe(false);
  });

  it('follow-up kind defaults to the original kind and can be overridden; invalid kind → 400', async () => {
    const a = await pairAgent(app, jwt, { name: 'rig-q20' });
    const created = await createBroadcastWithKind([a.agentId], 'instruction');
    const { broadcast_id } = created.json() as { broadcast_id: string };
    const root = await prisma.agentQuestion.findFirst({ where: { broadcastId: broadcast_id } });

    const def = await followupQuestion(root!.id, { question: 'Lanjut ubah ke 30 detik' });
    expect(def.statusCode).toBe(201);
    expect((def.json() as { kind: string }).kind).toBe('instruction');

    const over = await followupQuestion(root!.id, { question: 'Sudah berubah belum?', kind: 'question' });
    expect(over.statusCode).toBe(201);
    expect((over.json() as { kind: string }).kind).toBe('question');

    const bad = await followupQuestion(root!.id, { question: 'x', kind: 'perintah' });
    expect(bad.statusCode).toBe(400);
  });

  it('follow-up to an unknown question/broadcast is 404; unauthenticated follow-up is 401', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const r1 = await followupQuestion(missing, { question: 'halo' });
    expect(r1.statusCode).toBe(404);
    const r2 = await followupBroadcast(missing, { question: 'halo' });
    expect(r2.statusCode).toBe(404);
    const anon = await app.inject({
      method: 'POST',
      url: `/api/questions/${missing}/followup`,
      payload: { question: 'halo' },
    });
    expect(anon.statusCode).toBe(401);
  });
});
