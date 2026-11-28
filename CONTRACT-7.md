# CONTRACT-7 — Phase 7: Runtime Monitoring (Monitoring dari Runtime Muse)

Source spec: Satria's prompt "Monitoring Miner dari Runtime" (2026-11-28).
This file number reuses the slot freed when the generic-cron CONTRACT-7 was
deleted on 2026-11-27; the content is unrelated.

## Principle

Status is computed on the SERVER from three sources, in trust order:
(1) runtime events, (2) bridge heartbeats, (3) pool data (comparison only,
never a status input). WebSocket presence NEVER influences status. The
bridge reports and executes; it no longer decides liveness. The runtime
(Muse on the agent VM, surviving VM replacement) reports transitions via
its own token.

Out of scope (spec): VM trigger execution (UI only, disabled), changes to
the runtime's watchdog/recovery mechanism (separate document), mass
rollout, new notifications.

## 1. Runtime token

- The server issues a `runtime_token` (32-byte random hex) in EVERY
  successful registration response: pairing register, self-register, and
  re-attach. Each issuance ROTATES the token: the server stores only the
  sha256 hash (`agent_runtime_states.runtime_token_hash`); the previous
  token stops working immediately. "Rotasi token lewat registrasi ulang."
- The bridge's ONLY change in this phase: when a registration response
  carries `runtime_token`, save it to `<bridgeDir>/runtime-token.json`
  (default `~/workspace/muse-bridge/runtime-token.json`), mode 0600, JSON:
  `{ "token": "<raw>", "agent_id": "<id>", "saved_at": "<iso>" }`.
  The runtime reads this file; the bridge never uses the token itself.
- Dashboard shows token state only: issued / not issued (+ last runtime
  contact time). The value is never exposed by any API.

## 2. Runtime state (one row per agent, replace semantics)

New model `AgentRuntimeState` (table `agent_runtime_states`), 1:1 Agent,
cascade delete:

- `runtimeTokenHash`, `runtimeTokenIssuedAt`
- `lastTransitionType` — VM_REPLACED | RECOVERY_OK | RECOVERY_FAILED
  (SNAPSHOT never overwrites the transition), `lastTransitionAt`
  (occurred_at), `lastTransitionPayload` (full event JSON)
- `bootTime` — from the latest transition event carrying one
- `lastSnapshotAt` (occurred_at), `snapshotHashrateHs`,
  `snapshotSharesLocal`, `snapshotPoolAccepted`, `snapshotPoolLastShareAt`,
  `snapshotMemAvailableGib`
- `lastContactAt` — server receive time of ANY valid runtime event
  (transitions and snapshots); this is the runtime-liveness clock
- `lastEventType`, `lastEventAt` — the literally latest event of any kind

Transition events (not SNAPSHOT) are also written to the `events` timeline
with their spec type names (VM_REPLACED / RECOVERY_OK / RECOVERY_FAILED)
and `metadata.source = "runtime"`. SNAPSHOT writes state only (a 30-minute
snapshot row per agent would flood the timeline).

## 3. Runtime event endpoint

`POST /api/agents/{id}/events` — the existing path gains a second auth
kind. Auth resolution order: agent (bridge) token first (legacy ad-hoc
event behaviour, unchanged); otherwise the runtime token. Neither → 401,
no state change (A12).

Runtime payload is FLAT (spec contract):

```json
{"type": "VM_REPLACED", "occurred_at": "ISO-8601 with offset",
 "boot_time": "ISO-8601", "pid": 2028, "hashrate_local": 1.91,
 "mem_available_gib": 1.27, "primer_gib": 6.66, "shares_local": 1,
 "pool_accepted": 185, "pool_last_share_at": "ISO-8601", "reason": "…"}
```

Validation (all failures → 400, NO state change, A11):
- `type` must be one of VM_REPLACED | RECOVERY_OK | RECOVERY_FAILED |
  SNAPSHOT (unknown type → 400).
- `occurred_at` required and parseable for all four.
- `boot_time` required for VM_REPLACED, RECOVERY_OK, RECOVERY_FAILED;
  optional for SNAPSHOT.
- RECOVERY_OK additionally requires `pid`, `primer_gib`,
  `mem_available_gib`. RECOVERY_FAILED additionally requires `reason`
  (non-empty) and `mem_available_gib`. SNAPSHOT additionally requires
  `hashrate_local` and `shares_local` (`pool_last_share_at` optional —
  "bila ada").
- Optional fields may be null. Unknown extra fields are ignored.

On success: update runtime state (§2), write the timeline event for
transitions, broadcast `agent.runtime_event`, respond 201 `{ok: true}`.

## 4. Combined status (server-computed, on read)

Pure function `computeCombinedStatus` in `services/combined-status.ts`.
Constants (use these names in code): `BRIDGE_SILENT_SEC = 300`,
`RUNTIME_SILENT_SEC = 1800`.

Inputs: now; last transition (type + at); last runtime contact at; last
bridge heartbeat at (heartbeat row received_at, falling back to
agent.last_seen_at); bridge miner service_state from the latest
heartbeat snapshot.

Rules, evaluated in order:
1. Last transition is VM_REPLACED (no RECOVERY_OK/FAILED after it) →
   **PULIH** ("VM diganti; pemulihan oleh runtime sedang berjalan").
   This holds even while the bridge is silent.
2. Last transition is RECOVERY_FAILED → **MATI**, reason carries the
   event's `reason`.
