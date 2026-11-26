// Rule automation (Phase 3, CONTRACT-3 §2).
//
// A rule watches a condition — a worker holding a status (MATI / GAGAL_START
// / WASPADA / POOL_STALL) for `for_sec`, or an agent being unreachable for
// `for_sec` — and then creates NORMAL commands through the Phase 1 creation
// path (services/commands.ts), so every eligibility gate still applies.
// Blocked attempts are recorded as RULE_SKIPPED events; successful firings as
// RULE_FIRED events + an audit row with actor "automation". Cooldown and a
// daily cap bound the firing rate. The engine runs inside the sweeper tick
// and only when the `automation_enabled` master switch is on.

import type { Agent, AutomationRule, PrismaClient, Worker } from '@prisma/client';
import { newId } from '../lib/crypto';
import { createAuditLog } from './audit';
import { COMMAND_TYPES, createCommand } from './commands';
import { createEvent } from './events';
import { getSettings } from './settings';
import { getTemplateOrThrow, mergePayload } from './templates';

export const RULE_WORKER_STATUSES = ['MATI', 'GAGAL_START', 'WASPADA', 'POOL_STALL'] as const;
export const ACTIVE_COMMAND_STATUSES = ['QUEUED', 'SENT', 'RUNNING'] as const;

export interface RuleCondition {
  kind: 'worker_status' | 'agent_unreachable';
  status?: string;
  for_sec: number;
}

export interface RuleAction {
  type?: string;
  template_id?: string;
  payload?: Record<string, unknown>;
}

export interface RuleTarget {
  agent_ids: string[] | 'all';
}

function httpErr(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate + normalize a rule condition (throws 400 with an Indonesian message). */
export function validateCondition(raw: unknown): RuleCondition {
  if (!isRecord(raw)) throw httpErr(400, 'Kondisi aturan wajib berupa objek');
  const kind = raw.kind;
  if (kind !== 'worker_status' && kind !== 'agent_unreachable') {
    throw httpErr(400, 'Kondisi aturan tidak dikenal: kind harus worker_status atau agent_unreachable');
  }
  const forSec = raw.for_sec;
  if (typeof forSec !== 'number' || !Number.isFinite(forSec) || forSec < 0) {
    throw httpErr(400, 'for_sec pada kondisi harus berupa angka >= 0');
  }
  if (kind === 'worker_status') {
    const status = raw.status;
    if (typeof status !== 'string' || !(RULE_WORKER_STATUSES as readonly string[]).includes(status)) {
      throw httpErr(400, `Status kondisi harus salah satu dari ${RULE_WORKER_STATUSES.join(', ')}`);
    }
    return { kind, status, for_sec: forSec };
  }
  return { kind, for_sec: forSec };
}

/** Validate the shared action shape (rule or schedule). Type/template existence is checked by the caller. */
export function validateActionShape(raw: unknown): RuleAction {
  if (!isRecord(raw)) throw httpErr(400, 'Aksi wajib berupa objek');
  const type = typeof raw.type === 'string' && raw.type.length > 0 ? raw.type : undefined;
  const templateId =
    typeof raw.template_id === 'string' && raw.template_id.length > 0 ? raw.template_id : undefined;
  if (Boolean(type) === Boolean(templateId)) {
    throw httpErr(400, 'Aksi harus berisi tepat satu dari type atau template_id');
  }
  if (type && !(COMMAND_TYPES as readonly string[]).includes(type)) {
    throw httpErr(400, `Tipe perintah tidak dikenal: ${type}`);
  }
  const payload = isRecord(raw.payload) ? raw.payload : undefined;
  return { type, template_id: templateId, payload };
}

/** Validate the shared target shape (rule or schedule). */
export function validateTarget(raw: unknown): RuleTarget {
  if (!isRecord(raw)) throw httpErr(400, 'Target wajib berupa objek {agent_ids}');
  const ids = raw.agent_ids;
  if (ids === 'all') return { agent_ids: 'all' };
  if (Array.isArray(ids) && ids.length > 0 && ids.every((v) => typeof v === 'string' && v.length > 0)) {
    return { agent_ids: [...new Set(ids as string[])] };
  }
  throw httpErr(400, 'agent_ids harus "all" atau daftar id agent yang tidak kosong');
}

/** Resolve an action into a concrete command type + payload (template lookup may throw 404). */
export async function resolveAction(
  prisma: PrismaClient,
  action: RuleAction,
): Promise<{ type: string; payload: Record<string, unknown>; templateId: string | null }> {
  if (action.template_id) {
    const template = await getTemplateOrThrow(prisma, action.template_id);
    return {
      type: template.type,
      payload: mergePayload(template.payload, action.payload),
      templateId: template.id,
    };
  }
  return { type: action.type as string, payload: action.payload ?? {}, templateId: null };
}

export interface RuleInput {
  name: string;
  enabled?: boolean;
  condition: unknown;
  action: unknown;
  target: unknown;
  cooldown_sec?: number;
  max_per_day?: number;
}

async function validateRuleInput(
  prisma: PrismaClient,
  input: RuleInput,
): Promise<{
  name: string;
  condition: RuleCondition;
  action: RuleAction;
  target: RuleTarget;
  cooldownSec: number;
  maxPerDay: number;
}> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw httpErr(400, 'Nama aturan wajib diisi');
  const condition = validateCondition(input.condition);
  const action = validateActionShape(input.action);
  await resolveAction(prisma, action); // template must exist at save time
  const target = validateTarget(input.target);
  const cooldownSec = input.cooldown_sec ?? 3600;
  if (!Number.isInteger(cooldownSec) || cooldownSec < 0) {
    throw httpErr(400, 'cooldown_sec harus bilangan bulat >= 0');
  }
  const maxPerDay = input.max_per_day ?? 5;
  if (!Number.isInteger(maxPerDay) || maxPerDay < 1) {
    throw httpErr(400, 'max_per_day harus bilangan bulat >= 1');
  }
  return { name, condition, action, target, cooldownSec, maxPerDay };
}

