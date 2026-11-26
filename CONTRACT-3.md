# Muse Management Control — CONTRACT-3 (Phase 3 addendum)

CONTRACT.md + CONTRACT-2.md stay in force. Phase 3 scope (spec v1.1 Bagian 18,
Fase 3): **otomasi berbasis aturan dan jadwal (cron dari dashboard), peran pengguna
lebih dari satu, retensi dan ekspor data**. This is the final phase.

## 1. Multi-user & roles

- `users` gains `role` (`ADMIN` | `OPERATOR` | `VIEWER`, default `ADMIN` for the
  seeded admin) and `disabled_at` (nullable). Existing admin keeps working.
- Permissions (server-enforced; UI hiding is cosmetic only):
  - VIEWER: read-only. Any POST/PUT/PATCH/DELETE → 403.
  - OPERATOR: everything VIEWER can, plus commands (single + broadcast), templates,
    automation rules, schedules. NOT: user management, settings changes, exports.
  - ADMIN: everything, including user management, settings, exports, retention runs.
- JWT payload gains `role`. Auth plugin exposes `requireRole(...roles)`.
- User management API (ADMIN only):
  - `GET /api/users` — list (id, email, role, disabled, created_at; never hashes).
  - `POST /api/users` {email, password, role} → 201 (scrypt hash, same scheme as the
    admin seed; duplicate email → 409).
  - `PATCH /api/users/:id` {role?, disabled?} — cannot disable or demote yourself.
  - `POST /api/users/:id/reset-password` {password} → 200.
- Login rejects disabled users (401 with a clear message). Audit rows for all user
  management actions.

## 2. Rule automation

New table `automation_rules`: id `rul_…`, name, enabled (default false),
condition JSON {kind: "worker_status", status: MATI|GAGAL_START|WASPADA|POOL_STALL,
for_sec} or {kind: "agent_unreachable", for_sec}, action JSON {type (command type),
template_id?}, target JSON {agent_ids: [] | "all"}, cooldown_sec (default 3600),
max_per_day (default 5), last_fired_at, fire_count_today + counter date,
created_at/updated_at.

Engine: evaluated on the existing sweeper tick.
- A rule fires when its condition has held continuously for `for_sec` (use
  worker.statusSince / agent unreachable-since), the target worker is not already
  the subject of a QUEUED/RUNNING command of the same type, cooldown has elapsed,
  and today's fire count < max_per_day.
- Firing creates NORMAL command rows (eligibility gates apply — a GAGAL_START
  worker still refuses miner.run; record the skip as a rule event), with
  `commands.source = "automation"` and `commands.rule_id` set (new columns:
  `source` default "manual", `rule_id`, `schedule_id` nullable).
- Events: RULE_FIRED / RULE_SKIPPED on the timeline + audit row (actor "automation").
- Master switch: system_setting `automation_enabled` (default true) — when false,
  no rule or schedule fires.
- API (OPERATOR+): CRUD `/api/automation/rules` + `POST /api/automation/rules/:id/toggle`.

## 3. Scheduled commands (cron from the dashboard)

