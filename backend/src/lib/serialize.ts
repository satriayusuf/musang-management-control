// DTO serializers: API responses use snake_case field names, matching the
// contract's payload conventions.

import type {
  Agent,
  AgentQuestion,
  AgentRuntimeState,
  AlertDelivery,
  AlertNotification,
  AutomationRule,
  BroadcastBatch,
  Command,
  CommandTemplate,
  Event,
  Schedule,
  Session,
  User,
  Worker,
} from '@prisma/client';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toSessionDto(s: Session) {
  return {
    id: s.id,
    agent_id: s.agentId,
    boot_id: s.bootId,
    boot_time: iso(s.bootTime),
    started_at: iso(s.startedAt),
    ended_at: iso(s.endedAt),
    end_reason: s.endReason,
    session_no: s.sessionNo,
  };
}

/**
 * CONTRACT-7 §6: the runtime block on agent DTOs. Token VALUE is never
 * exposed — only whether one was issued, plus the last state the runtime
 * reported (transition + snapshot).
 */
export function toRuntimeStateDto(s: AgentRuntimeState | null | undefined) {
  if (!s) return null;
  const payload = (s.lastTransitionPayload ?? null) as Record<string, unknown> | null;
  return {
    token_issued: Boolean(s.runtimeTokenHash),
    token_issued_at: iso(s.runtimeTokenIssuedAt),
    last_contact_at: iso(s.lastContactAt),
    last_event_type: s.lastEventType,
    last_event_at: iso(s.lastEventAt),
    last_transition_type: s.lastTransitionType,
    last_transition_at: iso(s.lastTransitionAt),
    transition_reason: payload && typeof payload.reason === 'string' ? payload.reason : null,
    boot_time: iso(s.bootTime),
    snapshot:
      s.lastSnapshotAt != null
        ? {
            at: iso(s.lastSnapshotAt),
            hashrate_hs: s.snapshotHashrateHs,
            shares_local: s.snapshotSharesLocal,
            pool_accepted: s.snapshotPoolAccepted,
            pool_last_share_at: iso(s.snapshotPoolLastShareAt),
            mem_available_gib: s.snapshotMemAvailableGib,
          }
        : null,
  };
}

export function toAgentDto(
  a: Agent,
  extras?: {
    current_session?: Session | null;
    worker?: Worker | null;
    runtime?: AgentRuntimeState | null;
    combined?: { status: string; reason: string } | null;
  },
) {
  return {
    id: a.id,
    name: a.name,
    worker_name: a.workerName,
    enrolled_via: a.enrolledVia,
    capabilities: a.capabilities,
    bridge_version: a.bridgeVersion,
    status: a.status,
    first_registered_at: iso(a.firstRegisteredAt),
    last_seen_at: iso(a.lastSeenAt),
    replacement_count: a.replacementCount,
    current_session_id: a.currentSessionId,
    revoked_at: iso(a.revokedAt),
    created_at: iso(a.createdAt),
    updated_at: iso(a.updatedAt),
    ...(extras?.current_session !== undefined
      ? { current_session: extras.current_session ? toSessionDto(extras.current_session) : null }
      : {}),
    ...(extras?.worker !== undefined ? { worker: extras.worker ? toWorkerDto(extras.worker) : null } : {}),
    ...(extras?.runtime !== undefined ? { runtime: toRuntimeStateDto(extras.runtime) } : {}),
    ...(extras?.combined !== undefined && extras.combined
      ? { combined_status: extras.combined.status, combined_status_reason: extras.combined.reason }
      : {}),
  };
}

export function toWorkerDto(
  w: Worker,
  extras?: { pool?: unknown; combined?: { status: string; reason: string } | null },
) {
  return {
    id: w.id,
    agent_id: w.agentId,
    name: w.name,
    pool_address: w.poolAddress,
    status: w.status,
    status_reason: w.statusReason,
    // CONTRACT-7 §4/§6: server-computed combined status (runtime >
    // bridge > pool), attached by routes that loaded the runtime state.
    ...(extras?.combined
      ? { combined_status: extras.combined.status, combined_status_reason: extras.combined.reason }
      : {}),
    status_since: iso(w.statusSince),
    last_share_at: iso(w.lastShareAt),
    last_local_share_at: iso(w.lastLocalShareAt),
    hashrate_hs: w.hashrateHs,
    accepted_shares: w.acceptedShares,
    rejected_shares: w.rejectedShares,
    shares_local: w.sharesLocal,
    job_height: w.jobHeight,
    difficulty: w.difficulty,
    miner_service_state: w.minerServiceState,
    last_recovery_at: iso(w.lastRecoveryAt),
    hold_until: iso(w.holdUntil),
    hold_active: w.holdActive,
    updated_at: iso(w.updatedAt),
    // Phase 5 (CONTRACT-5 B6): pool block, attached by routes that have
    // settings/snapshot access; absent entirely when not provided.
    ...(extras && 'pool' in extras ? { pool: extras.pool ?? null } : {}),
  };
}

