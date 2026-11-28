// Runtime monitoring (CONTRACT-7): token issuance, event validation and
// ingest for the Muse runtime that lives on the agent VM (outside the
// bridge). The runtime survives VM replacement; its events are the most
// trusted status source. All validation failures are 400 with NO state
// change; a wrong/missing token is 401 with NO state change.

import type { AgentRuntimeState, PrismaClient } from '@prisma/client';
import { generateAgentToken, sha256Hex } from '../lib/crypto';
import { computeCombinedStatus, type CombinedStatus } from './combined-status';
import { createEvent } from './events';
import { broadcast } from './ws';

export const RUNTIME_EVENT_TYPES = ['VM_REPLACED', 'RECOVERY_OK', 'RECOVERY_FAILED', 'SNAPSHOT'] as const;
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

const TRANSITION_TYPES = new Set<string>(['VM_REPLACED', 'RECOVERY_OK', 'RECOVERY_FAILED']);

/**
 * Issue (rotate) the agent's runtime token. Called on EVERY successful
 * registration (pairing, self, re-attach): the previous token stops
 * working immediately and the bridge persists the new one to
 * runtime-token.json for the runtime to read. Only the hash is stored.
 * Returns the RAW token — the caller puts it in the register response.
 */
export async function issueRuntimeToken(prisma: PrismaClient, agentId: string): Promise<string> {
  const raw = generateAgentToken();
  const now = new Date();
  await prisma.agentRuntimeState.upsert({
    where: { agentId },
    create: { agentId, runtimeTokenHash: sha256Hex(raw), runtimeTokenIssuedAt: now },
    update: { runtimeTokenHash: sha256Hex(raw), runtimeTokenIssuedAt: now },
  });
  return raw;
}

// --- Validation (pure) ---

export interface RuntimeEventBody {
  type?: unknown;
  occurred_at?: unknown;
  boot_time?: unknown;
  pid?: unknown;
  hashrate_local?: unknown;
  mem_available_gib?: unknown;
  primer_gib?: unknown;
  shares_local?: unknown;
  pool_accepted?: unknown;
  pool_last_share_at?: unknown;
  reason?: unknown;
  [key: string]: unknown;
}

export interface ValidatedRuntimeEvent {
  type: RuntimeEventType;
  occurredAt: Date;
  bootTime: Date | null;
  pid: number | null;
  hashrateLocal: number | null;
  memAvailableGib: number | null;
  primerGib: number | null;
  sharesLocal: number | null;
  poolAccepted: number | null;
  poolLastShareAt: Date | null;
  reason: string | null;
  raw: Record<string, unknown>;
}

function badRequest(message: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode: 400, code: 'RUNTIME_EVENT_INVALID' });
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Validate a runtime event payload against CONTRACT-7 §3. Throws 400 on
 * any violation; the caller must not have changed any state yet.
 */
export function validateRuntimeEvent(body: RuntimeEventBody): ValidatedRuntimeEvent {
  const type = body.type;
  if (typeof type !== 'string' || !(RUNTIME_EVENT_TYPES as readonly string[]).includes(type)) {
    throw badRequest(`Tipe event runtime tidak dikenal: ${String(type)}`);
  }
  const occurredAt = parseDate(body.occurred_at);
  if (!occurredAt) throw badRequest('occurred_at wajib ada dan berupa waktu ISO 8601');

  const bootTime = parseDate(body.boot_time);
  if (TRANSITION_TYPES.has(type) && !bootTime) {
    throw badRequest(`boot_time wajib untuk event ${type}`);
  }

  if (type === 'RECOVERY_OK') {
    if (!isPresent(body.pid) || numOrNull(body.pid) === null) throw badRequest('pid wajib untuk RECOVERY_OK');
    if (numOrNull(body.primer_gib) === null) throw badRequest('primer_gib wajib untuk RECOVERY_OK');
    if (numOrNull(body.mem_available_gib) === null) {
      throw badRequest('mem_available_gib wajib untuk RECOVERY_OK');
    }
  }
  if (type === 'RECOVERY_FAILED') {
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      throw badRequest('reason wajib untuk RECOVERY_FAILED');
    }
    if (numOrNull(body.mem_available_gib) === null) {
      throw badRequest('mem_available_gib wajib untuk RECOVERY_FAILED');
    }
  }
  if (type === 'SNAPSHOT') {
    if (numOrNull(body.hashrate_local) === null) throw badRequest('hashrate_local wajib untuk SNAPSHOT');
    if (numOrNull(body.shares_local) === null) throw badRequest('shares_local wajib untuk SNAPSHOT');
  }

  return {
    type: type as RuntimeEventType,
    occurredAt,
    bootTime,
    pid: numOrNull(body.pid),
    hashrateLocal: numOrNull(body.hashrate_local),
    memAvailableGib: numOrNull(body.mem_available_gib),
    primerGib: numOrNull(body.primer_gib),
    sharesLocal: numOrNull(body.shares_local),
    poolAccepted: numOrNull(body.pool_accepted),
    poolLastShareAt: parseDate(body.pool_last_share_at),
    reason: typeof body.reason === 'string' ? body.reason : null,
    raw: body as Record<string, unknown>,
  };
}

// --- Ingest ---

const TRANSITION_DESCRIPTIONS: Record<string, (e: ValidatedRuntimeEvent) => string> = {
  VM_REPLACED: () => 'Runtime melapor VM diganti; pemulihan mulai',
  RECOVERY_OK: (e) => `Runtime melapor pemulihan berhasil (pid ${e.pid ?? '-'})`,
  RECOVERY_FAILED: (e) => `Runtime melapor pemulihan gagal: ${e.reason ?? '-'}`,
};