New table `schedules`: id `sch_…`, name, enabled (default false), cron (5-field
expression, evaluated in the server's local timezone — document it), action
{type | template_id}, target {agent_ids | "all"}, broadcast boolean (fan-out as a
batch when true, else one command per target without a batch), next_run_at,
last_run_at, created_at/updated_at.

- Cron matcher: implement a small standard 5-field matcher (minute hour
  day-of-month month day-of-week, with `*`, lists, ranges, steps) as a pure,
  unit-tested function — no new dependencies.
- Sweeper: for each enabled schedule with next_run_at <= now and
  automation_enabled: create the command(s) (source="schedule", schedule_id set;
  broadcast=true uses the Phase 2 broadcast service), update last_run_at and
  compute next_run_at. Invalid cron → 400 at save time with a clear message.
- API (OPERATOR+): CRUD `/api/schedules` + toggle. Response includes next_run_at.

## 4. Retention

Settings (ADMIN): `retention_heartbeats_days` (default 30),
`retention_terminal_commands_days` (default 90), `retention_alerts_days`
(default 90), `retention_pool_snapshots_days` (default 30). 0 = disabled for that set.
- Cleanup runs inside the sweeper at most once per hour: delete heartbeats,
  pool_snapshots, alert_notifications (+deliveries) and terminal-state commands
  older than their window. NEVER delete agents, users, audit_logs, events,
  sessions, non-terminal commands.
- `POST /api/settings/retention/run` (ADMIN) → runs cleanup now, returns per-table
  deleted counts. Every cleanup (scheduled or manual) writes an audit row with counts.

## 5. Export

ADMIN only. Streaming CSV (Content-Disposition attachment), `?range=24h|7d|30d|all`
(default 30d) where a time column exists:
- `GET /api/export/agents.csv` — agents + current worker status.
- `GET /api/export/commands.csv` — commands in range (id, agent, worker, type,
  source, status, created/finished, error_reason).
- `GET /api/export/events.csv` — events in range.
- `GET /api/export/audit.csv` — audit log in range.
CSV: header row, comma-separated, ISO timestamps, values quoted when needed.

## 6. Frontend (Phase 3)

- New page **Otomasi**: rules list + editor (condition kind/status/duration, action
  type/template, targets, cooldown, max/day, enable toggle, last fired), schedules
  list + editor (cron input with next-run preview from the API, action, targets,
  broadcast toggle, enable toggle).
- New page **Pengguna** (ADMIN only in nav): user table, create user, role change,
  disable/enable, reset password.
- Pengaturan: Retention section (four day inputs + "Jalankan Pembersihan" button +
  result counts), Export section (four download buttons using authenticated fetch →
  blob), automation master switch toggle.
- Role-aware UI: nav items and action buttons hidden/disabled for roles without
  permission (VIEWER sees no create/command buttons anywhere; OPERATOR sees no
  Pengguna/Pengaturan-save/Export). Current user's role shown in the header.
- All copy Bahasa Indonesia; reuse Phase 1/2 patterns.

## 7. Tests (must pass)

Backend additions: role matrix (viewer 403 on writes, operator blocked from
users/settings/export, admin allowed; disabled user cannot log in; cannot disable
self); rule engine (fires once when condition duration met, cooldown blocks refire,
daily cap, duplicate-active-command guard, GAGAL_START skip recorded, master switch
off = no fire); cron matcher unit tests (steps/ranges/lists/dow) + schedule due
creation + next_run computation; retention (old rows pruned, protected tables
untouched, run-now counts, audit row); export (CSV headers + rows, role gate,
range filter). Full Phase 1+2 suite stays green; `npm run build` clean.

Migration: ONE new Prisma migration named `phase3`.

## 8. Zero-touch self-enrollment (added 2026-11-26 at the owner's request)

The owner pastes ONLY the URL `https://musang.mikasu.lol/agent.md` to an agent;
the agent must install and register itself with NO operator action (no pairing
code created by a human).

- system_setting `enrollment_key`: 32-byte random hex, generated at migration
  seed when absent. Treated as a write-only-ish secret: `GET /api/settings`
  exposes it ONLY to ADMIN (field `enrollment_key`, null for other roles).
- `POST /api/settings/enrollment-key/rotate` (ADMIN) → generates a new key,
  returns it. Rotation immediately invalidates previously served agent.md copies
  because the document is rendered live (next point).
- `GET /agent.md` — PUBLIC (no auth), served by the backend, Content-Type
  text/markdown. Renders the enrollment document template with the CURRENT
  enrollment_key and the public server URL substituted. (In production nginx
  proxies exactly this path to the backend; everything else stays static.)
- `POST /api/bridge/self-register` — public, body {enrollment_key, agent_name,
  worker_name?, boot_id, capabilities?}. Wrong key → 401. On success behaves
  like a pairing registration (creates agent + first session, returns
  {agent_id, agent_token, session_no, server_time, config}) so the bridge can
  reuse its register-response parsing. The agent row records
  `enrolled_via = "self"` (new column; pairing registrations set "pairing").
  Audit row actor "self-enroll". Rate-limit: reuse the pairing attempt limiter
  spirit — after 10 failed key attempts from one IP within 10 minutes, 429.
- Settings UI (frontend): an "Enrollment" section (ADMIN) showing the current
  key + the agent.md URL + a Rotate button with confirmation warning that old
  pasted copies stop working.
- The dashboard agent list shows a badge for self-enrolled agents.