export function toCommandDto(c: Command) {
  return {
    id: c.id,
    agent_id: c.agentId,
    worker_id: c.workerId,
    template_id: c.templateId,
    batch_id: c.batchId,
    source: c.source,
    rule_id: c.ruleId,
    schedule_id: c.scheduleId,
    type: c.type,
    payload: c.payload,
    idempotency_key: c.idempotencyKey,
    status: c.status,
    requested_by: c.requestedBy,
    created_at: iso(c.createdAt),
    sent_at: iso(c.sentAt),
    started_at: iso(c.startedAt),
    finished_at: iso(c.finishedAt),
    expires_at: iso(c.expiresAt),
    result: c.result,
    error_reason: c.errorReason,
    verify_deadline: iso(c.verifyDeadline),
  };
}

export function toEventDto(e: Event) {
  return {
    id: e.id,
    agent_id: e.agentId,
    worker_id: e.workerId,
    type: e.type,
    description: e.description,
    metadata: e.metadata,
    created_at: iso(e.createdAt),
  };
}

export function toTemplateDto(t: CommandTemplate) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    payload: t.payload,
    description: t.description,
    sensitive: t.sensitive,
    created_at: iso(t.createdAt),
    updated_at: iso(t.updatedAt),
  };
}

export function toBatchDto(b: BroadcastBatch) {
  return {
    id: b.id,
    type: b.type,
    template_id: b.templateId,
    payload: b.payload,
    requested_by: b.requestedBy,
    idempotency_key: b.idempotencyKey,
    total_count: b.totalCount,
    created_count: b.createdCount,
    skipped_count: b.skippedCount,
    skipped: b.skipped,
    created_at: iso(b.createdAt),
  };
}

export function toAlertDeliveryDto(d: AlertDelivery) {
  return {
    id: d.id,
    notification_id: d.notificationId,
    channel: d.channel,
    status: d.status,
    error: d.error,
    at: iso(d.at),
  };
}

export function toAlertNotificationDto(n: AlertNotification & { deliveries?: AlertDelivery[] }) {
  return {
    id: n.id,
    dedupe_key: n.dedupeKey,
    condition: n.condition,
    agent_id: n.agentId,
    worker_id: n.workerId,
    title: n.title,
    body: n.body,
    created_at: iso(n.createdAt),
    ...(n.deliveries ? { deliveries: n.deliveries.map(toAlertDeliveryDto) } : {}),
  };
}

// --- Phase 3 DTOs (CONTRACT-3 §1/§2/§3) ---

/** User DTO — never includes the password hash. */
export function toUserDto(u: User) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    disabled: u.disabledAt !== null,
    disabled_at: iso(u.disabledAt),
    created_at: iso(u.createdAt),
  };
}

export function toRuleDto(r: AutomationRule) {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    condition: r.condition,
    action: r.action,
    target: r.target,
    cooldown_sec: r.cooldownSec,
    max_per_day: r.maxPerDay,
    last_fired_at: iso(r.lastFiredAt),
    fire_count_today: r.fireCountToday,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

/** CONTRACT-8: one broadcast-question row. CONTRACT-9 adds `kind`. */
export function toQuestionDto(q: AgentQuestion) {
  return {
    id: q.id,
    agent_id: q.agentId,
    broadcast_id: q.broadcastId,
    kind: q.kind,
    question: q.question,
    asked_by: q.askedBy,
    asked_at: iso(q.askedAt),
    status: q.status,
    answer: q.answer,
    answered_at: iso(q.answeredAt),
  };
}

export function toScheduleDto(s: Schedule) {
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    cron: s.cron,
    action: s.action,
    target: s.target,
    broadcast: s.broadcast,
    next_run_at: iso(s.nextRunAt),
    last_run_at: iso(s.lastRunAt),
    created_at: iso(s.createdAt),
    updated_at: iso(s.updatedAt),
  };
}