export async function createRule(prisma: PrismaClient, input: RuleInput): Promise<AutomationRule> {
  const v = await validateRuleInput(prisma, input);
  return prisma.automationRule.create({
    data: {
      id: newId('rul'),
      name: v.name,
      enabled: input.enabled ?? false,
      condition: v.condition as never,
      action: v.action as never,
      target: v.target as never,
      cooldownSec: v.cooldownSec,
      maxPerDay: v.maxPerDay,
    },
  });
}

export async function updateRule(
  prisma: PrismaClient,
  id: string,
  patch: Partial<RuleInput>,
): Promise<AutomationRule> {
  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) throw httpErr(404, 'RULE_NOT_FOUND');
  const merged: RuleInput = {
    name: patch.name ?? existing.name,
    enabled: patch.enabled ?? existing.enabled,
    condition: patch.condition ?? existing.condition,
    action: patch.action ?? existing.action,
    target: patch.target ?? existing.target,
    cooldown_sec: patch.cooldown_sec ?? existing.cooldownSec,
    max_per_day: patch.max_per_day ?? existing.maxPerDay,
  };
  const v = await validateRuleInput(prisma, merged);
  return prisma.automationRule.update({
    where: { id },
    data: {
      name: v.name,
      enabled: merged.enabled ?? false,
      condition: v.condition as never,
      action: v.action as never,
      target: v.target as never,
      cooldownSec: v.cooldownSec,
      maxPerDay: v.maxPerDay,
    },
  });
}

export async function deleteRule(prisma: PrismaClient, id: string): Promise<void> {
  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) throw httpErr(404, 'RULE_NOT_FOUND');
  await prisma.automationRule.delete({ where: { id } });
}

export async function toggleRule(prisma: PrismaClient, id: string, enabled: boolean): Promise<AutomationRule> {
  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) throw httpErr(404, 'RULE_NOT_FOUND');
  return prisma.automationRule.update({ where: { id }, data: { enabled } });
}

/**
 * Pure per-target eligibility for an automation firing. Returns a skip
 * reason (Bahasa Indonesia) or null. The engine still routes creation
 * through createCommand, so these checks are a pre-filter, never a bypass.
 */
export function evaluateAutomationTarget(input: {
  agent: Agent | null;
  worker: Worker | null;
  type: string;
  hasActiveDuplicate: boolean;
}): string | null {
  const { agent, worker, type } = input;
  if (!agent) return 'Agent tidak ditemukan';
  if (agent.revokedAt) return 'Token agent sudah dicabut';
  if (!worker) return 'Agent belum memiliki worker';
  if (!agent.capabilities.includes(type)) return `Agent tidak memiliki kemampuan ${type}`;
  if (type === 'miner.run' && worker.status === 'GAGAL_START') {
    return 'Run Lagi tidak tersedia: miner gagal start karena memori di bawah ambang';
  }
  if (input.hasActiveDuplicate) return 'Sudah ada perintah aktif dengan tipe yang sama untuk agent ini';
  return null;
}

/** Local-day key (midnight, server local time) used by the daily fire cap. */
export function localDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export interface AutomationSummary {
  rulesFired: number;
  ruleSkips: number;
}

/**
 * One engine pass over all enabled rules. Called from the sweeper tick;
 * the caller gates on the automation_enabled master switch.
 */
export async function evaluateAutomationRules(
  prisma: PrismaClient,
  now: Date,
): Promise<AutomationSummary> {
  const summary: AutomationSummary = { rulesFired: 0, ruleSkips: 0 };
  const settings = await getSettings(prisma);
  const unreachableThresholdMs = settings.heartbeat_interval_sec * settings.unreachable_missed_beats * 1000;

  const rules = await prisma.automationRule.findMany({ where: { enabled: true } });
  for (const rule of rules) {
    try {
      await evaluateRule(prisma, rule, now, unreachableThresholdMs, summary);
    } catch {
      // One broken rule must never break the sweep (Phase 2 alerts precedent).
    }
  }
  return summary;
}