3. Bridge heartbeat fresh (age ≤ BRIDGE_SILENT_SEC) and miner
   service_state = active → **JALAN**.
4. Bridge heartbeat fresh but service_state ≠ active → **MATI**
   (bridge-reported; reason from the snapshot, e.g. LOW_MEMORY).
   (Documented extension: the spec table's MATI row is the
   runtime-reported case; a live bridge reporting a dead service is the
   same user-facing fact.)
5. Runtime silent (no contact for > RUNTIME_SILENT_SEC, or never) AND
   bridge silent (age > BRIDGE_SILENT_SEC, or never) →
   **TAK_TERJANGKAU**, reason states the RUNTIME is the problem, not
   the VM: "Tidak ada kabar dari runtime maupun bridge; kemungkinan
   runtime Muse yang bermasalah, bukan VM."
6. Otherwise (bridge silent but runtime in contact, no pending
   transition — e.g. snapshots arriving while the bridge is down) →
   **PULIH** is wrong and MATI is unproven; status is **TAK_TERJANGKAU**
   with reason "Bridge diam tetapi runtime masih melapor; menunggu
   kabar berikutnya" — EXCEPT when rule 1 applies. (The spec's
   additional rule only promotes VM_REPLACED/recovering to PULIH.)

Pool data is never an input. The legacy worker status
(SEHAT/WASPADA/…/POOL_STALL) is unchanged and remains what alerts and
automation consume; the combined status is the dashboard's headline
status (workers list + agent detail) and is exposed on DTOs as
`combined_status` + `combined_status_reason`, alongside a `runtime`
block (§6).

## 5. Command queue for dead VMs (runtime execution path)

The existing command endpoints gain runtime-token auth as a second kind
(agent token keeps the current behaviour exactly):

- `GET /api/agents/{id}/commands?status=queued` with the runtime token
  returns the agent's QUEUED, unexpired commands WITHOUT claiming them
  (status stays QUEUED; the dashboard keeps showing "Menunggu VM"; the
  bridge claim path is untouched). Response shape mirrors the bridge's:
  `{commands: [{id, type, payload, created_at, expires_at}]}`.
- `POST /api/agents/{id}/commands/{cmdId}/result` with the runtime
  token accepts a result for a command in QUEUED, SENT, or RUNNING
  (a QUEUED command is first moved to RUNNING with started_at set).
  Body: the existing result shape, extended with `status: "rejected"`.
  - succeeded → same handling as the bridge path (state-changing types
    stay RUNNING pending heartbeat verification, per CONTRACT.md).
  - failed → FAILED with `error_reason`.
  - rejected → FAILED with `error_reason` (e.g. LOW_MEMORY) and
    `result.reported_status = "rejected"`; the dashboard renders this
    as **Ditolak**, never as a bare failure (spec: LOW_MEMORY tampil
    sebagai ditolak). The bridge's existing LOW_MEMORY report (failed +
    error_reason LOW_MEMORY) renders the same way.
  - A second result for a terminal command → 409 (exactly-once on the
    server side; the runtime additionally tracks executed ids in its
    own state file — runtime-side, out of scope here).
- Runtime allowlist (miner.run, miner.restart) is enforced by the
  runtime, not the server; the queue read returns all queued types.

Dashboard creation of miner.* commands is unchanged (one button, two
paths): when the bridge is alive it claims and executes as today; when
the VM is dead the command simply stays QUEUED and the UI labels it
**Menunggu VM** while the agent's combined status is PULIH or MATI
(or the bridge is silent).

## 6. API surface additions

- Register responses (pairing, self, re-attach): `+ runtime_token`.
- Agent DTO: `+ runtime: { token_issued: boolean, token_issued_at,
  last_contact_at, last_event_type, last_event_at, last_transition_type,
  last_transition_at, transition_reason, boot_time, snapshot:
  { at, hashrate_hs, shares_local, pool_accepted, pool_last_share_at,
  mem_available_gib } | null } | null`.
- Worker DTO: `+ combined_status, combined_status_reason` (computed by
  the routes that serve workers/agents, which have the runtime state +
  heartbeat).
- Hashrate display rule (frontend): primary = bridge hashrate
  (worker.hashrate_hs). When the bridge is silent (> BRIDGE_SILENT_SEC)
  and a runtime snapshot exists, show the snapshot hashrate labelled
  "Snapshot" with its age — never a bare zero. Pool hashrate stays the
  existing comparison column, labelled windowed.

## 7. Frontend

- Workers list: headline status badge = combined status
  (JALAN / PULIH / MATI / TAK_TERJANGKAU) with its reason as tooltip/
  subtext; legacy worker status remains visible on the worker/agent
  detail. TAK_TERJANGKAU carries the "runtime yang bermasalah"
  explanation.
- Hashrate VM column follows §6's display rule (snapshot fallback +
  age label).
- Agent detail: runtime block — token issued or not, last contact,
  last transition + reason, last snapshot values; VM trigger control
  rendered DISABLED with the note "Menunggu API platform pengelola VM"
  and wired to nothing.
- Commands page: QUEUED commands for a down/recovering agent show
  "Menunggu VM"; FAILED with reported_status "rejected" or
  error_reason LOW_MEMORY shows "Ditolak" + the reason.

## 8. Checkpoint

After schema + runtime event endpoint + combined status are implemented
and tested (full local suite green), STOP and report before deploying —
per the source spec. Deploy (backend + bridge downloads + frontend)
only on Satria's approval.
