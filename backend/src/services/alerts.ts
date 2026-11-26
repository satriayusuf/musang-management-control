// Multi-channel alerts (Phase 2, CONTRACT-2 §4).
//
// Conditions are evaluated from the sweeper tick. One notification per
// occurrence: the dedupe key is `<condition>:<entity_id>:<occurrence start>`
// where the occurrence start is the worker's status_since (or the moment an
// agent transitioned to unreachable). When the condition clears and recurs,
// status_since moves, so the recurrence is a NEW occurrence with a new key.
//
// Channels: webhook (POST JSON) and Telegram Bot API, both configured via
// system_settings with write-only secrets. Delivery failures are recorded in
// alert_deliveries and never propagate to the caller.

import type { AlertDelivery, AlertNotification, PrismaClient } from '@prisma/client';
import { newId } from '../lib/crypto';
import { getRawSetting, getSettings, type Settings } from './settings';
import { broadcast } from './ws';

export const ALERT_CONDITIONS = {
  WORKER_MATI: 'WORKER_MATI',
  WORKER_GAGAL_START: 'WORKER_GAGAL_START',
  AGENT_UNREACHABLE: 'AGENT_UNREACHABLE',
  WORKER_POOL_STALL: 'WORKER_POOL_STALL',
  TEST: 'TEST',
} as const;

export type AlertChannel = 'webhook' | 'telegram';

/** Pure: build the dedupe key for one alert occurrence. */
export function alertDedupeKey(condition: string, entityId: string, occurrenceStartedAt: Date): string {
  return `${condition}:${entityId}:${occurrenceStartedAt.toISOString()}`;
}

const DELIVERY_TIMEOUT_MS = 5000;

interface ChannelOutcome {
  status: 'sent' | 'failed';
  error: string | null;
}