async function evaluateRule(
  prisma: PrismaClient,
  rule: AutomationRule,
  now: Date,
  unreachableThresholdMs: number,
  summary: AutomationSummary,
): Promise<void> {
  // Cooldown.
  if (rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < rule.cooldownSec * 1000) {
    return;
  }
  // Daily cap (counter resets when the stored day is not today).
  const today = localDayStart(now);
  const countedToday =
    rule.fireCountDate && localDayStart(rule.fireCountDate).getTime() === today.getTime()
      ? rule.fireCountToday
      : 0;
  if (countedToday >= rule.maxPerDay) return;

  const condition = rule.condition as unknown as RuleCondition;
  const target = rule.target as unknown as RuleTarget;
  const action = rule.action as unknown as RuleAction;

  const agents =
    target.agent_ids === 'all'
      ? await prisma.agent.findMany()
      : await prisma.agent.findMany({ where: { id: { in: target.agent_ids } } });

  // Resolve which targets currently satisfy the condition, and since when.
  const matched: Array<{ agent: Agent; worker: Worker | null; since: Date }> = [];
  for (const agent of agents) {
    const worker = await prisma.worker.findUnique({ where: { agentId: agent.id } });
    if (condition.kind === 'worker_status') {
      if (!worker || worker.status !== condition.status || !worker.statusSince) continue;
      const heldMs = now.getTime() - worker.statusSince.getTime();
      if (heldMs >= condition.for_sec * 1000) {
        matched.push({ agent, worker, since: worker.statusSince });
      }
    } else {
      // agent_unreachable: unreachable since lastSeen + heartbeat threshold.
      if (agent.status !== 'UNREACHABLE' || !agent.lastSeenAt) continue;
      const since = new Date(agent.lastSeenAt.getTime() + unreachableThresholdMs);
      if (now.getTime() - since.getTime() >= condition.for_sec * 1000) {
        matched.push({ agent, worker, since });
      }
    }
  }
  if (matched.length === 0) return;

  const { type, payload, templateId } = await resolveAction(prisma, action);

  let createdCount = 0;
  let skippedCount = 0;
  for (const { agent, worker, since } of matched) {
    const activeDuplicate = await prisma.command.count({
      where: { agentId: agent.id, type, status: { in: [...ACTIVE_COMMAND_STATUSES] } },
    });
    const reason = evaluateAutomationTarget({
      agent,
      worker,
      type,
      hasActiveDuplicate: activeDuplicate > 0,
    });
    if (reason !== null || !worker) {
      // The duplicate guard blocks silently (no event spam); genuine
      // eligibility refusals are recorded as RULE_SKIPPED per CONTRACT-3 §2.
      if (!reason || !reason.startsWith('Sudah ada perintah aktif')) {
        skippedCount += 1;
        summary.ruleSkips += 1;
        await createEvent(prisma, {
          agentId: agent.id,
          workerId: worker?.id ?? null,
          type: 'RULE_SKIPPED',
          description: `Aturan "${rule.name}" dilewati untuk agent ${agent.name}: ${reason ?? 'Agent belum memiliki worker'}`,
          metadata: { rule_id: rule.id, reason: reason ?? 'Agent belum memiliki worker', type },
        });
      }
      continue;
    }
    try {
      const { created } = await createCommand(prisma, {
        worker,
        agent,
        type,
        payload,
        templateId,
        idempotencyKey: `rule:${rule.id}:${agent.id}:${since.toISOString()}`,
        requestedBy: 'automation',
        confirm: true,
        source: 'automation',
        ruleId: rule.id,
      });
      if (created) createdCount += 1;
    } catch (err) {
      skippedCount += 1;
      summary.ruleSkips += 1;
      const message = err instanceof Error ? err.message : String(err);
      await createEvent(prisma, {
        agentId: agent.id,
        workerId: worker.id,
        type: 'RULE_SKIPPED',
        description: `Aturan "${rule.name}" dilewati untuk agent ${agent.name}: ${message}`,
        metadata: { rule_id: rule.id, reason: message, type },
      });
    }
  }

  if (createdCount > 0) {
    summary.rulesFired += 1;
    await prisma.automationRule.update({
      where: { id: rule.id },
      data: {
        lastFiredAt: now,
        fireCountToday: countedToday + 1,
        fireCountDate: today,
      },
    });
    await createEvent(prisma, {
      agentId: null,
      workerId: null,
      type: 'RULE_FIRED',
      description: `Aturan "${rule.name}" terpicu: ${createdCount} perintah ${type} dibuat`,
      metadata: { rule_id: rule.id, type, created: createdCount, skipped: skippedCount },
    });
    await createAuditLog(prisma, {
      actor: 'automation',
      action: 'automation.rule_fired',
      target: rule.id,
      metadata: { type, created: createdCount, skipped: skippedCount },
    });
  } else if (skippedCount > 0) {
    // All matched targets refused: still start the cooldown so a permanently
    // ineligible target does not produce a RULE_SKIPPED event every tick.
    // The daily fire counter is NOT incremented (nothing was created).
    await prisma.automationRule.update({
      where: { id: rule.id },
      data: { lastFiredAt: now },
    });
  }
}
