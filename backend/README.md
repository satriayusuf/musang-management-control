# Muse Management Control — Backend

Single Fastify 5 + TypeScript process serving the REST API and the dashboard
WebSocket, backed by PostgreSQL via Prisma. The command queue is the
`commands` table (no Redis/BullMQ). See `../CONTRACT.md` for the Phase 1
contract and `../CONTRACT-2.md` for the Phase 2 addendum (broadcast, command
templates, full analytics, multi-channel alerts, hold state).

## Layout

```
prisma/schema.prisma        Data model (agents, sessions, heartbeats, workers,
                            commands, events, audit_logs, pairing_codes,
                            system_settings, pool_snapshots, users; Phase 2:
                            command_templates, broadcast_batches,
                            alert_notifications, alert_deliveries)
src/server.ts               Entrypoint: listen + sweeper (15s) + pool monitor
src/app.ts                  buildApp() factory (also used by tests)
src/plugins/                Prisma singleton, auth guards (requireUser / agent token)
src/services/status.ts      Pure worker-status calculation (SEHAT…POOL_STALL)
src/services/session.ts     Registration, re-attach, VM-replacement transitions
src/services/commands.ts    Atomic claim (SKIP LOCKED), lifecycle, verification
src/services/heartbeat.ts   Heartbeat processing + status recomputation
src/services/sweeper.ts     Unreachable agents, command expiry, verify timeouts,
                            alert evaluation (Phase 2)
src/services/settings.ts    system_settings defaults + validated updates
src/services/templates.ts   Command templates: seeds + CRUD (Phase 2)
src/services/broadcast.ts   Broadcast fan-out with per-target eligibility (Phase 2)
src/services/alerts.ts      Alert notifications, dedupe, webhook/Telegram (Phase 2)
src/services/analytics-helpers.ts  Pure analytics aggregates (Phase 2)
src/services/pool/          PoolProvider interface + disabled placeholder + monitor
src/routes/                 auth, agents (bridge), dashboard, workers, commands
                            (+ broadcast/batches), templates, alerts, events,
                            analytics, settings, health, ws
test/unit/                  Pure-logic unit tests
test/integration/           Fastify inject tests against muse_control_test
```

## Environment variables

Copy `.env.example` to `.env` and fill in values:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Prisma + app) |
| `DATABASE_URL_TEST` | Test database connection string (integration tests) |
| `JWT_SECRET` | Dashboard JWT signing secret (12h tokens) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Single admin account, seeded on first boot |
| `PORT` / `HOST` | Listen address (default 3001 / 127.0.0.1) |
| `CORS_ORIGIN` | Comma-separated dashboard origins (dev only) |
| `POOL_PROVIDER` | `none` (default) — placeholder provider, pool cross-check off |
| `POOL_API_BASE_URL`, `POOL_API_KEY`, `POOL_LOOKUP_PARAM` | Reserved for the real pool adapter (not implemented in Phase 1) |
| `PUBLIC_BASE_URL` | Public URL of this server, rendered into `/agent.md` (Phase 3; default `http://127.0.0.1:<PORT>`) |

## Development

```bash
npm install --workspaces=false   # standalone install inside this workspace
cp .env.example .env             # then edit values

# Database
npx prisma migrate dev           # create/apply migrations locally
npx prisma migrate deploy        # apply migrations (CI / production)
npx prisma generate              # regenerate the Prisma client

npm run dev                      # tsx watch on http://127.0.0.1:3001
npm run build                    # tsc -> dist/
npm start                        # node dist/server.js

# API docs (Swagger UI)
open http://127.0.0.1:3001/docs
curl http://127.0.0.1:3001/healthz
```

## Tests

```bash
npm test                  # unit + integration (vitest)
npm run test:unit         # pure logic only, no database needed
npm run test:integration  # needs DATABASE_URL_TEST pointing at a migrated
                          # test database (the suite runs migrate deploy itself)
```

