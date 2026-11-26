# CONTRACT-4 — Heartbeat replace-latest (PURE)

Owner decision (Satria, 2026-11-26, final): heartbeat storage switches from
append-only history to **pure replace-latest** — one row per agent, overwritten
by every new report. No session aggregates (an earlier aggregates variant of
this contract was considered and dropped by the owner). Accepted, known
consequence: worker analytics that were derived from heartbeat history shrink
to the latest point (see §3); live status, sessions, events, alerts,
automation and command verification are unaffected because they never read
heartbeat history.

## 1. Schema (one new migration, name suffix `phase4_heartbeat_replace`)

- `Heartbeat`: add `@@unique([agentId])`. The generated migration SQL must
  FIRST collapse existing rows to the latest per agent (delete every row that
  is not the max(received_at) row of its agent) and only then create the
  unique index — otherwise `migrate deploy` fails on databases with history
  (production included).
- No other model changes.

## 2. Ingest — `services/heartbeat.ts processHeartbeat`

- Replace `prisma.heartbeat.create(...)` with an upsert keyed by `agentId`
  overwriting sessionId / receivedAt (receivedAt must be set explicitly to
  the ingest time on update — `@default(now())` does not fire on update) /
  memAvailableGib / minerSnapshot / agentStatus.
- After any number of heartbeats there is exactly ONE heartbeat row per agent.
- Everything else in processHeartbeat is unchanged.

## 3. Analytics — `routes/analytics.ts` worker section

Response shape stays identical (same field names); values now derive from the
agent's single latest heartbeat row only:

- `hashrate_series`: `[]` when no heartbeat exists, otherwise exactly one
  point `{ t: latest.receivedAt, v: snapshot.hashrate_hs ?? 0 }`.
- `last_share_intervals`: `[]`. `longest_share_gap_sec`: keep the existing
  helper's empty-input result (null) — do not fabricate.
- `shares_per_session`: computed by the existing helper from the single
  latest snapshot's `{ session_no, shares_local }` (or the helper's empty
  result when no heartbeat).
- `mem_at_session_start` / `mem_at_session_start_trend`: include the latest
  heartbeat's mem value only when its session started within the range;
  otherwise empty.
- `downtime_sec`: 0 (not derivable from a single point — report 0, never an
  estimate dressed as data).
- Agent section: unchanged.

## 4. Retention — `services/retention.ts`

Heartbeats leave the deletion set entirely: the single latest row per agent
must survive forever (an agent silent longer than the old window must not
lose its last known state). `runRetention` keeps returning `heartbeats` in
its counts shape, always 0. The `retention_heartbeats_days` setting stays
readable/writable (legacy no-op) so the settings API/UI do not change.

## 5. Tests

- Adapt tests that seed multiple heartbeat rows per agent: they now seed the
  single latest row, and analytics assertions follow §3 (single-point series,
  empty intervals, downtime 0).
- New coverage: (a) two heartbeats for one agent leave exactly one row
  carrying the latest values; (b) retention never deletes the latest
  heartbeat row, however old.
- Full backend suite must pass (`npm test` in `backend/`).

## 6. Out of scope / do not touch

Bridge, frontend (grep it for direct heartbeat-history usage and report any
hit — do not redesign), settings keys, pool adapter, deployment. No
production access: build and test locally only; deployment is done
separately by the parent agent.
