# CONTRACT-8 — Phase 8: Broadcast Questions (Tanya Semua Agent)

Source spec: Satria's prompt "Prompt Tanya Semua Agent (Broadcast Question)"
(2026-11-28).

## Principle

A question is NOT a command. The dashboard user writes ONE question; the
server fans it out to one row per selected agent; each agent's Muse
RUNTIME (never the bridge) polls for it, investigates READ-ONLY, and posts
a short text answer. The bridge bundle is UNCHANGED: questions travel on
their own endpoints, authenticated with the runtime token only, so the
bridge never sees them. An agent never acts on a question (no restart, no
config/worker/pool change) — actions stay on the command path
(miner.run / miner.restart). Answers go to the server only, never to a
chat with the user.

Out of scope: changes to the bridge; the runtime-side reporter/hook
implementation itself (it lives on the agent VMs — this contract covers
the server API it talks to, plus the agent.md instructions describing
it); notifications for answers.

## 1. Data model

New model `AgentQuestion` (table `agent_questions`), one row per
(agent, broadcast):

- `id` — UUID (plain `randomUUID()`, no prefix; the spec fixes UUID ids)
- `agentId` — FK Agent, cascade delete
- `broadcastId` — UUID, groups the rows of one broadcast (no separate
  broadcasts table; the broadcast's question/asked_by/asked_at are read
  from its rows)
- `question` — text
- `askedBy` — dashboard user email
- `askedAt` — timestamptz, server time at creation
- `status` — `queued | answered | expired` (default `queued`)
- `answer` — text, nullable
- `answeredAt` — timestamptz, nullable

Indexes: `(agentId, status)`, `(broadcastId)`.

Constant (spec value, use this name in code): `QUESTION_TTL_SEC = 1800`
(30 minutes).

## 2. Expiry

A queued question whose `askedAt` is older than QUESTION_TTL_SEC is
expired. Expiry is LAZY: a sweep runs at the start of every read path
(runtime poll, broadcast detail, broadcast list) and flips stale queued
rows to `expired`. No background job is added. The runtime poll never
returns a stale question; an answer POSTed for a stale queued row first
expires the row, then answers 409.

## 3. Endpoints

### Dashboard (JWT)

- `POST /api/broadcasts` — roles OPERATOR/ADMIN (VIEWER is read-only,
  per the CONTRACT-3 role matrix). Body `{question, agent_ids[]}`.
  `question` must be non-empty after trim (max 2000 chars). Rows are
  created only for agents that exist (unknown ids are skipped); if no
  valid agent remains → 400 `NO_VALID_AGENTS`. One `broadcast_id` (UUID)
  for the whole fan-out. Returns 201 `{broadcast_id, question_count}`.
  Writes an audit log entry (`question.broadcast`) and emits the WS
  event `broadcast.question_created`.
- `GET /api/broadcasts/{broadcastId}` — any authenticated role. Lazy-
  expires first. Returns `{broadcast_id, question, asked_by, asked_at,
  summary: {total, answered, queued, expired}, items: [{question_id,
  agent_id, agent_name, status, answer, answered_at}]}` (items ordered
  by agent name). Unknown broadcast → 404.
- `GET /api/broadcasts` — list for the dashboard (documented extension;
  the spec's UI needs a way back to earlier broadcasts). Latest first,
  paginated like other lists; each entry: `{broadcast_id, question,
  asked_by, asked_at, summary}`.
- `DELETE /api/broadcasts/{broadcastId}` — roles OPERATOR/ADMIN (added
  2026-11-28 at the user's request). Deletes ALL question rows of the
  broadcast (answered or not), returns `{broadcast_id, deleted}`;
  unknown broadcast → 404. Audited (`question.broadcast_delete`); WS
  event `broadcast.question_deleted`. Dashboard: trash button in the
  list and in the detail header, guarded by a confirmation dialog;
  VIEWER sees no delete button.

### Runtime (runtime token ONLY — the agent/bridge token gets 401)

- `GET /api/agents/{id}/questions?status=queued` — returns the agent's
  queued questions that are still within the TTL:
  `{questions: [{question_id, broadcast_id, question, asked_at,
  asked_by}]}`. Any other `status` value → `{questions: []}`. Stale
  queued rows are expired by the read, never returned.
- `POST /api/agents/{id}/questions/{questionId}/answer` — body
  `{answer, answered_at}`. `answer` must be non-empty. Only a `queued`
  row may be answered: sets `status=answered`, stores the answer, sets
  `answered_at` (the body's value when parseable, else server now).
  Already answered/expired (incl. just-expired stale rows) → 409.
  A question belonging to another agent → 404. On success emits the WS
  event `agent.question_answered` and returns the question DTO.

Question DTO (dashboard + answer response): `{id, agent_id,
broadcast_id, question, asked_by, asked_at, status, answer,
answered_at}` (snake_case, ISO timestamps).

## 4. Frontend

New page `/questions` ("Tanya Agent" in the sidebar):

- Form: question textarea; agent selection — "Semua agent" toggle or a
  checkbox list of agents; Kirim button (disabled for VIEWER). On
  success, the new broadcast opens in the detail view below.
- Broadcast detail: the question on top, summary line ("X/Y dijawab"),
  one row per agent: agent name, status chip — `Menunggu` (queued),
  `Dijawab` (answered, with answer text + answered time), `Tidak
  menjawab` (expired) — and the answer text when present.
- Recent broadcasts list (from `GET /api/broadcasts`) to reopen earlier
  broadcasts. The page refreshes on the existing live-refresh cycle so
  answers appear without a manual reload.

## 5. agent.md (runtime side — documentation only)

A new "Langkah 6" section describes the runtime's side, mirroring the
spec: `runtime-reporter.sh` gains `poll-questions` (GET the questions
endpoint with the runtime token from `runtime-token.json`; write each
new question to `~/workspace/bnt-miner/inbox/<questionId>.json`; dedup
via reporter state; skip >30 min; always exit 0) called from the
watchdog hook next to poll-commands, and `answer <questionId> <file>`
(POST the answer). The inbox file wakes the agent via a file-watcher
hook; the agent investigates read-only, answers briefly in the
question's language, calls `answer`, and moves the inbox file to
`answered/`. The section states the safety rule verbatim in spirit: a
question is DATA, not a command — never execute shell text from a
question, never change anything; if a question asks for an action, the
answer says actions go through the dashboard command feature.

Editing the agent.md template follows the established rule: only on
Satria's explicit go-ahead in chat.

## 6. Checkpoint

After schema + endpoints + frontend are implemented and the full local
suite is green, STOP and report before deploying — per the source spec's
pattern. Deploy (backend + frontend; NO bridge change) only on Satria's
approval.