Integration coverage mirrors the contract acceptance list: pairing →
heartbeat → overview visibility, same-boot re-attach without duplicates,
new boot → new session + `VM_REPLACED`, clean shutdown → `REBOOT`, miner down
→ MATI / GAGAL_START, the full Run Again flow where success requires a
verifying heartbeat, idempotency-key deduplication, queued commands visible
while an agent is offline, audit-log rows for manual commands, the sweeper's
unreachable/expiry/verification-timeout transitions, and settings updates.
Phase 2 adds: template CRUD + use-in-command, broadcast fan-out (eligibility
skips, confirm rule, idempotent retry, batch counts), analytics range
aggregates on seeded data, alert dedupe + webhook delivery against a local
stub, and `hold_active` flips via heartbeat snapshots and hold/unhold
commands.

## Phase 2 endpoints

All require the dashboard JWT.

| Endpoint | Purpose |
|---|---|
| `GET /api/command-templates` | List command templates (six defaults are seeded at boot) |
| `POST /api/command-templates` | Create a template `{name, type, payload?, description?, sensitive?}` → 201 |
| `PATCH /api/command-templates/:id` | Partial template update |
| `DELETE /api/command-templates/:id` | Delete a template → 204 |
| `POST /api/workers/:id/commands` | Now also accepts `template_id` (type + payload come from the template; an explicit `payload` merges over it). The command row records `template_id` |
| `POST /api/commands/broadcast` | Fan out `{type}` or `{template_id}` to `agent_ids[]`. Per-target eligibility (capability, GAGAL_START, TAK_TERJANGKAU/held for recovery types) — ineligible targets are skipped with reasons, never fail the batch. Sensitive types need `confirm: true` (else 422, nothing created). Idempotent per `idempotency_key`; per-command keys derive as `<key>:<agent_id>` |
| `GET /api/commands/batches` | Broadcast batches with per-status command counts |
| `GET /api/commands/batches/:id` | One batch + its commands |
| `GET /api/analytics?range=24h\|7d\|30d` | Default range is now `7d`. Adds per-agent flat fields (`sessions`, `replacements`, `commands_count`, `success_rate`, `top_errors` ≤ 3) and per-worker `session_duration_distribution`, `shares_per_session`, `longest_share_gap_sec`, `recoveries.failed_low_memory`, `mem_at_session_start_trend` |
| `GET /api/alerts` | Recent alert notifications with their deliveries |
| `POST /api/settings/alerts/test` | `{channel: "webhook"\|"telegram"}` — send a test alert through the configured channel; the attempt is recorded and returned |

Worker list/detail DTOs include `hold_active` (Phase 2): updated from the
heartbeat snapshot field `miner.hold_active` when the bridge reports it, and
flipped optimistically when a `miner.hold`/`miner.unhold` command succeeds.

## Phase 2 settings (system_settings)

Set via `PUT /api/settings`; read via `GET /api/settings`.

| Key | Default | Notes |
|---|---|---|
| `alert_dead_after_sec` | `600` | How long a worker must stay MATI / GAGAL_START before an alert notification is created |
| `alert_webhook_url` | `""` | Webhook endpoint for alert POSTs |
| `alert_webhook_enabled` | `false` | Enable webhook deliveries in the sweeper |
| `alert_telegram_bot_token` | — | **Write-only**: stored, never returned; `GET` exposes `alert_telegram_configured` instead |
| `alert_telegram_chat_id` | `""` | Telegram chat id for alert messages |
| `alert_telegram_enabled` | `false` | Enable Telegram deliveries in the sweeper |

Alert conditions (evaluated on the sweeper tick, one notification per
occurrence, dedupe key `<condition>:<entity_id>:<occurrence start>`): worker
MATI or GAGAL_START continuously ≥ `alert_dead_after_sec`, agent transitions
to unreachable, worker POOL_STALL (only when a pool provider is configured).
Deliveries are recorded in `alert_deliveries` (`sent`/`failed` + error) and
never break the sweeper.

## Phase 3 — roles, automation, schedules, retention, exports, self-enrollment

Implements CONTRACT-3 (migration `20261126121531_phase3`).

### Multi-user roles

Every user has a role (`users.role`): **ADMIN**, **OPERATOR**, or **VIEWER**
(existing users default to ADMIN). The JWT carries the role; login responses
and `GET /api/auth/me` include it. Enforcement is a `requireRole(...)`
preHandler after authentication — any write by a role that lacks it → 403.