/**
 * Persist a validated runtime event: replace-latest state + a timeline
 * event for transitions (SNAPSHOT is state-only). Returns the new state.
 */
export async function ingestRuntimeEvent(
  prisma: PrismaClient,
  agentId: string,
  event: ValidatedRuntimeEvent,
): Promise<AgentRuntimeState> {
  const now = new Date();
  const isTransition = TRANSITION_TYPES.has(event.type);

  const state = await prisma.agentRuntimeState.upsert({
    where: { agentId },
    create: {
      agentId,
      lastContactAt: now,
      lastEventType: event.type,
      lastEventAt: event.occurredAt,
      ...(isTransition
        ? {
            lastTransitionType: event.type,
            lastTransitionAt: event.occurredAt,
            lastTransitionPayload: event.raw as never,
            bootTime: event.bootTime,
          }
        : {
            lastSnapshotAt: event.occurredAt,
            snapshotHashrateHs: event.hashrateLocal,
            snapshotSharesLocal: event.sharesLocal,
            snapshotPoolAccepted: event.poolAccepted,
            snapshotPoolLastShareAt: event.poolLastShareAt,
            snapshotMemAvailableGib: event.memAvailableGib,
          }),
    },
    update: {
      lastContactAt: now,
      lastEventType: event.type,
      lastEventAt: event.occurredAt,
      ...(isTransition
        ? {
            lastTransitionType: event.type,
            lastTransitionAt: event.occurredAt,
            lastTransitionPayload: event.raw as never,
            ...(event.bootTime ? { bootTime: event.bootTime } : {}),
          }
        : {
            lastSnapshotAt: event.occurredAt,
            snapshotHashrateHs: event.hashrateLocal,
            snapshotSharesLocal: event.sharesLocal,
            snapshotPoolAccepted: event.poolAccepted,
            snapshotPoolLastShareAt: event.poolLastShareAt,
            snapshotMemAvailableGib: event.memAvailableGib,
          }),
    },
  });

  if (isTransition) {
    const worker = await prisma.worker.findUnique({ where: { agentId } });
    await createEvent(prisma, {
      agentId,
      workerId: worker?.id ?? null,
      type: event.type,
      description: TRANSITION_DESCRIPTIONS[event.type](event),
      metadata: { source: 'runtime', ...event.raw },
    });
    // The workers list's "Pemulihan Terakhir" column reads
    // workers.lastRecoveryAt, which the legacy status machine maintains.
    // A runtime RECOVERY_OK is a recovery too: mirror it there (forward
    // only, so an out-of-order older report never moves the column back).
    if (
      event.type === 'RECOVERY_OK' &&
      worker &&
      (worker.lastRecoveryAt === null || worker.lastRecoveryAt < event.occurredAt)
    ) {
      await prisma.worker.update({
        where: { id: worker.id },
        data: { lastRecoveryAt: event.occurredAt },
      });
      broadcast('worker.recovered', { agent_id: agentId, worker_id: worker.id });
    }
  }
  broadcast('agent.runtime_event', {
    agent_id: agentId,
    type: event.type,
    occurred_at: event.occurredAt.toISOString(),
  });
  return state;
}

/** Reason string carried by the latest transition payload, when present. */
export function transitionReason(state: AgentRuntimeState | null | undefined): string | null {
  const payload = state?.lastTransitionPayload as Record<string, unknown> | null | undefined;
  if (!payload) return null;
  return typeof payload.reason === 'string' ? payload.reason : null;
}

// --- Combined status loading (routes) ---

export interface AgentCombined {
  status: CombinedStatus;
  reason: string;
  state: AgentRuntimeState | null;
}

/**
 * Batch-load runtime states + latest heartbeats and compute the combined
 * dashboard status per agent (CONTRACT-7 §4). Bridge heartbeat time comes
 * from the heartbeat row (falling back to agent.last_seen_at).
 */
export async function loadCombinedStatuses(
  prisma: PrismaClient,
  agentIds: string[],
  now: Date,
): Promise<Map<string, AgentCombined>> {
  const out = new Map<string, AgentCombined>();
  if (agentIds.length === 0) return out;
  const [states, heartbeats, agents] = await Promise.all([
    prisma.agentRuntimeState.findMany({ where: { agentId: { in: agentIds } } }),
    prisma.heartbeat.findMany({ where: { agentId: { in: agentIds } } }),
    prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, lastSeenAt: true } }),
  ]);
  const stateBy = new Map(states.map((s) => [s.agentId, s]));
  const hbBy = new Map(heartbeats.map((h) => [h.agentId, h]));
  const agentBy = new Map(agents.map((a) => [a.id, a]));
  for (const agentId of agentIds) {
    const state = stateBy.get(agentId) ?? null;
    const hb = hbBy.get(agentId);
    const snapshot = (hb?.minerSnapshot ?? null) as { service_state?: unknown; start_blocked_reason?: unknown } | null;
    const combined = computeCombinedStatus({
      now,
      lastTransitionType: state?.lastTransitionType ?? null,
      transitionReason: transitionReason(state),
      lastRuntimeContactAt: state?.lastContactAt ?? null,
      lastBridgeHeartbeatAt: hb?.receivedAt ?? agentBy.get(agentId)?.lastSeenAt ?? null,
      bridgeServiceState: typeof snapshot?.service_state === 'string' ? snapshot.service_state : null,
      bridgeStartBlockedReason:
        typeof snapshot?.start_blocked_reason === 'string' ? snapshot.start_blocked_reason : null,
    });
    out.set(agentId, { status: combined.status, reason: combined.reason, state });
  }
  return out;
}
