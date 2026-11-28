# CONTRACT-9 — Phase 9: Broadcast Instructions (mode eksekusi untuk Tanya Agent)

Source: Satria's request 2026-11-28 ~19:47 WIB — broadcasts must be able
to EXECUTE what he orders, e.g. "Ubah interval poll hook watchdog jadi
60 detik" must be executed by every selected agent, not just answered.

This contract AMENDS CONTRACT-8. Everything in CONTRACT-8 stays in
force except where this contract says otherwise.

## Principle

A broadcast now has a `kind`:

- `question` (default) — exactly CONTRACT-8: read-only investigation,
  text answer, never an action.
- `instruction` — an order from the dashboard owner. Each selected
  agent's Muse RUNTIME executes the instruction text on its own VM
  and reports back what it did through the SAME answer endpoint (the
  "answer" of an instruction is its execution report). Instructions
  travel on the same runtime-token-only endpoints; the bridge is still
  never involved and is UNCHANGED.

The kind is chosen by the dashboard user per broadcast, never by the
agent, and is visible everywhere the broadcast is shown. The server
itself executes nothing — it only fans the instruction out and collects
reports, exactly like questions.

## 1. Data model

`AgentQuestion` gains one column:

- `kind` — `question | instruction`, default `question` (existing rows
  and existing clients keep the CONTRACT-8 behaviour).

Migration: `phase9_broadcast_instructions` (single ALTER TABLE, default
fills existing rows).

## 2. Endpoints (changes vs CONTRACT-8)

- `POST /api/broadcasts` — body gains optional `kind`
  (`question | instruction`; anything else → 400 via schema enum).
  Roles unchanged (OPERATOR/ADMIN). Response gains `kind`. Audit
  action: `question.broadcast` for questions, `instruction.broadcast`
  for instructions. WS event `broadcast.question_created` payload gains
  `kind`.
- Runtime poll `GET /api/agents/{id}/questions?status=queued` — each
  item gains `kind`, so the runtime knows whether to investigate
  read-only or execute. TTL, lazy expiry, dedup semantics unchanged.
- Answer endpoint — unchanged. For an instruction, the posted text is
  the execution report (what was done, or why it could not be done).
- `GET /api/broadcasts` and `GET /api/broadcasts/{id}` — list items,
  detail, and the question DTO gain `kind`.

## 3. Runtime behaviour (agent.md Langkah 6 amendment)

The inbox file gains `kind`. The reporter's dedup rule becomes a
safety rule for instructions: the runtime records an instruction's id
in its state BEFORE executing it, so a crash or re-poll never executes
the same instruction twice; a re-polled id that is already recorded is
skipped (and reported from the recorded outcome when available).

- `kind = question` → CONTRACT-8 rules verbatim (read-only, never act).
- `kind = instruction` → the text is an order from the dashboard owner:
  execute it on this VM, then report briefly what was done (or the
  failure and its reason) via the same `answer` call, and move the
  inbox file to `answered/`.

Existing enrolled runtimes only honour `kind` once their local
runtime setup follows the amended agent.md (new enrollments get it
automatically); the server treats both kinds identically either way.

## 4. Frontend (page Tanya Agent)

- The form gains a mode toggle: **Pertanyaan** (default) /
  **Instruksi**. In Instruksi mode the helper text states plainly that
  the text will be EXECUTED by every selected agent, the textarea
  placeholder shows an instruction example, and the send button reads
  "Kirim Instruksi".
- Sending an instruction requires a confirmation dialog naming the
  instruction text and the number of target agents ("akan dieksekusi
  oleh N agent"). Questions send directly, as before.
- Broadcast list items and the detail header show a kind badge:
  "Pertanyaan" (neutral) / "Instruksi" (red accent). In the detail,
  per-agent status labels are kind-aware for instructions:
  answered → "Dikerjakan", expired → "Tidak dikerjakan",
  queued → "Menunggu". Question labels stay as CONTRACT-8.
- VIEWER stays read-only for both kinds.

## 5. Checkpoint

Build + full local suite green → deploy (backend + frontend; NO bridge
change) on Satria's go-ahead, per the pattern of the earlier phases.
His 2026-11-28 request for this feature, with the deploy flow of
Phases 7–8, is that go-ahead; the agent.md template edit is part of
this feature and is covered by the same request.