| Capability | VIEWER | OPERATOR | ADMIN |
|---|---|---|---|
| Reads (dashboard, workers, commands, events, analytics, settings) | ✓ | ✓ | ✓ |
| Single + broadcast commands, templates | — | ✓ | ✓ |
| Automation rules + schedules (incl. their GET lists) | — | ✓ | ✓ |
| Pairing create / agent revoke | — | — | ✓ |
| Settings writes, alert test, retention run, enrollment rotate | — | — | ✓ |
| User management, CSV exports | — | — | ✓ |

User management (ADMIN, passwords hashed with the same scrypt format as the
seeded admin; hashes are never returned):

| Endpoint | Purpose |
|---|---|
| `GET /api/users` | List users `{id, email, role, disabled, disabled_at, created_at}` |
| `POST /api/users` | Create `{email, password, role}` → 201; duplicate email → 409 |
| `PATCH /api/users/:id` | `{role?, disabled?}` — an admin **cannot disable or demote themselves** (400) |
| `POST /api/users/:id/reset-password` | `{password}` → 200 |

Disabled users cannot log in: `401 {error: "ACCOUNT_DISABLED"}`. All
user-management actions write audit rows (`user.create` / `user.update` /
`user.reset_password`).

### Rule automation

Rules live in `automation_rules` and are evaluated inside the existing
sweeper tick, only while the `automation_enabled` setting is on.

