# CONTRACT-11 — Phase 11: Follow-up Replies on Tanya Agent (threaded updates)

Source: Satria's request 2026-11-29 ~00:21 WIB — "adain fitur balas
pesan per agent dan broadcast lagi sesuai dengan question_id nya, jadi
ada update nya gitu": from a broadcast's detail he wants to (a) reply
to ONE agent's answer, and (b) send the follow-up as a new broadcast,
both linked to the original question_id so the exchange forms a thread
with updates. Follow-up request 2026-11-29 ~00:25 WIB: the detail box
also gains a status filter (Dijawab / Dikerjakan / Menunggu / other
statuses).

This contract AMENDS CONTRACT-8 and CONTRACT-9. Everything there
stays in force except where this contract says otherwise.

## Principle

A follow-up is a NEW AgentQuestion row (its own id, its own 30-minute
TTL, its own answer) that points at the message it continues:

- `parent_question_id` — the immediately previous row in this agent's
  thread.
- `root_question_id` — the first row of this agent's thread (NULL on
  the root row itself, where the row is its own root).

Threads are PER AGENT: a broadcast follow-up fans out to the original
broadcast's agents, and each new row's parent is THAT agent's latest
row in the thread that started with its row in the original
broadcast. A follow-up carries a `kind` like any broadcast (default:
the parent/original kind; the dashboard user may switch it — a
question thread can receive an instruction follow-up and vice versa).
The runtime receives the parent exchange as context, so its answer is
an UPDATE, not a cold reply. The server still executes nothing;
bridges are still never involved; runtime-token-only poll/answer
endpoints are unchanged in shape.

## 1. Data model

`AgentQuestion` gains two nullable columns:

- `parent_question_id` TEXT NULL
- `root_question_id` TEXT NULL

plus indexes on both. Migration `phase11_question_followups` (two
ALTER TABLE ADD COLUMN + two CREATE INDEX). Existing rows are roots
(both NULL) — no backfill needed.

## 2. Endpoints (additions vs CONTRACT-8/9)

- `POST /api/questions/:questionId/followup` (JWT, OPERATOR/ADMIN) —
  body `{question, kind?}`. Creates ONE row for the SAME agent as the
  parent row, under a NEW broadcast_id, with parent = :questionId and
  root = parent.root_question_id ?? parent.id. kind defaults to the
  parent row's kind. Unknown parent → 404 `QUESTION_NOT_FOUND`.
  Response 201: `{broadcast_id, question_id, parent_question_id, kind}`.
  Audit: `question.followup` / `instruction.followup` (by kind).
- `POST /api/broadcasts/:broadcastId/followup` (JWT, OPERATOR/ADMIN) —
  body `{question, kind?, agent_ids?}`. Targets default to ALL agents
  that have a row in the original broadcast; `agent_ids` narrows to a
  subset (ids with no row in the original broadcast are skipped; zero
  valid targets → 400 `NO_VALID_AGENTS`). For each target, parent =
  that agent's latest row in the thread rooted at its original row
  (by asked_at, tie-break created order via asked_at + id scan in
  memory), root = the original row's id. kind defaults to the
  original broadcast's kind. Unknown broadcast → 404
  `BROADCAST_NOT_FOUND`. Response 201: `{broadcast_id, question_count,
  kind}` (the NEW broadcast id). Audit: `question.followup_broadcast`
  / `instruction.followup_broadcast` (by kind). WS event
  `broadcast.question_created` fires for the new broadcast, as usual.
- Question validation is identical to CONTRACT-8 (trim, non-empty,
  max 2000 chars; invalid kind → 400 via schema enum).
- Runtime poll — each item gains `parent`: NULL for roots, otherwise
  `{question_id, kind, question, answer, answered_at}` of the parent
  row, so the runtime answers with the previous exchange in view.
- Answer endpoint — unchanged.
- `GET /api/broadcasts/:broadcastId` — items gain (via DTO)
  `parent_question_id` and `root_question_id`; each item also gains
  `followups`: every later row in the same per-agent thread (root =
  this row, broadcast different from this one), ordered by asked_at
  asc, each a full question DTO plus `parent_question_id`. Items of a
  follow-up broadcast additionally carry `parent_question` (the parent
  row's text) so the dashboard can show what is being continued.
- `GET /api/broadcasts` — list items gain `is_followup` (true when the
  broadcast's rows have a parent).

Deleting a broadcast deletes only its own rows (CONTRACT-8 §3);
follow-up rows in other broadcasts keep their parent/root ids as
historical references (no cascade across broadcasts).

## 3. Runtime behaviour (agent.md Langkah 6 amendment)

The poll payload and the inbox file gain `parent` (same shape as the
poll's parent object; NULL/absent for roots). When `parent` is
present, the message is a FOLLOW-UP in a thread:

- Read the parent question/instruction AND its answer/report first.
- `kind = question` → investigate the CURRENT state and answer with
  what changed / the updated values (still read-only).
- `kind = instruction` → a new order continuing the thread: execute
  it once (dedup by THIS message's question_id, as always) and report
  the result, referencing what changed versus the parent when
  relevant.

## 4. Frontend (page Tanya Agent)

- Broadcast detail, per-agent item: a **Balas** button (OPERATOR/
  ADMIN) opens an inline composer under that row (textarea max 2000,
  kind toggle defaulting to that row's kind, Kirim Balasan). An
  instruction follow-up goes through the same danger ConfirmDialog
  pattern as the main form.
- Follow-ups of an item render nested under it (indented), each with
  its kind badge, question text, status chip, answer/report and
  timestamps — and its own Balas button, so a thread can continue.
- Detail header gains **Kirim Update ke Semua** (OPERATOR/ADMIN): a
  composer for a follow-up broadcast to all agents of this broadcast
  (same kind toggle + instruction confirmation).
- Status filter above the per-agent list: chips **Semua**,
  **Dijawab/Dikerjakan** (answered), **Menunggu** (queued),
  **Tidak menjawab/Tidak dikerjakan** (expired), with counts from the
  broadcast summary; labels are kind-aware like the existing status
  labels. Filtering is client-side over the detail items (nested
  follow-ups stay with their parent item).
- Broadcast list items that are follow-ups show a small "Update"
  badge.
- VIEWER stays read-only (no Balas / Kirim Update controls).

## 5. Checkpoint

Build + full local suite green → deploy (backend + frontend; NO
bridge change) and update agent.md, per the pattern of the earlier
phases. Satria's 2026-11-29 request for this feature is the go-ahead
for the build, the deploy, and the agent.md template edit.
