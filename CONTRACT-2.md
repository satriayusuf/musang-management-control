# Muse Management Control — CONTRACT-2 (Phase 2 addendum)

Phase 1 contract (`CONTRACT.md`) stays in force; this file only adds Phase 2 scope
(spec v1.1 Bagian 18, Fase 2): **broadcast perintah, template perintah, analitik
penuh, alert multi-kanal, tahan auto-recovery dari UI**. Phase 3 items (rule/schedule
automation, multi-user roles, retention/export) remain NON-goals.

## 1. Command templates

New table `command_templates`: id `tpl_…`, name (unique), type (one of the six
command types), payload JSON (default params merged into the command), description,
sensitive boolean (informational; the confirm rule still derives from the type),
created_at/updated_at.

API (admin JWT):
- `GET /api/command-templates` — list.
- `POST /api/command-templates` {name, type, payload?, description?} → 201.
- `PATCH /api/command-templates/:id` — partial update.
- `DELETE /api/command-templates/:id` → 204.

Seeded defaults (created if absent at boot): "Cek Status Miner" (miner.status),
"Jalankan Miner" (miner.run), "Restart Miner" (miner.restart),
"Tahan Auto-Recovery" (miner.hold), "Lepas Tahan Auto-Recovery" (miner.unhold),
"Reinstall Miner" (miner.reinstall).

Using a template = creating a normal command (single or broadcast) with
`template_id` recorded on the command row (new nullable column `commands.template_id`).
Audit + verification behave exactly like manual commands (spec: no shortcuts).

## 2. Broadcast

New table `broadcast_batches`: id `bct_…`, type, template_id nullable, payload JSON,
requested_by (user id), total_count, created_count, skipped_count, created_at.
`commands` gains nullable `batch_id`.

API: `POST /api/commands/broadcast`
{type?, template_id?, agent_ids: [..] (explicit targets), confirm?, idempotency_key}
- Exactly one of type/template_id. Template resolves to its type+payload.
- Per-target fan-out in ONE transaction: for each agent, resolve its worker and apply
  the SAME eligibility rules as single create (capability, status gates: miner.run on
  GAGAL_START or TAK_TERJANGKAU-held cases). Ineligible targets are SKIPPED with a
  reason recorded in the response + batch counts — never fail the whole batch.
- State-changing types require confirm:true (else 422, nothing created).
- Idempotency: the batch idempotency_key is unique; per-command keys derive as
  `<batch_key>:<agent_id>` so a retried broadcast creates no duplicates.
- Response 201: {batch_id, created: [{agent_id, command_id}], skipped: [{agent_id, reason}]}.
- `GET /api/commands/batches` (list, with per-status counts) and
  `GET /api/commands/batches/:id` (batch + its commands) for the UI progress view.

## 3. Full analytics

Extend `GET /api/analytics` with `?range=24h|7d|30d` (default 7d) and add:
- `agents[]`: per agent — uptime_pct (share of range with an active session & recent
  heartbeat), sessions count, replacements count, commands count, success_rate,
  top_errors (up to 3 failure reasons with counts).
- `workers[]`: per worker — session duration distribution (min/median/max minutes),
  shares_per_session (avg, from heartbeats where available; null when no data),
  longest_share_gap_sec, recoveries {succeeded, failed, failed_low_memory}
  (from miner.run command outcomes + verification results), mem_at_session_start
  trend (series of {at, mem_available_gib} at each session start).
All values computed from real DB rows; empty ranges return zeros/nulls, never
fabricated numbers. Existing Phase 1 analytics fields keep working.

## 4. Multi-channel alerts

Conditions (evaluated in the existing sweeper tick, using system_settings):
- worker MATI continuously ≥ `alert_dead_after_sec` (default 600)
- worker GAGAL_START continuously ≥ `alert_dead_after_sec`
- agent transitions to TAK_TERJANGKAU (unreachable)
- worker POOL-STALL (only when pool configured)

One notification per occurrence: new table `alert_notifications`
(id, dedupe_key unique = `<condition>:<entity_id>:<occurrence_started_at>`,
condition, agent_id, worker_id, title, body, created_at) and
`alert_deliveries` (id, notification_id, channel, status sent/failed, error, at).
A condition that clears and recurs is a NEW occurrence (new dedupe key).

Channels (configured in system_settings, secrets write-only like the pool key):
- `webhook`: `alert_webhook_url` (+ `alert_webhook_enabled`) — POST JSON
  {title, body, condition, agent_id, worker_id, at} with 5s timeout.
- `telegram`: `alert_telegram_bot_token` (write-only), `alert_telegram_chat_id`,
  `alert_telegram_enabled` — Bot API sendMessage.
Both default disabled. Delivery failures are recorded, never crash the sweeper.

API: `GET /api/alerts` (recent notifications + deliveries),
`POST /api/settings/alerts/test` {channel} → sends a test message through the
configured channel, returns delivery result. Settings GET exposes
`alert_webhook_configured` / `alert_telegram_configured` booleans (never raw secrets).

## 5. Hold (tahan auto-recovery) from the UI

- `workers` gains `hold_active` boolean (default false), updated from every
  heartbeat snapshot (bridge reports hold state) and optimistically after a
  miner.hold/unhold command verifies.
- API: worker list/detail include `hold_active`. No new endpoints (hold/unhold are
  normal commands); the FRONTEND adds explicit Tahan/Lepas Tahan toggle buttons on
  the Miners page and worker/agent detail, showing current hold state, using the
  existing command flow with confirmation.

## 6. Frontend (Phase 2 pages)

- Pusat Perintah: target mode (Satu Agent | Broadcast), agent multi-select with
  status hints, template picker (from API) + template manager (create/edit/delete),
  broadcast result summary + batch progress list (auto-refresh via WS/poll).
- Analitik: range selector (24 jam / 7 hari / 30 hari), per-agent table, per-worker
  table, MemAvailable-at-session-start trend chart.
- Pengaturan: Alert section — webhook URL + enable toggle, Telegram token (write-only)
  + chat id + enable toggle, alert threshold seconds, "Kirim Tes" buttons, recent
  alert deliveries list.
- Miners + detail: hold state badge + Tahan/Lepas Tahan buttons.
All copy Bahasa Indonesia; reuse Phase 1 components/patterns.

## 7. Tests (must pass)

Backend unit+integration additions: template CRUD + use-in-command; broadcast
fan-out (eligible created, GAGAL_START skipped with reason, confirm required,
idempotent retry = no duplicates, batch counts); analytics range aggregates on
seeded data; alert dedupe (same occurrence once, new occurrence after clear),
webhook delivery recorded (local stub server), telegram disabled = no send;
hold_active flips via heartbeat snapshot + verified hold command.
Full Phase 1 suite must stay green. `npm run build` clean.

Migration: ONE new Prisma migration named `phase2` with the new tables/columns.