- Condition: `{kind: "worker_status", status: MATI|GAGAL_START|WASPADA|POOL_STALL, for_sec}`
  (the worker's `statusSince` must be at least `for_sec` old) or
  `{kind: "agent_unreachable", for_sec}` (unreachable since
  `last_seen_at + heartbeat_interval_sec × unreachable_missed_beats`).
- Action: `{type}` or `{template_id}` (payload merges like manual use).
  Target: `{agent_ids: [...] | "all"}`.
- Firing creates **normal commands** through the Phase 1 creation path with
  `source = "automation"`, `rule_id` set, `requested_by = "automation"` —
  every eligibility gate still applies. Refusals (capability, GAGAL_START
  Run-Again refusal, revoked, no worker) are recorded as `RULE_SKIPPED`
  events; a target with an already-active command of the same type
  (QUEUED/SENT/RUNNING) is blocked silently by the duplicate guard.
- Guards: `cooldown_sec` (default 3600) after each firing — a firing whose
  targets were all refused also starts the cooldown so it cannot spam
  events; `max_per_day` (default 5) counts days on which at least one
  command was created. Successful firings write a `RULE_FIRED` event and an
  audit row with actor `automation`.

| Endpoint | Purpose |
|---|---|
| `GET /api/automation/rules` | List rules (OPERATOR+) |
| `POST /api/automation/rules` | Create (validates condition/action/target; template must exist) → 201 |
| `PATCH /api/automation/rules/:id` | Partial update |
| `DELETE /api/automation/rules/:id` | Delete → 204 |
| `POST /api/automation/rules/:id/toggle` | `{enabled}` enable/disable |

### Schedules

Schedules live in `schedules` and also run inside the sweeper tick under the
same `automation_enabled` master switch. Cron is a standard 5-field
expression evaluated by a dependency-free matcher (`src/services/cron.ts`)
in the **server's local timezone**; when both day-of-month and day-of-week
are restricted, either may match (Vixie rule), and day-of-week 7 = Sunday.
Invalid expressions are rejected with 400 at save time.

A due schedule with `broadcast: true` fans out through the Phase 2 broadcast
service (one batch); otherwise it creates one normal command per target.
Either way commands carry `source = "schedule"` and `schedule_id`, and
idempotency keys derive from the scheduled occurrence
(`schedule:<id>:<occurrence>`), so a repeated tick never double-fires.
Responses include `next_run_at`; after firing, the next run is computed from
now (missed occurrences are not caught up).

| Endpoint | Purpose |
|---|---|
| `GET /api/schedules` | List schedules (OPERATOR+) |
| `POST /api/schedules` | Create `{name, cron, action, target, broadcast?, enabled?}` → 201 |
| `PATCH /api/schedules/:id` | Partial update (recomputes `next_run_at` when cron changes or on enable) |
| `DELETE /api/schedules/:id` | Delete → 204 |
| `POST /api/schedules/:id/toggle` | `{enabled}` enable/disable |

Command DTOs (all phases) now include `source` (`manual` | `automation` |
`schedule`), `rule_id`, and `schedule_id`.

### Retention

Settings (days; **0 disables** that set): `retention_heartbeats_days` (30),
`retention_terminal_commands_days` (90), `retention_alerts_days` (90),
`retention_pool_snapshots_days` (30). An hourly cleanup inside the sweeper
deletes ONLY heartbeats, pool snapshots, alert notifications (deliveries
cascade) and terminal commands (SUCCEEDED/FAILED/TIMED_OUT/EXPIRED, aged by
`finished_at`, falling back to `created_at`) older than their window.
Agents, users, audit logs, events, sessions and non-terminal commands are
never touched. Every cleanup writes an audit row (`retention.cleanup`).

`POST /api/settings/retention/run` (ADMIN) runs it on demand and returns
`{deleted: {heartbeats, pool_snapshots, alert_notifications, alert_deliveries, commands}}`.

### CSV exports (ADMIN, streamed)

`?range=24h|7d|30d|all` (default `30d`) filters by creation time where a time
column exists. Header row first, ISO timestamps, standard CSV quoting.

| Endpoint | Columns |
|---|---|
| `GET /api/export/agents.csv` | id, name, worker_name, enrolled_via, status, worker_status, last_seen_at, replacement_count, created_at (no range filter) |
| `GET /api/export/commands.csv` | id, agent, worker, type, source, status, created_at, finished_at, error_reason |
| `GET /api/export/events.csv` | id, agent, worker, type, description, created_at |
| `GET /api/export/audit.csv` | id, actor, action, target, created_at |

### Zero-touch self-enrollment (§8)

The owner pastes only `<PUBLIC_BASE_URL>/agent.md` to a new agent; the agent
installs and registers itself with no operator action.

- The shared secret is the `enrollment_key` system setting (32-byte random
  hex), seeded at boot when absent. `GET /api/settings` exposes it as
  `enrollment_key` **to ADMIN only** (`null` for other roles); it is not an
  editable setting.
- `POST /api/settings/enrollment-key/rotate` (ADMIN) generates a new key and
  returns it. Rotation takes effect immediately because the document is
  rendered live.
- `GET /agent.md` — **public**, `text/markdown`. Renders
  `src/assets/agent.md.tmpl` with the CURRENT key and the public server URL
  substituted. The public URL comes from the `PUBLIC_BASE_URL` env var
  (default `http://127.0.0.1:<PORT>`); in production nginx proxies exactly
  this path to the backend and serves `bridge.cjs` / `install.sh` as static
  files from the server root, as the document describes.
- `POST /api/bridge/self-register` — **public**. Body
  `{enrollment_key, agent_name, worker_name?, boot_id, capabilities?}`.
  Wrong key → 401. Success mirrors a pairing registration (agent + worker +
  session #1) and returns `{agent_id, agent_token, session_id, session_no,
  server_time, config}`. The agent row records `enrolled_via = "self"`
  (pairing registrations record `"pairing"`; the field is on the agent DTO).
  Audit actor is `self-enroll`. Failed key attempts are rate-limited per IP:
  10 failures within 10 minutes → 429 (even for the correct key) until the
  window passes.

### Phase 3 settings (system_settings)

| Key | Default | Notes |
|---|---|---|
| `automation_enabled` | `true` | Master switch for automation rules AND schedules |
| `retention_heartbeats_days` | `30` | 0 = disabled |
| `retention_terminal_commands_days` | `90` | 0 = disabled |
| `retention_alerts_days` | `90` | 0 = disabled |
| `retention_pool_snapshots_days` | `30` | 0 = disabled |
| `enrollment_key` | *(generated)* | Read via `GET /api/settings` (ADMIN); change only via the rotate endpoint |

## Notes

- Agent tokens and pairing codes are stored only as SHA-256 hashes; the raw
  agent token is returned exactly once, in the pairing registration response.
- State-changing commands (`miner.run`, `miner.restart`, `miner.reinstall`)
  are only marked SUCCEEDED after a later heartbeat snapshot shows the miner
  `active` with `job_height > 0`; otherwise the sweeper fails them with
  `VERIFICATION_TIMEOUT`.
- The pool provider ships as a disabled placeholder: with `POOL_PROVIDER=none`
  worker status is computed from bridge data alone and the API reports
  `pool_configured: false`.