async function sendWebhook(settings: Settings, payload: Record<string, unknown>): Promise<ChannelOutcome> {
  if (!settings.alert_webhook_url) return { status: 'failed', error: 'Webhook belum dikonfigurasi' };
  try {
    const res = await fetch(settings.alert_webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'failed', error: `Webhook merespons HTTP ${res.status}` };
    return { status: 'sent', error: null };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendTelegram(
  prisma: PrismaClient,
  settings: Settings,
  text: string,
): Promise<ChannelOutcome> {
  const token = await getRawSetting(prisma, 'alert_telegram_bot_token');
  if (typeof token !== 'string' || token.length === 0) {
    return { status: 'failed', error: 'Token bot Telegram belum dikonfigurasi' };
  }
  if (!settings.alert_telegram_chat_id) {
    return { status: 'failed', error: 'Chat ID Telegram belum dikonfigurasi' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: settings.alert_telegram_chat_id, text }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'failed', error: `Telegram API merespons HTTP ${res.status}` };
    return { status: 'sent', error: null };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Attempt delivery through ONE channel and record the outcome. Never throws. */
export async function deliverToChannel(
  prisma: PrismaClient,
  notification: AlertNotification,
  channel: AlertChannel,
  settings: Settings,
): Promise<AlertDelivery> {
  const outcome =
    channel === 'webhook'
      ? await sendWebhook(settings, {
          title: notification.title,
          body: notification.body,
          condition: notification.condition,
          agent_id: notification.agentId,
          worker_id: notification.workerId,
          at: notification.createdAt.toISOString(),
        })
      : await sendTelegram(prisma, settings, `${notification.title}\n${notification.body}`);
  return prisma.alertDelivery.create({
    data: {
      id: newId('ald'),
      notificationId: notification.id,
      channel,
      status: outcome.status,
      error: outcome.error,
    },
  });
}

/** Deliver a notification through every ENABLED channel. Never throws. */
export async function deliverAlert(
  prisma: PrismaClient,
  notification: AlertNotification,
  settings: Settings,
): Promise<AlertDelivery[]> {
  const deliveries: AlertDelivery[] = [];
  try {
    if (settings.alert_webhook_enabled) {
      deliveries.push(await deliverToChannel(prisma, notification, 'webhook', settings));
    }
    if (settings.alert_telegram_enabled) {
      deliveries.push(await deliverToChannel(prisma, notification, 'telegram', settings));
    }
  } catch {
    // Delivery problems are recorded per channel; never break the caller.
  }
  return deliveries;
}

export interface CreateAlertInput {
  condition: string;
  agentId?: string | null;
  workerId?: string | null;
  entityId: string;
  occurrenceStartedAt: Date;
  title: string;
  body: string;
}

/**
 * Create the notification for an occurrence (unless it already exists) and
 * deliver it. Returns the notification, or null when this occurrence was
 * already notified. Never throws.
 */
export async function createAlertNotification(
  prisma: PrismaClient,
  input: CreateAlertInput,
): Promise<AlertNotification | null> {
  try {
    const dedupeKey = alertDedupeKey(input.condition, input.entityId, input.occurrenceStartedAt);
    const existing = await prisma.alertNotification.findUnique({ where: { dedupeKey } });
    if (existing) return null;
    const notification = await prisma.alertNotification.create({
      data: {
        id: newId('aln'),
        dedupeKey,
        condition: input.condition,
        agentId: input.agentId ?? null,
        workerId: input.workerId ?? null,
        title: input.title,
        body: input.body,
      },
    });
    const settings = await getSettings(prisma);
    await deliverAlert(prisma, notification, settings);
    broadcast('alert.created', {
      notification_id: notification.id,
      condition: notification.condition,
      agent_id: notification.agentId,
      worker_id: notification.workerId,
      title: notification.title,
    });
    return notification;
  } catch {
    return null;
  }
}

/**
 * Evaluate the worker conditions (MATI / GAGAL_START past the threshold,
 * POOL_STALL when the pool is configured). Called from the sweeper tick.
 * Returns how many NEW notifications were created. Never throws.
 */
export async function evaluateWorkerAlerts(
  prisma: PrismaClient,
  now: Date,
  poolConfigured: boolean,
): Promise<number> {
  let created = 0;
  try {
    const settings = await getSettings(prisma);
    const workers = await prisma.worker.findMany({
      where: { status: { in: ['MATI', 'GAGAL_START', 'POOL_STALL'] } },
      include: { agent: true },
    });
    for (const worker of workers) {
      const ageSec = (now.getTime() - worker.statusSince.getTime()) / 1000;
      if (worker.status === 'POOL_STALL') {
        if (!poolConfigured) continue;
        const n = await createAlertNotification(prisma, {
          condition: ALERT_CONDITIONS.WORKER_POOL_STALL,
          agentId: worker.agentId,
          workerId: worker.id,
          entityId: worker.id,
          occurrenceStartedAt: worker.statusSince,
          title: `Worker POOL-STALL: ${worker.name}`,
          body: `Worker ${worker.name} (agent ${worker.agent.name}) terindikasi pool-stall sejak ${worker.statusSince.toISOString()}: ${worker.statusReason}`,
        });
        if (n) created += 1;
        continue;
      }
      if (ageSec < settings.alert_dead_after_sec) continue;
      const condition =
        worker.status === 'MATI' ? ALERT_CONDITIONS.WORKER_MATI : ALERT_CONDITIONS.WORKER_GAGAL_START;
      const n = await createAlertNotification(prisma, {
        condition,
        agentId: worker.agentId,
        workerId: worker.id,
        entityId: worker.id,
        occurrenceStartedAt: worker.statusSince,
        title: `Worker ${worker.status}: ${worker.name}`,
        body: `Worker ${worker.name} (agent ${worker.agent.name}) berstatus ${worker.status} sejak ${worker.statusSince.toISOString()}: ${worker.statusReason}`,
      });
      if (n) created += 1;
    }
  } catch {
    // Alert evaluation must never break the sweeper.
  }
  return created;
}

/**
 * Send a test message through one configured channel (settings test button).
 * Creates a TEST notification + delivery row so the attempt shows up in
 * GET /api/alerts. Throws 400 for an unknown or unconfigured channel.
 */
export async function sendTestAlert(
  prisma: PrismaClient,
  channel: string,
): Promise<{ notification: AlertNotification; delivery: AlertDelivery }> {
  if (channel !== 'webhook' && channel !== 'telegram') {
    throw Object.assign(new Error(`Kanal tidak dikenal: ${channel}`), { statusCode: 400 });
  }
  const settings = await getSettings(prisma);
  const configured = channel === 'webhook' ? settings.alert_webhook_configured : settings.alert_telegram_configured;
  if (!configured) {
    throw Object.assign(new Error(`Kanal ${channel} belum dikonfigurasi`), { statusCode: 400 });
  }
  const now = new Date();
  const notification = await prisma.alertNotification.create({
    data: {
      id: newId('aln'),
      dedupeKey: alertDedupeKey(ALERT_CONDITIONS.TEST, channel, now),
      condition: ALERT_CONDITIONS.TEST,
      title: 'Tes Alert — Muse Management Control',
      body: `Pesan tes melalui kanal ${channel} pada ${now.toISOString()}`,
    },
  });
  const delivery = await deliverToChannel(prisma, notification, channel, settings);
  return { notification, delivery };
}
