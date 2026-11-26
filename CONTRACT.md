# Muse Management Control — Implementation Contract (Phase 1)

Single source of truth shared by backend, bridge, and frontend builders.
Spec: `spec/spek-flow-muse-management-control-v1.1.pdf` (v1.1, lightweight stack).
Prompt sections referenced as "P§n" (the user's build prompt), spec sections as "S§n".

## Stack (fixed, do not change)
- Monorepo, npm workspaces: `backend/`, `bridge/`, `frontend/`.
- Backend: Fastify 5 + TypeScript (Node 20+), Prisma 6 + PostgreSQL, one process serving REST + WebSocket (`@fastify/websocket`), Swagger via `@fastify/swagger` + `@fastify/swagger-ui` at `/docs`. Validation with JSON Schema on routes (Fastify native) — keep schemas in `backend/src/schemas/`.
- Frontend: Nuxt 4 + Vue 3 + TypeScript, `ssr: false`, static generate (`nuxt generate`), Tailwind CSS, Pinia, `lucide-vue-next` icons. No Node process in production; Nginx serves `frontend/.output/public`.
- Bridge: Node 20+ TypeScript in `bridge/`, bundled by esbuild to a single file `dist/bridge.cjs`. No heavy deps (only `node:` builtins + global fetch).
- Queue: `commands` table only. No Redis/BullMQ. No PM2. No NestJS. No SSR.

## Domain defaults (all stored in `system_settings`, never hardcoded in logic)
| key | default |
|---|---|
| heartbeat_interval_sec | 30 |
| unreachable_missed_beats | 3 |
| min_mem_start_gib | 5 |
| min_hashrate_hs | 0.5 |
| mem_warn_margin_gib | 1 (WASPADA when mem_available < min_mem_start + margin) |
| no_share_warn_sec | 1800 (30 min) |
| pool_stall_sec | 7200 (2 h) |
| pairing_ttl_sec | 900 (15 min) |
| command_ttl_sec | 600 |
| verify_window_sec | 120 |

## Data model (Prisma models; table names snake_case via @@map)
- `users`: id, email unique, password_hash (scrypt), created_at. Single seeded admin from env.
- `agents`: id (cuid, prefix agt_), name, token_hash (sha256 hex, nullable when revoked), worker_name (secondary key, nullable), capabilities String[], bridge_version, status (ONLINE/UNREACHABLE), first_registered_at, last_seen_at, replacement_count Int, current_session_id nullable, revoked_at nullable, created_at, updated_at.
- `sessions`: id (prefix ses_), agent_id FK, boot_id, boot_time, started_at, ended_at nullable, end_reason (TAKEOVER/SHUTDOWN/LOST/null), session_no Int (per-agent increment).
- `heartbeats`: id, agent_id, session_id, received_at, mem_available_gib Float, miner_snapshot Json, agent_status String.
- `workers`: id, agent_id unique FK, name unique, pool_address nullable, status (SEHAT/WASPADA/MATI/GAGAL_START/TAK_TERJANGKAU/POOL_STALL), status_reason String, status_since, last_share_at nullable, last_local_share_at nullable, hashrate_hs Float, accepted_shares Int, rejected_shares Int, shares_local Int, job_height Int, difficulty Float, miner_service_state String, last_recovery_at nullable, hold_until nullable, updated_at.
- `commands`: id (prefix cmd_), agent_id FK, worker_id nullable FK, type, payload Json, idempotency_key unique, status (QUEUED/SENT/RUNNING/SUCCEEDED/FAILED/TIMED_OUT/EXPIRED), requested_by (user email or "system"), created_at, sent_at, started_at, finished_at, expires_at, result Json nullable, error_reason nullable, verify_deadline nullable.
- `events`: id, agent_id nullable, worker_id nullable, type (enum strings per P§9), description, metadata Json, created_at.
- `audit_logs`: id, actor, action, target, metadata Json, created_at. Append-only (no update/delete endpoints).
- `pairing_codes`: id, code_hash (sha256), planned_name, created_by, expires_at, used_at nullable, used_by_agent_id nullable, created_at.
- `system_settings`: key PK, value Json, updated_at.
- `pool_snapshots`: id, worker_name, present Boolean, accepted Int, rejected Int, last_share_at nullable, fetched_at. (Written only when a pool provider is configured.)

## Auth
- Dashboard: `POST /api/auth/login` {email,password} → {token} (JWT, `@fastify/jwt`, 12h). All `/api/dashboard/*`, `/api/agents` (list/detail), `/api/workers`, `/api/commands`, `/api/events`, `/api/analytics`, `/api/settings`, `/api/agents/pairing` require JWT.
- Agent endpoints (`/api/agents/register`, `/api/agents/:id/heartbeat`, `/api/agents/:id/commands*`, `/api/agents/:id/events`) use `Authorization: Bearer <agent-token>`; server compares sha256(token) to `agents.token_hash`. Register with pairing code is the only unauthenticated agent call.

## API contract (exact paths)
Agent:
- `POST /api/agents/register` — body either {pairing_code, name, worker_name?, boot_id, boot_time, bridge_version, capabilities[]} (first time) or {agent_id, boot_id, boot_time, bridge_version, capabilities[], worker_name?} + Bearer token (re-attach). Response {agent_id, session_id, session_no, config:{heartbeat_interval_sec, unreachable_missed_beats}} — plus, ONLY on pairing registration, `agent_token` (the raw token, returned exactly once; re-attach responses omit it). The bridge persists it immediately (token file, mode 0600). Handles session logic per below.
- `POST /api/agents/:id/heartbeat` — body {session_id, sent_at, host:{boot_id, mem_available_gib}, miner:{service_state, pid?, session_no?, hashrate_hs, shares_local, last_share_at?, job_height, difficulty}}. Response {ack:true, queued_commands:n}. Updates agent.last_seen, worker row + status recalculation, resolves pending command verifications, stores heartbeat row (prune not required in P1).
- `GET /api/agents/:id/commands?status=queued` — atomically claims up to 10 QUEUED, unexpired commands for this agent: status QUEUED→SENT, sent_at=now, in ONE transaction (Prisma $transaction with raw `SELECT ... FOR UPDATE SKIP LOCKED` or updateMany guard). Returns claimed commands [{id,type,payload,created_at,expires_at}]. Expired QUEUED commands are flipped to EXPIRED lazily here and by the sweeper.
- `POST /api/agents/:id/commands/:cmdId/ack` — SENT→RUNNING, started_at.
- `POST /api/agents/:id/commands/:cmdId/result` — body {status:"succeeded"|"failed", output?, exit_code?, error_reason?}. For state-changing miner commands (miner.run/miner.restart/miner.reinstall) a reported success does NOT finish the command: set result, keep status RUNNING, set verify_deadline = now + verify_window_sec; the command becomes SUCCEEDED only when a later heartbeat snapshot shows miner.service_state == "active" (and job_height > 0) before the deadline; if the deadline passes → FAILED with error_reason "VERIFICATION_TIMEOUT". Non-state-changing commands (miner.status, miner.hold, miner.unhold) finish immediately on result.
- `POST /api/agents/:id/events` — body {type, description, metadata} → creates event.

Dashboard (JWT):
- `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/dashboard/overview` → {agents:{total,online,working,idle,warning,unreachable}, miners:{total,healthy,dead}, active_commands:n, worker_status_distribution:{SEHAT:n,...}, recent_events:[...10], active_alerts:[{agent_name, worker_name, type, reason, at, action}]}. Alerts derived from workers in MATI/GAGAL_START/POOL_STALL + unreachable agents.
- `GET /api/agents` (query: search, status, page, page_size, sort=last_seen) → paginated agents with current session + worker summary.
- `GET /api/agents/:id` → agent detail: info, current health, worker metrics, session history (paginated), recent events, recent commands.
- `POST /api/agents/pairing` {planned_name} → {pairing_code (raw, shown once), expires_at}.
- `POST /api/agents/:id/revoke` → clears token_hash, sets revoked_at, audit log.
- `GET /api/workers`, `GET /api/workers/:id` (worker + agent summary + session timeline).
- `POST /api/workers/:id/commands` {type, payload?, idempotency_key} → creates command for the worker's agent. Validates: type in allowlist; agent capability includes type; if type=miner.run and worker.status==GAGAL_START → 422 with reason; if agent unreachable → still creates QUEUED with expires_at (visible expiry). Idempotency: same key returns the existing command (200) instead of duplicating. Sensitive types (miner.restart, miner.reinstall, miner.run, miner.hold, miner.unhold) require body.confirm === true. Writes audit log + event COMMAND_CREATED + WS broadcast.
- `GET /api/commands` (filters: agent_id, status, type, page) , `GET /api/commands/:id`.
- `GET /api/events` (filters: agent_id, worker_id, type, from, to, outcome).
- `GET /api/analytics?range=24h|7d|30d|custom&from&to&agent_id&worker_id` → per-agent {uptime_pct, session_count, replacement_count, commands:{total,succeeded,failed,success_rate}, top_errors:[{reason,count}], avg_session_lifetime_sec} and per-worker {hashrate_series:[{t,v}], shares:{accepted,rejected}, last_share_intervals, recoveries:{succeeded,failed}, downtime_sec, mem_at_session_start:[{t,v}], pool_stall_count}. Real DB aggregates only.
- `GET /api/settings`, `PUT /api/settings` {key:value,...} (validated keys), audit-logged.
- WebSocket `GET /ws` (JWT via query ?token= or header) — server broadcasts JSON {type, payload, at} with type in: agent.registered, agent.heartbeat (throttled: only on status change or every heartbeat is fine at this scale — send on change + session events), agent.status_changed, agent.unreachable, agent.reconnected, session.started, session.ended, session.vm_replaced, session.rebooted, worker.status_changed, worker.recovered, worker.recovery_failed, command.created, command.sent, command.started, command.succeeded, command.failed, event.created, alert.created.

## Session / VM replacement logic (register + heartbeat)
- Re-attach with same boot_id as current session → same session (network blip; no event, no count change).
- Re-attach/register with different boot_id → close current session (ended_at = takeover time = now, end_reason=TAKEOVER), create new session (session_no+1), replacement_count+1, event VM_REPLACED — unless the previous session had a clean shutdown signal (bridge event type AGENT_SHUTDOWN recorded) in which case event REBOOT. Session end is takeover time, never the new VM's boot_time (pre-booted replacement rule, S§4).
- Two bridges same identity concurrently: the newest register supersedes; commands are only claimable by the agent's current_session_id (claim query filters commands by agent, and ack/result must carry the current session — heartbeat/result bodies include session_id; server rejects ack/result from a non-current session with 409).
- Heartbeat with a session_id that is not current → 409 {error:"SESSION_SUPERSEDED"} so the old bridge stops.
- Missing identity on bridge side is a bridge concern (it re-pairs); revoked token → 401.

## Worker status calculation (pure function `computeWorkerStatus(input, settings, poolConfigured)`)
Input: agentOnline (bool), miner.service_state, hashrate_hs, mem_available_gib, last_share_at (pool or local), last_local_share_age_sec, poolPresent (nullable), now.
Order:
1. !agentOnline → TAK_TERJANGKAU.
2. service_state in (inactive, failed, unit-missing) → if mem_available_gib < min_mem_start_gib AND service_state != active → GAGAL_START when the miner is not running *because* of memory: use bridge-reported `miner.start_blocked_reason == "LOW_MEMORY"` OR (service_state != active && mem < min). If service not active and mem OK → MATI.
   Precisely: if service_state != "active": if mem_available_gib < min_mem_start_gib → GAGAL_START else MATI.
3. service active:
   - poolConfigured && poolPresent === false && age(last pool share) > pool_stall_sec && local hashing normal (hashrate >= min) → POOL_STALL.
   - no share (local) for > no_share_warn_sec → WASPADA.
   - hashrate < min_hashrate_hs → WASPADA.
   - mem_available_gib < min_mem_start_gib + mem_warn_margin_gib → WASPADA.
   - else SEHAT. (When pool not configured, pool presence is not required for SEHAT and POOL_STALL never fires; UI must display "pool cross-check not configured".)
Reason strings in Bahasa Indonesia, e.g. "Service miner tidak aktif", "Memori tersedia 2.4 GiB di bawah ambang start 5 GiB".

## Pool provider (P§7)
- Interface `PoolProvider { name; isConfigured(): boolean; fetchWorkers(): Promise<PoolWorkerData[]> }`, `PoolWorkerData { worker_name, present, accepted, rejected, last_share_at }`.
- Env config: `POOL_PROVIDER` (default `none`), `POOL_API_BASE_URL`, `POOL_API_KEY`, `POOL_LOOKUP_PARAM`.
- Ship only `PlaceholderPoolProvider` (isConfigured=false) + the interface. A `PoolMonitorService` polls every 60s only when configured; writes pool_snapshots and feeds status calc. With `none`, overview/workers responses include `pool_configured:false`.

## Bridge behavior
- Config (env or `~/workspace/muse-bridge/config.json`): MUSE_SERVER_URL (required), MUSE_PAIRING_CODE (first run), MUSE_AGENT_NAME, MUSE_WORKER_NAME, MUSE_BRIDGE_MODE (`demo`|`real`, default demo), MUSE_MINER_UNIT (real mode, default ""), MUSE_REINSTALL_SCRIPT (real mode, optional), heartbeat interval from server config response.
- Identity: `~/workspace/muse-bridge/identity.json` {agent_id, name, worker_name}; token in `~/workspace/muse-bridge/token` file mode 0600. Never log the token.
- Loop: register/re-attach on start → heartbeat every interval (jitter ±3s) → poll commands each cycle → execute allowlisted commands ∩ registered capabilities → ack → execute → result → immediately send a fresh heartbeat (for verification). Exponential backoff on network errors (1s→60s cap), never exit on network failure.
- Miner snapshot:
  - demo mode: simulated state machine in `bridge/src/demo.ts` — env-tunable scenario: DEMO_MEM_GIB (default 6.8), DEMO_SCENARIO (`healthy` default; service state flips only via commands: miner.run/restart set active, a simulated crash can be triggered via payload {simulate:"crash"} on miner.status? No — keep simple: state starts `active` when DEMO_MINER_START=active (default) else `inactive`; commands change it; hashrate random-walks 1.4–1.91 H/s when active; shares_local increments; last_share updates while active; job_height increments.)
  - real mode: `systemctl is-active <unit>` (and `systemctl show -p MainPID`), mem from /proc/meminfo MemAvailable, boot_id from /proc/sys/kernel/random/boot_id (both modes read real boot_id), hashrate/shares unavailable → report 0/null honestly (fields nullable).
- Command execution (real mode): miner.run → if mem < min_mem_start (from server config in heartbeat response? use local copy from register config + settings pushed in heartbeat ack — keep simple: server includes `min_mem_start_gib` in register/heartbeat responses) reject result failed LOW_MEMORY with actual mem; else `systemctl start <unit>` (or reinstall script if unit missing and script configured). miner.restart → `systemctl restart <unit>`. miner.reinstall → run MUSE_REINSTALL_SCRIPT if set else fail NOT_CONFIGURED. miner.hold/unhold → write/remove `~/workspace/muse-bridge/hold` flag file (watchdog integration point) and succeed. miner.status → succeed with snapshot in result. Demo mode: same logic against the simulated state (LOW_MEMORY check uses DEMO_MEM_GIB).
- Capabilities default: ["miner.status","miner.run","miner.restart","miner.reinstall","miner.hold","miner.unhold"].
- `install.sh`: idempotent — writes `/etc/systemd/system/muse-bridge.service` only if content differs (unit per S§5, ExecStart pointing at node + bundled bridge.cjs under ~/workspace/muse-bridge), daemon-reload, enable, start/restart. Must work with sudo.
- Graceful shutdown: on SIGTERM send event AGENT_SHUTDOWN (best effort) so server can mark REBOOT vs VM_REPLACED.

## Frontend pages (all UI copy Bahasa Indonesia; dark-first; Lucide icons)
- `/login` — email+password → JWT in localStorage, redirect `/`.
- Layout: sidebar (Ringkasan, Agent, Miner, Pusat Perintah, Event & Pemulihan, Analitik, Pengaturan), collapse, connection status dot (WS), admin profile + logout, active alert count badge.
- `/` Ringkasan: 10 metric cards (P§4), Agent Health distribution, Worker Health distribution (6 statuses), Recent Events, Active Alerts with action links. Live via WS + initial fetch; refetch on WS events (DB is source of truth).
- `/agents` — searchable/filterable/sortable/paginated table (P§5 columns), "Tambah Agent" dialog → creates pairing code, shows code + expiry + install hint. Row actions: Detail, Kirim Perintah, Cabut Token.
- `/agents/[id]` — info, current health, worker metrics, session history, replacement timeline (events), command history, recent logs (events), action buttons (Kirim Perintah, Restart Miner, Run Lagi, Reinstall Miner, Tahan Pemulihan Otomatis, Lanjutkan Pemulihan) — only capabilities-supported actions; Run Lagi disabled with explanation when TAK_TERJANGKAU or GAGAL_START.
- `/miners` — worker table/cards with status chips + reason, hashrate, shares, last share, mem, session, replacements, last recovery, Run Lagi button (with confirm dialog per P§8), pool-not-configured banner when applicable.
- `/commands` Pusat Perintah — create command form (agent/worker select, type select, payload JSON optional, confirm checkbox for sensitive), queue + history table with live status, filters.
- `/events` — timeline with filters (agent, worker, type, date range, outcome).
- `/analytics` — range filters (24 jam / 7 hari / 30 hari / kustom), agent + worker analytics, simple SVG/canvas charts from real API data (no chart lib required; lightweight hand-rolled SVG is fine, or `vue-chartjs` — prefer hand-rolled to keep bundle small).
- `/settings` — form for all threshold keys, pool API config fields (stored as settings: pool_provider, pool_api_base_url, pool_lookup_param; API key write-only → stored as setting `pool_api_key_set` boolean + env recommended; keep simple: store in settings table, never returned after save), agent permissions overview (per-agent capabilities shown read-only in P1), sensitive command list display.
- Run Again confirm dialog (shared component): worker info, current status + reason, action explanation, explicit confirm → POST command with fresh idempotency_key (crypto.randomUUID), disable while pending (double-click safe).

## Env vars (backend)
DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD (seed on first boot), PORT (default 3001), HOST (127.0.0.1), POOL_PROVIDER=none, POOL_API_BASE_URL, POOL_API_KEY, POOL_LOOKUP_PARAM, CORS_ORIGIN (dev only).

## Tests (vitest, in `backend/test/` and `bridge/test/` where sensible)
Unit: computeWorkerStatus (all six statuses + boundaries), token hash/verify + pairing code expiry, idempotency key uniqueness handling, session transition logic (same boot / new boot / takeover / shutdown→REBOOT), command lifecycle incl. verification gate.
Integration (Fastify inject + test DB `DATABASE_URL_TEST`): register via pairing → heartbeat → agent visible in overview; re-attach same boot no duplicate; new boot → new session + VM_REPLACED event; 3 missed beats → unreachable (call sweeper function directly); miner inactive → MATI; miner.run success requires verifying heartbeat; duplicate idempotency key → single command; queued command visible while agent offline; audit log rows for manual commands.
Frontend: `nuxt generate` must succeed; no unit tests required in P1 beyond build.

## Deployment artifacts (`deploy/`)
- `docker-compose.yml`: exactly postgres (tuned command flags, mem limit 512M), app (backend, mem 384M), nginx (static + proxy, mem 128M); volumes; env file.
- `systemd/`: muse-control.service (backend), nginx site config `nginx/muse-control.conf` (serve frontend static, proxy /api + /ws, TLS via certbot note), `postgres-tuning.conf` snippet (shared_buffers=256MB, max_connections=30, work_mem=4MB), `install-server.sh` (no-Docker path: installs Node 22 + PostgreSQL, creates DB/user, writes units, builds/uploads note), README with both shapes + RAM budget table.
- Backend must expose `GET /healthz` for checks.

## Non-goals Phase 1 (do NOT build)
Broadcast commands, command templates, multi-user/roles, rule automation, retention/export, Redis, SSR, real pool adapter (interface + placeholder only), mobile app.
